"""Optional Ollama completion for a grammar miss.

No key is read from disk. ``OLLAMA_API_KEY`` is sent only to ``ollama.com``.
Local ``127.0.0.1:11434`` is tried first and does not receive the key.
``mistral-large-3:675b-cloud`` is refused. A failure returns None so playback
stays on the deterministic path.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any, Callable

from .mashup_contracts import COMPLEX_MODEL, SYSTEM1_MODEL

LOCAL_URL = "http://127.0.0.1:11434/v1/chat/completions"
CLOUD_URL = "https://ollama.com/v1/chat/completions"
_ALLOWED_MODELS = frozenset({SYSTEM1_MODEL, COMPLEX_MODEL})
_ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "ollama.com"})

_SYSTEM = (
    "Return one JSON object and nothing else. "
    'Shape: {"ops":[...],"declined":[{"code":"...","message":"..."}]}. '
    "ops items are only eq, gain, crossfader, filter, loop, play, or pause. "
    "deck is A or B. eq uses band low|mid|high and db from -12 to 12. "
    "gain value is 0 to 1. crossfader position is 0 (deck A) to 100 (deck B). "
    "filter mode is lowpass, highpass, or off, amount 0 to 1. "
    "loop bars are 1, 2, 4, or 8. At most 4 ops. "
    "If the user asks to loop or isolate vocals, decline with code "
    "STEM_LOOP_UNAVAILABLE and do not invent a stem. "
    "Do not include filenames, shell commands, or keys."
)


def _strip_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped


def _message_content(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        return None
    return _strip_fence(content)


def _post(opener: Callable[..., Any], url: str, model: str, text: str, key: str | None, timeout: float) -> str | None:
    parsed = urllib.request.urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _ALLOWED_HOSTS:
        return None
    body = json.dumps({
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": text[:500]},
        ],
    }).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with opener(request, timeout=timeout) as response:
            raw = response.read()
    except (OSError, urllib.error.URLError, TimeoutError, ValueError):
        return None
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except (UnicodeError, json.JSONDecodeError, AttributeError):
        return None
    return _message_content(payload)


def complete_json(
    model: str,
    text: str,
    *,
    opener: Callable[..., Any] | None = None,
    env: Mapping[str, str] | None = None,
    timeout_s: float = 8.0,
) -> str | None:
    """Return model JSON text, or None when no allowed model answers."""
    if model not in _ALLOWED_MODELS or not isinstance(text, str) or not text.strip():
        return None
    call = opener or urllib.request.urlopen
    source = os.environ if env is None else env
    local_timeout = min(1.0, timeout_s)
    local = _post(call, LOCAL_URL, model, text, None, local_timeout)
    if local:
        return local
    key = str(source.get("OLLAMA_API_KEY", "")).strip()
    if not key:
        return None
    return _post(call, CLOUD_URL, model, text, key, timeout_s)

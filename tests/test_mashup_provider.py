"""Provider routing stays on the two allowed models and never sends the key locally."""

import json

from twobecomeone.mashup_contracts import COMPLEX_MODEL, SYSTEM1_MODEL
from twobecomeone.mashup_provider import complete_json


class _Response:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_refuses_the_unbudgeted_large_model():
    called = []

    def opener(request, timeout):
        called.append(request.full_url)
        return _Response({"choices": [{"message": {"content": "{\"ops\":[]}"}}]})

    assert complete_json("mistral-large-3:675b-cloud", "make it slap", opener=opener) is None
    assert called == []


def test_local_answer_does_not_call_cloud_or_attach_a_key():
    seen = []

    def opener(request, timeout):
        seen.append((request.full_url, request.headers.get("Authorization"), timeout))
        if "127.0.0.1" in request.full_url:
            return _Response({"choices": [{"message": {"content": "{\"ops\":[]}"}}]})
        raise AssertionError("cloud should not be called")

    text = complete_json(SYSTEM1_MODEL, "make it slap", opener=opener, env={"OLLAMA_API_KEY": "secret"})
    assert text == '{"ops":[]}'
    assert seen[0][0].startswith("http://127.0.0.1:11434/")
    assert seen[0][1] is None
    assert len(seen) == 1


def test_cloud_is_used_only_when_local_is_down_and_a_key_exists():
    def opener(request, timeout):
        if request.full_url.startswith("http://127.0.0.1"):
            raise OSError("down")
        assert request.headers["Authorization"] == "Bearer secret"
        assert request.full_url.startswith("https://ollama.com/")
        body = json.loads(request.data.decode())
        assert body["model"] == COMPLEX_MODEL
        return _Response({"choices": [{"message": {"content": "```json\n{\"ops\":[]}\n```"}}]})

    text = complete_json(COMPLEX_MODEL, "mash this", opener=opener, env={"OLLAMA_API_KEY": "secret"})
    assert text == '{"ops":[]}'


def test_missing_key_stays_unavailable():
    def opener(request, timeout):
        raise OSError("down")

    assert complete_json(SYSTEM1_MODEL, "make it slap", opener=opener, env={}) is None

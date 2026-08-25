"""Source acquisition for 2become1.

Three ways to get a track:
  - local files  (already on disk)
  - YouTube      (via yt-dlp)
  - torrents     (via a scraper that queries public indexers for magnets)
"""

from __future__ import annotations

import re
import shutil
import subprocess
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from .common import UserError


def _require_ytdlp() -> None:
    if shutil.which("yt-dlp") is None:
        raise UserError("yt-dlp is required for YouTube sourcing but not found on PATH. "
                        "Install it with: uv tool install yt-dlp")


# ---------------------------------------------------------------------------
# Local files
# ---------------------------------------------------------------------------

def from_local(path: str | Path) -> Path:
    """Register an existing local audio file. Returns its path."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)
    if not p.is_file():
        raise ValueError(f"not a file: {p}")
    return p


# ---------------------------------------------------------------------------
# YouTube via yt-dlp
# ---------------------------------------------------------------------------

_YTDLP_TIMEOUT = 60 * 60


def is_youtube_url(value: str) -> bool:
    """Return whether *value* is an HTTP(S) YouTube URL."""
    try:
        parsed = urllib.parse.urlparse(value.strip())
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    return (
        parsed.scheme in {"http", "https"}
        and (hostname == "youtu.be" or hostname == "youtube.com" or hostname.endswith(".youtube.com"))
    )


_YT_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def canonicalize_youtube_url(value: str) -> str:
    """Return a stable canonical URL for a supported YouTube URL, or raise.

    Extracts the 11-character video ID from the three common formats:
      - https://www.youtube.com/watch?v=ID
      - https://youtu.be/ID
      - https://www.youtube.com/shorts/ID

    Returns ``https://www.youtube.com/watch?v=ID``. Anything else is rejected.
    """
    value = value.strip()
    if not is_youtube_url(value):
        raise UserError("enter a valid youtube.com or youtu.be URL")
    parsed = urllib.parse.urlparse(value)
    hostname = (parsed.hostname or "").lower()
    video_id: str | None = None

    if hostname == "youtu.be":
        video_id = parsed.path.lstrip("/").split("/")[0]
    else:
        query = urllib.parse.parse_qs(parsed.query)
        if "v" in query and query["v"]:
            video_id = query["v"][0]
        else:
            # /shorts/ID or /watch/ID style paths.
            parts = [p for p in parsed.path.split("/") if p]
            if parts and parts[0] in {"shorts", "watch", "embed", "live"} and len(parts) >= 2:
                video_id = parts[1]

    if not video_id or not _YT_VIDEO_ID_RE.match(video_id):
        raise UserError("could not extract a video ID from that YouTube URL")
    return f"https://www.youtube.com/watch?v={video_id}"


def from_youtube(url: str, out_dir: Path, fmt: str = "bestaudio/best") -> Path:
    """Download audio-only from a YouTube URL using yt-dlp."""
    url = url.strip()
    if not is_youtube_url(url):
        raise UserError("enter a valid youtube.com or youtu.be URL")
    _require_ytdlp()
    out_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(out_dir / "%(title)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "-x",                      # extract audio
        "--audio-format", "mp3",
        "--audio-quality", "0",    # best
        "--continue",              # resume interrupted partial downloads
        "-o", output_template,
        "-f", fmt,
        "--no-playlist",
        "--print", "after_move:filepath",  # emit the final file path to stdout
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_YTDLP_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise UserError("yt-dlp timed out after one hour; run the import again to resume")
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        message = detail[-1] if detail else "unknown download error"
        raise UserError(f"yt-dlp failed: {message[:500]}")

    # Extract the last produced file path from stdout
    lines = proc.stdout.decode().splitlines()
    produced = [ln for ln in lines if ln.strip().endswith(".mp3")]
    if not produced:
        raise UserError("yt-dlp did not report an output mp3")
    result = Path(produced[-1].strip())
    if not result.exists():
        raise UserError(f"yt-dlp reported a missing file: {result.name}")
    return result


# ---------------------------------------------------------------------------
# Torrent source
# ---------------------------------------------------------------------------

# Public torrent indexers that expose JSON search APIs (no auth).
TORRENT_APIS: list[str] = [
    # The Pirate Bay public API mirror (https JSON).
    "https://apibay.org/q.php?q={query}&cat=0",
    # Archive.org hosts many public-domain/legal torrents + JSON search.
    "https://archive.org/advancedsearch.php?q={query}&fl%5B%5D=identifier&fl%5B%5D=title&output=json&rows=10",
]

_SEARCH_TIMEOUT_SEC = 60


@dataclass
class TorrentHit:
    title: str
    magnet: str
    source: str = ""


def _build_magnet(info_hash: str, name: str, trackers: list[str]) -> str:
    params = [
        ("xt", f"urn:btih:{info_hash}"),
        ("dn", name),
    ] + [("tr", t) for t in trackers]
    return "magnet:?" + urllib.parse.urlencode(params)


_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
]


def _parse_apibay(data: list, cap: int) -> list[TorrentHit]:
    hits: list[TorrentHit] = []
    for it in data[:cap]:
        if not it.get("name"):
            continue
        ih = it.get("info_hash") or it.get("hash")
        if not ih:
            continue
        magnet = _build_magnet(ih, it["name"], _TRACKERS)
        hits.append(TorrentHit(title=it["name"], magnet=magnet, source="apibay"))
    return hits


def _parse_archiveorg(data: dict, cap: int) -> list[TorrentHit]:
    hits: list[TorrentHit] = []
    docs = data.get("response", {}).get("docs", [])
    for it in docs[:cap]:
        identifier = it.get("identifier")
        title = it.get("title") or identifier
        if not identifier:
            continue
        # Archive.org torrents are fetched via identifier; we return a
        # web URL rather than a magnet because they expose their own
        # trackerless torrent files at /download/<id>/<id>_archive.torrent
        link = f"https://archive.org/download/{identifier}/{identifier}_archive.torrent"
        hits.append(TorrentHit(title=title, magnet=link, source="archive.org"))
    return hits


def search_torrents(query: str, index: int = 0, cap: int = 10) -> list[TorrentHit]:
    """Search a public torrent index for `query`. Returns hits.

    `index` selects which API from TORRENT_APIS. Implementations are
    best-effort; a failed API raises so the caller can fall back.
    """
    import json
    import urllib.request

    if index >= len(TORRENT_APIS):
        return []
    base = TORRENT_APIS[index]
    q = urllib.parse.quote_plus(query)
    url = base.format(query=q)

    req = urllib.request.Request(url, headers={"User-Agent": "2become1/0.1"})
    with urllib.request.urlopen(req, timeout=_SEARCH_TIMEOUT_SEC) as resp:
        raw = resp.read().decode("utf-8", "replace")

    try:
        data = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"invalid JSON from {url}: {exc}")

    if isinstance(data, list):
        return _parse_apibay(data, cap)
    if isinstance(data, dict):
        return _parse_archiveorg(data, cap)

    raise RuntimeError(f"unexpected response type from {url}: {type(data).__name__}")

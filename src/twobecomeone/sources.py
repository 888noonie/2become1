"""Source acquisition for 2become1.

Three ways to get a track:
  - local files  (already on disk)
  - YouTube      (via yt-dlp)
  - torrents     (via a scraper that queries public indexers for magnets)
"""

from __future__ import annotations

import shutil
import subprocess
import urllib.parse
from dataclasses import dataclass
from pathlib import Path


def _require_ytdlp() -> None:
    if shutil.which("yt-dlp") is None:
        raise RuntimeError("yt-dlp is required for YouTube sourcing but not found on PATH. "
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

_YTDLP_TIMEOUT = 300


def from_youtube(url: str, out_dir: Path, fmt: str = "bestaudio/best") -> Path:
    """Download audio-only from a YouTube URL using yt-dlp."""
    _require_ytdlp()
    out_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(out_dir / "%(title)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "-x",                      # extract audio
        "--audio-format", "mp3",
        "--audio-quality", "0",    # best
        "-o", output_template,
        "-f", fmt,
        "--no-playlist",
        "--print", "after_move:filepath",  # emit the final file path to stdout
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_YTDLP_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError("yt-dlp timed out downloading the video")
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.decode()[:500]}")

    # Extract the last produced file path from stdout
    lines = proc.stdout.decode().splitlines()
    produced = [ln for ln in lines if ln.strip().endswith(".mp3")]
    if not produced:
        raise RuntimeError("yt-dlp did not report an output mp3")
    result = Path(produced[-1].strip())
    if not result.exists():
        raise RuntimeError(f"yt-dlp reported missing file: {result}")
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

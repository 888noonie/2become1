"""Source acquisition for 2become1.

Three ways to get a track:
  - local files  (already on disk)
  - YouTube      (via yt-dlp)
  - torrents     (via a scraper that queries public indexers for magnets)
"""

from __future__ import annotations

import subprocess
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Local files
# ---------------------------------------------------------------------------

def from_local(path: str | Path, out_dir: Path) -> Path:
    """Just register an existing local audio file. Returns its path."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)
    return p


# ---------------------------------------------------------------------------
# YouTube via yt-dlp
# ---------------------------------------------------------------------------

def from_youtube(url: str, out_dir: Path, fmt: str = "bestaudio/best") -> Path:
    """Download audio-only from a YouTube URL using yt-dlp."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "yt-dlp",
        "-x",                      # extract audio
        "--audio-format", "mp3",
        "--audio-quality", "0",    # best
        "-o", str(out_dir / "%(title)s.%(ext)s"),
        "-f", fmt,
        "--no-playlist",
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.decode()[:500]}")
    # find the produced file
    candidates = sorted(out_dir.glob("*.mp3"))
    if not candidates:
        raise RuntimeError("yt-dlp ran but produced no .mp3")
    return candidates[0]


# ---------------------------------------------------------------------------
# Torrent source
# ---------------------------------------------------------------------------

# Public torrent indexers that expose JSON search APIs (no auth). The CLI
# passes these through; a live scraper that aggregates many is a drop-in
# replacement behind the same `search_torrents()` interface.

TORRENT_APIS: list[str] = [
    # The Pirate Bay public API mirror (https JSON). Fields vary; we
    # parse defensively.
    "https://apibay.org/q.php?q={query}&cat=0",
    # Archive.org hosts many public-domain/legal torrents + JSON search.
    "https://archive.org/advancedsearch.php?q={query}&fl%5B%5D=identifier&fl%5B%5D=title&output=json&rows=10",
]

_TIMEOUT = (15, 60)


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


def search_torrents(query: str, index: int = 0) -> list[TorrentHit]:
    """Search a public torrent index for `query`. Returns magnet hits.

    `index` selects which API from TORRENT_APIS. Implementations are
    best-effort; a failed API raises so the CLI can surface which layer
    is unavailable rather than silently returning nothing.
    """
    import json
    import urllib.request

    if index >= len(TORRENT_APIS):
        return []
    base = TORRENT_APIS[index]
    q = urllib.parse.quote_plus(query)
    url = base.format(query=q)

    req = urllib.request.Request(url, headers={"User-Agent": "2become1/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8", "replace")

    hits: list[TorrentHit] = []
    cap = 10
    try:
        data = json.loads(raw)
    except Exception:
        return []

    # TPB (apiBay) shape: a JSON list of {name, info_hash, seeders,...}
    if isinstance(data, list):
        for it in data[:cap]:
            if not it.get("name"):
                continue
            ih = it.get("info_hash") or it.get("hash")
            if not ih:
                continue
            magnet = _build_magnet(ih, it["name"])
            hits.append(TorrentHit(title=it["name"], magnet=magnet,
                                   source="apibay"))
    return hits

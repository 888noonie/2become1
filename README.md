# 2become1 Studio

A local-first music mashup studio for combining two tracks without uploading
them to somebody else's cloud. It analyzes tempo and key, suggests a beat-grid
starting point, optionally isolates a lead vocal with Demucs, aligns the lead,
and produces a loudness-managed mix.

The name is a deliberately cheesy nod to the Spice Girls. The engine is general
purpose; bring audio you own or have permission to remix.

## Launch the Studio

Requirements: Python 3.11+, `uv`, and `ffmpeg`/`ffprobe` on `PATH`.

```bash
cd /home/richardn/2become1
uv venv .venv
uv pip install --python .venv/bin/python -e '.[web,demucs]'
.venv/bin/twobecomeone web
```

Open <http://127.0.0.1:8765>. The server binds to the local machine only by
default, and project media is kept under `~/.local/share/2become1/`.

The Studio provides:

- two drag-and-drop audio decks with BPM, key, duration, and playback;
- lightweight first-beat/downbeat suggestions with manual correction;
- start-offset, render-duration, and gain controls;
- optional CUDA-accelerated Demucs lead-vocal isolation;
- queued 12-second previews and full renders with live stage progress;
- local playback, downloads, and recent-render history;
- one same-origin FastAPI application—no public CORS or remote upload path.

## CLI

The underlying engine remains fully scriptable:

```bash
# Analyze tempo and key
.venv/bin/twobecomeone analyze track_a.mp3 track_b.mp3

# Machine-readable analysis
.venv/bin/twobecomeone analyze track_a.mp3 --json

# Real four-stem separation when Demucs is installed
.venv/bin/twobecomeone separate track.mp3 -o stems/ --method demucs

# Honest center/side fallback (not fake vocals/instrumental labels)
.venv/bin/twobecomeone separate track.mp3 -o stereo-parts/ --method ffmpeg

# Region-aware mash; anchor supplies target tempo and key
.venv/bin/twobecomeone mash anchor.mp3 lead.mp3 \
  --anchor-start 32.4 --lead-start 18.1 --duration 30 \
  --stems --stem-method demucs -o out.mp3

# Inspect the plan without creating stems or output files
.venv/bin/twobecomeone mash anchor.mp3 lead.mp3 --dry-run --json
```

The source module also contains experimental YouTube and public-index search
helpers. They are intentionally absent from the Studio's default interface.

## Architecture

```text
browser (same origin)
        │
        ▼
FastAPI routes ──► StudioService ──► SQLite project/job state
                         │
                         ├── analyzer + beat-grid suggestion
                         ├── single-worker Demucs queue (CUDA → CPU fallback)
                         └── ffmpeg align/mix/loudness pipeline
```

The CLI and web app call the service/audio modules directly; neither wraps or
scrapes the other's output. A single render worker prevents concurrent jobs
from competing for laptop GPU memory. Uploaded names are never used as storage
paths, supported audio suffixes are allow-listed, and uploads have a 750 MB
local ceiling.

## Development

```bash
uv pip install --python .venv/bin/python -e '.[web,dev,demucs]'
.venv/bin/pytest -q
```

The test suite covers DSP invariants, invalid media, JSON contracts, truthful
center/side output, Demucs caching and CUDA selection, OOM fallback behavior,
region timing, true-peak checks, safe ingestion, persistent jobs, and the full
HTTP upload-to-render vertical slice.

## Current boundaries

- Beat/downbeat positions are suggestions, not phrase or chorus detection.
- The ffmpeg fallback is a center/side transform, not vocal isolation.
- Vercel can host a static demonstration, but real ffmpeg/Torch processing
  belongs on this local backend or a dedicated GPU service.
- YouTube/torrent acquisition is not part of the launch UI.

## License

MIT—see [LICENSE](LICENSE).

# 2become1 Studio

A local-first music mashup studio for combining two tracks without uploading
them to somebody else's cloud. It analyzes tempo and key, suggests a beat-grid
starting point, optionally isolates stems with Demucs, aligns both sources to
an output BPM, and produces a loudness-managed mix.

The name is a deliberately cheesy nod to the Spice Girls. The engine is general
purpose; bring audio you own or have permission to remix.

## Launch the Studio

Requirements: Python 3.11+, `uv`, and `ffmpeg`/`ffprobe` on `PATH`. On
CachyOS/Arch, install ffmpeg with `sudo pacman -S ffmpeg`.

```bash
cd 2become1
uv venv .venv
uv sync --frozen --extra web --extra demucs
.venv/bin/twobecomeone web
```

Open <http://127.0.0.1:8765>. The server binds to the local machine only by
default, and project media is kept under `~/.local/share/2become1/`.

Binding to a non-loopback host (e.g. `0.0.0.0`) exposes the unauthenticated
Studio and its media routes to your network. It now requires an explicit
`--allow-network` flag:

```bash
.venv/bin/twobecomeone web --host 0.0.0.0 --allow-network --trusted-host 192.168.1.10
```

Replace the example IP with this computer's network address. Repeat
`--trusted-host` for additional exact hostnames. Network access remains
unauthenticated; only enable it on a network you trust. Mutating browser
requests must originate from the Studio itself.

The Studio provides:

- two audio decks accepting drag-and-drop files or single-track YouTube links;
- persistent DJ/FUN views: waveform precision in DJ and a seven-pad,
  touch-first project surface in FUN;
- one managed local media library with source provenance, BPM, key, duration, and playback;
- lightweight first-beat/downbeat suggestions with manual correction;
- explicit output BPM (Foundation/Lead/custom), overlay and A→B transition
  modes, and per-deck gain/pan/3-band EQ;
- optional CUDA-accelerated Demucs stem separation with honest center/side fallback;
- queued 12-second previews and full renders with live stage progress;
- bounded vocal Ghost phrase audition, visible tether/status, durable Commit,
  append-only Undo, and inclusion in the shared preview/render plan;
- local playback, downloads, and recent-render history;
- one same-origin FastAPI application—no public CORS or remote upload path.

The `main` branch contains the accepted V1 Action/Ghost
foundation: a project-scoped append-only Action ledger and reload projection,
server-managed vocal preview assets, a visible human Ghost audition/Commit/Undo
workflow, an injected Web Audio phrase scheduler, and the accepted Phase 12
live committed-layer engine. One committed layer can play alongside the Lead.
Producer access, live warping, and multiple committed layers remain deferred.

## CLI

The underlying engine remains fully scriptable:

```bash
# Analyze tempo and key
.venv/bin/twobecomeone analyze track_a.mp3 track_b.mp3

# Import a local file or permitted YouTube source into the Studio library
.venv/bin/twobecomeone import track_a.flac
.venv/bin/twobecomeone import 'https://youtu.be/VIDEO_ID'

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

YouTube imports use `yt-dlp`, fetch one video only, extract a high-quality MP3,
and then pass through the same managed ingestion and analysis path as uploads.
Public-index torrent search remains an experimental CLI-only helper.

## Architecture

```text
browser (same origin)
        │
        ▼
FastAPI routes ──► StudioService ──► SQLite project/job state
                         │
                         ├── analyzer + beat-grid suggestion
                         ├── single-worker Demucs queue (CUDA → CPU fallback)
                         ├── V1 Action ledger + projection snapshot
                         ├── managed ephemeral Ghost assets
                         └── ffmpeg align/mix/loudness pipeline
```

The CLI and web app call the service/audio modules directly; neither wraps or
scrapes the other's output. A single render worker prevents concurrent jobs
from competing for laptop GPU memory. Uploaded names are never used as storage
paths, supported audio suffixes are allow-listed, and uploads have a 750 MB
local ceiling.

## Development

```bash
uv sync --frozen --extra web --extra dev --extra demucs
.venv/bin/pytest -q          # Python unit + service + HTTP tests
npm ci && npm test           # frontend unit tests (jsdom)
npm run test:browser          # browser E2E + accessibility (system Chromium)
npm run test:ghost-browser    # headless V1 API → asset → Web Audio proof
node tests/browser/ultimate_deck_ux.js  # DJ/FUN desktop + mobile proof
```

The test suite covers DSP invariants, invalid media, JSON contracts, truthful
center/side output, Demucs caching and CUDA selection, OOM fallback behavior,
region timing, true-peak checks, safe ingestion, persistent jobs, the full
HTTP upload-to-render vertical slice, and browser-level primary journeys with
an accessibility audit.

The browser tier (`tests/browser/run.js`) drives the real Studio in system
Chromium via `playwright-core` (which never downloads a browser) against a
temporary data root with only the external network/GPU boundaries stubbed. CI
runs it as a distinct `browser-e2e` job.

## Backup and recovery

Project data lives under `~/.local/share/2become1/` (SQLite database plus
`tracks/`, `stems/`, `renders/`, `artwork/`, and `waveforms/`). Back up that
directory to preserve your library and projects. On restart, jobs left
queued/running by a previous process are marked `interrupted` and can be
retried or resumed from the Activity view.

## Current boundaries

- Beat/downbeat positions are suggestions, not phrase or chorus detection.
- The ffmpeg fallback is a center/side transform, not vocal isolation.
- Vercel can host a static demonstration, but real ffmpeg/Torch processing
  belongs on this local backend or a dedicated GPU service.
- YouTube importing requires `yt-dlp` on `PATH` and does not bypass access controls;
  use media you own or have permission to download and remix.
- Torrent acquisition is not part of the launch UI.
- Human Ghost drag/tether/audition, durable Commit and append-only Undo are
  visible. Producer access and live committed-layer playback remain deferred.
- FUN pads use the existing single local audition player. Their 1/2/4/8,
  blend, and arrangement controls update the saved render plan; multi-source
  live mixing, loops, stutter, and reverse require a future engine boundary.

## License

MIT—see [LICENSE](LICENSE).

## Processing limits and safeguards

- Uploads are limited to 750 MiB per audio file, with an additional 1 MiB
  allowance for HTTP multipart overhead. Actual streamed bytes are checked
  before they reach the multipart parser, even without Content-Length. Other
  request bodies are limited to 1 MiB.
- Audio inputs longer than 30 minutes are rejected explicitly; import a
  shorter region. Decoding uses temporary disk storage before loading the
  bounded signal. Spectral analysis processes every frame in small blocks.
- Decoding has a three-minute deadline; ffmpeg alignment, mixing, measurement,
  and center/side stages each have a ten-minute deadline. Demucs cancellation
  remains cooperative between safe stages.
- At most 32 jobs may be running or waiting in one Studio process. A full
  queue returns a retryable `queue_full` error without creating another job.
- Loopback hosts are allowed by default. Additional hosts require explicit
  configuration; cross-origin browser mutations are refused.
- Pitch matching preserves major/minor mode. Matching tonics does not guarantee
  harmonic compatibility; the plan warns when the source modes differ.

Release CI installs from `uv.lock` with `--frozen`. Dependency updates should
be made deliberately with a refreshed lockfile and the complete CI gates.

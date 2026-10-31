# 2become1

## What it does

2become1 is a local-first mashup studio for combining two tracks without
uploading them to a third-party service. It analyzes tempo and key, suggests a
beat-grid starting point, can separate stems, aligns both sources to an output
BPM, and renders a loudness-managed mix. The project has two front ends over the
same engine: a FastAPI web Studio for drag-and-drop mixing, library management,
previews, and renders, and a CLI for analysis, import, separation, and scripted
mashups. Both store state in SQLite and keep media in a managed local directory.

The name is a deliberately cheesy nod to the Spice Girls. The engine is general
purpose: bring audio you own or have permission to remix.

## Development status

Active. Development ran from August to September 2026 (roughly 100 commits),
with a docs commit in October 2026. Version 0.3.0 is declared in `pyproject.toml`,
but no Git tag or GitHub release exists; treat it as a source version.

## What demonstrably works

- The Studio serves one same-origin app on loopback, with SQLite-backed
  projects, jobs, and a local media library.
- Two decks accept drag-and-drop audio or a single YouTube URL; the library keeps
  source provenance and supports previews, renders with progress, downloads, and
  history.
- Analysis reports BPM, key, and duration, with first-beat/downbeat suggestions
  that can be corrected by hand.
- Mix settings include an explicit output BPM, overlay and A-to-B transition
  modes, and per-deck gain, pan, and 3-band EQ.
- Optional Demucs separation uses CUDA with CPU fallback. The ffmpeg method
  provides an honest center/side split, not isolated vocals.
- A short vocal phrase layer can be auditioned, committed, and undone; one
  committed layer can play alongside the Lead.
- The CLI can analyze, import, separate, and render a region-aware mash, or
  print the plan without writing files.
- Upload names are never used as storage paths, audio suffixes are allow-listed,
  and the Studio binds to loopback unless network access is explicitly enabled.

## Experimental, incomplete, or planned

- Deck audition is singleton: starting Lead B stops Foundation A, and the saved
  blend is not a live crossfader; three-bus live mixing is planned, not shipped.
- The proposed stem stack (four separated loops as one committed layer) is only
  a prototype at `design/stem_crate_fun_mock.html`; it persists and renders nothing.
- Producer access, live warping, and multiple committed layers remain deferred.
- FUN pads update the saved render plan. Multi-source live mixing, loops,
  stutter, and reverse need a future engine boundary.
- Beat and downbeat positions are suggestions, not phrase or chorus detection.
- Torrent search is an experimental CLI-only helper and is not in the Studio UI.

## Install, run, inspect

Requirements: Python 3.11+, `uv`, and `ffmpeg`/`ffprobe` on `PATH` (`sudo pacman
-S ffmpeg` on Arch-based systems).

```bash
uv venv .venv
uv sync --frozen --extra web --extra demucs
.venv/bin/twobecomeone web
```

Open <http://127.0.0.1:8765>. Omit `--extra demucs` if you do not need stem
separation. Project data lives under `~/.local/share/2become1/` (SQLite plus
`tracks/`, `stems/`, `renders/`, `artwork/`, and `waveforms/`); back it up.

Binding to a non-loopback address requires `--host 0.0.0.0 --allow-network` plus
an exact `--trusted-host <hostname>`. It stays unauthenticated; only enable it on
a network you trust.

CLI examples:

```bash
.venv/bin/twobecomeone analyze track_a.mp3 track_b.mp3
.venv/bin/twobecomeone separate track.mp3 -o stems/ --method demucs
.venv/bin/twobecomeone mash anchor.mp3 lead.mp3 --anchor-start 32.4 \
  --lead-start 18.1 --duration 30 -o out.mp3
```

`import` and `analyze --json` are also available. There is no hosted demo: the
homepage demo URL returns 404, and mixing requires the local ffmpeg/Torch
backend, so a static host could only show the interface.

## Tests and build evidence

Observed: CI passed on its last six runs across two jobs. `test` runs the Python
suite, the JavaScript unit suite, and a wheel/sdist build check; `browser-e2e`
drives the Studio in Chromium at desktop and mobile sizes. The checkout has 108
files under `tests/`; CI builds and verifies both a wheel and an sdist.

The changelog claims 427 Python tests (1 skipped) and 30/30 inherited browser
acceptance; those figures were not re-run for this README.

```bash
.venv/bin/pytest -q
npm ci && npm test
npm run test:browser    # needs system Chromium
```

## Limitations and dependencies

- Hard dependencies: Python 3.11+, NumPy, SciPy, and ffmpeg/ffprobe. The web
  extra adds FastAPI, uvicorn, and python-multipart. Demucs and Torch are optional
  and large; a single render worker keeps jobs from competing for GPU memory.
- YouTube import requires `yt-dlp` on `PATH`, but `yt-dlp` is **not declared** in
  `pyproject.toml`. This is a known packaging gap; without a separate install,
  YouTube import fails.
- Tempo/key detection and grid placement are estimates. Pitch matching preserves
  major/minor mode, but matching tonics does not guarantee harmonic
  compatibility; the plan warns when source modes differ.
- Guardrails: 750 MiB per upload, 30-minute audio limit, bounded process
  deadlines, and at most 32 queued or running jobs per process.
- Network mode is opt-in and unauthenticated. The default is loopback only, with
  no accounts, cloud sync, or remote upload path.

## Licence

MIT. See [LICENSE](LICENSE).

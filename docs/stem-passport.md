# Stem Passport — bring your own separated stems (2026-11-18)

Owner workstream: attach four stems separated elsewhere (another DAW) to a
library track and play them on the existing eight-lane desk, without a second
Library, mixer or provenance system.

## What the owner does

1. Choose a track in group A or B.
2. Press **Import My Stems**.
3. Pick four WAV files and, by position, name them Vocals, Drums, Bass, Other.
4. Press **Import four stems**, then **Load A/B**.

The dialog states the responsibility plainly: the four files must come from one
timeline with the same start point, and equal length is not proof of alignment.

## Contract

| Concern | Rule |
| --- | --- |
| Roles | exactly `vocals`, `drums`, `bass`, `other`; never inferred from a filename |
| Format | WAV only, checked by the **container** (RIFF/WAVE), not just the suffix; no transcoding, resampling or time-stretch |
| Agreement | one sample rate, one channel count (1 or 2), durations within **10 ms** |
| Size | staged like any upload (750 MB); the per-lane ceiling is checked at the **playback** rate (48 kHz), the stricter case, so import cannot publish a set the desk would refuse |
| Publish | four files written under `stems/<set>/<role>.wav`, directory rename is the atomic commit |
| Failure | no partial set becomes ready; a database failure removes the published directory; staged inputs are removed (the commit route, or the dialog's discard call when staging itself fails); the same staged file cannot fill two roles; a cache row whose media vanished is repaired by the next import |
| Provenance | `method="imported"`, `device="user"`, `model_name = sha256:<set hash>`, per-lane original name + SHA-256; the existing Stem dialog no longer appends "(Demucs)" to a role |
| Decode rate | the desk asks for a 48 kHz context and reports unavailable audio rather than silently accepting an unpredictable rate; repair is atomic per lane |
| Reprocessing | never starts a separation job, FFmpeg separation or model call |
| Desk | a complete imported quad is ready; imported sets are shown ahead of separation output for the same lane; Add / Process does not request Demucs while a complete quad exists; **one group is always built from one set**, never from two, while center/sides variants stay visible to the existing Stem dialog |

## Implementation

- `src/twobecomeone/migrations.py` — migration 13 adds `stem_sets.provenance_json`.
- `src/twobecomeone/studio.py` — `import_stem_set()` and `_probe_stem_audio()`;
  `list_stems()` exposes `set_hash`, `original_name`, `source_sha256` and the
  per-set provenance for imported variants.
- `src/twobecomeone/webapp.py` — `POST /api/stems/stage` and
  `POST /api/tracks/{id}/stem-import`.
- `src/twobecomeone/http_safety.py` — the staging route joins the media-sized
  body allowlist; every other route keeps the 1 MiB JSON guard.
- `src/twobecomeone/studio_static/js/api.js` — `stageStemFile`, `importStemSet`.
- `.../components/stem-desk-panel.js` — Import My Stems dialog plus readiness
  for imported quads (the readiness change was authored by Q in the governed
  workshop and independently re-verified).

## Evidence

| Gate | Result |
| --- | --- |
| Frontend suite | **546/546** |
| Python suite | **606 passed, 1 skipped** |
| Import unit + route tests | **26/26** (roles, format, decode, rate/channels, duration, traversal, cache hit, retry, no job, HTTP stage+commit, staged cleanup) |
| Eight-lane PCM with imported A + Demucs B | **9/9** |
| Browser import journey | **15/15** |
| Desktop / mobile journeys | 39/0 · 39/5 (same five historical a11y findings) |
| Existing desk gates | two-track UI **24/24**, two-track PCM **8/8**, single-desk UX pass |
| Static assets | 734,810 bytes / 69 files, +83,905 (+12.89%); 15% trigger not crossed |

PCM detail from the imported/Demucs render: eight lanes start together, mix RMS
0.169 with peak 0.617 (inside full scale), soloing an imported lane leaves a real
signal, no imported lane is silent, and playback ends in silence at `ready`.

## Limits stated at delivery

- **WAV only.** Stems from a DAW are normally WAV; other formats need an export,
  which keeps the desk from being handed bytes that contradict their name.
- **10 ms duration tolerance.** It catches a wrong export, not a musical
  misalignment. The owner remains responsible for aligned files.
- **One set per lane in the desk view.** When a track holds both an imported and
  a separated set, the imported set is shown (deterministic); the other files
  stay on disk.
- **No audible acceptance is claimed.** The PCM and browser gates prove the
  graph and the workflow; the PM must listen.

## Demonstration

`tests/browser/stem_passport_seed.py --data-dir <dir> [--demucs]` prepares a
temporary library: track A with an imported set, track B with a separation set
(`--demucs` uses the real separator), and track C with no stems for the import
journey. Nothing touches the production data directory.

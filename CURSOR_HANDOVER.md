# 2BECOME1 — Cursor terminal handover

Prepared for Richard Noon on 2026-09-06. Repository: https://github.com/888noonie/2become1.

## Current state (2026-09-07) — read this first

This section supersedes the older "Start here" below for the next session.

- **main tip:** `f50dac1` — Phase 14A (FUN stem-crate interaction prototype) merged.
- **Phase 14A is COMPLETE and ACCEPTED.** Artifact `design/stem_crate_fun_mock.html`,
  17 jsdom contract tests at `tests/frontend/design/stem-crate-fun-mock.test.js`,
  decision record `PHASE_14_STEM_CRATE_DECISION.md`, audits
  `PHASE_14A_STEM_CRATE_AUDIT.md` / `PHASE_14A_STEM_CRATE_REAUDIT.md`.
- **Stem-stack architecture APPROVED:** up to four stem loops → one prepared
  composite asset → one committed layer. Naming: "WaxDrop" is Loopit-mock-only;
  the feature lives in the existing FUN tab.
- **Next authorized work (awaiting Richard's go):** Phase 14B (persistent stem
  crate + loop specs), then Phase 15A–B (simultaneous DJ decks + live crossfader),
  then Phase 14C/15C convergence. See the tracked plans:
  - `PHASE_14_STEM_CRATE_TRI_PHASE_PLAN.md`
  - `PHASE_15_THREE_BUS_LIVE_MIXER_TRI_PHASE_PLAN.md`
- **Key audio truth:** the current `AudioController` owns ONE audio element and
  stops deck A when deck B starts (pinned by `tests/frontend/audio.test.js:11`).
  Simultaneous A + B + stem-stack audibility is NOT yet met — that is Phase 15.
  Do not wire Phase 14C to the singleton player and claim the requirement is met.
- **Phase 13 (listener-truth closure)** remains open: loopback (Class C) and
  acceptance tolerances are still pending; see
  `.hermes/plans/2026-09-07_000314-phase13-listener-truth-closure.md`.

## Start here

The audio-correctness and hardening work is complete and merged into `main` through [PR #1](https://github.com/888noonie/2become1/pull/1). Merge commit: `d9f8f85f811db0036199ae276795670e0362b790`. Tested PR head: `8481fd9e395213df6bb48ef4de5f28f6913e5129`.

Both `test` and `browser-e2e` passed in [CI run 33997257153](https://github.com/888noonie/2become1/actions/runs/33997257153). Browser evidence includes Studio, Ghost Commit, and live-layer journeys at 1280×800 and 390×844. Python, frontend, package build, and archive checks passed. The PR records 458 local Python passes with six skips, plus separately passing final request/cleanup tests, and 328 frontend passes. Those counts describe the recorded local run, not a newly counted CI total. GPU separation and physical listening were not verified here.

The earlier main tip remains backed up on `archive/main-before-phase12-2026-09-05` (`3fd7a5a`). Richard clarified that “protected” meant backed up. GitHub branch protection was not configured; administration access was unavailable. Do not revisit that as an unfinished requirement.

This handover is the current maintenance checkpoint. Read `CODEX.md` for architectural constraints and historical evidence, but its active-fixes paragraph predates this merge. Phase 11 Commit/Undo/render parity and Phase 12 live committed-layer playback are accepted. Older statements in `docs/V1_GHOST_ARCHITECTURE.md` that these are unimplemented are historical, not current status. Producer remains future work. The old `v0.3.0` tag is a historical release, not the current main tip.

## Resume safely in Cursor

Inspect the checkout before changing branches:

```bash
pwd
git status --short --branch
git remote -v
git fetch origin
git log -5 --oneline origin/main
```

Preserve uncommitted work. With a clean checkout, switch to main and update using `git pull --ff-only origin main`, then create a fresh branch for the chosen slice. If local history diverges, inspect it instead of resetting or force-pushing. The previous execution environment had locally authored commits with different IDs from their GitHub integration equivalents; do not cherry-pick duplicates simply because their hashes differ.

The documented machine paths are `/home/richardn/2become1` and `/home/richardn/.local/share/2become1`; confirm them locally. Never replace, purge, or recreate Richard's persistent data to make tests pass. Use isolated fixture data for automated tests. Do not run an unnecessary dependency sync over a working GPU environment: inspect installed optional extras first and preserve the needed Demucs setup.

For a clean test environment, follow `.github/workflows/test.yml`:

```bash
uv sync --frozen --extra web --extra dev
.venv/bin/pytest -q
npm ci
npm test
uv build --wheel --sdist
.venv/bin/python tests/verify_release_artifacts.py
git diff --check
```

Run the workflow's desktop/mobile browser commands for changes affecting playback, requests, or UI. Use actual installed Chromium or the workflow's pinned installation. Report skipped optional tests explicitly. Keep frontend static assets below the existing 500,000-byte ceiling. Do not bump versions or create release tags as a side effect of maintenance.

## What just shipped

| Area | Delivered behavior | Main code/tests |
| --- | --- | --- |
| Pitch correctness | Resample to the working rate before pitch manipulation; regression measurements cover pitch and duration across source rates. | `assembler.py`, `tests/test_audio_regressions.py` |
| Key normalization | Accepted enharmonic/flat spellings normalize correctly; malformed keys become user errors; mode mismatch gets a warning. | `assembler.py`, audio regressions |
| HTTP admission | Exact trusted hosts, mutation-origin checks, actual streamed-byte limits before multipart parsing, cleanup when an upload cannot enter the queue. | `http_safety.py`, `webapp.py`, `tests/test_request_safety.py` |
| Resource bounds | 32 pending/running jobs per Studio process; 30-minute decoded-audio ceiling; temporary-file decoding; spectral processing in blocks retaining every frame. | `jobs.py`, `analyzer.py`, `beatgrid.py`, `tests/test_resource_limits.py` |
| Process deadlines | Three-minute decode deadline; ten-minute deadlines for covered ffmpeg alignment, mixing, measurement, and center/side stages. | `common.py`, `assembler.py`, `separator.py` |
| Reproducibility | Frozen lockfile installation in CI and updated installation/status documentation. | `.github/workflows/test.yml`, `README.md`, `CODEX.md` |

Python source paths in the table are under `src/twobecomeone/`. Uploads retain the 750 MiB file ceiling plus 1 MiB multipart overhead; other request bodies have a 1 MiB ceiling. Queue refusal returns `queue_full`. Network mode remains explicitly enabled and unauthenticated. These guards are not session authentication or a public-hosting security boundary.

## Next improvements, in priority order

### 1. Prove what reaches the listener

Build the repeatable listening/timing benchmark recommended in this review. This is the strongest next musical investment before a larger engine change.

Use generated rhythmic transients and tones plus licensed or owner-provided sustained vocals and stereo material. Cover 22.05, 44.1, and 48 kHz inputs, nonzero pitch shifts, representative tempo ratios, phrase-boundary launches, nonzero cues, and longer playback under browser load. Exercise stop, seek, project switching, Release, Commit, Undo, reload, missing assets, and audio-device/context interruption.

Keep three evidence classes distinct: offline rendered samples, browser scheduling/routing events, and actual loopback/device recordings. Compare expected versus observed onset offset and drift, report distributions and worst cases, detect dropouts/clipping, and record browser, OS, device, sample rate, and buffer settings. Agree useful timing tolerances before claiming acceptance. Save reproducible fixtures/scripts and a short evidence report; avoid committing private music.

Phase 12 re-resolves each phrase against the media clock. HTML media and Web Audio clocks are not sample-identical. Existing tests prove scheduling and lifecycle behavior; they do not establish sample-accurate speaker output. Let measured problems determine whether clock changes or live warping are justified.

### 2. Finish the remaining security and resource work

The original review proposed a local session token; it was not implemented in PR #1. Design a token/bootstrap mechanism that also works for media range requests, downloads, and SSE without exposing secrets in logs or URLs. Keep same-origin guards. Treat authenticated network access as a separate feature with explicit threat assumptions and tests, not something `--trusted-host` supplies.

The current caps bound individual work but are not a complete resource budget. Profile peak RAM and temporary-disk use on long compressed inputs and concurrent admissions. Consider aggregate upload/staging limits, cleanup after disconnects, configurable resource envelopes, and admission before expensive staging where practical. Preserve explicit rejection rather than silently truncating audio. Audit subprocess coverage and recovery after timeouts; do not describe cooperative Demucs cancellation as a hard deadline.

Add meaningful adversarial tests for whichever gap is selected: streamed JSON and multipart bodies, malformed/duplicate headers, disconnected clients, full queues, timeout cleanup, and concurrent admission. Introduce broader chunked analysis only if measurement demonstrates remaining pressure, with parity against the existing result.

### 3. Make harmony decisions more useful

The flat-key crash is fixed; harmonic matching policy is intentionally unchanged. A tonic shift preserves mode: D minor shifted to C remains C minor, not C major. Inspect the existing server-authored plan and Preserve Lead pitch control before adding UI. Make the exact proposed shift and warning easy to understand, then consider an explicit semitone override and better compatible-key suggestions. Persist intent, keep detected/overridden/effective values distinct, and prove plan/preview/render parity. Do not silently reinterpret existing projects.

### 4. Keep installations and documentation trustworthy

Frozen CI is implemented. A separate intentional dependency-update lane and explicit optional Demucs/GPU validation remain useful follow-ups. Validate the user's actual CUDA environment before changing its dependencies; report unavailable hardware honestly.

Consolidate current status across `CODEX.md`, `docs/V1_GHOST_ARCHITECTURE.md`, and phase evidence while retaining historical records. Distinguish current main, accepted phase milestones, and release tags. This handover records the authoritative checkpoint until that editorial cleanup is done.

## The route toward the larger instrument

Richard's direction is a personal, local-first browser producer/DJ with a reliable human musical workflow, then AI assistance through the same controls. The wider design is preserved in `docs/V1_GHOST_ARCHITECTURE.md`; consult the Phase 11 and Phase 12 plans/evidence for what has already shipped.

The central vertical slice is borrowing a vocal phrase from A onto B, auditioning a Ghost, then committing exactly what was heard. That workflow now has durable human Commit, append-only Undo, render inclusion, and one live committed layer. Do not rebuild it from the older blueprint.

For a future Producer slice, begin with a sandboxed suggestion that proposes the existing validated `preview_layer` Action. Keep human acceptance explicit. Test denied actors, malformed proposals, stale revisions, repeated requests, cancellation, and exact accepted provenance. Producer gets no privileged engine, file, database, or session mutation path. Voice/text can later express the same intent; neither is a reason to bypass the Action contract.

Multiple layers, independent live decks, live warping, arbitrary layer editing, redo, automatic separation, MIDI, collaboration/battle, and more elaborate performance effects are future phases, not delivered capabilities. Choose one bounded outcome at a time. These ideas are preserved as roadmap context; this merge request did not approve implementing all of them at once. Follow Richard's current instructions when he starts the next session and reconcile them with the existing phase workflow rather than asking him to re-authorize completed work.

## Invariants to preserve

- SQLite is durable musical truth; the Action ledger is append-only, with idempotency and provenance intact.
- Managed, verified assets and their accepted transform/grid facts define committed content. Missing or corrupt assets must never silently become another source.
- Preview, Commit, reload, live playback, Undo, and export must agree on the accepted musical object.
- StateStore remains serializable; AudioNodes, decoded buffers, timers, clocks, and abort controllers belong to disposable runtime controllers.
- Preserve the single active HTML audition player and accepted one-Ghost/one-committed-layer policy until a deliberate engine phase changes them.
- Maintain explicit source-time/output-time mapping and server-authored planning; avoid duplicate frontend pitch/tempo mathematics.
- Preserve accessible non-drag actions, keyboard flow, focus handling, reduced motion, and usable mobile targets.
- Keep the framework-free frontend, local-first operation, and truthful UI. Avoid paid services, cloud accounts, or speculative infrastructure without a concrete product need.

Suggested first Cursor task: inspect this merged checkpoint, set up an isolated benchmark branch, and produce a small executable audio/timing baseline with an evidence report. Use those measurements to propose the next implementation slice. Richard welcomes reasoned pushback and practical progress; keep explanations clear and distinguish measured results from ambitions.

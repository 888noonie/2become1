# Phase 12 — Live Committed-Layer Engine (tri-phase plan)

**Author:** Hermes, on Richard's direction (a / fixed / CI-hard / keep-500k)
**Date:** 2026-08-29
**Status:** AWAITING RICHARD'S APPROVAL — no implementation authorized until approved.
**Predecessor:** Phase 11 Solid Ghost, accepted by CI 33276217128 (`c04f35d`), continuity in `CODEX.md`.

---

## 0. Scope decision (Richard's choices this session)

| Question | Decision |
|---|---|
| Primary boundary | **(a) Live-layer engine** — committed Ghosts become audible during the session, not only "included in the next preview/render" |
| Musical policy | **Fixed** — 4/4, 8-bar phrases, **one active Ghost**, one active proposal, one committed layer. No expansion in 12. |
| Acceptance gate | **CI-hard** — a phase is "complete" only when the pushed checkpoint is CI-green (test + browser-e2e desktop/mobile). |
| Static budget | **Keep 500,000 bytes** — 450,008 used after the Ultimate Deck checkpoint (`b460591`); the engine must fit in ~50,000 new bytes. |

This plan intentionally **does not** authorize (per CODEX.md's standing deferrals):
redo, Producer access, live warping, automatic separation, arbitrary layer
editing, multi-layer mixing, variable phrase lengths, or a rewrite of the
single active HTML audio player.

---

## 1. Goal

A committed Ghost layer plays **audibly during the live session**, looped on
phrase boundaries in sync with the playing Foundation (the single active
HTMLAudioElement), with its auditioned gain applied, appearing and vanishing
as it is committed and undone. The promise line on the committed-layer list
changes from *"Included in the next preview/render"* to truthful live-playback
copy, with an honest idle/fallback state when no Foundation is playing.

**Primary acceptance outcome:** after Commit, while the Foundation track is
audibly playing, the committed Ghost renders audibly on the next phrase
boundary and keeps looping; Undo stops it before the next phrase. This closes
Phase 11's acknowledged limitation #4 ("Commit does not add a persistent
live-layer engine").

---

## 2. Current context / assumptions (verified in code)

- **Single Foundation player:** `src/.../js/audio.js` `AudioController` owns one
  `HTMLAudioElement`. `get current()`, `playing`, `time()` are the media clock.
- **Web Audio Ghost bridge already exists:** `runtime/ghost-scheduler.js`
  `GhostScheduler` fetches/decode-schedules ONE proposal at a phrase boundary
  using `resolveNextPhrase` (`transport/derive.js`), `MIN_LEAD_SECONDS`,
  `onended` cleanup, abort/cancel. The **live engine generalizes this into a
  persistent looping scheduler**, it does not replace the Foundation player.
- **Clock bridging:** `runtime/transport-bridge.js` `buildDeckTransport()` maps
  `elementSeconds` (HTML audio) + `audioClockNow` (AudioContext) → Deck B
  transport. The engine reuses this to place phrase boundaries on the shared
  clock.
- **Committed layer data (no schema change):** the durable projection gives
  `committedLayers[]` with `acceptedAsset.{id,contentHash,transformSpec}` +
  `launchReceipt.{targetBpm, launchBeat, destinationOriginSeconds,
  destinationGridRevision}` + `placement{gainDb, source, timing}`. Gain is
  **not** baked into the pinned wav; it is applied at render, so live playback
  applies `gainDb` via a `GainNode`.
- **Asset serving:** pinned asset wav is served at
  `GET /api/ghost-assets/{asset_id}/audio` (opaque ID only; registered/pinned
  assets are served — verify this holds for *committed* assets during 12A).
- **The asset is already tempo-normalized** to the destination tempo
  (`_resolve_committed_layer` docstring). For live playback we **do not**
  tempo-stretch or pitch-shift; we start the asset at the destination launch
  beat and let it ring over the phrase the way the render places it.
- **Commit/Revert lifecycle already exists** and appends to the projection
  (`ghost-controller.js` `commit()`/`revert()`); the engine hooks these to
  add/remove the live layer.

### Audit corrections (GLM relay audit, 2026-08-29 — verified in code)

- **CLOSED (no server change):** the plan originally anticipated a possible
  `webapp.py` pin-check for committed assets. Verified: `asset_path()`
  (`ghost_assets.py:490`) applies the expiry check only when `pinned` is
  false, and the commit branch pins the asset (`action_store.py:599`,
  `"pinned": True`). `GET /api/ghost-assets/{id}/audio` therefore already
  serves committed assets. Phase 12A touches no server code.
- **NEW HARD-LINE (single committed layer must be enforced, it is not):** the
  backend appends to `committedLayers` without any cap
  (`action_store.py:604`); the existing "one active Ghost" rule only governs
  one active *proposal* (a committed proposal is terminal, so a second
  preview→commit cycle today yields two committed layers). The live engine is
  designed as a single loop under fixed musical policy, so Phase 12 adds an
  explicit gate: the `commit_layer` branch rejects a live commit when
  `committedLayers` is already non-empty, with a stable conflict code
  (e.g. `L_LAYER_LIMIT`, mirroring `L_ALREADY_REVERTED` naming); rebuild
  replay of a legacy two-layer ledger stays tolerated (append-only history is
  never rewritten — the cap is a live-action gate, not a projection rule).
  Frontend parity: permission/dispatcher tests, the Ghost card's preview
  entry point disables with truthful copy when a committed layer exists, and
  a browser journey check. Multi-layer remains an explicit future phase.
- **Wording fix:** "one active Ghost" (one active proposal, pre-existing) and
  "one committed layer" (the new Phase 12 gate) are distinct invariants; the
  engine assumes the latter and this phase makes it true rather than assumed.

---

## 3. Proposed approach

A new leaf module `runtime/committed-layer-engine.js` owned by `GhostController`
(which already owns all runtime machinery; StateStore stays serializable-only).
It reuses the existing transport/derive/scheduler primitives:

- **Scheduler:** on each phrase boundary, while the Foundation is audibly
  playing and grid parity holds, fetch+decode the committed asset once (cache
  the `AudioBuffer`), then `source.start()` a fresh `AudioBufferSourceNode` at
  the destination launch beat (repeated per phrase = looping). Gain applied via
  a persistent `GainNode`. Cancellable + stale-safe like `GhostScheduler`.
- **Looping / positioning:** the committed layer's launch beat is absolute in
  the destination grid (`launchReceipt.launchBeat`). Live placement maps that to
  media-clock time via the same phrase math `resolveNextPhrase` uses. Playback
  repeats each phrase (the layer is a phrase-length slice that sits at its
  launch beat within the phrase).
- **Truthfulness:** engine exposes an immutable schedule snapshot (asset hash,
  grid revision, resolved beats, next launch audio time) — proof of scheduling
  intent, never a physical-speaker/sample-accuracy claim (matches Phase 9C
  design rules). UI shows *"Playing live on the next phrase"* only when the
  engine is actively scheduling; otherwise an honest *"Ready when the
  Foundation is playing"* idle state.
- **Lifecycle:** `commit()` → engine.add(layer); `revert()` → engine.remove(id);
  project switch / pause / stop / reload → engine teardown (no autoplay,
  matching A8). One active committed layer only (fixed policy).

**Design hard-lines (carried forward):**
- No DOM in the engine; nothing on `window`; no runtime object in StateStore.
- No second visible player: the Foundation stays the single HTMLAudioElement.
- No sample-accuracy claim; launch receipt + resolved beat are deterministic
  render/schedule authority.

---

## 4. Step-by-step plan (TDD, bite-sized, frequent commits)

### Phase 12A — Engine core (pure + Web Audio scheduling)

**12A.1** `runtime/committed-layer-engine.js` — skeleton class:
constructor deps (`{ audioContext, loadAsset, transportProvider, resolvePlacement, onStateChange }`), `add(layer)`, `remove(commitActionId)`, `shutdown()`, `snapshot()`. No StateStore import.

**12A.2** Pure helper `resolveLivePlacement(layer, transport, nowAudioTime)` in
`transport/derive.js` (or a new `transport/live.js`): given a committed layer's
`launchReceipt` + `placement` and the Deck B transport, return the destination
`launchAudioTime` beat-aligned to the phrase grid (epsilon-stable like
`resolveNextPhrase`), the phrase length, and the gain linear. **Pure, fully unit-testable** (ratio/on-boundary/clip cases).

**12A.3** TDD the pure helper first (failing tests → implement → green): fixture
covering phrase-on-boundary, mid-phrase, MIN_LEAD re-resolution, layer longer
than a phrase (head clip), tempo ratio variance, gain linear from gainDb.

**12A.4** In the engine, loop scheduling: on each boundary a fresh
`AudioBufferSourceNode` from the cached decoded buffer, `GainNode` (persistent)
set to gainLinear, `source.onended` cleanup, abort on stale. Schedule receipt
snapshot per loop.

**12A.5** Node tests fake an AudioContext (as `ghost-scheduler.test.js` does):
decode fake, `source.start` capture, loop repeats N phrases, cancel stops
future starts, shutdown clears, stale response never starts.

**12A.6** Wire `commit()`/`revert()` in `ghost-controller.js` to
`this._engine.add(...)` / `.remove(...)`. Unit tests assert add/remove call
ordering and engine teardown on project switch / stop / reload.

**Commit per 12A sub-task.** 12A gate: engine unit tests + existing 256-node + full pytest still green.

### Phase 12B — UI truthfulness + wiring

**12B.1** `components/committed-layers.js`: per-layer status badge.
States: `live` (engine actively looping), `idle` (committed but Foundation not
playing), `error`. Truthful copy: replace "Included in the next preview/render"
with the resolved live state; keep the render-inclusion line only as a
secondary, accurate note.

**12B.2** `state.js` narrow serializable slice `ghostLiveStatus` (subset per
committed layer: `live`/`idle`/`error`, next launch beat, no runtime objects —
mirrors Amendment 9 discipline). Controller maps engine snapshot → slice.

**12B.3** Studio view reads the slice; accessibility + `aria-live` on state
change; no overflow. `components.css` minimal additions (reuse existing
badge/status styles; budget-conscious).

**12B.4** New frontend tests `tests/frontend/ghost-live.test.js`:
controller add/remove, slice transitions, view renders live/idle/error,
undo-busy disables during live, aria-live present.

**12B.5** Extend/create browser journey `tests/browser/ghost_live_ux.js`
(8-ish checks): commit → layer shows live while Foundation plays (real
Web Audio in the harness), undo → stops before next phrase, pause Foundation →
idle, reload after commit → idle (no autoplay) then live when playing, both
1280×800 and 390×844, no console error / overflow.

**Commit per 12B sub-task.** 12B gate: node + pytest + new/updated browser
journey green locally.

### Phase 12C — Gates, evidence, CI-hard closure

**12C.1** Full local gates: `.venv/bin/pytest -q`, `npm test` (node --test),
browser journeys (new live UX + all inherited: ghost_commit_ux, ghost_ux,
ghost_scheduler, run.js) at both viewports, `find ... node --check` syntax,
`git diff --check`.

**12C.2** Static size check under 500,000; if the engine pushes it over, trim
(reuse existing styles/functions; no new dependency).

**12C.3** Write `PHASE_12_LIVE_LAYER_EVIDENCE.md`: every gate, the measured
phrase-boundary placement, the honest limitations (media vs Web Audio clock
independence, no multi-layer, no sample-accuracy, live engine is session-only
and does not add a render path).

**12C.4** Update `CODEX.md` (Phase 12 accepted + the live gap closed), bump
gate numbers. **Commit → push → CI-green is the acceptance bar.** Only green CI
closes Phase 12.

---

## 5. Files likely to change

- Create: `src/.../js/runtime/committed-layer-engine.js`
- Create (if new): `src/.../js/transport/live.js` (else extend `derive.js`)
- Create: `tests/frontend/ghost-live.test.js`, `tests/browser/ghost_live_ux.js`
- Modify: `runtime/ghost-controller.js`, `components/committed-layers.js`,
  `state.js` (+ slice), `views/studio.js`, `components.css` (minimal),
  `PHASE_11...EVIDENCE` no, → new `PHASE_12_LIVE_LAYER_EVIDENCE.md`, `CODEX.md`
- Possibly: `webapp.py` only if the committed-asset serve route needs a pin
  check (verify in 12A).

---

## 6. Tests / validation

- Pure resolver: parameterized phrase math tests (TDD, first).
- Engine: fake-AudioContext Node tests — loop, cancel, shutdown, stale, single-active.
- Controller: add/remove ordering, teardown boundaries (switch/pause/reload).
- View/slice: live/idle/error render + aria-live.
- Browser: real commit→live→undo journey, both viewports.
- Release: full pytest + full node + all browser journeys + syntax + diff-check.
- **CI-hard:** push and require green test + browser-e2e before declaring done.

---

## 7. Risks, tradeoffs, open questions

- **HTML-media vs Web Audio clock drift (known, accepted).** Media-clock phrase
  boundaries vs AudioContext `currentTime` are not sample-identical. The engine
  re-resolves placement each phrase against the live media clock (like A2's
  observer does), so drift is bounded per-phrase, never accumulated. This is the
  same accepted limitation Phase 11 retained; we do not claim sample accuracy.
- **Live engine is a *session* player, not a render path.** It adds audible
  playback only; the export/parity pipeline stays as Phase 11. This is explicit
  and intentional.
- **One active Ghost / one committed layer.** With fixed policy the engine keeps
  a single active loop; multi-layer is out of scope (a later phase).
- **Static budget is tight (~50k after the Ultimate Deck checkpoint).** Mitigation: reuse `GhostScheduler` internals
  where possible, no new deps, minimal CSS. If over, the plan forces a trim
  (12C.2) — budget is a hard constraint, not a hint.
- **Autoplay policy.** The engine only schedules while the Foundation is already
  audibly playing (user-gesture-derived context), so no autoplay violation — but
  the browser journey must drive the same real gesture in CI.
- **Open question (verification in 12A):** does `GET /api/ghost-assets/{id}/audio`
  serve a *committed* (registered/pinned) asset, or only unregistered preview
  assets? If committed assets are not served, 12A adds the minimal route/pin
  check in `webapp.py` — that is the one server change this plan anticipates,
  and it is a read-only pin check, not a schema change.

---

## 8. Out of scope (explicitly NOT in Phase 12)

Redo; Producer/autonomous commits; live warping; automatic separation;
arbitrary layer editing; multiple simultaneous committed layers; variable
phrase lengths / non-4/4 grids; a DAW timeline; a second visible audio player;
sample-accuracy claims; altering the export/render parity path.

---

*Richard: approve by replying **"approve Phase 12"** (or adjust any scope line
first). On approval, implementation may begin, phase-by-phase, TDD with commit
per task, CI-hard acceptance.*

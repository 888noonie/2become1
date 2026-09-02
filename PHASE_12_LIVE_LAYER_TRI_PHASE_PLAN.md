# Phase 12 — Live Committed-Layer Engine (tri-phase plan)

**Author:** Hermes, on Richard's direction (a / fixed / CI-hard / keep-500k),
with Sol pre-implementation audit amendments
**Date:** 2026-08-29
**Status:** APPROVED BY RICHARD ON 2026-09-02 — authorized for Hermes
implementation under the branch, audit and merge protocol in section 8.
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
phrase boundaries in sync with the playing Lead (the single active
HTMLAudioElement), with its auditioned gain applied, appearing and vanishing
as it is committed and undone. The promise line on the committed-layer list
changes from *"Included in the next preview/render"* to truthful live-playback
copy, with an honest idle/fallback state when no Lead is playing.

**Primary acceptance outcome:** after Commit, while the Lead track is
audibly playing, the committed Ghost plays audibly on the next phrase
boundary and keeps looping; confirmed Undo stops it immediately. This closes
Phase 11's acknowledged limitation #4 ("Commit does not add a persistent
live-layer engine").

---

## 2. Current context / assumptions (verified in code)

- **Single authoritative player:** `src/.../js/audio.js` `AudioController` owns one
  `HTMLAudioElement`. `get current()`, `playing`, `time()` are the media clock.
- **Web Audio Ghost bridge already exists:** `runtime/ghost-scheduler.js`
  `GhostScheduler` fetches/decode-schedules ONE proposal at a phrase boundary
  using `resolveNextPhrase` (`transport/derive.js`), `MIN_LEAD_SECONDS`,
  `onended` cleanup, abort/cancel. The **live engine generalizes this into a
  persistent looping scheduler**, it does not replace the authoritative player.
- **Clock bridging:** `runtime/transport-bridge.js` `buildDeckTransport()` maps
  `elementSeconds` (HTML audio) + `audioClockNow` (AudioContext) → Deck B
  transport. The engine reuses this to place phrase boundaries on the shared
  clock.
- **Committed layer data (no schema change):** the durable projection gives
  `committedLayers[]` with `asset.{id,contentHash,transformSpec,pinned}` +
  `launchReceipt.{targetBpm, launchBeat, destinationOriginSeconds,
  destinationGridRevision}` + `placement{gainDb, source, timing}`. Gain is
  **not** baked into the pinned wav; it is applied at render, so live playback
  applies `gainDb` via a `GainNode`.
- **Asset serving:** pinned asset wav is served at
  `GET /api/ghost-assets/{asset_id}/audio` (opaque ID only; registered/pinned
  assets are served; the committed-path check is already closed below).
- **The asset is already tempo-normalized** to the destination tempo
  (`_resolve_committed_layer` docstring). For live playback we **do not**
  tempo-stretch or pitch-shift; we start the asset at the destination launch
  beat and let it ring over the phrase the way the render places it.
- **Commit/Revert lifecycle already exists** and appends to the projection
  (`ghost-controller.js` `commit()`/`revert()`). The engine reconciles their
  authoritative projection outcomes through the single `sync()` path.

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

- **Scheduler:** on each phrase boundary, while the Lead is audibly
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
  design rules). UI shows *"Scheduled for the next Lead phrase"* while a
  future source is armed, *"Playing live"* only after its boundary passes, and
  otherwise an honest *"Ready when the Lead is playing"* idle state.
- **Lifecycle:** authoritative projection hydration/reconciliation →
  `engine.sync(committedLayers)`; confirmed `revert()` → `engine.remove(id)`.
  Pause/stop/ended/seek/replacement suspends scheduled and sounding sources,
  while a later user-authored Lead play may reconcile and resume. Project
  switch and application shutdown hard-teardown the old runtime. Reload
  hydrates idle and never autoplays. One active committed layer only (fixed
  policy).

**Design hard-lines (carried forward):**
- No DOM in the engine; nothing on `window`; no runtime object in StateStore.
- No second visible player: the Foundation stays the single HTMLAudioElement.
- No sample-accuracy claim; launch receipt + resolved beat are deterministic
  render/schedule authority.

### Binding Sol pre-implementation amendments (2026-09-02)

1. **Lead is the clock authority.** Ghost source audio comes from Foundation,
   but every live ownership, play/pause, grid-parity and phrase-boundary check
   follows the destination Lead, exactly as `GhostController` does today.
2. **Authoritative sync, not optimistic add.** The engine may play only a
   server-projected committed layer. Commit, ambiguous outcome reconciliation,
   hydration/reload and Undo converge through one idempotent `sync()` path.
   A failed post-commit projection refresh is an honest idle/error state, never
   a client-invented live layer.
3. **Separate scheduled from live.** Public status is at least
   `idle|loading|scheduled|live|error`. `scheduled` means a future
   `AudioBufferSourceNode.start(when)` exists; `live` begins only when the
   launch boundary has actually passed while Lead ownership still holds.
4. **Transport changes suspend, not destroy.** Pause, stop, ended, seek and
   source replacement immediately cancel timers and sources. A subsequent
   user-authored Lead `play` event re-proves track/grid ownership and may
   schedule again. Only project switch/app shutdown destroys the engine.
5. **Legacy conflicts fail honestly.** Projection replay continues to tolerate
   historical multi-layer ledgers, but the single-layer live engine refuses to
   choose one silently and publishes a stable conflict/error state.
6. **Undo ordering is durable-first.** A layer keeps playing while Undo is
   merely pending. Once the server confirms or reconciliation proves the
   reversal, runtime cancellation is immediate; a failed Undo leaves playback
   and projection unchanged.
7. **No timer-drift claim.** Loop scheduling must use an injected,
   cancellation-safe look-ahead/wake mechanism and re-resolve against the live
   Lead media clock each phrase. Tests use fake timers/context. `setInterval`
   cadence or chaining from prior callback time is not acceptable authority.
8. **Browser proof must actually be CI-hard.** A new standalone script is not
   sufficient because `.github/workflows/test.yml` currently runs only
   `tests/browser/run.js`. Phase 12 must add the focused desktop/mobile live
   journey to the workflow (or integrate it into `run.js`) and upload its
   failure artifacts.
9. **Audibility wording stays bounded.** Automation can prove decoded asset,
   gain routing, scheduled source, boundary passage, cancellation and visible
   state. It cannot prove physical speaker output; evidence must say so.
10. **No premature acceptance.** Hermes delivers a CI-green feature branch and
    evidence, then stops. Sol independently audits the diff and runtime proof.
    Richard decides what merges. Only the post-merge `v0.3-workspace` CI run
    can mark Phase 12 accepted.

---

## 4. Step-by-step plan (TDD, bite-sized, frequent commits)

### Phase 12A — Engine core (pure + Web Audio scheduling)

**12A.0** Enforce the single committed-layer live-action gate before asset
verification/pinning: server `commit_layer` rejects a second live commit with
stable `L_LAYER_LIMIT`; replay still tolerates legacy history. Add the same
code/message to frontend Action errors and the pure dispatcher gate. Disable
new Preview entry with truthful copy while a committed layer exists. Pin
server, dispatcher, idempotent-retry, replay-with-legacy-two-layer and UI tests.

**12A.1** `runtime/committed-layer-engine.js` — skeleton class:
constructor deps (`{ audioContext, loadAsset, transportProvider,
resolvePlacement, setTimer, clearTimer, onStateChange }`),
`sync(committedLayers)`, `suspend(reason)`, `remove(commitActionId)`,
`shutdown()`, `snapshot()`. No StateStore import.

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

**12A.5** Node tests fake an AudioContext and timers (as
`ghost-scheduler.test.js` does): decode fake, `source.start` capture, loop
re-resolves for N phrases, pause/seek/replacement cancels current and future
starts, subsequent owned Lead play reschedules, shutdown clears, stale response
never starts, and a legacy multi-layer projection fails without choosing.

**12A.6** Wire `ghost-controller.js` through authoritative projection sync:
successful hydration/reconciliation calls `this._engine.sync(...)`; confirmed
Undo removes immediately; audio events suspend/reconcile; project switch and
app shutdown tear down. Unit tests assert durable-first ordering, failed-Undo
retention, commit-refresh failure truth, reload idle/no-autoplay, resume on a
later owned Lead play, and old-project stale-response rejection.

**Commit per 12A sub-task.** 12A gate: engine unit tests + existing 256-node + full pytest still green.

### Phase 12B — UI truthfulness + wiring

**12B.1** `components/committed-layers.js`: per-layer status badge.
States: `live` (a scheduled launch boundary has passed while Lead ownership
holds), `scheduled` (future boundary armed), `loading`, `idle` (committed but
Lead not playing), `error`. Truthful copy: replace "Included in the next preview/render"
with the resolved live state; keep the render-inclusion line only as a
secondary, accurate note.

**12B.2** `state.js` narrow serializable slice `ghostLiveStatus` (subset per
committed layer: `loading`/`scheduled`/`live`/`idle`/`error`, next launch beat,
no runtime objects — mirrors Amendment 9 discipline). Controller maps engine
snapshot → slice.

**12B.3** Studio view reads the slice; accessibility + `aria-live` on state
change; no overflow. `components.css` minimal additions (reuse existing
badge/status styles; budget-conscious).

**12B.4** New frontend tests `tests/frontend/ghost-live.test.js`:
controller sync/remove, slice transitions, view renders
loading/scheduled/live/idle/error,
undo-busy disables during live, aria-live present.

**12B.5** Extend/create browser journey `tests/browser/ghost_live_ux.js`
(8-ish checks): commit → layer shows scheduled then live while Lead plays
(real Web Audio scheduling in the harness), confirmed Undo → source stops
immediately, pause Lead → idle, reload after commit → idle (no autoplay) then live when playing, both
1280×800 and 390×844, no console error / overflow.

**Commit per 12B sub-task.** 12B gate: node + pytest + new/updated browser
journey green locally. Add that focused journey at both viewports to
`.github/workflows/test.yml` (or integrate it into the existing CI browser
harness) so this gate is exercised remotely, not merely documented.

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

**12C.4** Write a proposed `CODEX.md` update that says **candidate / awaiting
Sol audit**, not accepted. Hermes commits and pushes the feature branch and
waits for both required CI jobs to pass, then stops and hands Sol the baseline
SHA, head SHA, run URL, evidence file and any deviations.

**12C.5 — Sol-only acceptance gate.** Sol reviews the complete baseline..head
diff, re-runs focused math/runtime/backend tests, full Python/Node suites,
desktop/mobile browser journeys, static-size and release-artifact checks, and
visually inspects both viewports. Findings are fixed and re-audited before Sol
recommends a merge. Richard decides whether and what to merge. After that
decision, merge to `v0.3-workspace`, require green target-branch CI, then update
continuity/evidence from candidate to accepted.

---

## 5. Files likely to change

- Create: `src/.../js/runtime/committed-layer-engine.js`
- Create (if new): `src/.../js/transport/live.js` (else extend `derive.js`)
- Create: `tests/frontend/ghost-live.test.js`, `tests/browser/ghost_live_ux.js`
- Modify: `runtime/ghost-controller.js`, `components/committed-layers.js`,
  `state.js` (+ slice), `views/studio.js`, `components.css` (minimal),
  `actions/errors.js`, `actions/dispatcher.js`, `action_store.py`,
  `.github/workflows/test.yml`, new `PHASE_12_LIVE_LAYER_EVIDENCE.md`, and a
  candidate-only `CODEX.md` update.
- No `webapp.py` route change is expected: the committed-asset serving check
  was already closed by code inspection. Any newly discovered need is a scope
  stop for Sol/Richard review, not an automatic expansion.

---

## 6. Tests / validation

- Pure resolver: parameterized phrase math tests (TDD, first).
- Engine: fake-AudioContext Node tests — loop, cancel, shutdown, stale, single-active.
- Controller: authoritative sync/remove ordering, suspend/resume boundaries,
  project-switch teardown, and reload idle/no-autoplay.
- View/slice: loading/scheduled/live/idle/error render + aria-live.
- Browser: commit→scheduled→live→undo runtime journey, ownership loss/resume,
  reload idle/no-autoplay, both viewports; wire the focused journey into CI.
- Release: full pytest + full node + all browser journeys + syntax + diff-check.
- **CI-hard:** green feature-branch CI makes a candidate auditable; green
  post-merge target-branch CI is required before declaring Phase 12 done.

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
- **Autoplay policy.** The engine only schedules while the Lead is already
  audibly playing (user-gesture-derived context), so no autoplay violation — but
  the browser journey must drive the same real gesture in CI.
- **Committed asset serving is closed.** `asset_path()` applies expiry only to
  unpinned assets and commit pins the verified asset, so the existing opaque-ID
  audio route already serves committed audio. A contrary implementation-time
  finding stops the phase for review.

---

## 8. Execution ownership and branch protocol

1. Code baseline is `62a74eb` on `v0.3-workspace`. The Sol plan-amendment
   commit becomes the documentation parent before Hermes branches; record both
   SHAs in the handoff.
2. After Richard says **"approve Phase 12"**, Hermes creates a dedicated
   `phase12-live-layer-hermes` branch from that exact baseline.
3. Hermes implements 12A, 12B and 12C in reviewable commits, preserving a
   clean tree and recording deviations as they occur. Hermes may push only the
   feature branch for CI; it does not merge, mark accepted, or rewrite history.
4. Hermes hands off only after feature-branch CI is green, or reports the exact
   blocker without claiming completion.
5. Sol performs 12C.5 independently. Audit fixes remain explicit commits on
   the candidate branch. Richard then chooses full merge, partial follow-up,
   or no merge.

---

## 9. Out of scope (explicitly NOT in Phase 12)

Redo; Producer/autonomous commits; live warping; automatic separation;
arbitrary layer editing; multiple simultaneous committed layers; variable
phrase lengths / non-4/4 grids; a DAW timeline; a second visible audio player;
sample-accuracy claims; altering the export/render parity path.

---

*Richard approved Phase 12 on 2026-09-02. Implementation may proceed only under
the section 8 branch/handoff protocol, phase-by-phase and TDD-first; Sol audit,
Richard's merge decision and green post-merge CI remain mandatory acceptance
gates.*

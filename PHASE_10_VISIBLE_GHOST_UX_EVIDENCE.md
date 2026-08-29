# Phase 10 — First Visible Ghost UX: Evidence & Handoff

**Status:** 10A (backend) + 10B (headless frontend) + 10C (visible UX)
independently audited and complete. All local gates are green. Baseline HEAD
before the final commit: `8d9289c` on `v0.3-workspace`. No tag is authorized.

---

## 1. What was built

The vertical slice: select a vocal phrase on the Foundation deck (beats,
snapped, keyboard parity) → human `preview_layer` through the real API →
durable runtime lifecycle (`ready → scheduled → auditioning`) → live Lead
transport via a pure bridge → GhostScheduler start on a gesture-resumed
AudioContext → translucent tether + truthful status card → human Release/Retry.

### 10A — Backend (durable lifecycle facts + hardening)
- **Migration 10** (`proposal_lifecycle_facts` table) with the A4 uniqueness
  invariant: one successful fact per `(project, proposal, to_state)`.
- **`proposal_lifecycle.py`** (new, pure): A5 frozen receipt-echo schema
  (5 fields only, strict `ga-`/`sha256:`/`grid-v1:<64hex>` formats, numeric
  bounds, 512-byte canonical ceiling, `at` provenance-only, producer denied).
- **`action_store.py`**: `record_lifecycle_fact()` — BEGIN IMMEDIATE
  serialization, fact insert + projection update in ONE transaction,
  replay-idempotent, zero partial mutation, specific public errors preserved.
  `rebuild_projection()` replays lifecycle facts after ledger rows (A4).
- **`ghost_assets.py`**: region span bounds (1–64 beats → `S_REGION_OUT_OF_RANGE`)
  + media-duration validation (5e-7 tolerance → `S_REGION_BEYOND_MEDIA`).
- **Route**: `POST /api/projects/{id}/proposals/{proposal_id}/lifecycle` with a
  passthrough `LifecycleBody` (stricture lives in the pure module).

### 10B — Headless frontend
- **`api.js`**: `postProjectAction`/`postProposalLifecycle`/`getActionState`
  with `err.code` mapping; `buildPreviewAction`/`buildRejectAction`/
  `buildLifecycleBody` envelope builders.
- **`transport-bridge.js`** (new, pure): `secondsToBeats` is the exact inverse
  of the server formula (override-BPM case covered); carries the SERVER
  `destinationGridRevision` (A3); `checkGridParity` vs server `destinationGrid`
  + `targetBpm` with the six-decimal tolerance; ownership gate (A7).
- **`ghost-controller.js`** (new): generation-token controller implementing
  A1 (pending-POST outcome barrier, idempotent envelope replay on unknown
  outcome, memoized single reject, retryable `GHOST_RELEASE_UNRECONCILED`),
  A2 (launch-boundary observer records `auditioning` only after
  `currentTime >= launchAudioTime` — late never early), A7 (pause/stop/ended/
  element-restart → cancel runtime, no machine reject), A8 (project switch +
  hydration hard boundaries, deterministic recovery), A10 (retry serialized on
  durable release), A12 (single schedule per generation).
- **`ghostStatus` slice** (A9 naming) in `state.js`; hydration adapter wired in
  `project.js`; `app.js` audio events → controller + teardown shutdown.

### 10C — Visible UX
- **`waveform.js`**: OPTIONAL `regionHooks` (armed-drag selection, overlay,
  pointer capture released on up/cancel, Esc restores ordinary seek — A11).
  Zero behavior change when hooks absent.
- **`ghost-phrase.js`** (new): friendly error map, honest preconditions,
  Preview dialog (numeric beats = keyboard/AT parity path, bar shortcuts),
  exact beat conversion.
- **`ghost-card.js`** (new): truthful status card + aria-hidden SVG tether
  (DOM-bounds geometry only, A11).
- **`deck.js`**: "Select phrase" button (Foundation only), waveform mount guard
  (only re-mounts on track change — preserves in-progress drags).
- **`studio.js`**: ghost card + tether mount, region-armed flow, invoke/release/
  retry wiring.
- **CSS**: ghost-card, tether (fixed, dash animation, static under
  reduced-motion, accent-edge fallback <700px), region overlay, dialog grid.

---

## 2. Gate results (all green)

| Gate | Command | Result |
|------|---------|--------|
| Python | `.venv/bin/pytest -q` | **398 passed, 1 skipped** (92s) |
| Node | `npm test` | **247 declarations across 27 files, 0 failed** (7s) |
| Ghost UX browser (desktop) | `node tests/browser/ghost_ux.js --viewport 1280x800` | **18 checks, 0 failures** |
| Ghost UX browser (mobile) | `node tests/browser/ghost_ux.js --viewport 390x844` | **18 checks, 0 failures** |
| Ghost scheduler browser | `node tests/browser/ghost_scheduler.js` | **8 checks, 0 failures** |
| V0.3 acceptance browser | `node tests/browser/run.js --viewport 1280x800` | **30 checks, 0 failures** |
| Whitespace | `git diff --check` | **clean** |

### Ghost UX harness coverage (18 checks)
- Select phrase button on Foundation deck only
- Dialog opens via keyboard path (button click), beat/gain inputs, bar shortcuts
- Accessibility audit clean (0 serious/moderate/info) on dialog + studio
- Honest precondition gate: Lead not playing → toast, no dialog
- Full preview flow: card appears → armed → truthful summary → tether present
  & aria-hidden → Release durably rejects (verified server-side, 1 rejected)
- Waveform drag pre-fills the dialog (native mouse.down proves the real CSS
  hitbox; pointerup dispatched directly due to headless pointer-capture quirk)
- No uncaught console/page errors
- No horizontal overflow at both viewports (scrollWidth=1280 / 390)

---

## 3. Documented limitations (for Sol's audit)

1. **Independent clocks**: the transport bridge re-anchors at each read; the
   HTMLAudioElement clock and the AudioContext clock are independent. No
   sample-accuracy claim is made — the receipt proves Web Audio scheduling
   intent, not physical speaker output.
2. **Fixed musical policy**: 4/4, 8-bar phrases; no time-signature detection is
   claimed. Region capped at 64 beats.
3. **One active Ghost**: the controller enforces a single non-terminal
   proposal; >1 hydrated active is a deterministic conflict state, never a
   silent pick.
4. **No auto-reject on Lead stop**: runtime work cancels but the proposal is
   NOT machine-rejected — only a human Releases (constitutional).
5. **Retry = one reject + one new preview** (two durable records, both
   visible). Supersedes-linkage deferred.
6. **Frontend budget**: the complete shipped static payload (HTML + CSS + JS)
   is **402,590 bytes**, below the **500,000-byte** allowance Richard explicitly
   approved on 2026-08-29. V0.3 shipped at 247,010 bytes; no build step exists
   because the app serves native ES modules directly.
7. **Headless pointer-capture quirk**: in headless Chromium,
   `setPointerCapture` retargets pointerup and mobile emulation can also retarget
   pointermove, so the harness dispatches the captured move/up directly on the
   canvas. Native `mouse.down()` still proves the real CSS hitbox delivers
   pointerdown. This is a test-harness accommodation, not a product workaround.

---

## 4. Routine edits to existing files (flagged for Sol)

- `tests/test_phase9a_actions.py`: `test_latest_version_is_9` → `test_latest_version_is_10`
  (Migration 10 bumped the schema version).
- `tests/test_phase9b_ghost_assets.py`: fixture stems extended 4s → 32s (the
  old 4s fixtures silently relied on ffmpeg truncation past media end, which A6
  now forbids).
- `tests/browser/ghost_fixture_server.py`: seeded tracks + vocals stems
  extended 4s → 32s (the A7 ownership gate needs Lead playing=true at the
  transport read; a 4s track ends first).

---

## 5. Files delivered

**Modified:** `package.json`, `src/twobecomeone/{action_store,ghost_assets,
migrations,studio,webapp}.py`, `src/twobecomeone/studio_static/js/{api,
app-context,app,state,project}.js`, `.../js/components/deck.js`,
`.../js/runtime/ghost-scheduler.js`, `.../js/views/studio.js`,
`.../js/waveform.js`, `.../styles/{components,responsive}.css`,
`tests/browser/ghost_fixture_server.py`, `tests/test_phase9a_actions.py`,
`tests/test_phase9b_ghost_assets.py`.

**New:** `src/twobecomeone/proposal_lifecycle.py`,
`.../js/components/{ghost-card,ghost-phrase}.js`,
`.../js/runtime/{ghost-controller,transport-bridge}.js`,
`tests/browser/ghost_ux.js`,
`tests/frontend/actions/ghost-api.test.js`,
`tests/frontend/runtime/{ghost-controller,transport-bridge}.test.js`,
`tests/test_phase10a_{lifecycle,bounds}.py`.

**Phase evidence:** `PHASE_10_VISIBLE_GHOST_UX_TRI_PHASE_PLAN.md` and this
evidence file. `Sol to Sol.txt` remained deliberately untracked and was never
read or touched.

---

## 6. Hermes handoff to Sol (pre-audit record)

- Hermes left the implementation uncommitted exactly as required so Sol could
  audit it before creating the checkpoint.
- The authoritative spec is `PHASE_10_VISIBLE_GHOST_UX_TRI_PHASE_PLAN.md`
  (Sol-audited, 12 binding amendments A1–A12).
- `CODEX.md` remains the authoritative status/next-steps doc.
- Architecture Ghost Phase C commit/acceptance UX stays deferred.

---

## 7. Sol final audit corrections and rerun — 2026-08-29

The final audit verified the five requested vectors against code rather than
accepting the initial green handoff. It found and fixed these narrow blockers:

1. Active waveform drags now release pointer capture, remove document/canvas
   listeners, disconnect the observer, and remove their DOM on teardown. The
   mount guard also remounts when waveform-relevant analysis changes—not on
   playback ticks—and Esc/pointer-cancel disarms region mode truthfully.
2. Mobile region mode now declares `touch-action: none` only while armed.
   Production pointer capture remains intact; the Chromium harness directly
   dispatches captured move/up because of the documented headless retargeting.
3. The `audioController` injection is a direct constructor dependency from
   `app-context.js`; no global and no import cycle exists. Explicit seek events
   now cancel an armed Ghost just like pause/stop/end/source replacement.
4. `ghostStatus` now accepts only whitelisted, recursively plain JSON. Runtime
   class instances, nested DOM/audio/canvas-like objects, unknown geometry, and
   AudioContext-relative launch time cannot enter the slice.
5. Release now durably handles in-flight preparation, 5xx/unknown preview
   outcomes, stable-envelope reject retries, and hydrated proposals. A restored
   proposal carries enough semantic summary for Retry; natural Ghost completion
   becomes an actionable `ended` state instead of leaving the card stuck at
   `auditioning`.
6. Every project-changing path, including “new mix from render,” crosses the
   Ghost runtime cancellation boundary before dispatching the new project.

Final rerun evidence after these corrections:

- `.venv/bin/pytest -q` → **398 passed, 1 skipped**.
- `npm test` → **247 declarations across 27 files, 0 failed**.
- Phase 10 Ghost UX → **18/18** at both 1280×800 and 390×844.
- Phase 9 Ghost scheduler → **8/8**.
- V0.3 desktop acceptance → **30/30**.
- All shipped/harness JavaScript passes `node --check`.
- `git diff --check` is clean.
- Complete shipped HTML/CSS/JS → **402,590 bytes / 500,000 allowed**.

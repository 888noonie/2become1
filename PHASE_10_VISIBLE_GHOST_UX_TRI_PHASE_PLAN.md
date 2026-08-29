# 2BECOME1 V1 — Phase 10: First Visible Ghost UX

**Audience:** Hermes (implementation owner); Sol (auditor); Richard (approval)
**Baseline:** `v0.3-workspace` at `8d9289c` (Phase 8 `044cb03` and Phase 9 `f110a2d`
accepted, CI green: 356 Python, 200 Node, 8/8 Chromium Ghost checks)
**Status:** Implemented and independently audited; local acceptance gates green.
The binding amendments in the final audit section are part of the plan.
**Architecture reference:** `docs/V1_GHOST_ARCHITECTURE.md` §2, §7 (Ghost Phase B),
§9.1–9.4; this plan implements Ghost Phase B only.

## Mission and hard boundary

Wire the accepted Phase 8–9 headless plumbing into the product as the first
VISIBLE, deterministic, human-driven Ghost preview. The bounded vertical slice:

```text
select a vocal region on Deck A (Foundation), in beats, snapped, keyboard parity
  -> human preview_layer through the real API (server pre-renders the asset)
  -> durable runtime lifecycle facts: ready -> scheduled -> auditioning
  -> live Deck B (Lead) transport derived by a pure bridge
  -> GhostScheduler source.start(launchAudioTime) on a gesture-resumed AudioContext
  -> translucent tether (decorative) + truthful Ghost status card
  -> human Release (reject_proposal) or Retry (reject + new preview)
```

This is Ghost Phase B: the deterministic human preview workflow. It is NOT
acceptance. Read `CODEX.md`, `docs/V1_GHOST_ARCHITECTURE.md`,
`V1_DURABLE_ACOUSTIC_TRI_PHASE_PLAN.md`, `V1_DURABLE_ACOUSTIC_EVIDENCE.md`,
`js/actions/*`, `js/transport/*`, `js/runtime/ghost-scheduler.js`,
`js/actions/hydration.js`, `js/state.js`, `js/app-context.js`, `js/app.js`,
`js/audio.js`, `js/api.js`, `js/project.js`, `js/waveform.js`,
`js/components/deck.js`, `js/views/studio.js`, `action_store.py`,
`ghost_assets.py`, `studio.py`, `webapp.py`, `migrations.py`, and their tests
before editing. Preserve `Sol to Sol.txt` untracked.

### Non-negotiable boundaries

- **Ghost Phase B only.** No commit/acceptance UI, no undo, no render-plan
  change, no committed-layer rendering, no Producer interface or access, no
  delegation UI. Ghost Phase C items stay deferred (see final section).
- **The frozen Action contract is untouched.** Still exactly
  `preview_layer` / `commit_layer` / `reject_proposal`; no `supersedes` field;
  Retry = one reject Action plus one new preview Action (two durable records,
  both visible). No new public Action types.
- **No live warping, no phase alignment, no beat/phrase detection work, no
  automatic separation, no background GPU work.** A preview request never
  triggers Demucs; the UI honestly reports "separate vocals first".
- **V0.3's single-active-`HTMLAudioElement` runtime is unchanged.** The Ghost
  owns one separate, disposable `AudioContext` + `GhostScheduler`. No runtime
  object (context, node, buffer, timer, fetch, controller, DOM) ever enters
  StateStore, SQLite JSON, or Action payloads. The store receives only
  serializable semantic facts (architecture rule 5).
- **No new autoplay path.** The Ghost `AudioContext` is created and resumed
  only inside the explicit Preview click gesture. It is never exposed on
  `window`, and nothing audible can start without that gesture.
- Preserve all V0.3 endpoints, media, migrations, and project-save semantics.
  Add only numbered, transactional migrations. Every automated database,
  browser fixture, and test uses `tmp_path`/temporary data roots; never touch
  `/home/richardn/.local/share/2become1`. The server stays loopback-only.
- DOM is built with DOM APIs and `textContent`; never `innerHTML` for data.
  CSS uses semantic custom properties from `studio.css` — no literal component
  colors. Preserve visible focus, 44px enabled targets, keyboard tab order,
  and `prefers-reduced-motion`. No horizontal overflow at 390px.
- The uncompressed frontend stays under the 500 KB budget (raised from 350 KB
  by Richard on 2026-08-29 before final acceptance).
- Hermes keeps work **uncommitted**: no tag, push, branch change, media change,
  or persistent-data-root change. Record commands and counts in
  `PHASE_10_VISIBLE_GHOST_UX_EVIDENCE.md`, including limitations. Sol owns
  audit, narrow fixes, commit, push, CI, and any tag authorization.

## Frozen integration decisions

### 1. Durable runtime lifecycle facts (closes the Phase 9 deferred gap)

The Phase 9 harness advanced `ready -> scheduled -> auditioning` by mutating
the projection directly (documented test seam). Phase 10 makes those facts
durable and public, without touching the frozen Action envelope:

```text
POST /api/projects/{project_id}/proposals/{proposal_id}/lifecycle
body: { "to": "scheduled" | "auditioning",
        "actor": { "type": "human", "id": "..." },
        "at": "<ISO-8601>",
        "fact": { optional scrubbed receipt echo: assetId?, contentHash?,
                  launchBeat?, launchAudioTime?, gridRevision? } }
```

Server rules (mirror the existing strictness):

- Project and proposal must exist in project scope; unknown proposal ->
  `L_UNKNOWN_PROPOSAL`; unknown project -> standard 404 envelope.
- Actor must be `human`. Producer -> `P_ACTOR_NOT_ALLOWED` (a producer cannot
  schedule or audition what it could not propose via the public API).
- `to` must be a forward runtime state; the transition must satisfy the frozen
  lifecycle table (`ready -> scheduled`, `scheduled -> auditioning`). Anything
  else -> stable `L_INVALID_TRANSITION` code with zero mutation.
- **Replay-idempotent:** if the proposal is already in the target state, the
  endpoint returns success with the current state and writes nothing (network
  retries must not fail the client). Terminal proposals -> `L_INVALID_TRANSITION`.
- The `fact` object is untrusted input: unknown-key rejection, finite-number
  rule for numerics, non-empty strings, no arrays-of-objects, size-bounded,
  no absolute paths; stored scrubbed. It is provenance, never truth.
- **Migration 10** (transactional, idempotent): `proposal_lifecycle_facts`
  table — `id, project_id, proposal_id, from_state, to_state, actor_type,
  actor_id, fact_json, recorded_at`, indexed on
  `(project_id, proposal_id, recorded_at)`. The fact insert and the
  `action_projection` proposals-json lifecycle update commit in ONE SQLite
  transaction. The append-only `actions` ledger is NOT used for runtime facts;
  it remains musical-Action-only.
- `GET .../action-state` reflects advanced lifecycle, so reload hydration
  shows the true state of an interrupted audition.
- Same-phase hardening (narrow, test-covered): a server-side region bound for
  Ghost preparation — `MIN_GHOST_REGION_BEATS = 1`,
  `MAX_GHOST_REGION_BEATS = 64` (16 bars at 4/4) -> new
  `S_REGION_OUT_OF_RANGE` precondition in `ghost_assets.py`. The Action
  contract itself is unchanged (bounds remain contract-optional; preparation
  requires them anyway). Existing fixtures use ≤ 4 beats and stay green.

### 2. Frontend Action/lifecycle client

`js/api.js` gains thin, abortable, standard-envelope helpers:
`postProjectAction(projectId, action, signal)`,
`postProposalLifecycle(projectId, proposalId, body, signal)`,
`getActionState(projectId, signal)`. POST responses drive narrow V1 reducer
dispatches that mirror the SERVER-returned records (`v1/proposal/record` with
the server record; `v1/proposal/transition` with the server-confirmed state).
The client-side `ActionLedger`/`ActionDispatcher` stay test-only; production
truth is always the server response. Action IDs and idempotency keys are
fresh `crypto.randomUUID()` values per new intent; a network retry of the
same intent reuses the same key and payload, so the server returns the
original recorded outcome.

### 3. Hydration wiring (Phase 9 adapter finally connected)

`project.js` boot calls `hydrateActionState({ store, projectId })` after a
current project exists; `switchTo` aborts the previous controller and
re-hydrates. Silent failure retains the local projection (existing adapter
behaviour). The Ghost controller treats hydration as stale-safe: if its
active proposal disappears or is terminal after hydration, it cancels
runtime work (the scheduler is already stale-safe) and reports the honest
status. No visual change on hydration failure.

### 4. Transport bridge (pure, `js/runtime/transport-bridge.js`)

Derives a live `DeckTransport` for Deck B from real playback facts, with
injected clock reads (no DOM imports; Node-testable):

```text
buildDeckTransport({ deck, track, elementSeconds, playing, audioClockNow })
  playing        = destination playback facts
  tempoBpm       = track.bpm  (effective: bpm_override ?? detected — parity
                   with server `_v1_track_bpm`)
  beatsPerBar    = 4, phraseBars = 8   (fixed V1 policy, no time-signature
                   detection claimed; the policy is recorded inside
                   gridRevision so receipts are comparable)
  anchor per read: startedAtAudioTime = audioClockNow
                   beatAtStart = secondsToBeats(elementSeconds)
  secondsToBeats(s) = (s - beat_grid.first_beat) * tempoBpm / 60
                   — the EXACT inverse of the server slice formula in
                   ghost_assets.py (offset = first_beat + beat * 60 / bpm).
                   Parity test mirrors the server formula, including the
                   override-BPM case where grid interval != 60/effective BPM.
  gridRevision   = stable deterministic string from (track id, effective BPM,
                   first_beat, interval, 4, 8), e.g.
                   "grid-v1:{trackId}:{bpm}:{first_beat}:{interval}:4:8"
```

Documented limitations (code comment + evidence file, no accuracy claims):
the HTMLAudioElement clock and the AudioContext clock are independent; the
bridge re-anchors at each read and cannot observe element seeks/pauses that
happen between the read and the launch; the controller cancels runtime work
when destination pause/stop events arrive; nothing here is sample-accurate.

### 5. Ghost controller (runtime, `js/runtime/ghost-controller.js`)

App-scoped, constructed in `app-context.js` with injected dependencies (store,
api helpers, scheduler factory, audioController, announcer). Imported by
`app.js` (teardown) only — never by views; no import cycles.

- Owns ONE lazily-created `AudioContext` and one `GhostScheduler`. The context
  is created and `resume()`d synchronously inside the Preview click gesture.
- `invoke(region, gainDb)`: one-active-Ghost check -> POST `preview_layer` ->
  dispatch server record -> POST lifecycle `scheduled` -> `scheduler.schedule(
  serverProposal, serverAsset)` with `transportProvider` reading the live
  bridge -> on scheduler STARTED -> POST lifecycle `auditioning` with the
  receipt echo as `fact` -> dispatch transition.
- `release()`: cancel runtime work + POST `reject_proposal` (human actor) +
  dispatch. `retry(params)`: release + invoke with prefilled parameters — one
  gesture, two durable records, both visible in the status card history.
- Destination pause/stop: cancel runtime work but do NOT auto-reject. The
  status card says Lead stopped and offers Release (constitutional: only a
  human rejects).
- Reports only serializable facts to a new additive `ghostRuntime` slice
  `{ activeProposalId, phase: idle|preparing|armed|auditioning|ended|failed|
  blocked, receipt: <serializable>|null, error: <code/message>|null }` via a
  new narrow reducer `v1/ghost-runtime/set` (architecture rule 5; runtime
  objects never enter the store; snapshots stay structuredClone-safe).
- Teardown/shutdown cancels everything; late async responses never start a
  source (scheduler stale-safety + controller generation tokens).

### 6. Visible UX (Studio route only; no other route changes)

- Foundation deck gains a **"Select phrase"** button (enabled when a
  Foundation track exists; preconditions surface honestly in-dialog).
- **Region mode** on the Foundation waveform: `waveform.js` gains OPTIONAL
  region hooks (mode flag, drag handler, overlay draw, Esc exit) — zero
  behaviour change when unused; V0.3 seek/cue behaviour untouched. Pointer
  drag selects a beat-snapped region with a canvas overlay. Full keyboard/AT
  parity comes from numeric beat inputs in the dialog, so every canvas
  gesture has a labelled equivalent.
- **"Preview vocal phrase over Lead" dialog** (house `components/dialog.js`
  pattern): start beat, end beat (finite, ≥ 0, end > start, region ≤ 64
  beats, within track duration in beats), bars helpers (8/16 bars from
  start), gain dB (-24..12, default -3), Preview + Cancel. Honest client-side
  preconditions before submit: Foundation vocals stem exists (from existing
  stems state / `listStems`); Lead deck assigned; tempo ratio
  `leadBpm/anchorBpm` within 0.25–4.0; Lead currently playing (else the
  friendly `T_TRANSPORT_NOT_PLAYING` message "Start Lead playback first").
- **Server error -> friendly message map** (one module):
  `S_STEM_UNAVAILABLE` -> "Separate vocals on Foundation first" (+ button
  opening the existing stem dialog), `S_GRID_MISSING` -> "Edit analysis
  first — BPM/beat grid missing", `S_TEMPO_RATIO_OUT_OF_RANGE`,
  `S_REGION_OUT_OF_RANGE`, `S_DESTINATION_INVALID`, `S_ASSET_EXPIRED`,
  `L_*`/`P_*`/`T_*` as applicable. Codes are never shown raw to the user but
  ARE logged; toasts reuse the existing pattern.
- **Tether:** an `aria-hidden`, `pointer-events: none` overlay between the
  deck slots while a Ghost is armed/auditioning; semantic CSS variables;
  fully static under `prefers-reduced-motion`; decorative only — the status
  card is the accessible truth. At narrow widths it simplifies to an accent
  edge on the Lead deck (no layout overflow).
- **Ghost status card** (the truth): source (Foundation vocals + region in
  beats and bars), destination (Lead), phase, resolved launch beat/phrase
  index (from the immutable receipt once armed), gain, Release + Retry.
  Live-announcer messages on every phase change (existing `onAnnounce`
  pattern). All controls labelled, ≥ 44px, in tab order, visible focus.
- **One active Ghost:** a new preview while one is active is blocked with an
  honest message pointing at Release/Retry. No silent supersession.
- Audition length is bounded by the region (≤ 64 beats); no looping, no
  retrigger, no second Ghost.

### 7. Naming

Foundation = Deck A (source), Lead = Deck B (destination). User-facing words:
"Select phrase", "Preview vocal phrase over Lead", "Ghost preview", "Release",
"Retry". No routing terminology (buses/sends/channels) in UI copy.

## Phase 10A — Durable runtime lifecycle facts (backend)

Deliver:

1. Migration 10 (`proposal_lifecycle_facts`) — numbered, transactional,
   idempotent; a temp copy/fixture of the current schema migrates without
   changing pre-existing rows.
2. Repository-owned validation for the lifecycle request (unknown keys,
   finite numbers, human actor, forward states, scrubbed `fact`) with stable
   public codes; narrow `StudioService` facade method; standard error
   envelope and status mapping in `webapp.py`.
3. One-transaction fact insert + projection lifecycle update; replay
   idempotency; zero partial mutation on every failure path.
4. `MIN/MAX_GHOST_REGION_BEATS` (1/64) precondition in `ghost_assets.py`
   with `S_REGION_OUT_OF_RANGE`.
5. Python tests: contract vectors, human-only, invalid/terminal transitions,
   replay no-op, restart durability, `action-state` reflection, region
   bounds (including boundary values 1 and 64), atomicity under injected
   failure, error envelope, `tmp_path` everywhere.

Exit gate: a human preview + two lifecycle POSTs survive service restart and
hydrate identically from `action-state`; producer lifecycle POST is denied;
no mutation on any failure; full `pytest` green; no frontend change yet.

## Phase 10B — Headless frontend plumbing

Deliver:

1. `js/api.js` action/lifecycle client (above) with envelope handling.
2. `js/runtime/transport-bridge.js` (pure) + the `secondsToBeats` helper as a
   shared pure function with a parity test mirroring the server formula
   (including `bpm_override` != detected BPM).
3. `js/runtime/ghost-controller.js` (above) + `ghostRuntime` slice and
   `v1/ghost-runtime/set` reducer in `state.js` (additive; structuredClone
   safe; no other slice touched).
4. Hydration wiring in `project.js` boot/switch with abort-on-switch.
5. Node tests: bridge math (zero/nonzero origins, override BPM, gridRevision
   stability across reads), controller state machine with a fake scheduler/
   context/api (invoke -> scheduled -> auditioning; release; retry;
   one-active rule; destination pause/stop cancel without auto-reject;
   stale/teardown; late-async never starts), slice purity, hydration
   abort/stale behaviour, api client error mapping.
6. `node --check` on all new/changed JS.

Exit gate: all new Node tests plus the existing 200 pass; no visible UI yet;
`git diff --check` clean; screenshots of the untouched Studio unchanged.

## Phase 10C — Visible Ghost UX

Deliver:

1. Waveform region mode (optional hooks; no regression when unused) + region
   overlay drawing.
2. "Select phrase" button, region dialog, error-message map module.
3. Tether overlay + Ghost status card + `ghostRuntime` subscription, with
   CSS in the existing styles files using semantic variables only.
4. A11y: labels, 44px targets, tab order, live announcer, reduced motion;
   responsive down to 390×844 with zero horizontal overflow.
5. `tests/browser/ghost_ux.js` against `ghost_fixture_server.py` (add a
   `--no-vocals` seed variant for the honest-precondition path): drive the
   REAL UI — click Select phrase, set beats via the numeric inputs (and one
   canvas-drag case), submit; instrument `AudioContext` via an init-script
   wrapper to record `createBufferSource`/`start`; assert the full POST
   sequence (preview -> scheduled -> auditioning), the receipt's launch equals
   `resolveNextPhrase` on the bridged transport, tether presence, status-card
   phases, Release (reject POST + no later `start()`), Retry, honest
   precondition errors, the a11y audit (reuse `auditDocument`), and 390×844
   layout. Screenshots as artifacts only. Run at 1280×800 and 390×844; add
   `test:ghost-ux` to `package.json` and wire it into the existing CI browser
   job pattern.
6. Size-budget check: uncompressed frontend remains under 500 KB.

Exit gate: the visible journey works end-to-end against the real server in
real Chromium at both viewports; every control has a keyboard equivalent;
all Python + Node + browser suites green (existing suites unchanged in
behaviour); `PHASE_10_VISIBLE_GHOST_UX_EVIDENCE.md` records commands, counts,
and the documented limitations (element-clock vs audio-clock independence;
no sample-accuracy claim; fixed 4/4-8-bar phrase policy; one active Ghost).

## Sol acceptance blockers

Reject/fix if: a client can write a path or command fragment anywhere;
producer can schedule/audition/reject; a lifecycle fact mutates the
projection outside its transaction or bypasses the frozen transition table;
runtime objects enter StateStore/SQLite/Action payloads; audio can start
without the Preview gesture (autoplay) or the scheduler surfaces on
`window`; anyone claims sample accuracy; V0.3's player is rewritten;
a preview triggers automatic separation; region bounds are missing
server-side; a visible Ghost affordance appears before the 10C gates pass;
a11y/44px/tab-order/overflow regressions; the bundle exceeds budget; any
test touches the real data root; hydration or client dispatches diverge from
server truth; Phase 9's asset/pinning/idempotency guarantees stop being
green; `Sol to Sol.txt` is tracked or modified.

## Deferred after this phase (need fresh Richard sign-off)

Commit/acceptance UX and undo (Ghost Phase C), render inclusion of committed
layers, audition-to-render parity proof, Producer proposal UI and delegation,
`supersedes` linkage between retries, phrase/downbeat detection improvements,
time-signature detection, live warp, phase alignment, multiple simultaneous
Ghosts, expiry/GC policy UI, and true simultaneous two-deck playback.

## Sol pre-implementation audit — 2026-08-29

**Disposition:** approved for Hermes implementation only with the amendments
below treated as part of the Phase 10 contract. The overall tri-phase boundary,
the five product judgment calls, and the deferrals are sound. This audit was
performed against the live `8d9289c` tree, including `action_store.py`,
`ghost_assets.py`, the frozen Action/lifecycle reducers, hydration adapter,
`AudioController`, waveform/deck mounts, and the accepted `GhostScheduler`.

### Binding amendments and added acceptance tests

1. **Release during preparation needs an outcome barrier; fetch abort is not
   cancellation.** `ActionStore.append_action()` prepares the Ghost asset before
   its SQLite append, and the current ffmpeg subprocess is synchronous. Aborting
   the browser fetch cannot prove that server preparation or the eventual append
   stopped. The controller must therefore mark the generation released
   immediately, prevent every later lifecycle/scheduler step, and reconcile the
   original preview intent using the SAME action ID, idempotency key, and payload.
   Once the original outcome is known, it must durably append exactly one human
   `reject_proposal`. It may abort ordinary asset fetch/decode and route-scoped
   reads, but it must not treat an aborted Action POST as proof of rollback.
   Simplest safe implementation: keep the authoring POST promise alive behind a
   generation token, then reject its returned proposal without ever scheduling
   it. If implementation aborts that POST, it must idempotently replay it to
   resolve the unknown outcome before rejecting. Test Release both before and
   after the preview append, with delayed preparation, and prove zero later
   `source.start()` calls, one preview ledger row, and one reject ledger row.

2. **`scheduled` and `auditioning` must remain truthful.** In the accepted
   scheduler, `SCHEDULE_STATES.STARTED` currently means that
   `source.start(futureAudioTime)` was called; it fires immediately and can be
   many seconds before audible onset. Phase 10 must not POST `auditioning` from
   that callback. Persist `scheduled` after the server accepts the transition;
   schedule exactly once; then advance to `auditioning` only from a
   controller-owned, cancellable launch-boundary observer which verifies the
   same generation, proposal, destination ownership, non-suspended context, and
   `audioContext.currentTime >= receipt.launchAudioTime`. A late observer may
   record auditioning late, never early. Timers/observers stay outside
   StateStore. Tests must hold the fake clock before the boundary, cross it,
   cancel immediately before it, and simulate a suspended context.

3. **Use the server-authored destination grid revision.** The draft's example
   client revision (`grid-v1:{trackId}:...`) does not equal Phase 9's actual
   `grid-v1:<sha256>` revision from `GhostAssetStore._server_grid_facts()`.
   Do not create a second identity algorithm. The transport used to schedule
   must carry `asset.transformSpec.destinationGridRevision`, and the controller
   must compare the current Lead identity/BPM/origin/interval against the
   server-returned `destinationGrid` facts before scheduling. A mismatch is a
   stale-grid failure requiring a fresh preview, never a silently relabelled
   receipt. Cross-language parity tests must compare beat/seconds within an
   explicit tolerance that includes the server's six-decimal ffmpeg argument
   serialization; they must not demand bit-identical Python/JavaScript floats.

4. **Lifecycle facts must be rebuildable and race-idempotent.** Updating
   `action_projection` from a second append-only table means
   `ActionStore.rebuild_projection()` can no longer rebuild truth from Actions
   alone. Extend the repair path so terminal musical Actions remain decisive
   while the latest valid lifecycle fact restores `scheduled`/`auditioning` for
   still-active previews. Add a rebuild-after-snapshot-deletion test, not only a
   service-restart test. Migration 10 must also enforce one successful fact per
   `(project_id, proposal_id, to_state)` (or an equivalent database invariant),
   and the write path must serialize/conditionally update so two concurrent
   identical transitions yield one fact plus one replay response, while two
   competing transitions cannot partially mutate or surface a raw SQLite lock.

5. **Freeze a narrow lifecycle-fact schema.** Replace the generic
   "no arrays-of-objects, size-bounded" language with exact allowed keys and
   limits. The receipt echo may contain only the fields named in this plan,
   with strict opaque asset/hash/grid formats, finite numeric bounds, bounded
   string lengths, canonical JSON, and a small maximum encoded byte size.
   `recorded_at` is server time. Client `at` is validated provenance only and
   must not order facts or override server time. Never return or log paths,
   ffmpeg details, or unsanitized request content.

6. **Server region validation must include media bounds.** The 1–64 beat span
   is necessary but insufficient for an untrusted client. Before ffmpeg, verify
   that the server-derived source offset and duration are finite, positive, and
   within the resolved Foundation media/stem duration (with one documented
   numerical tolerance). Add before-origin, exact-end, and past-end vectors.
   Client dialog validation remains convenience, never authority.

7. **The Lead transport must prove playback ownership.** `playing: true` alone
   is unsafe because the singleton player may currently own Foundation, a
   render, or another track. Every transport read and launch-boundary check
   must require `audioController.current.trackId` to equal the current
   project's Lead track ID and read `audioController.time`/`playing` directly;
   StateStore playback ticks are display state, not the scheduling clock.
   Cancel on pause, stop, natural `ended`, source replacement, project switch,
   Lead reassignment, or analysis/grid change. Add tests for Foundation playing,
   same-time source replacement, seek after scheduling, natural end, and Lead
   replacement. None of these events auto-rejects.

8. **Project switch and hydration are hard runtime boundaries.** Cancel the old
   controller generation before changing the current project and before the new
   hydration can dispatch. A hydrated `scheduled`/`auditioning` proposal cannot
   be resumed automatically because its old AudioContext clock is gone and
   autoplay is forbidden; show it as interrupted with human Release/Retry.
   Hydrated active proposals must block a new preview. If corrupt/legacy state
   contains more than one active proposal, render a deterministic recovery state
   rather than silently selecting one. Hydration failure must be visible once
   Ghost UI exists (retryable status, no fabricated empty truth), superseding the
   draft's "no visual change" rule for Phase 10C.

9. **Keep semantic presentation state distinct from runtime machinery.** The
   architecture explicitly says runtime is not a StateStore slice, so do not
   name or model the new slice `ghostRuntime`. Use a narrow serializable
   `ghostStatus`/proposal-presentation projection, updated only by reducers.
   Keep AudioContext-relative clock values, generation tokens, requests,
   AbortControllers, timers, nodes, buffers, DOM references, canvas geometry,
   and animation state controller-owned. Store/display durable semantic facts
   such as proposal ID, lifecycle, resolved beat/phrase, region, gain, and a
   scrubbed friendly error. Add a recursive structured-clone/purity test and a
   test that no tether bounding boxes, paths, canvas contexts, or elements enter
   any store snapshot.

10. **Retry is serialized, not merely two method calls.** The new preview must
    not be authored until the prior human reject is durably successful (or an
    idempotent replay confirms it). If rejection fails, keep a retryable
    releasing/error state and do not create the replacement proposal. The Retry
    gesture may synchronously call/resume the AudioContext first, then await the
    durable release barrier. Test rejection failure and rapid repeated Retry.

11. **The tether and waveform overlay remain derived view geometry.** Compute
    tether endpoints locally from current DOM bounds and recompute on resize/
    responsive layout; never dispatch them. Pointer capture must be released on
    pointer-up/cancel, Esc must restore ordinary seek behavior, and unmount must
    remove listeners/observers. At 390px the accent-edge fallback must not leave
    an off-screen SVG/canvas hitbox. Test pointer-cancel, Esc, teardown, resize,
    reduced motion, and keyboard-only numeric selection.

12. **Continuous scheduling is forbidden and observable.** Transport may be
    re-anchored on demand, but `resolveNextPhrase()` and
    `AudioBufferSourceNode.start()` run once per proposal generation after
    decode. They must never live in `requestAnimationFrame`, `timeupdate`, a
    render subscription, or a polling loop. The browser harness must advance
    through multiple playback ticks and rerenders and still observe exactly one
    source creation and one `start()` for that proposal.

### Audit treatment of the five judgment calls

- The separate lifecycle endpoint/table is accepted, subject to amendments 4
  and 5; it preserves the frozen musical Action vocabulary.
- Fixed 4/4, eight-bar phrases, and the 64-beat cap are accepted as an honest
  Phase B policy, subject to amendment 6.
- Destination stop cancels runtime without machine rejection: accepted.
- Retry as reject plus a fresh preview, with no `supersedes`: accepted, subject
  to amendments 1 and 10.
- Re-anchoring the independent clocks without a sample-accuracy claim is
  accepted, subject to amendments 2, 3, 7, and 12.

### Revised Sol acceptance blockers

In addition to the blockers above, reject/fix Phase 10 if Release can leave an
unknown successful preview unreconciled; `auditioning` is recorded before the
launch boundary; a client-generated grid revision replaces the server revision;
projection rebuild drops lifecycle facts; a concurrent lifecycle replay writes
duplicates; transport accepts playback owned by anything other than the current
Lead; a project switch leaves a source armed; hydration silently treats failure
as empty truth once visible Ghost UI exists; Retry authors a new proposal before
the prior reject is durable; or any scheduling/render loop can call `start()`
more than once.

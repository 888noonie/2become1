# V1 Action and Transport Foundation — Phase 8 Evidence

**Status:** Phases 8A, 8B, and 8C complete. Working tree left uncommitted for Sol audit.

**Baseline:** `v0.3.0` tag at `216bc4a` (CI-green), branch `v0.3-workspace`.

**Plan:** `V1_ACTION_TRANSPORT_TRI_PHASE_PLAN.md` (committed at `b03992d`).

---

## What was built

Three additive, headless, pure-JavaScript module families under the existing
frontend source tree. Nothing was wired into application boot, the UI, audio
playback, Python, SQLite, or persistent data.

### Phase 8A — Action contract and projection

- `src/twobecomeone/studio_static/js/actions/contracts.js`
  - Frozen Action envelope: `{ id, schemaVersion: 1, type, actor, requestedAt, idempotencyKey, payload }`
  - Allowed types: `preview_layer`, `commit_layer`, `reject_proposal`
  - Pure `validateAction()` returning structured `Result` objects; rejects bad decks,
    same-deck preview, bad region bounds, bad launch/quantize/gain, unknown keys,
    and non-serializable values.
  - `isSerializable()` guard to keep functions/symbols/DOM/audio out of state.

- `src/twobecomeone/studio_static/js/actions/errors.js`
  - Stable error-code table grouped by family: V_, P_, L_, I_, T_, X_.
  - No UI copy or implementation exceptions leak into the contract.

- `src/twobecomeone/studio_static/js/actions/permission.js`
  - Constitutional permission gate.
  - Producer may only `preview_layer` when `producerPreviewAllowed === true`.
  - Producer is denied `commit_layer` and `reject_proposal`.

- `src/twobecomeone/studio_static/js/actions/lifecycle.js`
  - Frozen state machine: `ready -> scheduled -> auditioning -> accepted`
  - Rejection reachable from any non-terminal state.

- `src/twobecomeone/studio_static/js/actions/reducers.js`
  - Additive `state.session` and `state.proposals` slices.
  - Pure reducers for recording, transitioning, superseding, rejecting, and
    committing proposals.
  - `makeCommittedLayer()` creates a first-class layer containing:
    - `sourceRegionRef` (semantic)
    - `acceptedAsset` with `id`, `contentHash`, `transformSpec` (immutable identity)
    - `placement` and `acceptedBy` provenance.

- `src/twobecomeone/studio_static/js/state.js`
  - Added `session` and `proposals` initial slices.
  - Registered each V1 reducer action type individually so the existing
    exact-type reducer lookup remains untouched.

### Phase 8B — deterministic deck transport planner

- `src/twobecomeone/studio_static/js/transport/normalize.js`
  - Validates and freezes the DeckTransport shape.
  - Rejects out-of-range tempo, signature, phrase length, bad time/grid.

- `src/twobecomeone/studio_static/js/transport/derive.js`
  - `beatsPerSecond`, `phraseBeats`, `beatAtTime`, `derivedPosition`.
  - `resolveNextPhrase(rawTransport, nowAudioTime)` returns the *following*
    phrase boundary, grid revision, and normalized source facts.
  - Stopped transport returns `T_TRANSPORT_NOT_PLAYING`.
  - `PHRASE_EPSILON = 1e-9` used only for deterministic boundary comparison;
    no real clock or audio scheduling.

### Phase 8C — dispatcher, ledger, and provenance proof

- `src/twobecomeone/studio_static/js/actions/ledger.js`
  - In-memory `ActionLedger` with `append`, `findByIdempotencyKey`,
    `findByActionId`, `entries`, and `toJSON`.
  - Entries are frozen and deep-cloned on read.
  - `compareActions()` for strict idempotency comparison.

- `src/twobecomeone/studio_static/js/actions/dispatcher.js`
  - `ActionDispatcher` follows the frozen order:
    `raw request -> validate -> permission/idempotency -> transport fact -
     -> immutable ledger outcome -> reducer projection -> deep-cloned result`
  - Preview creates a `ready` proposal and optional launch fact.
  - Commit requires `auditioning`, retains the original proposal, appends a
    distinct `committed` ledger entry, and creates a first-class `CommittedLayer`.
  - Rejection records provenance and removes the proposal from active.
  - Idempotent retry returns the original outcome without duplicate ledger entry.
  - Test-only `advanceLifecycle()` helper models `scheduled` and `auditioning`.

---

## Tests added

| File | Count | Focus |
|---|---|---|
| `tests/frontend/actions/contracts.test.js` | 17 | valid/invalid envelope, payload, bounds, serializability, no mutation |
| `tests/frontend/actions/permission.test.js` | 8 | human/producer preview/commit/reject gate |
| `tests/frontend/actions/lifecycle.test.js` | 7 | frozen transitions, terminal states, rejection |
| `tests/frontend/actions/reducers.test.js` | 10 | pure projection, commit layer, supersession, no-op safety |
| `tests/frontend/actions/store-integration.test.js` | 5 | StateStore wiring, runtime-object purity, zero-change on invalid actions |
| `tests/frontend/actions/dispatcher.test.js` | 11 | full provenance chain, Producer denial, idempotency, ledger history |
| `tests/frontend/transport/derive.test.js` | 16 | 60/120/137.5 BPM, signatures, origins, boundaries, epsilon determinism |
| **Total new tests** | **74** | |

Pre-existing frontend tests remain at **102**. Total: **175 pass / 0 fail**.

---

## Verification

```text
npm test  ->  175 pass / 0 fail
node --check src/twobecomeone/studio_static/js/actions/*.js
node --check src/twobecomeone/studio_static/js/transport/*.js
node --check src/twobecomeone/studio_static/js/state.js
git diff --check  ->  clean
```

No Python tests were changed or run as part of this tri-phase (the work is
strictly frontend headless modules). The persistent data root
`/home/richardn/.local/share/2become1` was not accessed by any new code.

---

## Explicit non-changes (boundary honored)

The following were **not** modified, added, or wired:

- No HTML, CSS, views, components, or visible Studio behaviour.
- No Web Audio, `AudioController`, `HTMLAudioElement`, canvas, or playback changes.
- No Python backend, API routes, SQLite migrations, or persistent storage.
- No Producer UI, Ghost tether, region selection, drag/drop, or visual affordances.
- No version bump, tag, commit, push, or media change.
- `Sol to Sol.txt` remains untracked and untouched.
- `docs/V1_GHOST_ARCHITECTURE.md` remains documented but unimplemented.

---

## Key acceptance results

1. **StateStore Purity:** `session` and `proposals` slices contain only JSON-shaped
   values. Tests assert no `runtime`, `audio`, `transport`, `audioContext`, or
   `timer` fields appear at the top level.
2. **Zero projection change on invalid input:** validation failures return
   structured errors without touching `state.proposals` or `state.session`,
   and without appending to the ledger.
3. **Producer has no secret door:** Producer preview requires explicit
   `producerPreviewAllowed === true`; Producer commit is always denied with
   `P_ACTOR_NOT_ALLOWED`.
4. **Provenance proof:** Node tests prove `preview_layer` -> `ready` ->
   `scheduled` -> `auditioning` -> human `commit_layer` retains the original
   proposal, appends a distinct `committed` ledger entry, and inserts a
   `CommittedLayer` containing both `sourceRegionRef` and the immutable
   `acceptedAsset`.
5. **Transport determinism:** Deck B at beat 16 on 4/4 8-bar phrases resolves to
   beat 32; exactly at beat 32 resolves to beat 64. No real clock or audio is
   touched.

---

## Remaining deferred work

Per the plan and `CODEX.md`, the following remain out of scope until a fresh
sign-off:

- SQLite Action ledger / durable projection persistence.
- Region selection UI / drag / tether / visual Ghost.
- Pre-rendered preview assets and actual audio scheduling.
- Producer parity beyond the validated `preview_layer` path.
- Live warp, broad phrase detection, multitrack DAW behaviour.

---

## Handoff

Working tree is uncommitted. The only modified tracked files are
`package.json` (test glob) and `src/twobecomeone/studio_static/js/state.js`
(additive V1 slices). All other work is in new leaf modules and tests.

Ready for Sol audit.

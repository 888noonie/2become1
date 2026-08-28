# V1 Durable and Acoustic Plumbing — Phase 9 Evidence

**Status:** Phases 9A, 9B, and 9C complete and independently audited.

**Baseline:** `v0.3-workspace` at `044cb03` (V1 Action/DeckTransport foundation accepted).
**Plan:** `V1_DURABLE_ACOUSTIC_TRI_PHASE_PLAN.md` (authorized next boundary per `CODEX.md`).

---

## What was built

### Phase 9A — Durable Action ledger, API, reload hydration

- **Migration 8** (transactional, idempotent): `actions` ledger table with
  per-project monotonic `sequence`, action ID, project ID, schema version,
  type, actor type/id, requested timestamp, idempotency key, canonical payload
  JSON, outcome JSON, recorded timestamp; unique
  `(project_id, actor_type, actor_id, idempotency_key)`; plus
  `action_projection` snapshot table (projection_version, last_sequence,
  session_json, proposals_json).
- **`src/twobecomeone/actions.py`** — pure Python contract validator mirroring
  the Node `contracts.js` exactly: same wire names, unknown-key rejection,
  strict finite-number rule (bools rejected), region `startBeat < endBeat`,
  actor policy. Errors surface the Node vocabulary (`V_INVALID_GAIN`, etc.)
  directly in the HTTP envelope `code`.
- **`src/twobecomeone/action_store.py`** — ledger append + projection update in
  ONE SQLite transaction; idempotent replay, per-project/per-actor key
  scoping, zero mutation on any failure.
- **HTTP**: `POST /api/projects/{id}/actions`, `GET .../action-state`,
  `GET .../actions?after&limit` (limit 1–200), all through the standard error
  envelope.
- **Shared vectors**: `tests/fixtures/action_contract_vectors.json` consumed by
  BOTH pytest and Node tests — one real parity divergence found and fixed (null
  region now `V_MISSING_REGION` on both sides).
- **Frontend**: `js/actions/hydration.js` (defensive shape gate, deep-clone,
  abortable/teardown-safe, silent failure, never fake success) + narrow
  `v1/hydrate-projection` reducer in `state.js` replacing only the two V1
  slices.

### Phase 9B — Pre-rendered vocal Ghost asset backend

- **Migration 9**: `ghost_assets` registry table (opaque ID, project/proposal
  refs, content hash, relative managed path, transform-spec JSON, sample
  rate/channels/duration/size, pinned flag, created/expiry).
- **`src/twobecomeone/ghost_assets.py`** — server-only preparation:
  - deck→track→vocals-stem resolution (A=anchor, B=lead; exact `vocal` only,
    center/sides never substituted);
  - server-resolved slice maths (beats→seconds on source grid), bounded
    `atempo` via the existing `assembler._atempo_chain` (no divergent chain);
  - temp + atomic-replace publish, SHA-256, ffprobe decode validation;
  - strict `ga-` + 32-lowercase-hex ID validation before database lookup,
    plus managed-root validation before serving;
  - verify-and-pin for commits (ID + hash + decode + hash re-check);
  - explicit GC of expired/unpinned only; pinned assets survive.
- **`ActionStore` hooks**: expensive preparation runs before `BEGIN`; only the
  prepared-asset registry insert joins the short ledger/projection transaction.
  Failed or racing appends discard the unpublished managed file. Commit
  verifies+pins in the same durable operation.
- **Guarded serving**: `GET /api/ghost-assets/{asset_id}/audio` resolves by
  opaque ID + DB row + strict managed-root validation; expired/unpinned never
  served.

### Phase 9C — Deterministic Web Audio scheduling bridge

- **`js/runtime/ghost-scheduler.js`** — leaf runtime module:
  - injected `AudioContext`, asset loader, transport provider (no DOM imports,
    no runtime object in StateStore);
  - schedules only a HUMAN proposal marked `scheduled`; never promotes
    `ready`, never starts Producer work, never commits;
  - calls pure `resolveNextPhrase()` with `audioContext.currentTime` + Phase 8
    epsilon rule; `source.start(launchAudioTime)` exactly once;
  - finite minimum lead-time policy (0.25s): if decode makes a boundary
    unsafe, repeatedly re-resolves following phrases until the first safe
    boundary rather than starting late;
  - cancellable/stale-safe (refresh/reject/shutdown/stale async never starts
    later); one scheduled source per proposal;
  - immutable schedule receipt (proposal ID, asset content hash, grid revision,
    resolved beat, launchAudioTime).
- **Node unit tests** (`tests/frontend/runtime/ghost-scheduler.test.js`, 15):
  fake AudioContext; before/on/after boundary; nonzero origin; decode delay +
  lead-time re-resolution; stopped transport; non-human/non-scheduled; one
  source per proposal; cancel/shutdown; immutable receipt; gain node; no
  runtime objects in snapshots.
- **Browser harness** (`tests/browser/ghost_scheduler.js` + `ghost_fixture_server.py`):
  real FastAPI + temp data, real Chromium, real AudioContext. Dispatches a
  human preview_layer through the real API, prepares a managed asset, schedules
  it, and asserts the recorded `start()` equals the Phase 8 receipt. Passes at
  desktop (1280×800) and mobile (390×844) viewports.

---

## Tests added

| File | Count | Focus |
|---|---|---|
| `tests/test_phase9a_actions.py` | 29 | contract vectors, strict validation, ledger/projection/rebuild, idempotency, restart durability, migration integrity, no write lock during preparation |
| `tests/test_phase9a_http.py` | 9 | HTTP contract, error envelope, idempotent replay, pagination bounds |
| `tests/test_phase9b_ghost_assets.py` | 25 | real ffmpeg preparation, server grid provenance, strict opaque-ID serving, pinning, GC, isolation, no-Demucs |
| `tests/test_phase9c_fixture.py` | 3 | ghost fixture server helpers |
| `tests/frontend/actions/parity.test.js` | 2 | shared vectors (Node side) |
| `tests/frontend/actions/hydration.test.js` | 8 | hydration adapter |
| `tests/frontend/runtime/ghost-scheduler.test.js` | 15 | scheduler unit tests |
| **Total new tests** | **90** | |

Pre-existing suites remain green. **Python 356 pass / 0 fail; Node 200 pass / 0 fail.**

---

## Verification

```text
.venv/bin/pytest -q        ->  356 passed
npm test                   ->  200 test declarations / 0 failed
node tests/browser/ghost_scheduler.js --viewport 1280x800  ->  8 checks, 0 failures
node tests/browser/ghost_scheduler.js --viewport 390x844   ->  8 checks, 0 failures
node --check (all new JS)  ->  OK
git diff --check           ->  clean
```

---

## Key acceptance results

1. **Durable ledger + hydration**: a human `preview_layer` creates one durable
   ledger record and a `ready` proposal; a fresh `StateStore` hydrates to
   proposal/session equality with the server projection. Restart durability
   proven.
2. **Strict cross-language parity**: the shared JSON contract vectors pass on
   both Python and Node with identical error codes. Pydantic does not coerce;
   the pure Python validator owns every rule.
3. **Zero partial mutation**: any validation/permission/lifecycle/preparation
   failure leaves the ledger and projection unchanged (single transaction).
4. **Producer has no secret door**: producer preview denied via public API;
   producer commit/reject always denied.
5. **Managed asset safety**: exact-`vocal` only; no Demucs on request paths;
   atomic publish; strictly validated opaque-ID serving; expired-and-unpinned
   assets are not served, unexpired previews remain available, pinned assets
   survive GC, and forged/stale commit assets are rejected.
6. **Scheduling proof**: the browser harness records exactly one
   `AudioBufferSourceNode.start()` at the next phrase boundary, and the
   recorded argument equals the controller's Phase 8 phrase-resolution receipt.
   Teardown prevents any later start.
7. **No visible Ghost work**: no HTML/CSS/view/UI changes; the scheduler is a
   leaf module not wired into boot; no `window` exposure, no hidden button, no
   production autoplay path.

---

## Explicit non-changes (boundary honored)

- No HTML, CSS, views, components, or visible Studio behaviour.
- No rewrite of V0.3's single-active-`HTMLAudioElement` deck runtime; the
  Ghost scheduler owns a separate disposable `AudioContext` source.
- No live warping, beat/phrase detection, source-selection UI, automatic
  separation, background GPU work, render-plan changes, 3+ tracks, undo/branch
  UI, or production claim of sample-accurate sync.
- No Python backend rewrite of V0.3 endpoints/media/migrations; only numbered
  transactional migrations 8 and 9 added.
- No version bump, tag, commit, push, or media change.
- `Sol to Sol.txt` remains untracked and untouched.
- `docs/V1_GHOST_ARCHITECTURE.md` remains documented but unimplemented.
- No test touches `/home/richardn/.local/share/2become1`; all use `tmp_path`/
  temporary data roots.

---

## Limitations (documented per plan)

- The Web Audio scheduling call and receipt prove scheduling intent, NOT
  physical speaker output, device latency, two independent deck players, or a
  full mix being sample-accurately aligned. Headless CI cannot establish that.
- V1 proposal lifecycle facts created by the audio runtime (`scheduled`,
  `auditioning`, cancellation) remain runtime/projection facts for this
  tri-phase; they are not new public Action types.
- The browser harness advances the proposal to `scheduled` via the documented
  runtime/test seam (direct projection mutation), not a public API Action.

---

## Handoff

Audited scope: `CODEX.md` (plan reference), `package.json` (test scripts),
`common.py` (optional `code=` kwarg), `migrations.py` (migrations 8+9),
`studio.py` (facade + hooks), `webapp.py` (3 endpoints + asset route),
`state.js` (hydrate reducer), `contracts.js` (parity fix), plus the new leaf
modules and tests listed above. `Sol to Sol.txt` remains outside this work.

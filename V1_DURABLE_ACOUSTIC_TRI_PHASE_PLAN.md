# 2BECOME1 V1 — Durable and Acoustic Plumbing

**Audience:** Hermes (implementation owner)
**Baseline:** `v0.3-workspace` at `044cb03` (V1 Action/DeckTransport foundation accepted and CI-green)
**Status:** Approved tri-phase implementation specification

## Mission and hard boundary

Make the already-approved V1 Action contract durable, prepare exactly one
pre-rendered vocal preview asset safely, then prove that the supplied
deck-transport facts schedule that decoded asset on the Web Audio clock.

This is plumbing, not Ghost UX. The bounded vertical proof is:

```text
human preview request
  -> validated, project-scoped SQLite ledger/projection
  -> managed pre-rendered vocal asset
  -> reload hydration
  -> supplied Deck B transport resolves a Web Audio start time
  -> AudioBufferSourceNode.start(exact resolved time)
```

Read `CODEX.md`, `docs/V1_GHOST_ARCHITECTURE.md`,
`V1_ACTION_TRANSPORT_TRI_PHASE_PLAN.md`, the V1 `js/actions/` and
`js/transport/` modules, `studio.py`, `webapp.py`, `migrations.py`,
`audio.js`, `app.js`, `api.js`, and their existing tests before editing.
Preserve `Sol to Sol.txt` untracked.

### Non-negotiable boundaries

- **No visible Ghost work.** Do not alter `index.html`, views, Studio markup,
  CSS, drag/drop, tethers, canvases, dialogs, accessibility controls, or
  Producer/chat UI. Test-only harnesses may be separate test files and must
  not add a user-facing control.
- No AI/Producer implementation. The constitutional permission policy stays
  intact: only a human can commit, reject, delete, replace, export, publish,
  or cause audible playback. Do not add an API bypass.
- Do not rewrite V0.3's single-active-`HTMLAudioElement` deck runtime. A new
  controller may own a separate, disposable `AudioContext` Ghost source; it
  must not put nodes, buffers, fetches, timers, abort controllers, or DOM in
  StateStore, SQLite JSON, or Action payloads.
- Do not add live warping, beat/phrase detection, source-selection UI,
  automatic separation, background GPU work, render-plan changes, 3+ tracks,
  undo/branch UI, or a production claim of end-to-end “sample accurate” sync.
- Preserve all V0.3 endpoints, media, migrations, and ordinary project-save
  semantics. Do not edit an applied migration. Add only numbered,
  transactional migrations. Tests and browser fixtures use `tmp_path`/
  temporary data roots exclusively; never create, migrate, clean, or inspect
  Richard's persistent data root except the existing read-only release test.
- Treat every request, JSON column, and asset URL as untrusted. No client path,
  absolute path, ffmpeg filter fragment, arbitrary stem name, or filesystem
  identifier reaches a subprocess or `FileResponse`.
- Hermes keeps work **uncommitted**: no tag, push, branch change, media change,
  or persistent-data-root change. Record commands and counts in a new
  `V1_DURABLE_ACOUSTIC_EVIDENCE.md` handoff, including limitations.

## Frozen integration decisions

### Project scope and canonical facts

Actions are project-scoped by URL, not by adding a mutable `projectId` to the
already-frozen Action envelope:

```text
POST /api/projects/{project_id}/actions
GET  /api/projects/{project_id}/action-state
GET  /api/projects/{project_id}/actions?after=<sequence>&limit=<1..200>
```

`action-state` returns a versioned, finite bootstrap projection:

```json
{
  "projection_version": 1,
  "last_sequence": 17,
  "session": {"deckAssignments": {}, "committedLayers": [], "acceptedActionIds": []},
  "proposals": {"byId": {}, "order": [], "activeIds": []}
}
```

The ordered SQLite ledger is historical truth. The returned projection is a
rebuildable acceleration/boot snapshot, not an alternative source of truth.
V1 proposal lifecycle facts created by the audio runtime (`scheduled`,
`auditioning`, cancellation) remain runtime/projection facts for this tri-phase;
they are not silently invented as new public Action types.

Use a new migration for an append-only action table and a current project
projection table. The ledger must include at least: monotonically increasing
per-project sequence, action ID, project ID, schema version, type, actor type
and ID, requested timestamp, idempotency key, canonical payload JSON, outcome
JSON, and recorded timestamp. Enforce a unique `(project_id, actor_type,
actor_id, idempotency_key)` constraint. Store JSON with deterministic key
ordering/separators only after strict validation. Store a projection version
and last applied ledger sequence. No raw runtime facts or asset bytes live in
either JSON blob.

Retry semantics are exactly those of Phase 8: identical actor/key/semantic
request returns the original recorded outcome; changed type or payload using
that same key fails loudly and creates neither ledger row nor projection
mutation. Scope idempotency to a project, so another project may use the same
key safely.

Python validates independently and strictly. Do not execute JavaScript on the
server and do not weaken the Node contract to fit Pydantic coercion. Create a
small pure Python Action validation/normalization module with the same accepted
wire names, ranges, unknown-field rejection, finite-number rule, region rule
`startBeat < endBeat` when both bounds are present, actor policy, lifecycle
preconditions, and stable public code vocabulary. Add shared valid/invalid JSON
contract-vector fixtures consumed by both Python and Node tests so deliberate
cross-language parity is demonstrable. Keep server-only failures separately
namespaced (for example project/asset/source availability); never return a
traceback or managed path.

The frontend may add a small API/hydration adapter and a new **narrow V1
reducer action** that replaces only `session`/`proposals` with validated,
deep-cloned server projection data. Boot may fetch `action-state` only after a
current project exists. It must be silent, abortable/teardown-safe, and leave
all existing views visually and behaviorally unchanged. On a failed hydration,
retain the empty/local V1 projection and report no fake success.

### First Ghost asset policy

A `preview_layer` is eligible for acoustic preparation only if all of these
server-resolved facts are true:

- its source deck maps to a real track in the scoped project (V1 mapping is
  `A = anchor`, `B = lead`);
- source `stem` is exactly `vocal` in the Action and resolves only to a
  completed, validated Demucs `vocals` stem. `center`/`sides` are never
  silently substituted or labelled vocal;
- both `startBeat` and `endBeat` are supplied, finite, non-negative, and
  strictly ordered; the source's effective BPM and beat-grid origin exist;
- destination track and effective BPM exist; source/destination grid revision
  facts are captured. Missing/manual grid metadata fails honestly rather than
  guessing phrase timing.

No request path may cause a Demucs run. The caller must first obtain a valid
vocal stem by the existing explicit separation flow. The first Ghost is tempo
stretched only: no pitch shifting, live DSP, gain baking, mixing, or phase
alignment. Its durable transform specification records enough immutable facts
to reproduce/inspect what was heard: source track content hash, stem-set/model
identity, semantic region, resolved source seconds/duration, source and target
BPM, tempo ratio, output sample format, grid revisions, and encoder/tool
version. It contains no absolute path or client-controlled command fragment.

For a source tempo `sourceBpm` and destination tempo `targetBpm`, use the
existing renderer-consistent `tempoRatio = targetBpm / sourceBpm`; slice the
source duration `(endBeat - startBeat) * 60 / sourceBpm` from the resolved
source offset, then apply the bounded `ffmpeg atempo` chain. A new small public
server helper may reuse/extract the safe renderer alignment primitive; do not
copy a second, divergent filter-chain implementation.

Generate an opaque asset ID and write under a dedicated managed
`ghost_assets/` root through a same-filesystem temporary file and atomic
replace. SHA-256 the completed bytes, decode-validate them with ffmpeg, then
record only the opaque ID, relative managed location, content hash,
transform-spec JSON, creation/expiry times, and proposal/project references.
Serve it only through an ID route such as
`GET /api/ghost-assets/{asset_id}/audio`; resolve by database row and strict
managed-root validation, never a supplied path. The preview response may expose
only `asset: {id, contentHash, transformSpec, audioUrl, expiresAt}`.

Preview assets are ephemeral by default and must never overwrite an existing
asset. Rejected/expired/unpinned assets may be garbage-collected only by an
explicit, test-covered service routine; accepted assets are pinned and cannot
be removed by that routine. A `commit_layer` must verify that its accepted asset
was prepared for the referenced proposal, hashes/spec match the server record,
is unexpired/decodable, and is then atomically pinned with the ledger/projection
write. Until Phase 9B creates an asset, commits fail with a stable availability
code—clients may not forge one.

### Scheduling truth

The runtime scheduler is a factory/testable controller, not a store slice and
not a second visible player. It receives an injected `AudioContext`, asset
loader/fetch, and destination-transport provider. It observes proposal
projection changes and schedules only a **human** proposal explicitly marked
`scheduled` by the narrow runtime/test seam. It never promotes `ready` itself,
never starts Producer work, and never commits.

After fetch/decode, it calls the existing pure `resolveNextPhrase()` with
explicit `audioContext.currentTime`, target Deck B facts, and the Phase 8
epsilon rule. It creates a disposable `AudioBufferSourceNode`, applies gain via
a controller-owned gain node, and calls `source.start(launchAudioTime)` once.
It emits semantic lifecycle facts only after successful scheduling; source
ended/cancel/fetch/decode failures clean up nodes and report structured runtime
failure without mutating durable session truth. A refreshed/removed/rejected
proposal, shutdown, or stale async response must cancel/disconnect its runtime
work and may never start later.

The controller exposes an immutable schedule receipt including proposal ID,
asset content hash, transport grid revision, resolved beat, and
`launchAudioTime`. This is proof of Web Audio scheduling intent. Do **not** call
it proof that physical speakers, device latency, two independent deck players,
or a full mix are sample-accurately aligned; headless CI cannot establish that.

## Phase 9A — Durable Action ledger, API, and reload hydration

Build the project-scoped SQLite ledger/projection service, strict HTTP contract,
and silent V1 bootstrap/hydration adapter. Write Python and Node tests first.

Deliver:

1. One new numbered transactional migration, repository-owned pure Python
   validation/normalization/projector/store modules, and narrow
   `StudioService` facade methods. Validate project existence, preserve the
   standard error envelope/status mapping, use parameterized SQL, and make the
   action append plus projection update one SQLite transaction.
2. `POST /api/projects/{project_id}/actions`, `GET .../action-state`, and a
   cursor/limit-bounded ledger read endpoint. Return IDs/sequences and
   canonical outcome/projection facts; no internal paths, stack traces, or
   unbounded history in boot response.
3. Shared JSON contract vectors and parity tests. The server rejects bad IDs,
   unknown/weakening fields, non-finite/coerced numerics, equal/reversed
   region bounds, invalid deck pairing/lifecycle, producer commit/reject, and
   changed idempotency reuse with zero partial mutation.
4. A small frontend API/hydration leaf. It deep-clones validated API data into
   only the V1 slices after project boot, and has testable handling for network
   errors, stale project responses, and teardown. It adds no visual controls
   and no general app-store rewrite.

Proof/exit gate:

- A human `preview_layer` creates one durable ledger record and a `ready`
  proposal. Repeat after application/service restart, then hydrate a fresh
  `StateStore` and prove proposal/session equality with the server projection.
- A human reject is durable provenance. Commit cannot be forged before an
  accepted server-managed asset exists. Existing Phase 8 Node proofs remain
  green.
- Migration is idempotent and a temp copy/fixture of the current V0.3 schema
  migrates without changing pre-existing table rows. Every automated database,
  browser fixture, and app uses a temporary data root.
- `pytest`, `npm test`, Python/JS syntax checks, and `git diff --check` are
  green. No audio render, media file, CSS, HTML, view, or visible Studio change.

## Phase 9B — Pre-rendered vocal Ghost asset backend

Build the managed asset preparation behind an accepted `preview_layer` request.
This is server-only; it does not schedule or play anything.

Deliver:

1. A dedicated managed asset root/table plus one new numbered migration. Add
   strict project/deck/track/grid/stem resolution and asset provenance/pinning
   helpers to the service layer. Record source semantic reference *and* exact
   immutable result identity.
2. A safe, bounded ffmpeg preparation helper based on the existing alignment
   primitive. All derived offsets, durations, ratio, sample rate/channels, and
   output extension come from validated server facts. Capture scrubbed ffmpeg
   failure detail only; clean staging files on every error/cancellation path.
3. Extend successful human `preview_layer` handling to prepare the asset before
   finalizing its outcome/projection, or use a clearly documented atomic
   prepare-then-append service transaction boundary that never publishes a
   half-written asset. Return the opaque asset descriptor in its result.
   Add guarded audio serving and explicit, safe cleanup/pin operations.
4. Make `commit_layer` verify-and-pin the prepared asset in the same durable
   operation as proposal acceptance and `CommittedLayer` projection update.
   A retry must return the original immutable result, never render again.

Proof/exit gate:

- Python fixture tests generate a known short PCM/WAV source and known vocal
  stem within `tmp_path`; assert exact server-selected slice (within documented
  codec/sample tolerance), expected stretched duration, decoded validity,
  content hash, transform-spec facts, opaque `audioUrl`, and no unmanaged path
  disclosure.
- Prove missing `vocals`, `center`/`sides`, missing beat-grid/BPM, invalid
  ranges, stale/wrong proposal asset, corrupt file, expiry, and path traversal
  are rejected without an ffmpeg call or partial DB/file state.
- Prove accepted asset pinning survives restart; rejected/expired unpinned
  assets are removed only by the explicit cleanup routine and are never served.
  Existing project/media/render behavior remains unchanged.
- Full Python and Node suites, exact targeted asset tests, `ffmpeg` decode
  check, syntax, and `git diff --check` are green. No browser/audio scheduling
  or UI change yet.

## Phase 9C — Deterministic Web Audio scheduling bridge

Connect the durable prepared asset to a controller-owned Web Audio scheduling
seam. There is still no visible way for an ordinary user to invoke it; a
test/programmatic harness supplies the explicit human scheduling request.

Deliver:

1. A leaf frontend runtime module (for example `js/runtime/ghost-scheduler.js`)
   and narrow API adapter that fetches the server asset, decodes it, derives
   the next phrase solely through Phase 8 transport modules, and schedules it
   with `AudioBufferSourceNode.start(launchAudioTime)`. Constructor dependencies
   are injected for Node/browser tests; no DOM imports and no runtime object
   enters StateStore.
2. A narrow application composition seam that is inert unless an explicit
   human/programmatic scheduling call supplies both destination Deck B
   transport and a resumed `AudioContext`. It must coexist with, not replace,
   `audioController` and its single HTML audio element. Do not expose it on
   `window`, ship a hidden button, or create a production autoplay path.
3. Cancellable/stale-safe asset fetch/decode/scheduling lifecycle management,
   including one scheduled source per proposal, cleanup on ended/reject/
   teardown, and immutable schedule receipts. Use a finite minimum lead-time
   policy; if decoding makes the computed boundary unsafe, re-resolve the
   following phrase rather than starting late.
4. Node unit tests with an injected fake context and a browser integration
   harness using system Chromium and temporary FastAPI data. The browser test
   dispatches a human action through the real API, obtains a prepared asset,
   explicitly resumes/provides a test `AudioContext`, supplies Deck B transport,
   and asserts the recorded `start()` argument exactly equals the controller's
   Phase 8 phrase-resolution receipt. It also proves source cleanup and no
   scheduling after reject/teardown/stale fetch.

Proof/exit gate:

- For deterministic supplied transport fixtures, a scheduled Deck B proposal
  produces one and only one `AudioBufferSourceNode.start()` at the next phrase
  boundary—not now, not a previously passed boundary, and not a visual timer.
  Test before/on/after boundaries, nonzero clock origins, and decode delay.
- The test proves the Web Audio scheduling call and receipt, not physical
  speaker output or full-mix sample accuracy. Document that limitation in the
  evidence handoff.
- Existing V0.3 playback still has one active `HTMLAudioElement`; V1 runtime
  buffers/nodes are absent from all state snapshots, ledger/projection JSON,
  API responses, and persistent records.
- `pytest`, `npm test`, the browser harness at desktop and mobile viewports,
  JS syntax checks, and `git diff --check` are green. Screenshots may be
  collected as test artifacts only; they must show no new Ghost UI.

## Sol acceptance blockers

Reject/fix if a client can write a path, an asset row/file becomes visible
before validation/atomic finalization, non-vocal center/side material is called
vocal, a preview causes automatic Demucs, ledger/idempotency state can diverge
from projections, mutable/runtime objects enter state or SQLite, commit accepts
a client-forged/stale asset, expired data is served, scheduling depends on a DOM
timer or implicit clock, stale async work starts a source, the controller claims
speaker/sample-accuracy proof, production autoplay appears, V0.3 playback is
rewritten, a visible Ghost affordance appears, or any test touches
`/home/richardn/.local/share/2become1`.

## Deferred after fresh sign-off

Human region selection and accessible Ghost controls, visual tether/clip,
manual release/retry UX, durable scheduling lifecycle/event model, exact
audition-to-render integration, render inclusion of committed layers, cleanup
policy UI, source/destination simultaneous transport, Producer proposal UI,
permissions/delegation UI, live warp, phase alignment, and broad phrase
detection all remain out of scope.

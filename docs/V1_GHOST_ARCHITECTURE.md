# V1 Ghost Action Architecture

- **Status:** Product blueprint; first visible Ghost preview completed in Phase 10
- **Captured:** 2026-08-27; implementation status updated 2026-08-29
- **Source:** Richard/Sol design conversation preserved in `Sol to Sol.txt`
- **First vertical slice:** Borrow a selected vocal phrase from Deck A and
  audition it temporarily over Deck B at the next phrase boundary

Implementation checkpoint: Phase 8 (`044cb03`) delivered the strict Action,
proposal, permission, reducer, provenance, and DeckTransport contracts. Phase 9
(`f110a2d`) delivered the durable SQLite ledger/projection, managed
pre-rendered vocal assets, reload hydration, and deterministic Web Audio
scheduling proof. Phase 10 delivered the first visible, human-only Ghost Phase
B workflow: bounded phrase selection, preview scheduling, status/tether, and
durable Release/Retry. Commit/acceptance, render parity, and Producer access
remain deferred. See `V1_ACTION_TRANSPORT_EVIDENCE.md`,
`V1_DURABLE_ACOUSTIC_EVIDENCE.md`, and
`../PHASE_10_VISIBLE_GHOST_UX_EVIDENCE.md` for exact scope and limitations.

## 1. Product rule

Producer gets no secret door.

Every actor requests musical changes through the same validated Action
contract:

```text
human gesture ─────┐
Producer intent ───┼──> Action ──> validation/permission ──> engine
MIDI control ──────┤
collaborator input ┘
```

If a human cannot express an operation through the Action system, Producer
cannot perform it either. AI may help select or parameterize an Action, but it
does not gain privileged access to audio, persistence, or project state.

This makes human authority, undo, provenance, history, explanation, and Ghost
previews properties of the Action system instead of AI-specific features.

## 2. The first Ghost

The initial operation should be deterministic and human-driven:

> Select a vocal phrase on Deck A, drag it to Deck B, and preview it beginning
> at the next musically valid phrase boundary.

The source deck continues independently. The borrowed phrase plays over the
destination for a bounded audition, initially 8 or 16 bars. The user can:

- **Commit:** accept exactly what was auditioned;
- **Retry:** create a revised proposal with different region, launch, or gain;
- **Release:** stop and reject it without changing the session.

A translucent visual tether remains connected to Deck A while the Ghost is
auditioning. It communicates source, destination, and temporary status without
requiring routing terminology. Acceptance removes the tether and renders the
new committed layer as durable session content.

The first implementation must not use AI. Producer should invoke this operation
only after the deterministic human path is proven.

## 3. State boundaries

2BECOME1 uses its existing framework-free `StateStore extends EventTarget`.
This design does not authorize Redux or another frontend framework.

```text
session state                 proposal state              runtime state
durable musical truth         serializable intent         disposable machinery
----------------------        ----------------------      ----------------------
committed layers              proposed Action             AudioNodes/buffers
deck assignments              actor + provenance          timers/schedulers
arrangement/mixer intent      lifecycle/status            AbortControllers
accepted Action refs          retry/supersession refs     geometry/animation
SQLite-backed                 bounded active set          controller-owned
```

Rules:

1. `session` contains only durable musical truth and remains SQLite-backed.
2. `proposals` contains small, normalized, serializable records. It may keep a
   bounded active set in the frontend while durable provenance lives in the
   backend action ledger.
3. `runtime` is not a StateStore slice. The audio/transport and visual
   controllers own nodes, decoded buffers, clocks, timers, requests, canvas
   geometry, and animation handles.
4. Store snapshots stay deep-cloned and reducers remain the sole mutation path.
5. Runtime controllers report semantic lifecycle events to the store; playback
   ticks and raw engine objects never become application truth.

An illustrative proposal—not a frozen schema—is:

```json
{
  "id": "proposal-184",
  "action": {
    "type": "preview_layer",
    "source": {"deck": "A", "stem": "vocal", "region": "chorus_2"},
    "destination": {"deck": "B"},
    "timing": {"launch": "next_phrase", "quantize": true},
    "gain_db": -3
  },
  "proposed_by": {"type": "human", "id": "richard"},
  "status": "ready",
  "supersedes": null
}
```

Possible active lifecycle:

```text
ready -> scheduled -> auditioning -> accepted
   |          |             |
   +----------+-------------+-> rejected
   +----------+-------------+-> expired
```

Lifecycle transitions must be explicit and validated. A proposal record is
immutable apart from its lifecycle projection; revised musical parameters
create a new proposal linked through `supersedes`.

## 4. Acceptance is a new Action

Commit must not rewrite `proposal-184` from `ghost` to `solid`. Acceptance emits
a distinct committed Action referencing the exact proposal:

```text
preview_layer proposal-184
  proposed by: Producer
  auditioned by: Richard
  source: A / vocal / chorus_2
  destination: B
  launch: phrase_17
             |
             v
commit_layer action-185
  proposal: proposal-184
  accepted by: Richard
```

That separation allows the project to answer truthfully:

- who proposed the operation;
- who auditioned it;
- what exact parameters were heard;
- who accepted or rejected it;
- which committed Action changed the production.

Explanations should be generated from this recorded provenance. Producer must
not invent a plausible rationale after the fact.

## 5. Action execution contract

The Action layer should distinguish three concepts:

- **Request:** actor-authored intent, not yet trusted or scheduled;
- **Proposal:** validated, permission-checked, reproducible audition intent;
- **Committed Action:** accepted durable change applied to session state.

Execution should be idempotent where practical and use stable IDs so UI retries
cannot create duplicate layers. Validation must cover actor permission, source
availability, destination compatibility, region bounds, timing data, and safe
gain limits before the engine receives the request.

The engine returns facts—resolved source, phrase/grid revision, scheduled
transport time, actual duration, and failure reason—rather than silently
repairing invalid intent. Those facts become provenance.

## 6. Timing and transport reality

Scheduling an already decoded buffer against `AudioContext.currentTime` is only
the smallest part of this feature. A trustworthy Ghost also requires:

- one authoritative transport clock;
- compatible beat and downbeat grids with explicit revisions;
- phrase boundaries or an honest manual fallback;
- source-to-output time mapping;
- tempo matching/time-stretch policy;
- phase alignment and latency handling;
- cancellation that removes the Ghost without disturbing either deck;
- deterministic agreement between what is previewed and what is committed.

"Sample-accurate" must not be claimed for the complete experience until those
conditions are measured. Serato/Ableton-class live warping is not an incidental
extension of the existing server-render pipeline.

The target domain model gives each deck a musical transport independent of the
current playback implementation:

```text
DeckTransport
  playhead
  playing
  tempo
  beat_phase
  phrase_position
  started_at_audio_time
```

Layers follow a destination transport. The current single-active-player rule
may remain as a pragmatic V0.3 UI/runtime invariant, but it must not be encoded
as permanent Action, MusicalObject, or persisted-session semantics. This is a
future target, not authorization to rebuild V0.3 playback.

## 7. Implementation sequence and current status

Completed foundations do not authorize the remaining product work. Every new
phase still requires a repository-aware, Richard-approved plan.

### Ghost Phase A — Action and transport contracts

**Foundation complete (Phase 8); human preview integration completed in Phase
10. Producer integration remains deferred.**

- model actors, requests, proposals, lifecycle events, and committed Actions;
- define permission, idempotency, provenance, and failure contracts;
- choose the transport/clock and phrase-boundary truth model;
- prototype with synthetic fixtures and no new production UI.

### Ghost Phase B — Deterministic human preview

**Completed in Phase 10:** the Phase 9 acoustic backend/scheduler proof is now
wired into the visible, accessible human workflow.

- implement selected-region drag from A to B;
- schedule one bounded Ghost vocal against the destination transport;
- add the visual tether and accessible non-drag equivalent;
- support release and retry without durable project mutation.

### Ghost Phase C — Acceptance and Producer parity

**Partially founded:** durable human commit verification/pinning exists; undo,
render parity, visible acceptance UX, and Producer access remain unimplemented.

- commit by emitting a new Action that references the proposal;
- persist the action ledger and committed layer relationship;
- prove undo/reload/render parity and exact audition provenance;
- only then allow Producer to request the same `preview_layer` Action.

Each phase needs a separate, repository-aware implementation plan and exit gate.

## 8. Explicit non-goals for the first Ghost

- unrestricted multitrack DAW editing;
- arbitrary plugin graphs, buses, or automation lanes;
- AI-only operations or hidden audio-engine access;
- generative audio;
- automatic acceptance of Producer suggestions;
- storing Web Audio objects or animation state in StateStore;
- claiming universal phrase detection or production-grade live warping before
  it exists and is measured.

## 9. Design defaults for the first implementation plan

These are target semantics, not immediate implementation commandments. A future
repository-aware plan may refine them when evidence requires it, but it must
report any departure explicitly.

### 9.1 Derived suggestions, manual authority

V1 accepts server-derived phrase/downbeat markers as suggestions and allows the
user to edit or replace every derived boundary. Manual region selection invokes
the same `preview_layer` Action as an automatically suggested region. Low
confidence or missing phrase analysis must never block an exact manual Ghost.

### 9.2 Pre-render the first Ghost

The Hello World Ghost uses a derived preview asset prepared before launch, then
schedules that decoded buffer precisely. This isolates Action, proposal,
transport, and acceptance behavior from the separate difficulty of live
time-stretching. A later live-warp engine may replace the implementation behind
the same Action contract without changing its user-facing semantics.

### 9.3 Deck-owned musical transport

Deck transport is the future authoritative clock model. The V0.3
single-active-player implementation remains temporarily valid, but is not a
domain constraint. No Phase 7 work should rebuild it merely to anticipate
Ghosts.

### 9.4 Persist facts; expire heavyweight previews

Accepted proposals remain as durable lightweight provenance. Rejected proposals
also remain as compact history by default, subject to a future explicit
retention/privacy policy. Decoded buffers and derived preview assets may be
garbage-collected when they are rejected, expired, unpinned, and unreferenced by
a committed session.

The durable record keeps actor, Action parameters, source/destination,
lifecycle result, timestamps, and relevant engine facts. It does not keep raw
runtime objects.

### 9.5 Acceptance stores meaning and acoustic identity

A committed layer references both:

```text
CommittedLayer
  source_region_ref     # semantic meaning: vocal / chorus_2 / bars 33-49
  accepted_asset_id     # immutable identity of exactly what was auditioned
  transform_spec        # reproducible preparation and placement parameters
```

The semantic reference remains understandable and editable. The immutable
asset identity prevents a historical production from changing when analysis,
beat grids, source files, or separation models evolve. Asset identity requires
content hashing and enough transform/tool provenance to verify reproducibility;
an ID alone is not proof.

### 9.6 Committed layers are first-class session inputs

Accepted layers are not ad-hoc properties attached to Deck B. The deterministic
render plan resolves base deck assignments, committed layers, transforms, and
ordered Actions. Retry uses the same accepted assets and parameters. Branching
or `new mix` may reference the state without mutating the original session.

### 9.7 Producer proposes; humans commit

The initial permission policy is constitutional:

```text
READ STATE       Producer allowed
ANALYSE          Producer allowed
CREATE PROPOSAL  Producer allowed
CREATE GHOST     Producer allowed within user-invoked/session permission
AUDITION         Producer allowed within user-invoked/session permission

COMMIT           human confirmation required
DELETE           human confirmation required
REPLACE SOURCE   human confirmation required
EXPORT/PUBLISH   human confirmation required
```

Producer must not begin unsolicited audible playback merely because it may
create proposals. Ghost creation/audition occurs within a visible user-invoked
mode or explicit session permission. Later delegation may authorize bounded
Action classes, but delegation is itself a visible, recorded, reversible human
Action with clear scope and expiry.

### 9.8 Action ledger and reduced state

The ordered append-only Action ledger is historical truth. The reduced
StateStore projection is current working truth. Durable projections and
periodic snapshots accelerate startup and recovery without replacing the
ledger's provenance role.

SQLite can store all three: the canonical Action ledger, current durable
session projections, and recovery snapshots. The distinction is semantic, not
a requirement for separate storage technologies.

Every committed Action records its input contract and resulting durable facts.
Projection rebuilding must be versioned and testable; snapshots identify the
ledger position and reducer/schema version from which they were derived. UI
rendering consumes the current projection and must not replay an unbounded log
on every repaint.

This model enables evidence-backed undo, branching, explanations, and eventual
collaboration without prematurely requiring distributed event sourcing or
multi-user merge semantics in the first Ghost.

## 10. Frozen first-Ghost bias

The default vertical slice is therefore:

```text
manual-or-derived region
  -> pre-rendered vocal Ghost
  -> deck-owned musical clock
  -> ephemeral active proposal
  -> human acceptance
  -> semantic reference + immutable accepted asset
  -> first-class committed layer
  -> append-only Action ledger + reduced session projection
```

Producer may request the same proposal/audition path only after the human path
works, and may not commit it without explicit human authority.

These defaults preserve a long-term north star without expanding or rewriting
the V0.3 Phase 7 release scope.

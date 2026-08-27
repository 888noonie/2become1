# 2BECOME1 V1 — Action and Deck-Transport Foundation

**Audience:** Hermes (implementation owner)  
**Baseline:** `v0.3.0` at `216bc4a` (tagged and CI-green)  
**Status:** Approved tri-phase implementation specification

## Mission and hard boundary

Build a headless, deterministic foundation for the first human Ghost: a validated
musical Action contract, serializable session/proposal projections, and pure
deck-transport math. Prove it with Node tests. Do not build a Ghost.

The bounded proof is: given a valid proposal and a Deck B transport, what
history/projection facts change and what supplied-clock timestamp is the next
phrase boundary?

- Read `CODEX.md`, `docs/V1_GHOST_ARCHITECTURE.md`, `state.js`, `audio.js`,
  `project.js`, and relevant tests first. Preserve `Sol to Sol.txt` untracked.
- Use native ES modules and the existing `node --test` harness. No Redux,
  framework, schema dependency, or build step.
- Do not change HTML, views, CSS, visible Studio behaviour, browser screenshots,
  Python/API, SQLite migrations, audio playback, version, media, or persistent
  data. No user-facing control of any kind.
- `runtime` is controller-owned, never a StateStore slice. State must never hold
  audio contexts/nodes/buffers/elements, timers, DOM, requests, abort controllers,
  animation handles, or geometry.
- Reducers remain the only store mutation path; snapshots/results deep-clone.
  Invalid input must not partly mutate projection or ledger.
- Producer has no secret door: it may only propose when explicit permission is
  passed in; it can never commit, delete, replace, export, publish, or start
  playback here.
- Do not read a real clock or claim sample-accurate Ghost scheduling. This is
  numerical planning from explicit facts only.
- Hermes keeps work uncommitted: no tag, push, branch/media/data-root change.

## Frozen contract

Additive V1 StateStore seam; do not migrate V0.3 views in this handoff:

```text
state.session:   deckAssignments, committedLayers, acceptedActionIds
state.proposals: byId, order, activeIds
runtime:         future clock/scheduler/buffers/nodes/timers/visuals, outside state
```

`session` is durable-shaped, not durable yet. `proposals` is a bounded working
projection. A separate backend phase will make SQLite Action ledger/projections
canonical. The constitutional bottleneck applies to new V1 *musical* mutations,
not an unsafe rewrite of ordinary V0.3 routing/loading/autosave state.

Pure validator/normalizer; inject `now()` and `idFactory()`:

```js
{ id, schemaVersion: 1, type, actor: { type, id }, requestedAt,
  idempotencyKey, payload }
```

Only these types exist now:

```js
preview_layer: {
  source: { deck: 'A'|'B', stem: 'vocal', region: regionRef },
  destination: { deck: 'A'|'B' }, // source and destination differ
  timing: { launch: 'next_phrase', quantize: true }, gainDb: -24..12
}
commit_layer: { proposalId, acceptedAsset: { id, contentHash, transformSpec }, acceptedAt }
reject_proposal: { proposalId, rejectedAt, reason?: boundedPlainText }
```

`regionRef` is semantic—not samples—with non-empty `id` and optional `label`,
`startBeat`, `endBeat`, `gridRevision`; numerical bounds must be finite,
non-negative, and ordered. Reject bad IDs, actor/type, nonserializable values,
unknown weakening fields, gains, deck pairing, bounds, and lifecycle states with
structured codes, never UI copy/implementation exceptions.

Permissions and lifecycle:

| Action | Human | Producer |
| --- | --- | --- |
| `preview_layer` | allowed | only `producerPreviewAllowed === true` |
| `commit_layer` | allowed | denied, `ACTOR_NOT_ALLOWED` |
| `reject_proposal` | allowed | denied |

```text
ready -> scheduled -> auditioning -> accepted
  |          |             |
  +----------+-------------+-> rejected
```

No audio is scheduled. A lifecycle helper models scheduled/auditioning facts.
Commit requires `auditioning`, retains the preview, creates a distinct committed
Action and first-class layer. Revision makes a new proposal linked by
`supersedes`, never edits musical parameters. Same actor/idempotency key/same
semantics returns the original result; changed reuse fails.

Create injected in-memory `ActionLedger` (`append`, `findByIdempotencyKey`,
`entries`) as an explicit temporary stand-in for SQLite. Dispatcher order:

```text
raw request -> validate -> permission/idempotency -> optional transport fact
-> immutable ledger outcome -> reducer projection -> deep-cloned result
```

Transport is pure and supplied:

```js
{ deck: 'A'|'B', playing, tempoBpm: 20..300, beatsPerBar: 1..16,
  phraseBars: 1..64, beatAtStart, startedAtAudioTime, gridRevision }
```

Derive `playhead`, `beat_phase`, `phrase_position` at supplied `nowAudioTime`:

```text
beatsPerSecond = tempoBpm / 60
beatAt(t) = beatAtStart + (t - startedAtAudioTime) * beatsPerSecond
phraseBeats = beatsPerBar * phraseBars
```

`resolveNextPhrase()` returns `launchAudioTime`, `launchBeat`, `phraseIndex`,
grid revision and normalized facts. Stopped transport returns
`TRANSPORT_NOT_PLAYING`. An exact phrase boundary means the *following* phrase;
document a small floating-point epsilon. No `AudioContext`, timers, or
`audioController.play()`.

## Phase 8A — Action contract and projection

Deliver a leaf `js/actions/` module family (pure: no DOM/fetch/audio/app/view
imports); additive serializable `session`/`proposals` initial slices and narrow
reducers in `state.js`; validation, permission, transition table, immutable
proposals/revisions, error codes, and semantic idempotency comparison.

Write focused Node tests first for valid/invalid contracts, cloning, lifecycle
legality, immutable revision, Producer denial, and invalid input causing exactly
zero projection change.

Do not add dispatcher/ledger integration, transport, API/UI/browser-test/CSS/
HTML/view change, or persistence claim.

Exit: `npm test` green; test evidence shows human preview becomes `ready`, only
a valid event reaches `auditioning`, no in-place musical edit occurs, and all
rejected payloads retain the exact prior StateStore snapshot.

## Phase 8B — deterministic deck transport planner

Deliver isolated pure `js/transport/` modules for normalized transport, derived
position, and next-phrase resolution. Return structured facts/failures, never
silent repair. Preserve grid/tempo facts for future provenance. Document that
this computes numerical planning, not audio scheduling.

Test synthetic A/B fixtures at 60, 120, and 137.5 BPM; varied signatures and
phrase lengths; nonzero origins; before/on/after boundaries; stopped/invalid
input; grid mismatch; epsilon determinism.

Do not use Web/HTML audio, timer/rAF, live warp, beat detection, server analysis,
visible transport control, or alter V0.3's single-active-player runtime rule.

Exit: `npm test` green. Prove Deck B at beat 16 on 4/4 and 8-bar phrases gives
beat 32 with mathematically correct float time; exactly beat 32 gives beat 64.
No real clock/audio is touched.

## Phase 8C — dispatcher, ledger, provenance proof

Deliver factory-created injected `ActionLedger` and `ActionDispatcher`, but do
not mount them into Studio or app boot. Dispatcher follows the frozen order and
uses reducers for every V1 projection update. Preview creates normalized
proposal/provenance/optional launch fact/supersedes only; runtime work is absent.
A test-only lifecycle path records scheduled then auditioning facts.

Human commit requires auditioning, retains/accepts original proposal, appends a
distinct ledger record, and inserts `CommittedLayer` with `sourceRegionRef`,
immutable accepted asset (`id`, hash, transform spec), placement/action refs,
and stable ID. Rejection retains history and removes the proposal from active.

Add integration Node proof:

```text
human preview -> ready -> scheduled/auditioning -> human commit
-> original proposal retained/accepted -> distinct commit ledger event
-> session.committedLayers contains durable-shaped first-class layer
```

Also prove explicit Producer preview permission, Producer commit denial,
idempotent retry, changed-key reuse failure, rejected provenance, and cloned
return/snapshot values.

Do not add SQLite/API/UI/drag/tether/accessibility UI/source selection/audio
decode or scheduling/pre-render/warp/reload-durability claim.

Exit: all Node tests pass; syntax-check new modules; `git diff --check` clean.
Handoff lists files and exact command/count evidence and explicitly confirms no
UI/CSS/HTML/backend/migration/media/persistent-data/real-audio change.

## Sol acceptance blockers

Reject/fix if validation mutates before failure; Producer can commit/audibly act;
proposals mutate instead of superseding; commit overwrites preview; layer misses
semantic region plus immutable asset/transform identity; StateStore holds runtime
objects; timing reads implicit real time or launches immediately on boundary;
visible Ghost work appears; or any fixture touches
`/home/richardn/.local/share/2become1`.

## Deferred after fresh sign-off

SQLite ledger/projection persistence; region selection; pre-rendered preview
assets; user-invoked audition scheduling; visual/accessibility Ghost affordances;
reload/render parity; then bounded Producer parity. Live warp, broad phrase
detection, multitrack DAW behaviour, and autonomous Producer action remain out.

# 2BECOME1 V1 — Phase 11: Solid Ghost (Commit, Render, Undo)

**Audience:** Hermes (implementation owner); Sol (auditor); Richard (approval)
**Baseline:** `v0.3-workspace` at `4189dcc` ("Complete Phase 10 visible Ghost UX").
Phase 8 `044cb03`, Phase 9 `f110a2d`, Phase 10 `4189dcc` accepted; CI green
(398 Python, 239 Node, 18/18 Ghost UX both viewports, 8/8 Ghost scheduler,
30/30 V0.3 acceptance).
**Status:** IMPLEMENTED AND SOL-AUDITED LOCALLY — all binding amendments and
acceptance gates are evidenced in `PHASE_11_SOLID_GHOST_EVIDENCE.md`.
**Architecture reference:** `docs/V1_GHOST_ARCHITECTURE.md` §2, §7 (Ghost Phase C),
§9.4–9.8; this plan implements Ghost Phase C (commit, render parity, undo) and
explicitly does NOT implement Producer access (§9.7 stays deferred).

## Mission and hard boundary

Turn the temporary Ghost audition into durable, reversible session truth. The
bounded vertical slice:

```text
audition a vocal phrase over Lead (Phase 10, unchanged)
  -> human Commit (commit_layer) using the EXACT asset/hash/transform/region/
     gain/resolved-launch heard during audition
  -> server verifies + pins the immutable asset transactionally
  -> committed layer becomes a first-class input to the server-authored render
  -> render from the pinned asset (never regenerated), preserving placement/
     duration/gain/transform provenance exactly
  -> hydrate committed layers after browser + server restart
  -> human Undo (revert_commit) removes the layer from the render projection
     while retaining full provenance (append-only, no deletion)
```

The acceptance principle (verbatim from the mission):

> The exact Ghost Richard hears is the exact immutable asset that becomes
> session truth, appears after reload, enters the exported mix, and can be
> reversed without erasing history.

### Non-negotiable boundaries (carry-forward + new)

- **Ghost Phase C only.** No Producer access, no delegation UI, no automatic
  acceptance, no AI-generated musical decisions. §9.7 (Producer proposes;
  humans commit) stays deferred to a later phase.
- **The frozen Action contract is extended by exactly ONE type.** Phase 10
  froze the contract at `preview_layer` / `commit_layer` / `reject_proposal`.
  Phase 11 adds `revert_commit` (append-only reversal). This is the ONLY
  contract change, and it is explicitly authorized by the Phase 11 mission.
  No other new types, no `supersedes` field, no mutation of existing types.
- **No history deletion.** The `actions` ledger is append-only. `revert_commit`
  appends a new row; it never deletes or mutates the `commit_layer` row or the
  pinned asset. Reverted layers retain full provenance in the projection.
- **No live warping, no phase alignment, no transport rewrite, no automatic
  stem separation, no arbitrary layer editing, no plugin graph, no DAW
  timeline.** The render consumes the already-prepared pinned asset; it never
  re-runs Demucs or re-separates on a request path.
- **Single-active-`HTMLAudioElement` runtime unchanged.** The Ghost owns its
  separate disposable `AudioContext` + `GhostScheduler` (Phase 10). No runtime
  object (context, node, buffer, timer, fetch, controller, DOM) enters
  StateStore, SQLite JSON, or Action payloads. The store receives only
  serializable semantic facts (architecture rule 5).
- **No new autoplay path.** Commit and Undo are pure durable writes; they
  never create or resume an AudioContext.
- **Uncompressed frontend static allowance is strictly capped at 500 KB.**
  Current JS is ~354 KB (measured 2026-08-29). Phase 11 must stay under 500 KB;
  the gate is measured in the evidence file.
- Preserve all V0.3 endpoints, media, migrations, and project-save semantics.
  Add only numbered, transactional migrations. Every automated database,
  browser fixture, and test uses `tmp_path`/temporary data roots; never touch
  `/home/richardn/.local/share/2become1`. The server stays loopback-only.
- DOM is built with DOM APIs and `textContent`; never `innerHTML` for data.

### Grounding note (what already exists — do not rebuild)

The backend commit path is ALREADY implemented and tested in Phase 9B/10A:

- `actions.py` validates `commit_layer` (`_validate_commit_payload`,
  `_validate_accepted_asset`) and builds the committed layer
  (`make_committed_layer`).
- `action_store.py` `_apply_to_projection` has the full commit branch
  (lines 493–539): requires `auditioning` precondition, calls the asset
  verifier, pins the asset, appends `committedLayers` + `acceptedActionIds`,
  sets `proposal.committedActionId`, transitions to `accepted`.
- `ghost_assets.py` `verify_and_pin` (lines 498–554) verifies the claimed
  asset against the server's prepared record (ID + content hash), decode-
  validates the bytes, re-hashes, and pins atomically in the caller's
  transaction.
- `reducers.js` has `V1_PROPOSAL_COMMIT_RECORDED` and `makeCommittedLayer`.

What is MISSING (the actual Phase 11 work):

- No visible Commit control (ghost-card.js has only Release/Retry).
- No `buildCommitAction` in api.js; no `commit()` method on GhostController.
- No committed-layer render integration (render plan resolves only anchor +
  lead; `RenderOptions` has no committed-layer field).
- No `revert_commit` Action type, no undo control, no reverted-layer projection.
- No render-parity tolerance measurement.

---

## Phase 11A — Human Commit

### UX

- Add a **Commit** control to the Ghost status card (`ghost-card.js`), beside
  Release and Retry. It is visible only when the proposal is in `auditioning`
  (or `ended` with a recorded auditioning fact — see the "resolved launch"
  note below). It is disabled while a commit is in flight.
- On Commit, the card transitions to a `committing` phase, then to a durable
  `committed` state showing the committed layer (source region, gain, launch
  beat, pinned asset identity). The decorative tether is removed; the
  committed layer is represented by a durable committed-layer entry in the
  session (Deck B / committed-layers list), not by the transient tether.
- The Commit control is keyboard/AT reachable (a real `<button>`, not a
  canvas hitbox), matching the Phase 10 Release/Retry accessibility bar.

### Ledger

- Add `buildCommitAction(proposalId, acceptedAsset, acceptedAt)` to `api.js`,
  mirroring `buildRejectAction`. It emits the frozen `commit_layer` envelope:
  `{ id, schemaVersion: 1, type: 'commit_layer', actor: {type:'human', id},
  requestedAt, idempotencyKey, payload: { proposalId, acceptedAsset:
  { id, contentHash, transformSpec }, acceptedAt } }`.
- The `acceptedAsset` is taken VERBATIM from the generation's prepared asset
  (`generation.asset` = `{ id, contentHash, transformSpec }`), which the server
  already returned from the preview POST. The client never invents or
  re-derives the hash/transform — it echoes the server's own record.
- The "resolved launch heard during audition" is captured from the
  `auditioning` lifecycle fact (Phase 10A already records `assetId`,
  `contentHash`, `launchBeat`, `launchAudioTime`, `gridRevision`). Commit
  requires that fact to exist: a proposal that never reached the launch
  boundary (still `scheduled`/`armed`) is NOT committable — the Commit control
  is hidden and the controller refuses with an honest error. This enforces
  "the exact Ghost Richard hears" — you can only commit what actually played.

### Backend (verify + pin transactionally)

- No new backend commit logic is required; the existing `verify_and_pin` +
  `_apply_to_projection` commit branch already does the transactional
  verify-and-pin. Phase 11A adds tests that pin the following invariants
  explicitly (some are already covered; the plan makes them acceptance gates):
  - The accepted asset's `id` and `contentHash` must match the server's
    prepared record for that proposal (`S_ASSET_MISMATCH` otherwise).
  - The asset bytes are decode-validated and re-hashed before pinning; a
    corrupt/missing file fails the commit (`S_ASSET_UNAVAILABLE` /
    `S_ASSET_MISMATCH`), never silently pins.
  - The pin (`pinned = 1`) joins the SAME SQLite transaction as the ledger
    append + projection update, so a failed commit leaves no half-pinned asset.
  - A pinned asset is exempt from TTL GC (`cleanup_expired` and
    `delete_for_proposal` already skip `pinned` rows).

### Safety (outcome barrier + idempotency)

- **Commit/Release race (outcome barrier).** Both `commit_layer` and
  `reject_proposal` are terminal transitions on the same proposal. The server
  already serializes them: commit requires `auditioning` (else
  `L_NOT_AUDITIONING`), reject requires non-terminal (else
  `L_INVALID_TRANSITION`). The controller adds a single in-flight
  terminal-transition barrier per generation (extending the existing
  `_rejectDurably` memoization): Commit and Release both route through it, so
  only one terminal transition is in flight at a time. The loser reconciles
  against the server's authoritative state:
  - Commit loses to Release → the proposal is `rejected`; the controller
    reports an honest "released before commit" (no fabricated success, no
    silent retry).
  - Release loses to Commit → the proposal is `accepted`; Release reports
    "already committed" (the existing `L_INVALID_TRANSITION` reconciliation
    path already treats this as a durable-success equivalence).
- **Idempotency (double-click / network retry).** The commit envelope is
  memoized per generation (built once, reused on retry), exactly like
  `_rejectDurably` memoizes `rejectAction`. A double-click or network retry
  re-POSTs the SAME envelope; the server's `_find_idempotent_row` +
  `compare_actions` returns the replay result without creating a second
  committed layer. The Commit button is disabled while `committing` is true.
- **No duplicate layers.** The `acceptedActionIds` list and the
  `committedLayers` append are guarded by the idempotency check; a replayed
  commit never appends a second layer.

---

## Phase 11B — Reload and Render Parity

### Render engine (committed layers as first-class inputs)

- Extend the server-authored render plan (`studio.py` `_compute_arrangement` /
  `plan_render`) and `RenderOptions` to accept the project's committed layers
  as additional inputs. The plan resolves, for each non-reverted committed
  layer, its pinned asset path, its output placement, its output duration, and
  its gain — all from the durable committed-layer record, never from a fresh
  separation or a client-supplied path.
- `POST /api/renders/plan` and `POST /api/renders` gain an optional
  `committed_layers` field (or the server reads committed layers directly from
  the project's action-state projection — see the judgment call below). The
  read-only plan and the real render share the SAME resolution code (the
  existing "single source of truth" invariant in `_compute_arrangement`).

### Acoustic truth (render from the pinned asset, never regenerate)

- The render consumes the pinned asset bytes (`ghost_assets` row with
  `pinned = 1`), resolved by opaque asset ID through the managed root only
  (zero-trust path validation, as in `asset_path`). It never re-runs Demucs,
  never re-slices the source stem, never re-stretches from the source BPM.
- Placement, duration, gain, and transform provenance are preserved exactly
  from the committed-layer record. The exact render math is specified below
  and pinned by a cross-language parity test (mirroring the Phase 10
  beat↔seconds parity test).

### Exact render math (committed layer)

A committed layer's durable facts (from `make_committed_layer` + the pinned
asset's `transformSpec` + the `auditioning` lifecycle fact):

- `transformSpec.targetBpm` — the destination (Lead) BPM at preview time.
- `transformSpec.sourceDurationSeconds` — the source-grid slice length.
- `transformSpec.semanticRegion.{startBeat,endBeat}` — the source region.
- `placement.gainDb` — the auditioned gain (dB).
- `launchBeat` — the resolved launch beat on the destination grid (from the
  `auditioning` fact).

The pinned asset is `span = endBeat - startBeat` beats long at `targetBpm`
(its duration is `span * 60 / targetBpm` seconds — the Phase 9B stretch already
normalized it to the destination tempo).

In the render, the output BPM is `output_bpm` (from `tempo_mode`), and the
Lead is stretched by `lead_tempo_ratio = output_bpm / lead_bpm`. Because
`targetBpm == lead_bpm` (the destination IS the Lead), the committed asset is
stretched by the SAME `lead_tempo_ratio` to land on the output grid:

```text
committed_tempo_ratio = lead_tempo_ratio = output_bpm / targetBpm
committed_output_start = lead_output_start
    + (lead_first_beat + launchBeat * 60 / targetBpm - lead_start)
      * lead_tempo_ratio
committed_output_duration = span * 60 / targetBpm * lead_tempo_ratio
                          = span * 60 / output_bpm
committed_gain_linear = 10 ** (gainDb / 20)
```

where `lead_first_beat` is the Lead's `beat_grid.first_beat` (seconds),
`lead_start` is the render's Lead cue, and `lead_output_start` is 0 (overlay)
or `transition_start` (transition). The committed layer is mixed as an
additional delayed source into `build_mash` (extended to accept N committed
sources, each with its own delay + gain), then passes through the shared
loudness/true-peak limiter exactly like the anchor/lead.

**Gain range note (judgment call):** the preview `gainDb` range is
`[-24, +12]` dB, but `build_mash`'s `_channel_chain` caps linear gain at
`[0, 2]` (≈ +6 dB). The committed-layer gain path must accept the full
`[-24, +12]` dB range (converting to linear without the 0..2 cap), or the
render must document and enforce a narrower committed-gain bound. This is
flagged for Sol; the default recommendation is to allow the full dB range on
the committed-layer path only (the anchor/lead 0..2 linear controls are a
separate, unchanged axis).

### Resilience (hydration + hard failure on missing/corrupt asset)

- Committed layers already hydrate through `GET /api/projects/{id}/action-state`
  → `session.committedLayers` (Phase 9A hydration). Phase 11B verifies that a
  committed layer survives browser reload AND server restart: the pinned asset
  is exempt from TTL GC, and the projection rebuild (`rebuild_projection`)
  replays the `commit_layer` action to restore `committedLayers` without
  re-running filesystem/subprocess side effects (the existing `replaying=True`
  path).
- **Hard failure, never silent omission.** When the render plan resolves a
  committed layer whose pinned asset is missing or whose bytes no longer match
  the recorded `contentHash`, the plan/render FAILS with a clear, stable error
  (e.g. `S_ASSET_UNAVAILABLE` / `S_ASSET_MISMATCH`), naming the layer. It never
  silently drops the layer from the mix. The UI surfaces this honestly (the
  committed layer is shown as "asset missing/corrupt", and the render is
  blocked until the human resolves it).

### Testing (parity within a measured tolerance)

- Prove that **preview**, **committed playback**, and **exported render** agree
  within an explicitly measured and documented tolerance. Because all three
  consume the SAME pinned asset bytes, the tolerance is dominated by:
  - gain application (Web Audio `GainNode` vs ffmpeg `volume`), and
  - the render's loudness/true-peak limiter (preview has no limiter).
- The parity test measures the committed asset's decoded PCM against the
  render's committed-layer contribution (isolated via a render with the
  anchor/lead gains at 0 and the committed layer alone), and asserts a
  documented tolerance (e.g. ±0.5 dB RMS on the committed layer, excluding the
  limiter). The exact tolerance is a judgment call for Sol; the plan requires
  it to be measured and written into the evidence file, not asserted.

---

## Phase 11C — Reversible Creative History

### Action contract (one append-only reversal Action)

- Add `revert_commit` to `ACTION_TYPES` (both `actions.py` and
  `contracts.js`), with payload `{ commitActionId, revertedAt, reason? }`.
  Validation mirrors `reject_proposal`: `commitActionId` and `revertedAt` are
  required non-empty strings; `reason` is an optional non-empty string.
- `revert_commit` is append-only: it appends a new ledger row and NEVER
  deletes or mutates the `commit_layer` row, the pinned asset, or the
  proposal's `committedActionId`. The pinned asset is retained (it is
  provenance; GC must not remove it while a revert references it — see the
  judgment call on asset retention).

### Projection (remove from render, retain provenance)

- `_apply_to_projection` (and the mirroring `reducers.js` reducer) handles
  `revert_commit`:
  - Find the committed layer by `commitActionId` in `session.committedLayers`.
    If absent (already reverted, or unknown), the transition is replay-
    idempotent (no-op) or a `L_UNKNOWN_COMMIT` error — never a double-revert.
  - Move the layer from `session.committedLayers` to a new
    `session.revertedLayers` list, retaining the FULL layer object unchanged
    (provenance preserved). Mark the proposal's committed layer as
    `revertedBy: <revertActionId>`.
  - The render projection (Phase 11B) reads only `committedLayers`; reverted
    layers are excluded from the mix but remain in the ledger + projection.
- `rebuild_projection` replays `revert_commit` naturally (append-only replay),
  so a reverted layer stays reverted after a rebuild.

### UX (accessible Undo with honest confirmation + status)

- Add an **Undo** control for each committed layer (in the committed-layers
  list / Deck B representation). It is a real `<button>`, keyboard/AT
  reachable, with an honest confirmation ("Undo this committed Ghost? The
  layer is removed from the mix but its history is kept.") and a clear status
  after the revert (layer shown as reverted, not deleted).
- Undo is one-way in this phase: a reverted layer stays reverted. Re-committing
  the same phrase is a NEW `preview_layer` → `commit_layer` cycle (a new
  proposal), not an "un-revert". This is documented as a boundary.

### Testing (full lifecycle through backend, frontend, real Chromium)

- Prove the full lifecycle end-to-end:
  `commit → reload → render → undo → reload → render`, through:
  - backend tests (pytest): commit → rebuild_projection → render plan includes
    the layer → revert → rebuild → render plan excludes it, provenance intact;
  - frontend tests (node): reducer + controller commit/revert + hydration
    shape;
  - real-Chromium browser harness: commit via the visible control, reload,
    verify the committed layer persists, render, undo, reload, verify the layer
    is reverted but its history entry remains.

---

## Schema / API changes

- **Migration 11** (numbered, transactional): no new table is strictly
  required — `revert_commit` is a new `type` value in the existing append-only
  `actions` table, and the reverted-layer projection lives in
  `session_json`. The plan recommends NO new table; if Sol prefers a dedicated
  revert-fact table (mirroring the A4 lifecycle-facts pattern), that is a
  judgment call. The projection `session` shape gains `revertedLayers: []`
  (additive; `initial_projection` and `ensureSessionSlots` updated).
- **Action contract**: `ACTION_TYPES` += `revert_commit`; new
  `ALLOWED_REVERT_KEYS = ('commitActionId', 'revertedAt', 'reason')`; new
  error codes `L_UNKNOWN_COMMIT` (revert references an unknown commit) and
  `L_ALREADY_REVERTED` (revert of an already-reverted layer — replay no-op).
- **Render API**: `RenderOptions` + `RenderBody` gain a committed-layers input
  (see judgment call on whether the server reads committed layers from the
  projection or the client passes them). `build_mash` gains N committed
  sources (each delayed + gained).
- **Frontend**: `api.js` gains `buildCommitAction` and `buildRevertAction`;
  `ghost-controller.js` gains `commit()` and `revert()`; `ghost-card.js` gains
  Commit + Undo controls; `state.js`/`reducers.js` gain the reverted-layer
  projection.

---

## Race handling (summary)

| Race | Server behavior | Controller behavior |
|------|-----------------|---------------------|
| Commit vs Commit (double-click/retry) | idempotency replay (same envelope) | memoized envelope; button disabled while in flight |
| Commit vs Release | first terminal transition wins; loser gets `L_NOT_AUDITIONING` / `L_INVALID_TRANSITION` | single in-flight terminal barrier; loser reconciles honestly |
| Revert vs Revert | replay no-op (`L_ALREADY_REVERTED`) | memoized envelope; button disabled |
| Revert vs Commit (same layer) | revert requires the layer in `committedLayers`; commit requires `auditioning` | serialized by the terminal barrier + layer-state check |
| Project switch / hydration mid-commit | commit is a durable write; hydration re-reads authoritative state | controller cancels runtime (A8) but the durable commit outcome is reconciled, never lost |

---

## Browser journeys (real Chromium, both viewports)

1. **Commit happy path**: select phrase → preview → audition → Commit → card
   shows committed layer → tether removed → committed layer appears in Deck B.
2. **Commit idempotency**: double-click Commit → exactly one committed layer
   (server `acceptedActionIds` length 1).
3. **Commit/Release race**: press Commit and Release in rapid succession →
   exactly one terminal outcome, honest reconciliation, no duplicate layer.
4. **Reload parity**: commit → `page.reload()` → committed layer persists →
   render plan includes it.
5. **Render parity**: commit → render → exported mix contains the committed
   layer (verified via the parity tolerance test, not just "render succeeded").
6. **Undo lifecycle**: commit → reload → render → Undo (with confirmation) →
   reload → render excludes the layer → history entry retained.
7. **Missing/corrupt asset**: delete the pinned asset file → render plan fails
   with a clear error naming the layer (never silently omits it).
8. **Mobile (390×844)**: Commit/Undo controls reachable, no horizontal
   overflow, tether accent-edge fallback unchanged.

---

## 500 KB gate

- Current uncompressed JS: ~354 KB (measured 2026-08-29). Phase 11 adds
  `buildCommitAction`/`buildRevertAction` (small), `commit()`/`revert()`
  controller methods, Commit/Undo controls, and the reverted-layer reducer —
  estimated < 15 KB. The evidence file records the post-Phase-11 JS size and
  asserts it is < 500 KB. If the committed-layer render integration requires
  client-side math, it must reuse the existing `transport-bridge.js` /
  `derive.js` primitives rather than duplicating them.

---

## Judgment calls (for Sol's audit)

1. **Committed-layer render input source.** Does the server read committed
   layers directly from the project's action-state projection (recommended —
   single source of truth, no client-supplied layer list), or does the client
   pass `committed_layers` in the render body? Recommendation: server reads
   from the projection; the render body stays unchanged.
2. **Committed-layer gain range.** Allow the full `[-24, +12]` dB on the
   committed-layer path (recommended), or cap committed gain to the render's
   existing `[0, 2]` linear bound? Recommendation: full dB range, converted to
   linear without the 0..2 cap, on the committed path only.
3. **Revert provenance storage.** No new table (revert is a `type` in the
   existing `actions` table; reverted layers live in `session_json`) —
   recommended — vs a dedicated revert-fact table mirroring the A4 lifecycle
   pattern.
4. **Pinned-asset retention after revert.** Keep the pinned asset after revert
   (provenance; recommended) vs allow GC once no committed layer references it.
   Recommendation: keep pinned assets indefinitely in this phase; a future
   retention policy is out of scope.
5. **Render-parity tolerance.** The exact numeric tolerance (dB/RMS) for
   preview vs committed playback vs exported render. Recommendation: measure
   and document ±0.5 dB RMS on the committed layer (excluding the render
   limiter), asserted by a test, not a hardcoded guess.

---

## Acceptance blockers (reject/fix Phase 11 if any hold)

- Commit can be issued for a proposal that never reached the launch boundary
  (no `auditioning` fact) — "the exact Ghost Richard hears" is violated.
- A double-click or network retry creates a duplicate committed layer.
- Commit and Release racing leaves an unreconciled outcome or a half-pinned
  asset.
- The render regenerates or re-separates audio instead of consuming the pinned
  asset.
- Placement/duration/gain/transform provenance is not preserved exactly (the
  parity test fails beyond the documented tolerance).
- A missing/corrupt accepted asset is silently omitted from the mix.
- A committed layer fails to survive browser reload or server restart.
- `revert_commit` deletes or mutates history (the ledger, the commit row, or
  the pinned asset).
- Undo is not accessible (no keyboard/AT path, no honest confirmation/status).
- The single-active-player architecture is broken, or the 500 KB static
  allowance is exceeded.
- Producer access, automatic acceptance, or AI-generated musical decisions
  creep in.

---

## Test matrix (target)

| Layer | Suite | Coverage |
|-------|-------|----------|
| Backend | `test_phase11a_commit.py` | commit verify/pin, idempotency, race, missing/corrupt asset |
| Backend | `test_phase11b_render_parity.py` | committed-layer render math, parity tolerance, hard-fail on missing asset |
| Backend | `test_phase11c_revert.py` | revert append-only, projection, rebuild, replay idempotency |
| Frontend | `ghost-commit.test.js` | buildCommitAction, controller commit/revert, reducer reverted-layer |
| Frontend | `ghost-render.test.js` | committed-layer render body, parity math (mirrors server) |
| Browser | `ghost_commit_ux.js` | the 8 journeys above, both viewports |
| Gates | pytest + npm test + browser (both viewports) + `git diff --check` | all green |

---

## Handoff

- Leave the working tree **uncommitted** for Sol's final audit (as in Phase 10).
- Write `PHASE_11_SOLID_GHOST_EVIDENCE.md` with commands, counts, the measured
  render-parity tolerance, the post-Phase-11 JS size, and documented
  limitations (independent clocks, fixed 4/4 policy, one-way undo, no Producer).
- Preserve `Sol to Sol.txt` untracked. Sol owns commit/push/CI.

---

## Sol audit — approved judgment calls and binding amendments

**Audit date:** 2026-08-29

**Decision:** Approved for Hermes implementation, subject to every amendment in
this section. These amendments override any conflicting earlier wording in the
plan. Hermes must leave the implementation uncommitted for Sol's final audit.

### Approved judgment calls

1. **Projection-owned render input:** accepted. The server reads committed
   layers directly from the project-scoped durable Action projection. The
   client never supplies a layer list, asset path, placement, gain, or hash in
   either render request.
2. **Full committed gain range:** accepted. Committed Ghost gain remains the
   auditioned `[-24, +12]` dB and is converted with
   `10 ** (gainDb / 20)`. The existing Foundation/Lead `[0, 2]` linear control
   contract is unchanged. The shared final limiter remains in force.
3. **Ledger-native revert:** accepted. `revert_commit` is a new Action type in
   the existing append-only ledger; no dedicated revert-fact table is added.
4. **Asset retention after revert:** accepted. Reverting never unpins or
   deletes the accepted asset. A future bounded retention/privacy policy is a
   separate, explicitly authorized phase.
5. **Measured parity tolerance:** accepted. The isolated committed-layer
   contribution must measure within **±0.5 dB RMS** of the expected gain,
   excluding the final mastering limiter. Evidence must report the measured
   values, not merely a passing assertion. Because the exported mix includes a
   limiter, its post-limiter level is tested separately for correct onset,
   duration, audibility, and bounded finite output; the plan must not describe
   post-limiter amplitude as identical to the Web Audio audition.

### Amendment 1 — Undo/revert serialization

`revert_commit` is strictly serialized per committed layer. The frontend builds
and memoizes exactly one revert envelope for an in-flight layer and disables
that layer's Undo control until the outcome is reconciled. An exact replay of
the same Action/idempotency key returns the original successful outcome. A
different Action attempting to revert an already-reverted commit returns
`L_ALREADY_REVERTED` without appending a ledger row or changing either
projection list. Rapid clicks, network retry, two tabs, and concurrent requests
must all leave exactly one `revert_commit` row for the commit.

### Amendment 2 — Missing/corrupt asset preflight

Asset existence, managed-root containment, pinned status, content hash, and
decode validity are verified while constructing the server-authored render
plan. `POST /api/renders/plan` must therefore fail immediately with the stable
layer-identifying error before any render begins. `POST /api/renders` must call
the same planner/preflight before it creates or queues a job, so bypassing the
read-only plan endpoint cannot defer the failure into ffmpeg. No partial output
or job record may be created for this preflight failure.

### Amendment 3 — Commit control state and ambiguous outcomes

Clicking Commit enters `committing` and blocks further terminal controls for
that generation. On a definite server rejection, the UI returns to
`auditioning` and shows the mapped error. On timeout, disconnect, aborted
response, or another ambiguous network failure, it must first fetch the
authoritative action state: show `committed` if the server accepted it; return
to `auditioning` only if the proposal is still auditioning; show the truthful
terminal state if Release won. Reconciliation failure leaves a retryable,
explicitly unknown state—never permanent `committing`, fabricated success, or
an automatic second Action with a new idempotency key.

### Amendment 4 — Strict 500 KB allowance

The shipped uncompressed frontend static total must remain strictly below
**500,000 bytes**, measured using the same static-tree command and inclusion
rules as Phase 10. Record the exact command and byte count in the evidence
file. No new runtime package is authorized: use vanilla modules, existing
helpers, and native `crypto.randomUUID()` (with the repository's existing
testable ID-injection seam where needed).

### Amendment 5 — Correct output-clock render mathematics

The draft's multiplication by `committed_tempo_ratio` is incorrect for the
existing `assembler.render_aligned()` implementation: ffmpeg `atempo=r` makes
output duration equal to source duration divided by `r`. The binding formulas
are:

```text
committed_tempo_ratio = output_bpm / accepted_target_bpm
accepted_destination_time = accepted_destination_origin
    + launchBeat * 60 / accepted_target_bpm
committed_output_start = lead_output_start
    + (accepted_destination_time - lead_start)
      / committed_tempo_ratio
committed_output_duration = span * 60 / accepted_target_bpm
    / committed_tempo_ratio
                          = span * 60 / output_bpm
committed_source_trim = committed_output_duration
    * committed_tempo_ratio
```

The accepted destination origin/BPM/grid revision come from the immutable
preview/launch provenance, not mutable current track analysis. If placement
starts before the chosen render window or ends after it, the shared planner
must deterministically trim the asset and adjust its source offset; it must not
clamp the delay while replaying the full phrase. Pin tests for ratios below,
equal to, and above 1.0, overlay and transition placement, non-zero Lead cue,
partial overlap, and complete out-of-window exclusion. Python planner and
ffmpeg execution must consume the same resolved values—no duplicate client
beat arithmetic is needed.

### Amendment 6 — Durable launch receipt and rebuild parity

The current `make_committed_layer()` does not copy `launchBeat`, and Phase 10's
receipt lives in `proposal_lifecycle_facts`, not the Action projection. Before
append, Commit must server-side load the unique durable `auditioning` fact,
verify its `assetId`, `contentHash`, and `gridRevision` against the proposal's
prepared asset/accepted destination grid, and derive a canonical immutable
launch receipt. The committed layer must retain the render-relevant receipt
(`launchBeat`, destination grid revision/origin/BPM, asset ID/hash); client
claims and `launchAudioTime` are not render authority.

Projection rebuild must reproduce the byte-equivalent committed placement
without filesystem work or dependence on mutable analysis. Hermes may achieve
this with a narrowly versioned extension to the `commit_layer` payload or a
deterministic join to the durable lifecycle fact during rebuild, but must not
silently manufacture absent provenance. Legacy committed rows lacking the
receipt must fail render planning clearly rather than defaulting to beat zero.
This is the only permitted refinement to the existing commit contract and does
not authorize another musical Action type.

### Amendment 7 — Truthful meaning of “committed playback”

Phase 11 does not authorize a persistent live-layer Web Audio engine or a
rewrite of the single-active player. Immediately after Commit, the UI must say
that the layer is **committed and will be included in the next preview/render**;
it must not imply that the continuing base-deck transport now contains the
solid layer. “Committed playback” in this phase means playback of an output
produced through the existing preview/render pipeline from the server-authored
plan. The browser journey must exercise that real output before claiming
preview/commit/render parity.

### Amendment 8 — Revert authority, projection invariants, and schema discipline

Only a human may issue `revert_commit`; Producer receives the stable
`P_ACTOR_NOT_ALLOWED` response in both Python and JavaScript policy tests.
`committedLayers` and `revertedLayers` are mutually exclusive by
`commitActionId`, while the original proposal remains terminal `accepted` and
retains `committedActionId`; reversal is session projection state, not a
retroactive proposal lifecycle transition. Hydration strictly validates both
lists as bounded, recursively plain JSON and rejects duplicate identities.

Do not add an empty Migration 11 merely to advance a number. Add a numbered,
transactional migration only if implementation introduces an actual durable
database schema change; the additive JSON projection shape is normalized by
load/hydration compatibility code. If no SQL schema changes, the evidence must
state that no migration was required.

### Revised Sol acceptance blockers

In addition to the draft's blockers, reject/fix the implementation if: render
placement uses multiplication instead of division by the ffmpeg tempo ratio;
mutable current analysis can move an accepted layer; projection rebuild loses
the launch receipt; a second distinct revert row can be appended for one
commit; the direct render endpoint can enqueue before asset preflight; an
ambiguous Commit response fabricates a terminal outcome; the UI claims live
committed playback that does not exist; Producer can revert; or an empty
migration is introduced without a durable schema change.

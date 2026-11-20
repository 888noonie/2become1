# OPERATION ALL THE TIME IN THE WORLD — Milestone A evidence

Date: 2026-11-20
Coordinator: OpenCode / MISIX
Branch: `feature/all-the-time` in `/home/richardn/MISIX-worktrees/all-the-time`
Scope: headless ProjectState and editing engine. **No production activation, no
remote push, no main promotion, no canonical media mutation.** The accepted
Performance Desk, Black Tie UI, Library and media pipeline are untouched.

## 0. Starting position (verified references)

| Ref | Verified |
| --- | --- |
| `main @ 28eef69` | "Preserve the PM-approved Black Tie design and review contracts" — the current public release |
| `feature/the-visitor @ e9ae93d` | "Record the final review of the section timeline" — a **strict descendant** of `28eef69` (merge-base is `28eef69` itself), carrying 5 extra commits: proposal markings on the stem strips, a section window inside the recording, moved-section announcements and a section-timeline UX assessment |

The Visitor candidate is preserved as-is at its own worktree
(`~/MISIX-worktrees/the-visitor`). This milestone's worktree was created fresh
from `28eef69`, so the accepted mixer and the Visitor proposal layer are both
recoverable untouched.

## 1. Architecture decision: state and rendering are separate systems

Milestone A implements the state half only, headlessly:

```
src/twobecomeone/studio_static/js/arrangement/
  time-math.js      normative time / stretch / pitch conventions (shared contract)
  project-state.js  ProjectState model, validation, schema-versioned persistence
  edit-api.js       atomic edit engine, undo/redo, AI-Producer proposal seam
```

- All edits mutate exactly one serialisable, versioned `ProjectState`.
- Decoded audio never enters the model. An asset's `bufferReference` is a
  persistent string identifier (e.g. `cache:sha256:…`); the bounded decoded
  buffer cache is a runtime-side system reached only through that reference
  (built with the DSP graph in Milestone B). Validation refuses any
  non-string reference, so an `AudioBuffer` cannot leak in.
- No editing operation lives in a UI component. The later Black Tie arrangement
  view calls `EditEngine` and nothing else.
- The renderer (B/C) consumes immutable snapshots (`engine.snapshot()`) and
  never writes back.

## 2. Normative conventions (pinned by tests)

### 2.1 Time and stretch

```
secPerBeat            = 60 / masterBpm
beats -> seconds      = beats * secPerBeat

sourceAdvanceRate     = SOURCE seconds consumed per OUTPUT second
  beat_sync:            masterBpm / asset.nativeBpm
  manual:               clip.customStretchRatio
output multiplication = 1 / rate   (explicitly the reciprocal)

beats -> source secs  = beats * secPerBeat * rate
```

- Pitch factor `2^(semitones/12)` is DSP-side metadata; it never changes a
  duration, rate or offset here. `setClipPitch` provably leaves duration and
  source offset untouched.
- **beat_sync source consumption is tempo-invariant** (the `masterBpm` terms
  cancel: `durationBeats * 60 / nativeBpm`). Manual spans scale with the tempo
  mapping. Both properties are tested.
- `beat_sync` on an asset with unmeasured BPM is refused
  (`BEAT_SYNC_UNAVAILABLE`); `nativeBpm`/`detectedKey` stay explicitly `null`
  and are never invented.
- Manual `customStretchRatio` bounds: 0.05–20 (documented constants).

### 2.2 Clip regions and edits

- `MIN_CLIP_DURATION_BEATS = 1/64`; computed times round to 1 ns so repeated
  trims/splits cannot accumulate drift.
- **Split** at beat `b`: the left half keeps id and `fadeInBeats`, the right
  half gets a new id and continues the source exactly —
  `sourceOffset += (b − start) * secPerBeat * rate`. Outer edges keep the
  parent's fades (clamped); inner edges get the 0.015-beat micro-fade.
- **Trim** `start` moves timeline and source together at the clip's own rate;
  `end` changes length only. Exactly-at-asset-end is legal (1 ns tolerance);
  overshoot is refused `BEYOND_ASSET_END`, crossing beat 0 is refused, and an
  edit that would drop below 1/64 beat is refused.
- **Stretch** keeps the clip's timeline duration and changes how much source it
  consumes; a ratio that would run past the asset is refused. Trim the clip to
  make room.
- **Overlap policy** is `sum`: overlapping regions on one track are all audible,
  ordered deterministically by `(timelineStartBeat, id)`. Edits never
  auto-trim neighbours; validators report overlaps as warnings.

### 2.3 Micro-fades

Default 0.015 beats in and out. Very short clips get each fade capped at half
the clip and the pair scaled to fit, so `fadeIn + fadeOut ≤ duration` always.

## 3. API surface (as required by §6)

`loadStemToTrack(trackIndex, audioFile, nativeBpm?)`, `moveClip`, `trimClip`,
`splitClipAtBeat`, `setClipStretch`, `setClipPitch`, `setClipGain`,
`exportMasterMix`, plus track controls (`setTrackVolume/Pan/Mute/Solo/Eq`),
`setMasterBpm`, `setLoopRange`, `setPlayhead`, `setPlaying`.

- Every operation is validated, atomic and snapshot-undoable. An invalid edit
  throws `InvalidEditError` with a stable code and leaves the previous
  `ProjectState` **object identity** unchanged; failed edits push no history.
- Source references are immutable (`Object.freeze` on asset records); a test
  proves trims/splits/gains never alter stored asset data.
- `exportMasterMix` exists in the API surface but genuinely depends on the
  renderer. It throws `ExportNotReadyError` rather than pretending to export
  (Milestone B replaces it with the real offline bounce).
- **AI Producer seam:** `propose(command)` is a validated dry run that never
  mutates; `applyProposal(proposal, {approved: true})` requires explicit owner
  approval (`ApprovalRequiredError` otherwise) and re-runs the same validated
  command path as a hand edit, re-checking against the current state at apply
  time. A proposal can go stale and is then refused.

### Undo/redo semantics

Snapshot-based, bounded at 200 entries. Live transport markers (`playheadBeat`,
`isPlaying`) are not editing state: they never enter history and survive
undo/redo. `masterBpm` and `loopRange` are arrangement choices and are
undoable. A split is one undo step. A cleared redo stack on new edits is
tested.

### Schema-version handling

`schemaVersion: 1` inside `ProjectState`. `deserializeProject` refuses a
missing version (`SCHEMA_VERSION_MISSING`), a newer one
(`SCHEMA_VERSION_TOO_NEW`) and an older one with no registered migration
(`SCHEMA_VERSION_UNMIGRATABLE`), then runs full validation. The migration map
gives future versions one place to land without changing the required model.

## 4. Verification

New deterministic suite (node `--test`, no network, no browser):

| File | Tests | Covers |
| --- | --- | --- |
| `tests/frontend/arrangement/time-math.test.js` | 12 | rate convention and its reciprocal, tempo invariance of the beat↔source mapping, `2^(s/12)`, micro-fade clamping, deterministic clip order |
| `tests/frontend/arrangement/project-state.test.js` | 13 | eight-track invariant, ranges, unknown-BPM honesty, bufferReference type, overlap policy, JSON round-trip fidelity, asset reference stability, schema-version refusal codes |
| `tests/frontend/arrangement/edit-api.test.js` | 22 | load/move/trim/split/stretch/pitch/gain, split source correspondence under rate 2, repeated splits + trims against an independent reference, boundaries (exact asset end, beat 0, minimum length), atomic failure semantics, source immutability, loud export refusal |
| `tests/frontend/arrangement/history-and-proposals.test.js` | 14 | undo/redo reversibility (byte-exact), redo clearing, transport markers outside history, bounded history, serialize/deserialize round trip, proposal dry-run/apply-time re-validation/owner-approval gate |
| `tests/frontend/arrangement/negative-control.test.js` | 2 | the same scenario passes the real engine and **fails the intentionally defective one** |

**Total: 63 tests, 63 pass.**

The required §11 subset for this milestone maps as: JSON round-trip fidelity ✓,
asset reference stability ✓, undo/redo reversibility ✓, repeated splits and
trims ✓, timeline/source position accuracy ✓, correct stretch-rate semantics ✓,
pitch changes without duration changes ✓ (time-stretching without pitch change
and formants need the DSP and are Milestone B), micro-fade click suppression is
specified and metadata-tested here and audibly tested in B/C.

### Negative control (intentionally defective implementation)

`tests/frontend/arrangement/fixtures/defective-engine.js` reproduces the classic
stretch-rate bug: split offsets advance at the timeline rate instead of the
clip's source-advance rate. The independent checker
(`fixtures/correspondence.js`, plain arithmetic over the operation log, no
engine imports) accepts the real engine and rejects the defective one with the
exact corruption: `clip-2 sourceOffsetSec expected 30, actual 18` (rate 2). So
the verification detects the defect class it claims to.

### Regressions

| Gate | Result |
| --- | --- |
| `npm test` (all frontend incl. 63 new) | **632 pass, 0 fail** |
| `pytest -q` | **630 passed, 1 skipped** |
| Browser journeys / OfflineAudioContext capture | not required: this change touches neither UI nor playback (the new modules are not yet imported by any view). They return in Milestone D |

Harness defect recorded: the fresh worktree initially failed 100+ existing
frontend files with `Cannot find package 'jsdom'` — missing `node_modules`, not
a regression. `npm ci` restored the environment and the same command went
green. A worktree without `npm ci` must not be read as a test failure.

## 5. Static assets (per docs/static-asset-policy.md)

| Measure | Value |
| --- | --- |
| Total uncompressed bytes | **829,595** (75 files) |
| At `28eef69` before this change | 783,688 (72 files) |
| This operation's growth | **+45,907 bytes (+5.86%)** — three new UI-free modules: `edit-api.js` 23,860, `project-state.js` 17,124, `time-math.js` 4,923 |
| Delta vs recorded baseline `763e1d9` (650,905) | +178,690 bytes (+27.45%) — of which +132,783 predates this operation |
| Five largest files | unchanged: `stem-desk-panel.js` 59,185, `ghost-controller.js` 55,945, `live-mixer.js` 39,556, `stem-desk.js` 36,523, `studio.css` 28,814 |

Growth is real and explained: the non-destructive edit engine required the
schema, validators, atomic command path, undo/redo and the proposal boundary in
readable, unminified form (policy: never minify to satisfy a historical number).
The trigger against the old baseline is already open from earlier accepted work;
this entry records this operation's share and its reason.

## 6. Compatibility limitations (honest)

- No DSP, no rendering, no audio yet: `exportMasterMix` refuses loudly; nothing
  here can be auditioned. The accepted eight-stem performance engine remains the
  only audio path, unchanged.
- No UI: the arrangement timeline arrives in Milestone D and will wire every
  gesture through `EditEngine`.
- Two-track/four-stem → eight-track ProjectState translation (§9) is specified
  (one clip per loaded stem at beat 0, `method`/provenance preserved in asset
  names) but not yet implemented; it lands with Milestone D's Library wiring.
- Signalsmith Stretch is **not yet integrated or qualified**; §3's seven proof
  steps are the first executable part of Milestone B.

## 7. Next assignment (Milestone B, executable)

1. Qualify Signalsmith Stretch (pin revision, keep MIT notices): WASM/
   AudioWorklet load in target browser; headless `OfflineAudioContext` render;
   independent pitch vs time; formant compensation on vocals; latency, pre-roll,
   tail and seek; 8-instance real-time budget on the 6 GB RTX 4050 target;
   quality at moderate and extreme ratios. Measure, never assume; a failed
   capability returns a specific feasibility blocker with a bounded repair plan.
2. Build the shared WASM DSP graph in the mandatory signal-flow order
   (slice → stretch/shift → clip gain + micro-fade → 3-band EQ → track
   volume/pan/mute/solo → master → lookahead brickwall limiter at −0.3 dBFS).
3. Offline bounce of an eight-track arrangement to a valid WAV, with duration
   and channel-layout checks and negative tests (missing asset, invalid region,
   insufficient memory), then real-time/offline PCM parity with latency
   compensation.

## 8. Commits (local only)

| Commit | Contents |
| --- | --- |
| `feat(daw): headless ProjectState, atomic edit engine and undo/redo (Milestone A)` | `js/arrangement/{time-math,project-state,edit-api}.js` |
| `test(daw): deterministic Milestone A suite with intentional negative control` | `tests/frontend/arrangement/**` |
| `docs: record Milestone A architecture decisions and evidence` | this document |

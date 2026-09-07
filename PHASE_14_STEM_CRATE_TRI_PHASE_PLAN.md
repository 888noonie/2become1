---
title: "Phase 14 — Stem Crate tri-phase"
status: PROPOSED — implementation requires Richard's authorization
planning_baseline: f9bd2592eae545120178a8f2aac7114c14cbdaf9
branch: main
owner: Hermes B (implementation)
auditor: Sol (independent audit and plans)
---

# Phase 14 — Stem Crate

> Tracked mirror of the Sol-authored plan at
> `.hermes/plans/2026-09-07_013848-phase14-waxdrop-stem-crate-tri-phase.md`.
> This file is the durable repo copy for cross-session continuity.
>
> **Naming correction (Richard, 2026-09-07):** "WaxDrop" is a Loopit mock-image
> working name only and is NOT used in the product. The feature lives in the
> existing FUN tab (next to DJ). The Phase 14A artifact is
> `design/stem_crate_fun_mock.html` and the decision record is
> `PHASE_14_STEM_CRATE_DECISION.md` (not the `waxdrop_*` names below). Phase 14A
> is COMPLETE and MERGED to main at `f50dac1`; Phase 14B/14C remain pending.

## Product decision

Build the first version as one **stem stack**: up to four separated stem loops
become components of one server-prepared committed audio asset and therefore one
entry in `session.committedLayers`.

Do not create four committed layers or four independent live decks. The stack
preserves the current one-visible-player rule, the exactly-one-committed-layer
policy, append-only Action history, render parity, and the existing
`CommittedLayerEngine` lifecycle.

The Loopit experiments in `Mock Images/` are design references, not source assets
or an implementation dependency. They establish the useful interaction language:

- a top master strip (play, undo, record affordance, BPM, filter, drive, key);
- four avatar slots: BEAT, BASS, MELODY/OTHER, VOICE;
- a bottom searchable crate with packs/categories and WAV HUNTER;
- drag/drop cards on pointer devices and an equivalent tap-select/tap-slot flow;
- compatibility colour/glow, 1/2/4/8-bar loop choice, a Fever trophy surface;
- a radial/X-Y Bloom gesture preview.

## Audit corrections to the supplied concept

1. `render_aligned` is an offline/server render path. Its benchmark does not
   prove that arbitrary interactive Web Audio pitch/tempo changes are onset-clean.
   Phase 14 may use server-prepared audio and must measure that exact path.
2. Existing stems do not have independent BPM/key analysis. Initially inherit
   the source track's effective grid/key and label it
   `source-track inherited`; never call it stem-detected metadata.
3. Demucs truthfully supplies `vocals`, `drums`, `bass`, and `other`. The UI may
   present OTHER as the melody-role slot, but must retain the source label
   `other`; it is not guaranteed to contain only melody.
4. The ffmpeg fallback produces `center` and `sides`, not four musical stems.
   Never auto-label those as voice/drums/bass/melody or silently place them into
   the four-slot recipe.
5. WAV HUNTER does not currently imply separation. Import, analysis, explicit
   separation, crate addition, and loop selection remain visible states.
6. Compatibility is advice, not proof of musical quality. Show the source and
   target BPM/key, applied semitone/tempo change, confidence/provenance, and let
   the existing human overrides correct the source grid.

## Baseline and sequencing

Planning baseline is clean remote-parity `main` at
`f9bd2592eae545120178a8f2aac7114c14cbdaf9`. At planning time the only worktree
entries are untracked `.hermes/`, `.vscode/`, and `Mock Images/`; preserve all of
them. Never stage `.vscode/` or `Mock Images/` without explicit authorization.

Before implementation, Richard must provide/confirm the exact executable
baseline. Hermes B must verify HEAD, remote parity, status, and CI, then branch
from that SHA. If the checkout or ownership has changed, stop rather than reset a
shared worktree.

Phase 14A can be reviewed as a standalone interaction artifact. Production Phase
14C must not claim timing/lifecycle acceptance until Phase 13 listener-truth
closure has supplied the applicable clean Class A/B baseline and lifecycle
evidence. Phase 13 tolerances must not be invented or copied into this phase.

## Hard invariants

### Richard's simultaneous-output acceptance requirement

The completed product must let Richard hear Foundation deck A and Lead deck B
simultaneously in DJ mode while also hearing the multi-stem stack output. The
planning baseline does **not** do this: `audio.js` owns one HTMLAudioElement and
`play()` stops/resets the prior deck; `tests/frontend/audio.test.js` pins that
singleton behavior.

Phase 14A does not demonstrate audio. Phase 14B's crate work may proceed without
changing playback. Do not wire Phase 14C to the singleton and then claim this
requirement is met. Its live-playback portion must converge with the separately
reviewed Phase 15 shared three-bus mixer plan: deck A + deck B + one prepared
stem-stack asset. "One committed layer" still governs the stack; it does not
mean only one audible deck. No phase may claim product closure without a real
browser assertion that all three buses contribute non-silent output together.

- One visible `HTMLAudioElement`; no second deck/player element.
- Exactly one server-projected committed layer. A stem stack is one layer with
  bounded components, not a loophole around `L_LAYER_LIMIT`.
- Maximum four stack components and at most one component per role.
- The server resolves all media by opaque IDs beneath managed roots. No client
  path or URL is passed to ffmpeg or persisted as authority.
- Every component retains track ID/content hash, stem-set ID, actual stem name,
  separation method/model/device, analysis provenance, region/grid revision,
  loop bars, transform, gain, and prepared-asset hash.
- Demucs and ffmpeg provenance remains visible. Separated means bleed is possible;
  it never means clean multitrack/acapella.
- StateStore contains serializable intent/status only; AudioNodes, decoded
  buffers, timers, requests and abort controllers remain runtime-owned.
- Mobile/accessibility cannot depend on drag, colour, hover, radial gestures, or
  sound alone.
- No new runtime or build dependency. Static frontend remains <= 500,000 bytes.
- No Producer/AI generation, bridge generation, QR networking, multi-user sync,
  multiple committed layers, or unrestricted user sample filesystem paths.

# Phase 14A — Feel the interaction before engine work

> COMPLETE and MERGED to main at `f50dac1` (commit `ef5b8e5`). Artifact:
> `design/stem_crate_fun_mock.html`; 17 jsdom contract tests at
> `tests/frontend/design/stem-crate-fun-mock.test.js`; decision record
> `PHASE_14_STEM_CRATE_DECISION.md`; audits `PHASE_14A_STEM_CRATE_AUDIT.md` and
> `PHASE_14A_STEM_CRATE_REAUDIT.md`. Final audit PASS.

## Goal

Deliver a standalone responsive HTML prototype and a signed-off interaction
contract. It may simulate state but must not call production APIs, play uploaded
music, or imply implemented DSP.

## Required interactions

1. Four role slots: BEAT, BASS, OTHER/MELODY, VOICE. Each exposes empty,
   selected, compatible, transform-needed, playing, muted, error and unavailable
   states.
2. Searchable crate cards show track, actual stem, method (`demucs` or
   `ffmpeg center/sides`), inherited/detected metadata provenance, BPM/key,
   confidence, source hash shorthand and bleed warning.
3. Pointer drag/drop plus keyboard and mobile tap-select/tap-target parity.
4. Per-slot 1/2/4/8-bar selector, mute/solo, gain, remove, and a textual
   compatibility explanation such as `120→124 BPM; +2 st; source inherited`.
5. The master strip and Fever trophy room reflect deterministic prototype state.
   A trophy unlock requires an explicit recipe and never hides a failed or
   incompatible component.
6. Bloom X/Y preview: X communicates pitch intent, Y gain/duck intent, and
   release shows `queued for next beat`. Provide sliders/buttons and Escape/
   Cancel equivalents; do not rely on the radial gesture.
7. Honest reduced-motion, focus-visible, labels, live-region announcements,
   44px touch targets, contrast, narrow/mobile and desktop layouts.

## Phase 14A acceptance

- A user can discover, select, place, adjust and remove four representative
  cards at phone and desktop sizes without audio.
- Every transformation and provenance state is visible in text.
- No production code, database, Action contract or static-budget bytes changed.
- Decision record identifies deferred ideas rather than silently promising them.

# Phase 14B — Persistent honest stem crate and non-destructive loops

## Goal

Make separated stems searchable/reusable with truthful source identity and
non-destructive 1/2/4/8-bar loop specifications. This phase does not commit or
play a stack.

## Contract first

### Crate item

Define a versioned server contract with, at minimum:

- opaque crate item ID and schema version;
- source track ID and immutable content SHA-256;
- stem-set ID, actual stem name, method, model and device;
- role (`beat`, `bass`, `other`, `voice`) as user-facing placement metadata;
- source analysis facts and provenance (`source_track_inherited` initially);
- effective BPM/key/grid revision and whether human overrides are active;
- non-destructive region start/end beats and loop bars in `{1,2,4,8}`;
- optional bounded gain and user label; created/updated timestamps.

The crate row references existing managed stem media. It does not duplicate a
three-minute WAV or persist a client path. Reading an item revalidates the stem
set, source content hash and managed file. Missing/stale media is returned as an
honest unavailable item, not silently substituted.

### Proposed API

- `GET /api/stem-crate` — bounded pagination, search and role filter.
- `POST /api/stem-crate` — add from an existing track/stem-set/stem identity.
- `PATCH /api/stem-crate/{item_id}` — label, role, loop region/bars and gain only.
- `DELETE /api/stem-crate/{item_id}` — removes the crate reference, never source
  track/stem media or ledger history.
- Existing separation submission remains the only way to create stems.

Exact request/response models must reject unknown fields, booleans as numbers,
NaN/infinity, unsupported loop lengths, duplicate source-region identities,
stale track hashes, mismatched stem-set ownership, ffmpeg-as-Demucs claims,
missing files and traversal attempts.

## TDD tasks

### 14B.1 — Migration and service

1. Write migration rollback/upgrade/idempotency tests using the next sequential
   migration number; add a bounded indexed `stem_crate_items` table.
2. Write service RED tests for CRUD, pagination/search, uniqueness, source-hash
   drift, missing media, deletion semantics and restart persistence.
3. Implement through `StudioService`; reuse `_validated_stem_path` and existing
   track/stem lookup rather than accepting paths.
4. Add web models/routes and HTTP contract tests, including hostile JSON shapes.

### 14B.2 — Loop and compatibility truth

1. Add pure RED tests for bar-region derivation from effective first beat,
   downbeat, BPM and grid revision. Regions remain beat references; do not write
   derivative loop files in this phase.
2. Fail closed when BPM/grid facts are absent or invalid. Surface low confidence
   and current user overrides.
3. Implement deterministic compatibility output: BPM delta/ratio, tonic/mode
   relationship when known, proposed semitone shift, and explicit reasons.
   Unknown key is `unknown`, never `compatible`.
4. Do not run per-stem analysis while claiming inherited source facts. If real
   per-stem analysis becomes desirable, treat it as a scope stop and new
   evidence task.

### 14B.3 — Production crate UI

1. Add a compact crate panel to the existing Studio composition; do not replace
   the current decks or committed-layer UI.
2. Reuse existing API/state/dom conventions. Keep request objects and media out
   of StateStore.
3. Add separation job progress and explicit outcomes: full track available,
   Demucs four-stem set, ffmpeg center/sides only, unavailable, stale/error.
4. Implement search/filter, provenance disclosure, loop selector and user grid
   correction link. Placement into a production stack remains disabled with
   truthful `Stem stack arrives in Phase 14C` copy.
5. Add unit tests and a bounded browser journey at both viewports; if it is
   acceptance evidence, wire both to CI.

## Phase 14B acceptance

- Crate survives restart and never exposes filesystem paths.
- A Demucs result creates four truthful candidates; ffmpeg creates center/sides
  candidates and never fabricates musical categories.
- Loop math is deterministic against effective grid facts and invalidates when
  the grid revision changes.
- Search, keyboard/mobile selection and stale/unavailable states work at both
  viewports.
- Full Python/frontend/browser gates pass and static bytes remain <= 500,000.

# Phase 14C — One committed stem stack, production playback and parity

## Goal

Place up to four crate loops into one bounded stack, prepare one composite asset,
preview/commit it through the Action system, and play/render it through the
existing one-layer lifecycle.

## Architecture

Use new versioned Actions `preview_stem_stack` and `commit_stem_stack` rather
than weakening the frozen semantics of historical `preview_layer` /
`commit_layer`. Mirror exact contracts in Python and JavaScript. Register all new
error codes in `studio_static/js/actions/errors.js` first and provide
cross-language vectors.

The preview payload contains a bounded ordered component list. Each component
references a crate item and immutable expected source/grid identity plus loop
bars, role, gain and requested transform. The server re-resolves every fact,
rejects duplicates/stale sources, and prepares one managed stereo 44.1-kHz WAV:

1. resolve each managed stem;
2. derive/crop the requested source region from server grid facts;
3. apply bounded tempo/key transform only when explicitly approved;
4. repeat/crop to a common 1/2/4/8-bar destination span;
5. mix with bounded gain/headroom and clipping validation;
6. hash/register one asset with a transform manifest containing every component;
7. publish it atomically or clean it up on any failure/race.

The server-projected committed result remains one object in
`session.committedLayers` with `kind: stem_stack`. The existing
`CommittedLayerEngine` should decode/schedule its one prepared asset unchanged
except for truthful stack presentation. If implementation requires N live
AudioBufferSourceNodes or relaxes `L_LAYER_LIMIT`, that is a scope stop for Sol
and Richard.

## TDD tasks

### 14C.1 — Cross-language Action and projection contract

- RED vectors: empty/5-component stacks, duplicate roles/items, unknown keys,
  bool-as-number, non-finite gain/shift, bad loop bars, stale hashes/revisions,
  invalid actor policy, replay/idempotency collision, commit without prepared
  proposal and attempting a second committed layer.
- GREEN only when Python/JS canonical forms and error codes match exactly.
- Extend replay/rebuild for old and new ledgers; historical actions must remain
  byte-semantically stable.

### 14C.2 — Composite asset preparation and export parity

- Use generated public-domain test tones/clicks, not private music.
- RED tests cover each stem role, mixed sample rates/channels, source offsets,
  tempo/key bounds, missing tools/media, cancellation, clipping/headroom,
  atomic cleanup, content hashes and restart resolution.
- Measure every expected onset in every component, not only the first transient.
- Compare the one prepared stack used live with the asset included in preview/
  final render. A scheduling receipt proves intent only; Class C remains separate.
- Do not claim transparent separation or sample-accurate audible output.

### 14C.3 — Stack builder and live lifecycle

- Promote the Phase 14A slot interaction into the production crate panel using
  pointer plus tap/keyboard parity.
- Preview, commit, Undo, pause/stop/ended, seek, source replacement, project
  switch, reload, missing asset, AudioContext suspend/resume/close and failed
  projection refresh inherit the Phase 13 lifecycle matrix.
- UI shows per-component source/provenance/transform and one aggregate stack
  state: loading, scheduled, live, idle, error.
- A deterministic Fever recipe may unlock when its exact four role/compatibility
  predicate is met. The recipe is inspectable; no AI and no retention timer.
- Bloom remains prototype-only unless a separately approved action/automation
  contract records its quantized intent and the real scheduler path is measured.
  Do not smuggle transient FX into local UI state.

## Phase 14C acceptance

- Exactly one stack with 1–4 components can be previewed, committed, played,
  rendered and undone; a second committed layer is refused.
- One prepared asset drives live and render parity, with component provenance and
  hashes sufficient to reproduce it.
- Actual beat-boundary scheduling uses the production scheduler and independent
  expected-value assertions; audible claims remain classified A/B/C.
- Existing single-vocal Ghost ledgers continue to hydrate/play/render.
- Full gates pass, new browser journey runs at 1280x800 and 390x844 in CI, static
  bytes remain <= 500,000, and the feature branch receives independent Sol audit
  before merge.

# Explicit deferrals after this tri-phase

These ideas are good but are not safe to fold into the first vertical slice:

- performance REC as an append-only gesture/automation script;
- live stutter/reverse and quantized Bloom FX;
- QR crate sharing, licensing/redaction policy and battle collaboration;
- per-stem independent BPM/key analysis;
- multiple simultaneous committed layers or N-source live submixing;
- AI Producer bridges or automatic Fever composition;
- background GPU/router/A2A orchestration.

A later tri-phase should start REC/FX from a versioned automation Action, then
add deterministic replay, then add share/export provenance. Do not persist a
recording as opaque UI events.

# Required implementation return contract

After each sub-phase, Hermes B returns and stops for Sol audit with:

- exact baseline/head SHA and commit list;
- exact changed/untracked paths and confirmation `.vscode/`/`Mock Images/` were
  preserved;
- RED command and failure reason for every task, then GREEN command/results;
- full pytest/npm/browser counts, both viewport results, syntax/diff checks and
  static byte total;
- migration/API/Action schema versions and compatibility notes;
- generated artifact hashes and provenance (never private source media);
- scope deviations, unsupported cases and remaining evidence gaps;
- CI run URL and both job conclusions only after Richard authorizes push.

No merge, acceptance label, timing tolerance, dependency, or production scope
expansion is authorized by this plan alone.

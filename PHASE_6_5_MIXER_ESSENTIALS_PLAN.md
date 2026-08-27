# Phase 6.5 — Two-Deck Mixer Essentials

**Audience:** Hermes (implementation owner)  
**Baseline:** `v0.3-workspace` at `8a4c14a`  
**Status:** Proposed implementation plan; do not begin Phase 7 release work in
the same change set  
**Ownership:** Hermes codes and tests. Codex/Sol audits, applies only narrow
corrections, commits, pushes, and monitors CI.

## 1. Why this phase exists

Phase 6 completed the reliable select → arrange → preview → render → recover
journey, but the current mix model still hides too much musical intent:

- the Foundation silently dictates output BPM;
- only the Lead is time-stretched;
- both sources begin together on the output clock;
- gains are available, but there is no transition shape, pan, or basic tone
  shaping;
- the plan reports technical ratios without giving the user a clear target-BPM
  decision.

This phase adds the smallest coherent mixer needed to blend two files with
intent. It is not a full DAW.

## 2. Scope boundary

### In scope

- explicit output BPM selection;
- Foundation, Lead, or custom BPM as the tempo target;
- truthful per-deck stretch ratios and percentage changes;
- legacy simultaneous overlay plus a deliberate A→B transition mode;
- transition start, crossfade duration, and a small safe curve allowlist;
- per-deck gain, stereo pan, and fixed-band low/mid/high EQ trim;
- exact plan/preview/full-render parity;
- persistence, history, retry, and “Use these settings in a new mix” support;
- accessible, responsive controls and a compact output-clock visualization.

### Explicitly out of scope

- three or more simultaneous tracks;
- arbitrary clip lists, drag/drop timeline editing, clip splitting, looping, or
  automation lanes;
- plugin hosting, VST/LV2, arbitrary FFmpeg filters, buses, sends, or sidechain;
- live Web Audio recreation of the server DSP;
- beat/phrase/chorus detection;
- changes to job scheduling, GPU policy, acquisition, or stem separation;
- version bump, tag, or release work (still Phase 7).

If Richard asks for arbitrary multitrack composition, stop and propose a V0.4
relational `project_clips` design. Do not stretch the current two-role project
row into an unbounded track array.

## 3. Product semantics

### 3.1 Tempo target

Persist these project settings:

- `tempo_mode`: `foundation` (default), `lead`, or `custom`;
- `target_bpm`: `null` unless `tempo_mode=custom`, otherwise finite and within
  the same supported BPM range used by analysis overrides.

Resolve the output BPM as:

- Foundation mode: effective Foundation BPM;
- Lead mode: effective Lead BPM;
- Custom mode: validated `target_bpm`.

Both sources are aligned to the output BPM:

- `anchor_tempo_ratio = output_bpm / anchor_effective_bpm`;
- `lead_tempo_ratio = output_bpm / lead_effective_bpm`.

The old `tempo_ratio` response field remains as a compatibility alias for
`lead_tempo_ratio`. With default settings, Foundation ratio is `1.0` and output
must remain behaviorally equivalent to V0.3.

Pitch behavior remains explicit and independent:

- time stretching preserves each source's pitch;
- `pitch_mode=match` additionally shifts the Lead toward the Foundation key;
- `pitch_mode=preserve` applies no key shift.

Do not change detected or overridden track BPM merely because a project chooses
a different output BPM. The project setting is arrangement intent, not track
metadata.

### 3.2 Arrangement modes

Persist:

- `arrangement_mode`: `overlay` (default) or `transition`;
- `transition_start`: non-negative output-clock seconds;
- `crossfade_duration`: finite `0..30` seconds;
- `crossfade_curve`: `equal_power` (default) or `linear`.

`overlay` preserves V0.3 semantics: both selected source regions begin at
output time zero and the automatic duration is the shorter aligned overlap.
Transition-only settings are ignored by rendering and clearly disabled in the
UI while overlay is selected.

`transition` means:

1. Foundation begins at output time zero from `anchor_start` source time.
2. Lead begins at `transition_start` from `lead_start` source time.
3. Foundation fades out and Lead fades in over `crossfade_duration`, beginning
   at `transition_start`.
4. A zero-duration crossfade is an explicit hard cut.
5. Automatic output duration is `transition_start + aligned Lead availability`.
6. A requested duration is capped truthfully to available media.
7. Foundation must have enough aligned material to reach the end of the
   crossfade. Reject an impossible transition; never silently move it.

The server-authored plan must warn about gaps, insufficient overlap, severe
stretch, large pitch shifts, duration capping, and transition truncation.

### 3.3 Channel controls

Retain `anchor_gain` and `lead_gain`. Add:

- `anchor_pan`, `lead_pan`: finite `-1..1`, default `0`;
- `anchor_eq`, `lead_eq`: strict objects with exactly `low`, `mid`, `high`;
- each EQ value: finite dB trim in `-12..12`, default `0`.

Use fixed, documented musical bands (approximately low shelf 120 Hz, mid bell
1 kHz, high shelf 8 kHz). These are numeric controls, never client-supplied
filter expressions. Keep the existing final loudness/true-peak stage.

## 4. API and persistence contracts

1. Extend the project settings validator with the exact keys and ranges above.
   Reject unknown nested EQ keys, booleans used as numbers, NaN, infinities,
   malformed objects, and contradictory custom-tempo settings.
2. Extend `RenderOptions`, `RenderBody`, canonical `POST /api/renders`, the
   `/api/jobs` compatibility route, and `POST /api/renders/plan` with matching
   defaults.
3. Preserve old requests and existing project rows without a migration where
   possible; missing fields must produce V0.3 behavior exactly.
4. Persist normalized mixer settings in job requests so restart, retry,
   history, rename, and new-mix reconstruction remain deterministic.
5. Extend result/plan metadata with:
   - resolved output BPM and tempo mode;
   - both ratios and both percentage changes;
   - arrangement mode and transition timing;
   - normalized channel controls;
   - per-source consumed time and output-clock intervals.
6. Continue returning no absolute paths and the common error envelope.
7. Update CLI render options only where needed to keep service/CLI parity. Do
   not create a second planning or DSP implementation in the CLI.

## 5. Renderer design

1. Refactor alignment so both Foundation and Lead can be time-stretched. Avoid
   a special Lead-only path whose math can drift from planning.
2. Keep subprocess calls as argument lists. Construct FFmpeg filter graphs only
   from validated numeric values and internal allowlisted filter/curve names.
3. Apply each channel in a deterministic order:
   - source trim;
   - tempo alignment;
   - Lead key shift when requested;
   - fixed-band EQ;
   - pan;
   - gain;
   - transition delay/envelope when applicable.
4. Mix, then retain the existing final loudness and true-peak limiting stage.
5. Use one shared arrangement calculation for plan and render. Duration,
   consumed-source time, ratios, warnings, and transition boundaries must not
   be recomputed independently in the browser.
6. Cancellation boundaries and atomic managed-output finalization remain
   unchanged.
7. Preview is the exact same DSP path with only the established duration cap.
   No lower-quality or client-side approximation.

## 6. UI design

### 6.1 Tempo card

Replace the opaque ratio-first presentation with:

- `Output BPM` as the primary value;
- segmented choices: `Foundation`, `Lead`, `Custom`;
- validated numeric custom BPM input;
- quick `½` and `×2` target helpers with accessible names;
- one row per deck: source BPM → output BPM, ratio, and signed percent change;
- a `Reset to Foundation` action.

Ratios remain visible but secondary. State plainly which audio is being
stretched and by how much. Large-change warnings come from the server plan.

### 6.2 Arrangement card

- `Overlay` and `Transition A → B` modes;
- transition start on the output clock;
- crossfade duration and curve;
- numeric fields plus range controls where useful;
- a compact, non-draggable output-clock diagram showing Foundation, Lead, and
  the overlap/fade region;
- source cues remain visibly distinct from output placement.

This visualization is explanatory, not a DAW timeline. It must use semantic DOM
and CSS rather than canvas if text/regions need to remain accessible.

### 6.3 Channel strips

Provide matching Foundation and Lead groups:

- gain with numeric value and existing safe range;
- pan with `L`, `C`, `R` labeling and numeric fallback;
- low, mid, and high EQ trims in dB;
- per-channel `Reset` plus a global `Reset mixer`;
- role colors remain Foundation pink and Lead cyan.

Controls must persist through the serialized `ProjectManager`, invalidate stale
plans synchronously, and never enable Preview/Render until the exact new plan
request matches current state.

Do not add a second audio element or attempt simultaneous raw deck playback.
Processed audition remains `Preview 12s` through the render job path.

## 7. Implementation order for Hermes

### Task 0 — Baseline and scope lock

- Confirm clean `v0.3-workspace` at `8a4c14a` (or report the newer accepted
  commit before editing).
- Read `CODEX.md`, `V0.3_IMPLEMENTATION_PLAN.md`, this file, renderer/planner,
  project validation, API models, and the Phase 5/6 frontend components.
- Run the full baseline. Preserve Richard's media and persistent data.
- Do not commit or push; Sol owns audit and commits.

### Task 1 — Failing contract and planner tests

- Add strict project/API tests for all new defaults, ranges, enums, nested EQ,
  unknown keys, non-finite values, and old payload compatibility.
- Add planner vectors for Foundation, Lead, and custom targets across slower and
  faster sources.
- Add overlay and transition duration/availability vectors, including hard cut,
  insufficient Foundation overlap, requested-duration cap, and severe-stretch
  warnings.

### Task 2 — Shared backend contracts and planning

- Implement validated settings and request models.
- Refactor the single server-authored arrangement calculation.
- Keep compatibility aliases and default output identical.
- Return normalized mixer/transition facts needed by the UI and history.

### Task 3 — DSP implementation

- Generalize two-source alignment.
- Implement allowlisted EQ, pan, delay, and fade filters.
- Preserve final loudness/limiting and atomic output behavior.
- Add generated-tone integration tests for duration, tempo, transition energy,
  channel pan, EQ direction, and true peak. Tests must be deterministic and
  require no network, CUDA, or Richard's media.

### Task 4 — Project and render plumbing

- Extend strict frontend `RenderBody` construction.
- Extend new-mix allowlisting and validation.
- Ensure autosave serialization, retry requests, history display, and restart
  recovery preserve every normalized field.
- Prove stale plans disable actions in the same turn as every mixer change.

### Task 5 — Mixer UI

- Build the tempo, arrangement, and two channel-strip controls.
- Render server-authored plan facts and warnings.
- Add the accessible output-clock visualization.
- Keep touch targets at least 44 px, visible focus, reduced motion, semantic
  tokens, safe `textContent`, and no horizontal-overflow masks.

### Task 6 — Acceptance and handoff

- Focused backend and frontend tests, then full `pytest` and `npm test`.
- `node --check` all changed/new modules and `git diff --check`.
- Recalculate the uncompressed frontend budget (must remain below 350 KB).
- Chromium QA at 1440×1100, 1280×800, 820×1180, and exact 390×844 with populated
  long-name states; prove `scrollWidth === clientWidth` at 390px.
- Keyboard-only pass for all new controls and dialog flows.
- Report files, tests, bundle size, screenshots, deviations, and known limits.
- Leave the complete working tree uncommitted for Sol's audit.

## 8. Required regression coverage

- V0.3 payload with no new fields produces Foundation ratio `1.0`, the old Lead
  ratio, the old duration, and equivalent output behavior.
- Plan and renderer agree for both ratios and all duration/source-time math.
- Preview and full render share the same mixer settings.
- Retry and restart use the original normalized request.
- Preview completion never replaces the latest full result.
- New-mix copies every new allowlisted field and rejects malformed history
  before mutating live state.
- Hostile names/details remain literal text.
- One AudioController and one EventSource per job remain true.
- Transition settings cannot leak into overlay behavior.
- Invalid EQ/pan/BPM/transition values never reach FFmpeg.
- Extreme but valid settings produce warnings and remain below 0 dBFS after the
  final limiter.

## 9. Exit gate

Phase 6.5 is complete only when a user can:

1. choose two tracks with different effective BPMs;
2. select Foundation, Lead, or a custom output BPM and understand both stretch
   operations before rendering;
3. choose legacy overlay or place an A→B transition with an audible, truthful
   crossfade;
4. shape each source with gain, pan, and three fixed EQ trims;
5. preview and render through the identical server DSP path;
6. reload, retry, inspect history, and create a new mix without losing settings;
7. use the complete flow at all target widths and by keyboard;
8. pass the complete local suite and green CI after Sol's audit/commit.

Only after this exit gate should Phase 7 quality/release work resume.

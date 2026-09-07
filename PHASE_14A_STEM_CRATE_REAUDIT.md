# Phase 14A Stem Crate FUN mock — Sol re-audit

Status: **CHANGES REQUESTED — one functional truth blocker remains.**
Architecture recommendation: **STEM STACK APPROVED IN PRINCIPLE.**

Re-audited branch `phase14-stem-crate-fun` at
`f9bd2592eae545120178a8f2aac7114c14cbdaf9`, equal to `origin/main` at audit.

## Prior findings disposition

1. Cross-role drop: fixed and reproduced green in real Chromium. Vocals→BEAT
   leaves BEAT empty and produces visible/announced error copy.
2. Unsupported override authority: fixed. Governance now requires evidence and
   Richard/Sol approval before production deviation.
3. BPM/key truth: fixed. 94→120 is `+26` and `+27.7%`; C major→A minor is
   identified as relative-key compatible with a proposed 0-st shift.
4. Bloom parity: fixed. Pointer, focusable keyboard pad and two synchronized
   native ranges share state.
5. Reachable error/unavailable states and ffmpeg visible treatment: materially
   fixed. Missing media and missing BPM reach their states; ffmpeg cards are
   visibly reference-only with disabled Place.

The compact 2×2 mobile stage, role-specific labels, filter pressed state,
disabled future controls, visible status and role characters are also present.

## Remaining blocker

### HIGH — Failed/unavailable stack components still unlock Fever recipes

Location: `design/stem_crate_fun_mock.html:507-515`

`Master Drop` verifies all four slot states are compatible, but `Harmonic Blend`
and `Tempo Match` compare raw key/BPM values only. They do not require their
component slots to be compatible/available.

Real Chromium reproduction:

1. Place valid Drums `c1` in BEAT.
2. Place valid Vocals `c4` in VOICE.
3. Place missing-media Bass `c11` in BASS (`data-state="unavailable"`).
4. `Master Drop` remains locked, but both `Harmonic Blend` and `Tempo Match`
   become unlocked.

That contradicts the decision record's claim that recipes unlock “never on a
failed/incompatible component” and would reward an inaudible/corrupt stack.

Required fix:

- Define one explicit eligibility helper for a Fever ingredient, minimally
  requiring the slot to contain an item and `slotState(item) === 'compatible'`.
- Require eligibility for every ingredient in all three recipes before comparing
  key/BPM facts.
- Add RED/GREEN tests proving each recipe stays locked for `error`,
  `unavailable`, and `transform` ingredients, then proves the intended compatible
  recipe unlocks.
- Keep recipe copy and implementation in exact parity.

## Remaining accessibility correction

### MEDIUM — Reference-only ffmpeg cards still announce themselves as actionable

Location: `design/stem_crate_fun_mock.html:445-478`

The nested Place button is disabled, but the outer ffmpeg card still has
`role="button"`, `tabIndex=0`, and `aria-label="Place Center from First Love"`.
It has no activation handler. A keyboard/screen-reader user therefore encounters
an enabled-sounding Place control that does nothing—the same truth problem the
visible treatment was intended to remove.

Required fix:

- Reference cards must be non-actionable article/list-item content: no button
  role, no placement aria-label, and no tab stop unless they expose a genuine
  details control.
- Prefer one interactive element per card. The current actionable cards use a
  focusable `role=button` container containing a native button, which creates
  nested/duplicate activation semantics. Make the card plain content with one
  native Place button, or make the whole card the sole button without a nested
  button.
- Add a contract test for reference-card semantics and keyboard focusability.

## Deliberate tap-flow disagreement

Accepted. A single explicit Place action that auto-targets the stem's declared
role is lower-friction and prevents role ambiguity. Phase 14A does not need a
select-then-target interaction. Keep drag/drop as an optional pointer shortcut
with strict role validation; retain the native Place button as the accessible
canonical action.

## Re-audit verification

- Baseline/head/remote parity verified at
  `f9bd2592eae545120178a8f2aac7114c14cbdaf9`.
- Focused design suite: `12 passed, 0 failed`.
- Full frontend suite: `340 passed, 0 failed`.
- Test-file and extracted 332-line inline JavaScript syntax: clean.
- `git diff --check`: clean.
- Real Chromium desktop: 4 slots, 11 cards, 3 trophies; prior cross-role defect
  remains fixed; corrected ffmpeg/Bloom/error states execute.
- Real Chromium adversarial Fever case reproduced the remaining blocker.
- Real Chromium 390×844: 390px content width, 169px × 2 slot columns, no
  horizontal overflow; all four compatible cards unlock three trophies.
- Production static assets: 489,004 bytes.
- No production files changed and no commit/push performed.

## Hermes B return contract

Fix only the Fever eligibility truth and card interaction semantics, add focused
RED/GREEN tests, rerun the 12+ amended focused suite and full frontend suite, and
return for final Phase 14A re-audit. Do not begin Phase 14B yet.

The one-prepared-asset/one-committed-layer architecture remains recommended.
Final implementation authorization remains Richard's decision after green
re-audit.

## Final addendum — PASS

Status: **PASS for Phase 14A interaction acceptance.**

The final correction adds one shared `feverEligible(role)` gate and applies it
to every recipe ingredient. Sol reproduced the former valid-Drums + valid-Vocals
+ missing-media-Bass case in real Chromium: BASS remained `unavailable` and zero
trophies unlocked. Error and transform-needed ingredients are pinned by separate
regression tests.

Reference ffmpeg cards now expose no button role, tab stop, drag behavior or
enabled control. Actionable cards are plain containers with exactly one labeled
native Place button. The prior duplicate/dead interaction semantics are gone.

Final verification:

- focused design contract: 17 passed, 0 failed;
- full frontend suite: 345 passed, 0 failed;
- real Chromium adversarial Fever case: 0 unlocked;
- real Chromium happy path: four compatible slots, 3 unlocked;
- cross-role drag remains rejected with visible feedback;
- reference card: role null, tabIndex -1, draggable false, zero enabled buttons;
- actionable card: one labeled native Place button;
- mobile 390×844: 169px × 2 columns, no horizontal overflow;
- `git diff --check` and JavaScript syntax checks clean;
- production static assets remain 489,004 bytes.

The auto-targeting native Place action is accepted. Phase 14A may be committed
when Richard authorizes. This PASS does not itself authorize Phase 14B, push or
merge, and it does not establish simultaneous Foundation+Lead playback.

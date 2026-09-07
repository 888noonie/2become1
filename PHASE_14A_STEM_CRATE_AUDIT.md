# Phase 14A Stem Crate FUN mock — Sol audit

Status: **CHANGES REQUESTED** for interaction acceptance.
Architecture recommendation: **APPROVE STEM STACK IN PRINCIPLE** — up to four
stem-loop components rendered into one managed prepared asset and projected as
one committed layer.

Audited branch/worktree: `phase14-stem-crate-fun` at
`f9bd2592eae545120178a8f2aac7114c14cbdaf9` (equal to `origin/main` at audit).
Audited untracked implementation artifacts:

- `design/stem_crate_fun_mock.html`
- `PHASE_14_STEM_CRATE_DECISION.md`

Preserved unrelated/untracked `.hermes/`, `.vscode/`, and `Mock Images/`.

## What works

- The visual direction is coherent with the current dark 2become1 language and
  makes compatibility/provenance more legible than the inspiration mock.
- Desktop rendering is clean and the 390px layout has no horizontal overflow.
- Four role slots, nine cards and three deterministic trophies render.
- The four matching Demucs cards produce four compatible slots and unlock all
  three recipes.
- Source-track inheritance, separation bleed, method and source hash are visible.
- ffmpeg is not silently represented as a four-way musical separation.
- Search/filter, direct Place, keyboard Enter/Space, loop length, mute, solo,
  gain, remove, Bloom pointer input and Escape cancellation execute.
- Prototype-only/no-audio/no-production-DSP copy is explicit.

## Blocking findings

### HIGH — Drag/drop ignores role compatibility and can falsify Fever state

Locations: `design/stem_crate_fun_mock.html:346-356,417-425,428-436`

The Place button sends a card to its declared role, but drop accepts the target
slot without validating it. In a real Chromium run, dragging the Progressive
Train Vocals card onto BEAT resulted in:

`Vocals from Progressive Train placed in beat.`

The beat slot then held Vocals and was considered by the compatibility/Fever
logic. This violates the one-component-per-role contract and lets recipes reason
about mislabeled components.

Required fix: reject a drop whose `item.role !== targetRole`, announce and show a
visible reason, leave the prior slot unchanged, and add an automated regression
for all cross-role drops. If creative cross-role placement is desired later,
model `sourceStem` and `assignedRole` separately and make recipes validate the
assigned role explicitly; do not obtain it accidentally from a drop target.

### HIGH — The decision record grants unsupported authority to override the plan

Location: `PHASE_14_STEM_CRATE_DECISION.md:13-14`

The record says Richard granted the coder latitude to override the plan for
latency/UX. That authorization is not present in the Phase 14 handoff audited by
Sol and is too broad for the phase governance: a perceived lower-latency choice
could bypass the one-asset architecture or evidence stops.

Required fix: remove it unless Richard supplies the exact authorization. Replace
it with: implementation deviations are proposed with evidence and stop for
Richard/Sol approval before production scope changes.

### MEDIUM — Compatibility copy reports the BPM change with the wrong sign and
key transformation without a transform

Locations: `design/stem_crate_fun_mock.html:271-286` and
`PHASE_14_STEM_CRATE_DECISION.md:31-33,63-64`

For `94→120 BPM`, the required target-minus-source change is `+26 BPM` (ratio
`1.2765957447`, approximately `+27.66%`), but the mock displays `−26`. The code
computes `source - target` while presenting an arrow from source to target.

`C major → A minor (needs shift)` is also not enough to claim that the applied
shift is shown. C major and A minor are relative keys sharing the same pitch
collection; whether tonic alignment requires a shift is a policy decision. No
semitone amount is calculated or displayed.

Required fix: present source BPM, target BPM, signed applied delta/ratio with one
documented convention, and a musically explicit key relation. For this mock,
`relative-key compatible; 0 st pitch shift proposed` is more truthful than
`needs shift`. If tonic matching is the policy, display the exact signed semitone
proposal instead.

### MEDIUM — Bloom has no non-pointer control despite claiming slider parity

Locations: `design/stem_crate_fun_mock.html:215-230,450-473` and
`PHASE_14_STEM_CRATE_DECISION.md:37-39`

The Bloom pad has `role="application"`, `tabIndex == -1`, no keyboard handler and
no Bloom range inputs. The only buttons queue and cancel the current value. The
decision record says sliders/buttons provide an equivalent and the interaction
does not rely on the radial gesture; that claim is false.

Required fix: add labeled pitch and gain/duck ranges synchronized with the pad,
or make the pad focusable with documented arrow/Home/End controls. Prefer
ordinary range inputs and remove `role="application"` unless custom keyboard
interaction genuinely warrants it. Test keyboard-only adjustment and announced
readout changes.

### MEDIUM — Claimed error/unavailable slot states are unreachable; ffmpeg cards
look actionable but fail invisibly for sighted users

Locations: `design/stem_crate_fun_mock.html:289-295,346-350,378-394` and
`PHASE_14_STEM_CRATE_DECISION.md:24-25,49-51`

`slotState()` defines `error` and `unavailable`, but every ffmpeg card is rejected
before assignment and no non-ffmpeg card has missing BPM. Therefore neither
state can be demonstrated through the UI. The ffmpeg cards retain an enabled
purple Place button; clicking it only updates the screen-reader-only announcer,
with no visible card/slot feedback.

Required fix: either add deterministic prototype cards/actions that visibly
exercise error and unavailable states, or narrow the claim. Mark ffmpeg cards
`reference only` with a visibly disabled/non-place action and explanation, or
show an inline visible rejection message. Do not present an enabled primary
button whose only outcome is invisible rejection.

## Non-blocking product/a11y findings

1. At 390×844 there is no horizontal overflow, but the document is 4,053px tall
   and the crate begins only after four large single-column empty slots. FUN mode
   feels like a settings form rather than immediate play. Trial a compact 2×2
   orb grid or horizontally scrollable character stage so the crate and running
   stack can share the first interaction viewport.
2. Populated controls use `M`, `S`, `✕`, repeated `Gain`, and repeated `Loop bars`
   labels without role/stem context. Add `Mute Beat`, `Solo Bass`, `Remove Voice`,
   `Voice gain`, etc.
3. Filter active state is visual-only; update `aria-pressed`. DJ initially lacks
   `aria-pressed="false"`.
4. REC, Undo and DJ are enabled-looking no-ops. Disable and mark them `future in
   prototype`, or implement honest simulated state. The prototype disclaimer
   does not fully repair a primary control that silently does nothing.
5. The mock is polished and strong on the “Djay brains” side, but its four
   letter-orbs and dense cards do little yet to deliver Incredibox character/play
   energy. Add distinct role character silhouettes/personality and immediate
   motion/state feedback without copying Incredibox assets or sacrificing text.
6. “Place” auto-targets the declared role. That is accessible, but it is not the
   planned tap-select/tap-target interaction. Record this as an intentional UX
   simplification or implement selectable card + explicit target choice.

## Verification performed by Sol

- Branch/HEAD/remote parity checked: local and `origin/main` baseline are
  `f9bd2592eae545120178a8f2aac7114c14cbdaf9`.
- `git diff --check`: clean.
- Extracted 252-line inline JavaScript and ran `node --check`: clean.
- Parsed static HTML: no duplicate IDs.
- Real Chromium at desktop: 4 slots, 9 cards, 3 trophies; matching four-card
  recipe unlock verified.
- Real Chromium adversarial drop: Vocals accepted into BEAT (blocking defect
  reproduced).
- Real Chromium ffmpeg action: enabled Place button, no visible failure state;
  screen-reader announcement only.
- Real Chromium 390×844: 390px content width/no horizontal overflow, one 350px
  slot column, 4,053px document height.
- Bloom inspection: pad not keyboard-focusable and zero Bloom-specific sliders.
- Static production assets remain 489,004 bytes because the mock is outside
  `studio_static/`.
- Production files are unchanged; full production suites were not rerun for this
  standalone untracked design artifact.

## Return contract for Hermes B

Make only Phase 14A artifact/decision corrections. Do not begin Phase 14B.
Return:

- exact changed paths;
- RED/GREEN automated checks for cross-role drop rejection, Bloom keyboard/range
  parity, visible ffmpeg rejection/unavailability, and truthful compatibility;
- desktop and 390×844 browser results, including no horizontal overflow;
- an updated decision record with no unsupported authority claim and all
  interaction claims matching reachable behavior;
- any deliberate disagreement with the compact mobile/game-stage recommendation.

The one-prepared-asset/one-committed-layer stem-stack architecture is the right
direction, but Richard's final sign-off and a green Phase 14A re-audit remain
required before production Phase 14B starts.

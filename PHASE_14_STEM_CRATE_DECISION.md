# Phase 14A — Stem Crate (FUN) interaction decision record

Status: CANDIDATE — awaiting Richard's acceptance and Sol's re-audit.
Branch: `phase14-stem-crate-fun` (from main `f9bd2592eae545120178a8f2aac7114c14cbdaf9`).

## Naming decision (Richard, 2026-09-07)

- "WaxDrop" is a Loopit mock-image working name only. It is NOT used in the
  product or this artifact.
- The feature lives in the existing **FUN** tab (next to DJ), reusing the
  `performance-deck.js` DJ/FUN toggle and the existing dark `#070a14` /
  `#8a5cff` / `#2ee5a8` visual language.

## Governance

Implementation deviations are proposed with evidence and stop for Richard/Sol
approval before any production scope change. No blanket override authority is
assumed; the audited Phase 14 handoff governs.

## Artifact

- `design/stem_crate_fun_mock.html` — one self-contained HTML/CSS/JS file,
  no CDN, no dependencies, no copied Loopit assets. Inline JS extracted and
  `node --check` clean.
- `tests/frontend/design/stem-crate-fun-mock.test.js` — 12 jsdom contract
  tests driving the real DOM (cross-role drop rejection, ffmpeg reference-only,
  reachable error/unavailable states, signed compatibility math, Bloom
  pointer/keyboard/range parity, recipe unlock, aria-pressed, disabled no-ops).

## What the prototype demonstrates

1. Four role slots — BEAT, BASS, OTHER/MELODY, VOICE — each with empty,
   compatible, transform-needed, error, and unavailable states, all reachable
   through the UI.
2. Searchable crate cards showing track, actual stem, method (Demucs 4-stem
   vs ffmpeg center/sides), source-track-inherited provenance, BPM/key,
   confidence, source-hash shorthand, and a bleed warning.
3. Pointer drag/drop plus tap-select (Place button) and keyboard (Enter/Space)
   parity. Cross-role placement is rejected with visible and announced
   feedback; a stem may only occupy its declared role.
4. Per-slot 1/2/4/8-bar selector, mute/solo, gain, remove, and a textual
   compatibility explanation with signed, truthful math.
5. Fever trophy room with three deterministic recipes (Master Drop, Harmonic
   Blend, Tempo Match) that unlock only on an explicit predicate — never on a
   hidden timer or a failed/incompatible component.
6. Bloom X/Y preview with full parity: pointer drag, focusable pad with arrow
   keys (Home resets), and synchronized pitch/gain range inputs. Release shows
   "queued for next beat"; Escape/Cancel resets.
7. Honest reduced-motion, focus-visible, live-region announcements, 44px touch
   targets, role-specific accessible labels, and responsive desktop/mobile
   layouts.

## Compatibility math (truthful, signed)

- BPM delta is target minus source, signed: 94→120 BPM displays `+26` (ratio
  +27.7%), never a negative applied change.
- Key relation is musically explicit: same key → `same key; 0 st`; relative
  keys (e.g. C major ↔ A minor) → `relative-key compatible; 0 st pitch shift
  proposed`; otherwise a signed tonic-alignment semitone proposal.
- Unknown key/BPM is `unknown`, never `compatible`.

## Honest-stem guardrails honored

- Demucs `other` is presented as OTHER/MELODY but retains the source label
  `other`; it is never relabeled a guaranteed melody stem.
- ffmpeg center/sides is `reference only` with a disabled Place action and a
  visible explanation; it is never auto-labeled as a musical stem and cannot
  be placed into a role slot.
- Stems inherit track BPM/key and are labeled `source-track inherited`, never
  "stem-detected".
- Compatibility is advice, not proof of musical quality; the source and target
  BPM/key and the applied shift are shown.

## Verified interactions (browser smoke test + jsdom contract)

- 4 slots, 11 crate cards, 3 trophies render; FUN mode active by default.
- Placing all four Vinyl Streetwear stems (120 BPM, A minor) → all four slots
  `compatible`, all three trophies unlock.
- Placing a 94 BPM / C major stem → slot `transform`, text shows `+26` BPM and
  the key relation.
- Placing a C major bass against A minor master → `relative-key compatible;
  0 st pitch shift proposed`.
- Cross-role drop (Vocals → BEAT) → rejected, slot unchanged, visible + announced.
- ffmpeg center/sides → `reference only`, disabled Place, visible explanation.
- Missing-media stem → `unavailable`; unknown-BPM stem → `error`.
- Bloom: pointer, arrow keys, and range inputs all synchronized; Escape resets.
- Mobile (390×844): slots collapse to 2 columns, bloom to 1 column, no
  horizontal overflow.

## Deferred (not silently promised)

- Production APIs, DSP, database, Action contracts, and static-budget changes
  (Phase 14B/14C).
- REC gesture automation, live stutter/reverse, quantized Bloom FX, QR crate
  sharing, per-stem analysis, multiple committed layers, AI Producer bridges.

## Open decision for Richard

The stem-stack decision (up to four stem loops → one prepared asset → one
committed layer) is the architecture Phase 14B/14C will build on. This
prototype assumes it. Richard confirms the interaction and the stem-stack
decision before Phase 14B begins.

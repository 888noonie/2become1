# 2become1 integration receipt — 2026-11-17

Branch `integration/family-together`, worktree
`/tmp/opencode/2become1-family-together`.

This is the composition of three accepted candidates on top of the preserved
local baseline. Nothing was pushed, promoted or deployed.

## Provenance

| Item | Ref | Content |
| --- | --- | --- |
| Local baseline | `763e1d9` | `main` in the owner checkout |
| Stem Desk | `c88d64e` | `feature/stem-desk`, 4 commits |
| Static policy | `86c9eb8` | `feature/static-budget-policy`, 1 commit |
| Native Q growth recorder | `2a02169` | `q/static-growth-evidence`, 1 commit |

All three candidates share merge-base `763e1d9`. They were merged with real
merge commits (`--no-ff`) in that order, so every candidate ref and commit is
preserved unrewritten. **No merge conflicts occurred**: Stem Desk is additive
to `src/` and `tests/`, the policy commit touches only documentation, and the
recorder adds three new files. The single semantic adaptation after the merges
is described below.

Integration HEAD at test time: `c9db957` (the receipt commit adds only this
document, so the tested code is identical).

## Policy adaptation (the only post-merge change)

The Q recorder originally failed when growth exceeded either 15% or 50,000
bytes. The owner's 2026-11-17 decision makes those thresholds **reporting and
investigation triggers, not automatic release-rejection thresholds**.

`tests/frontend/static-size.test.js` now:

- always prints the measured total, file count, baseline, delta, growth and the
  five largest files;
- prints an explicit *investigation trigger* when either threshold is crossed;
- fails only when a release job opts in with `STATIC_GROWTH_ENFORCE=1`.

Control run in a throwaway copy with the baseline lowered to 500,000 bytes
(35.72% growth): report-only mode exits 0 with the trigger printed, enforced
mode exits 1. Both behaviours are proven, not asserted in prose.

`docs/static-asset-policy.md` records the same rule and the integrated
measurement.

## Static asset measurement

| Metric | Value |
| --- | --- |
| Total uncompressed bytes | 678,605 |
| Files | 69 |
| Baseline (763e1d9) | 650,905 bytes, 67 files |
| Delta | +27,700 bytes (+4.26%) |
| Triggers (15% / 50,000 B) | not crossed |

Largest files: `js/runtime/ghost-controller.js` 55,945; `js/runtime/live-mixer.js`
39,556; `styles/studio.css` 30,601; `js/components/plan.js` 27,543;
`js/components/deck.js` 22,250.

The growth is the four-lane Stem Performance Desk. It is explained, measured
and covered by the journeys below. No feature was minified or removed.

## Suites

| Suite | Result |
| --- | --- |
| Frontend `npm test` | 490 tests, 490 pass, 0 fail |
| Python `.venv/bin/pytest -q` | 580 passed, 1 skipped |
| Browser desktop `1280x800` | 39 checks, 0 failures |
| Browser mobile `390x844` | 39 checks, **5 failures — all pre-existing** |
| Stem Desk UX | pass, including mute/solo state and no horizontal overflow |
| Stem crate UX | pass, including 44 px target and no overflow |
| Three-bus UX | pass |
| Signal-level audio (`stem_desk_audio.js`) | 8/8 checks |

The audio capture renders four synthetic stems through the real runtime on an
`OfflineAudioContext` and measures the produced PCM: each stem audible, muting
drums removes only drums, −12 dB is one quarter amplitude, solo suppresses the
other three, and stop-before-render leaves silence. It is a signal test, not a
listening test, and makes no speaker claim.

### The five mobile accessibility failures are baseline, not new

The identical run on the preserved baseline `763e1d9` produces the same five
checks and the same counts:

| Check | Baseline `763e1d9` | Integration `c9db957` |
| --- | --- | --- |
| accessibility: source picker | 0 serious, 8 moderate | 0 serious, 8 moderate |
| accessibility: stem dialog | 0 serious, 8 moderate | 0 serious, 8 moderate |
| accessibility: completed render result | 0 serious, 8 moderate | 0 serious, 8 moderate |
| accessibility: analysis dialog | 0 serious, 8 moderate | 0 serious, 8 moderate |
| accessibility: studio view | 0 serious, 8 moderate | 0 serious, 8 moderate |

No serious finding in either run, and no new failure introduced by the
integration. The mobile baseline defect remains a known limitation.

## Audio memory safety is unchanged

The owner's relaxation applies to the **frontend static-asset budget only**.
The Stem Desk keeps `STEM_DESK_LIMITS`: at most four lanes, a bounded declared
and fetched byte size per stem, a bounded decoded PCM size per stem and in
total, and a truthful refusal (`S_TOO_MANY_STEMS`, over-size refusals) instead
of unbounded allocation. A safer loop-window or streaming design was not
implemented and is not claimed.

## What this branch does not do

- No push, no `main` promotion, no deployment, no Studio production instance.
- No change to the owner's `main` checkout, which remains at `763e1d9`.
- No change to the Stem Desk's four-stem transport, gain, mute, solo,
  provenance or lifecycle behaviour; the integration merge is unmodified.

---
name: audio-validation
description: >
  Prove a 2become1 audio or autonomous-edit change with a negative control and
  a measured WAV. Use before calling a timing, level, or takeover bug fixed.
---

# Audio validation and negative controls

## When to use

A change claims to preserve a clip, a curve, a source offset, a stop, or an export level. The existing green suite is not that proof until a test fails on the old code and passes on the new code.

## Problem

Arrangement bugs survive broad suites because the happy path still produces some arrangement. The useful test is the one that used to delete, layer, or clip.

## Source of truth

- `tests/frontend/chorus-fit-panel.test.js` — the three controls added while reviewing `fbf7732`
- `tests/frontend/arrangement/negative-control.test.js`
- `tests/browser/maestro_journey.js` and `tests/browser/full_house_daw.js`
- `src/twobecomeone/studio_static/js/arrangement/wav.js`
- `src/twobecomeone/studio_static/js/arrangement/offline-render.js`
- `docs/stem-desk-engineering-guide.md` for the desk's listening rule
- `docs/the-maestro.md`

## Boundaries

Synthetic songs prove clip identity, timing, levels, and handoffs. They do not prove taste. Headless PCM does not replace the PM listening to real songs. No journey uploads a recording.

## Invariants

- A negative control fails on the implementation being replaced.
- Export is 48 kHz, stereo, 24-bit, arrangement length plus the journey's tail.
- On `cbe6984`, the Maestro journey measured peak −0.30 dBFS and 0 samples at or above 0.999. The Full House journey measured about −1.49 dBFS, under the −0.3 dBFS ceiling. Re-measure after any render change. Those numbers are evidence for that commit, not a permanent certificate.
- The latest autonomous arrangement still needs the PM listening steps in `docs/the-maestro.md`. A green journey is not that acceptance.
- Analysis and deterministic planning are not hearing. A model call, when one runs, reads text. No audio is sent to it.
- Live versus export on that Maestro run: 50 ms envelope correlation 0.963 at 115 ms lag, median level difference −0.12 dB.
- One skipped frontend test, the saved bounce artifact, is skipped when `artifacts/living-daylights-bounce.wav` is absent. Do not add that wav to git.

## Procedure

1. Write the assertion against the broken behaviour and run it. Keep the failure output.
2. Make the smallest code change that turns that assertion green.
3. Run the surrounding frontend file, then the browser journey if timing or export changed.
4. Record passed, failed, skipped, and unrun counts from that run.
5. Prove the red run against the previous file, then restore the candidate. In zsh, `for f in $FILES` does not split the variable, so an unquoted list swaps nothing and the red run quietly tests the new code. Name each path.
6. Hold a load open for a race: `holdLoads` in `tests/frontend/chorus-fit-panel.test.js` replaces `session.loadSource` with a promise you release by hand.

## Failure modes

- A test that forces `input.disabled = false` and hides a stalled Take over.
- A probe that only checks that some new clip exists, missing that the musician's clip was deleted.
- Calling a synthetic export "accepted" or "acoustically perfect".
- Using tone probes alone where the desk contract requires real stems and a negative control.
- A fixture that exits before the path under test. A one-phrase stem makes Ask for a clip idea stop at "Only 1 phrase found", so a kept-clip test passes on the old code too.
- Testing a reload on the same card. Mount a fresh card to reproduce a reload.
- A conditional assertion that never fires, or a setup command that returns `ok: false` (for example `splitClip` instead of `splitClipAtBeat`) and is not checked.

## Tests

```bash
node --test tests/frontend/chorus-fit-panel.test.js tests/frontend/arrangement/negative-control.test.js
node tests/browser/maestro_journey.js
node tests/browser/full_house_daw.js
```

## Resource traps

`/tmp` on this machine is a RAM disk of about 6.7 GB. One full `pytest -q` left about 3 GB in `/tmp/pytest-of-richardn`. Check `df -h /tmp` before a second full run, and prefer a targeted file. Run one Chromium journey at a time.

## Recovery

If a control cannot be made red on the old code, it is not a regression test. Drop it or rewrite it before relying on it. Revert the product change rather than deleting the control.

## What not to do

Do not publish or upload the WAV. Do not weaken a ceiling to make a clip pass. Do not skip the red run and call the new test a negative control.

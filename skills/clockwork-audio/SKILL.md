---
name: clockwork-audio
description: >
  Keep 2become1 transport, Stop, Draw Levels automation, and WAV export on one
  clock. Use when changing playback, seek, loop, automation curves, or the
  offline renderer.
---

# Clockwork audio and automation

## When to use

Changing play, pause, stop, seek, loop, Draw Levels, or the comparison between what is heard and what the WAV contains.

## Problem

The playhead, the live voices, and the export must describe the same arrangement. A late callback or a second clock makes Stop, seek, and automation lie.

## Source of truth

- `src/twobecomeone/studio_static/js/arrangement/transport.js`
- `src/twobecomeone/studio_static/js/arrangement/automation.js`
- `src/twobecomeone/studio_static/js/arrangement/voice-scheduler.js`
- `src/twobecomeone/studio_static/js/realtime-engine.js`
- `src/twobecomeone/studio_static/js/voice-pool.js`
- `src/twobecomeone/studio_static/js/arrangement/offline-render.js`
- `src/twobecomeone/studio_static/js/arrangement/wav.js`
- `src/twobecomeone/studio_static/js/arrangement/limiter-worklet.js`
- `docs/clockwork-listening-procedure.md`
- `docs/golden-ear-ii-clockwork-rescue.md`

## Boundaries

One `AudioContext` for the mounted arrangement. Draw Levels writes automation points in bars and dB. It does not move clips. The export reads the saved project. Machine RAM is not a byte budget.

## Invariants

- Play creates one context. Stop releases every voice and processor.
- Pause parks at the heard position.
- A clip move while playing reaches the live engine without starting a second transport.
- Automation points survive save and reopen, and the export follows the drawn curve within 0.1 dB.
- The limiter ceiling is −0.3 dBFS. A measured peak at or above full scale is a failure.
- A shared start is not beat matching. Do not claim tempo or phrase alignment from one clock.
- A lane gain curve is linear in amplitude between points and **holds its first point's value before it** (`sampleCurve` in `automation.js`). A curve that starts at −60 dB on beat 48 silences everything on that lane before beat 48, including a clip the musician kept. A curve is heard by every clip on its lane; to shape one clip, use that clip's fades.
- The live path is the session monitor bus, a gain node at `DEFAULT_MONITOR_DB` (−12 dB) in front of the destination. The offline bounce has no monitor stage. Compare the two only after removing that gain.

## Procedure

1. Serve a seeded loopback Studio with the synthetic two-song fixture (recipe in `skills/black-tie-daw/SKILL.md`).
2. Run `node tests/browser/final_movement_levels.js <url> <out-dir>`. The out-dir defaults to a relative path in the checkout, so always pass one.
3. Run `node tests/browser/black_tie_encore.js <url> <out-dir>`.
4. If the change touches timing, also run the Clockwork frontend tests below.
5. To compare what is heard with the WAV, tap the live output without touching the engine: load the served `src/twobecomeone/studio_static/js/arrangement/capture-worklet.js` (`/assets/js/arrangement/capture-worklet.js`) into the session's context, connect `session.monitor` to an `AudioWorkletNode('pcm-capture')`, sink it through a zero gain, Play from beat 0, and collect the chunks. `tests/browser/maestro_journey.js` does exactly this. Align by envelope, not by sample: 1 ms energy frames, 50 ms windows, a lag search of 0–600 ms. Expect a start lag of about 115 ms and a correlation above 0.95; the paths are not sample-identical.

## Failure modes

- Stop leaves a voice or worklet running.
- Seek hands the playhead to a stale position after a loop wrap.
- Drawing a point moves the clip, or moving the clip rewrites the curve.
- The export clock and the live clock disagree by more than the journey's envelope check.
- Automation stored in samples or ticks instead of bars.
- A new curve written on a lane that already holds a clip, which silences that clip before the curve's first point.
- A live-versus-export envelope compared at 10 ms with 10 ms lag steps. Short transients misalign, and correlation falls to about 0.76 even when the audio matches.

## Tests

```bash
node --test tests/frontend/arrangement/transport-core.test.js tests/frontend/arrangement/automation.test.js tests/frontend/arrangement/voice-scheduler.test.js tests/frontend/arrangement/realtime-engine.test.js tests/frontend/clockwork-audition.test.js
# against a seeded loopback Studio (recipe in skills/black-tie-daw/SKILL.md); out-dir outside the repo
node tests/browser/final_movement_levels.js http://127.0.0.1:8791 "$T/final-movement"
node tests/browser/black_tie_encore.js http://127.0.0.1:8791 "$T/encore"
# starts its own temporary Studio
node tests/browser/maestro_journey.js
```

## Recovery

Revert the transport or automation commit and rerun the two browser journeys. Do not "fix" a clock bug by muting the export check.

## What not to do

Do not add a second master. Do not resample a section to make it fit. Do not describe a synthetic journey as a musical acceptance.

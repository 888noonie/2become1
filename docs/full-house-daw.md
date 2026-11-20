# Operation Full House: the Studio arrangement editor

Branch `daw/full-house`, built on `fix/clockwork-rescue @ b3a2eb7`, which
contains `feature/all-the-time @ ec74085`. The branch also cherry-picks
Golden Ear `aef4b9d` (design documents) and Two Become One `1db6c0b`,
`063b0ab` and `a2e78a5`. None of these needed conflict resolution.
`feature/the-visitor` was inspected and not used. Nothing was pushed.

## What a musician can do

Open Studio → **Arrangement**, or go to `#/studio/arrangement`.

1. **Bring in stems.** Choose a separated library track for A and for B, a
   section (30, 60 or 90 s, or Full length) and a start, then press Bring in A
   or Bring in B. Each track's vocals, drums, bass and other stems land on its
   four lanes in one undoable step. A fresh arrangement takes A's measured
   tempo. A track with no complete stem set is sent back to the Performance
   desk's Add / Process Track.
2. **Eight lanes:** A Vocals to A Other in copper and B Vocals to B Other in
   aqua. Each lane has M, S and a level fader. Clips show waveform peaks
   computed from the decoded stem.
3. **Ruler and timeline.**
   - **Ruler:** bars and beats. Click to cue; drag to set a loop.
   - **View:** Snap (Bar, Beat, ½, ¼, ⅛, Off; hold Alt for free), Zoom − / +,
     and horizontal scroll.
   - **Playhead:** taken from the audio clock, minus output and limiter delay.
4. **Clips.** Click to select.
   - **By pointer:** drag the body to move (also to another lane), drag an edge
     to trim, drag the top-corner grips for fades.
   - **Inspector:** Split at playhead (S), Duplicate (Ctrl+D), Delete, gain and
     fade sliders.
   - **Time (pitch kept):** Fit to project tempo uses the track's measured BPM;
     Speed × sets a manual ratio; a source BPM can be entered by hand and is
     labelled as entered.
   - **Pitch (time kept):** −12 to +12 semitones, with optional formant
     compensation.
   - **Exact values:** start, duration, source offset, rate and asset.
5. **Mix.** Track level, pan, mute and solo, plus 250 Hz / 1 kHz / 4 kHz EQ in
   the track inspector. The project row has a Master level (exported) and a
   Listening level (not exported, −12 dB by default).
6. **Transport.**
   - **Controls:** Play, Pause (resumes from the position heard), Stop (returns
     to the cue), Esc stops, Space toggles, L toggles the loop.
   - **Editing while playing:** edits change what is heard; mixer moves ramp
     and clip edits hand over at the position heard.
   - **Desk exclusivity:** Play here stops the Performance desk, and the reverse.
7. **History.** Undo and Redo buttons, or Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y. A
   fader drag counts as one step. Up to 200 steps.
8. **Project.** Name, Save, Open saved…, New. Export WAV saves first, renders
   that saved state offline and offers a 24-bit 48 kHz stereo download.
9. **AI Producer.** Ask for an idea, then Hear it / Hear mine, Keep it /
   Keep mine, Undo, or Reject.
   - **The idea:** the accepted desk rule, applied as arrangement mutes. A keeps
     its drums and bass; B keeps its vocals and other.
   - **How it applies:** every step is an ordinary edit to the same project.
     Lanes you move yourself stay yours, and nothing starts playback.

## Not available or limited

- **Undo history:** not saved with the project; it starts fresh after Open (the
  Studio says so).
- **Export size:** at most 32 clips per bounce (the accepted Signalsmith
  instance budget). The live voice pool is 28.
- **Bounce routing:** export runs every clip through Signalsmith, as in the
  accepted Milestone B bounce. Live playback plays rate-1, 0-semitone clips
  directly. These were measured equal in level, with the stretch path
  1.3 ms late.
- **Pitch and stretch range:** a pitch shift, or a rate outside 0.857–1.2,
  plays but is reported as outside the measured priming range.
- **Changing tempo:** clips at ratio 1 keep their timeline beats, so a slower
  tempo can run them past their source. That change is refused, with the
  reason.
- **Not built:** multi-select, copy/paste, automation lanes, markers, a
  metronome and time-signature editing.
- **Producer scope:** the arrangement Producer proposes mixes (mutes), not
  clip placement.
- **Phones:** lane faders are hidden; level is set in the inspector. M and S
  keep 44 px targets.
- **Listening:** none of the audio has been heard by the PM. Click-free
  handovers, Signalsmith quality at +3 st and fade shapes are measured, not
  listened to.

## Evidence (real Chromium, seeded loopback Studio)

`node tests/browser/full_house_daw.js <studio-url> <out-dir>` drives the
eleven acceptance steps through the page's own controls, with
`--disable-audio-output --mute-audio`. It passed 54/54 on three consecutive
runs at `HEAD`.

- **Loading and waveforms:** loading opens no audio device. Waveform peaks
  equal the decoded PCM.
- **Edits keep source offsets exact:**
  - A drag moves a clip by 28 bars on the bar grid and keeps its source offset.
  - Splitting at bar 37 continues the source exactly; trimming the start moves
    the source offset by the same musical time.
- **Stretch and pitch:**
  - Fit to project tempo turns 84.3 BPM material into 96.8 BPM time with the
    same source and unchanged pitch.
  - +3 st with formants changes neither duration nor offsets.
- **Mix edits** land in the ProjectState; a fader drag is one undo step.
- **Live playback, timing and loop:**
  - Play creates one AudioContext; the heard playhead advances at 1.613 beats/s
    (96.8 BPM).
  - Eight lanes play with 0 deadline misses inside the voice budget.
  - A loop dragged on the ruler plays and wraps.
  - Stop releases every voice and processor; Pause parks at the heard position.
- **Live editing:**
  - Mute while playing ramps the live track gain to 0.
  - A clip moved while playing reaches the engine without stopping.
- **Measured at the output (an analyser after the limiter and listening level):**
  - The soloed, stretched, +3 st B Vocals reads −36 to −39 dBFS through
    Signalsmith (armed with an 89–93 ms lead against the 64 ms floor).
  - Swapping the solo to an empty lane reads digital silence.
- **Save, reopen and export:**
  - Save, closing the page and Open reproduce the identical ProjectState.
  - Export is 48 kHz, stereo, 24-bit; its length is the arrangement end plus
    0.5 s; its peak is under −0.3 dBFS.
  - The gap before the moved vocal is silent, the vocal sounds at its new bar,
    and the file matches the saved arrangement.
- **Producer:** Hear it / Hear mine / Keep / Undo change only the same
  ProjectState and keep the musician's move.
- **Accessibility and layout:** the a11y audit is clean at 1440 and 390, and
  there is no horizontal overflow at 390.

Unit tests:

- `tests/frontend/arrangement/full-house.test.js` (19 tests): the edit
  commands, live plan replacement and the session lifecycle, plus a negative
  control in which an engine that ignores edits keeps the old source sounding,
  and the detector catches it.
- `tests/frontend/arrangement-panel.test.js` (10 tests).
- `tests/test_arrangements.py` (4 tests): reference, id, schema and size guards.

Regression runs at `HEAD`:

| Suite | Result |
|---|---|
| `npm test` | 848 tests, 847 passed, 0 failed |
| `pytest` | 634 passed, 1 skipped |
| Clockwork rescue harness, offline | 20/20 |
| For Your Ears | 20/20 |
| Hear it | 26/26 |
| Black Tie captures | 41 rows, 0 overflow, 0 errors |

## Demo procedure

From the worktree, with a seeded copy of the For Your Ears fixture (two
tracks, four stems each):

```sh
.venv/bin/python tests/browser/for_your_ears_fixture.py --out /var/tmp/fh/fixture
PYTHONPATH=src .venv/bin/python tests/browser/for_your_ears_seed.py --data-dir /var/tmp/fh/demo --fixture /var/tmp/fh/fixture
PYTHONPATH=src .venv/bin/python -m twobecomeone.cli web --port 8791 --data-dir /var/tmp/fh/demo
```

Open `http://127.0.0.1:8791/#/studio/arrangement`, then:

1. Under Bring in stems, choose Midnight Circuit for A and Paper Lanterns for
   B, 60 s from 30 s each, and press Bring in A, then Bring in B.
2. Set Snap to Bar. Drag B Vocals to bar 29.
3. Click the ruler at bar 37, select the clip and press Split at playhead.
   Drag the right half's left edge one bar in.
4. Select the left half. Press Fit to project tempo, set Semitones to +3 and
   tick Keep formants.
5. Set a 2-beat Fade in, drag the fade-out grip, set Gain to −3 dB, then
   select B Vocals' lane name and adjust its EQ, pan and level.
6. Click the ruler at bar 1, press Play (the Listening level starts at −12 dB),
   drag the ruler over bars 3–5 to loop, then Stop.
7. Press Ctrl+Z and Ctrl+Shift+Z.
8. Name the arrangement and Save. Reload the page, choose it under Open saved…
   and press Open.
9. Press Export WAV.

## Static payload

1,223,856 bytes in 94 files under `studio_static`. That is 113,899 bytes and
4 files more than the integrated base (`ff120e6`, 1,109,957 bytes in 90 files),
and 440,168 bytes more than `main` (783,688 bytes). The new files are
`arrangement-panel.js` (52 KB), `daw-session.js` (23 KB), `arrangement.css`
(14 KB) and `arrangement-producer.js` (7 KB). The largest file is still the
vendored `SignalsmithStretch.mjs` (114 KB).

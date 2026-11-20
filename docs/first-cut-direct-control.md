# Operation First Cut: direct control of where a stem starts and how it enters

Branch `daw/first-cut`, cut from `daw/full-house @ e37287f`. The Black Tie
arrangement editor is unchanged in layout; this adds slip, direct gain and fade
handles, a hint line and a typed Producer clip idea on the same project data.
Nothing was pushed or merged.

## Four different things

| Interaction | What changes | What stays |
|---|---|---|
| **Play cue** (click the ruler, or `Cue at clip start`) | Where Play begins | Every clip and every source |
| **Move** (drag the clip body) | `timelineStartBeat` (and lane) | Source in-point, length, gain, fades |
| **Trim** (drag a clip edge) | A boundary; a start trim advances the in-point at the clip's own rate | The audio's place on the timeline |
| **Slip** (drag the bottom bar, Shift-drag the body, `,` / `.`, or the inspector) | `sourceOffsetSec` only | Position, length, rate, pitch, gain, fades |

Slip is non-destructive, in absolute source seconds, and bounded by the stem:
the clip's whole span must stay inside the asset. A clip that already uses the
whole stem has no room; the inspector says "trim the end first".

## What the musician can do

- **Slip:** drag the striped bar along the bottom of the selected clip left for
  later material, right for earlier (Alt for free, otherwise it follows Snap).
  Shift-drag on the body does the same. The waveform redraws live from the
  decoded audio at the new in-point, with a label such as `Source in-point
  14.876 s`. Keyboard: `,` earlier and `.` later by one snap step. The
  inspector's *Source in-point (slip)* block shows seconds, the 48 kHz frame,
  the stem's own bar and beat at its measured tempo, and the room either way,
  with a slider, an exact seconds field and Earlier / Later buttons.
- **Gain:** drag the dB pill at the top right of the selected clip up or down
  (0.5 dB steps, Alt for 0.1). It is the clip's gain, separate from track level.
- **Fades:** drag the two top-corner grips; the live label gives beats and
  seconds (`Fade in 1 beat · 0.62 s`). The inspector shows the same units.
- **The waveform is the sound:** it is drawn from the decoded peaks at the
  current in-point, scaled by clip gain and the linear fade envelope the live
  engine and the bounce both apply, with the envelope outlined.
- **One action, one undo step:** a drag of any of these is one Undo; a one-pixel
  wobble is none, and an edit that changes nothing is not an undo step.
- **Hint line:** one quiet line under the timeline names what the pointer is
  over (play cue, move, trim, fade, gain, slip). Grips appear on the selected
  clip or on hover; cursors and tooltips match.
- **Producer clip idea:** `Ask for a clip idea` proposes typed edits for the
  selected clip: position (bar 9), source in-point (start of the second
  detected phrase), clip gain (−3 dB) and a one-beat fade-in. They are
  dry-run with `propose`, listed with their before values, and applied as ONE
  ordinary batch by Hear it. Hear mine, Keep it / Keep mine, Undo and Reject
  work as before; a field the musician changes is theirs. If a later in-point
  would run past the end of the stem, the idea also shortens the clip's end and
  lists that change.

## Bug found and fixed on the way

Choosing a cue on the ruler and then pressing Play for the **first time**
started from bar 1: a new engine parks at frame 0 while it prepares, and the
session read that as the musician moving the cue. `DawSession` now ignores
parking until the engine exists. A unit test fails without the fix. (The
earlier Full House journey missed it because it had already pressed Play.)

## Not available or limited

- The Producer does not read free text. `Ask for a clip idea` is one typed
  example (bar 9, second phrase, 1 beat, −3 dB); `suggestClipIdea` takes any
  typed values. Phrase starts come from a loudness heuristic on the decoded
  peaks at 256-frame resolution (about 5 ms), not from lyrics or notes.
- Slip, gain and fade handles are mouse affordances; keyboard and touch use the
  inspector, `,` / `.` and the exact fields. Phone lanes still hide faders.
- Gain handle steps are 0.5 dB by drag (0.1 with Alt); exact values via the
  inspector.
- The offline bounce still renders every clip through Signalsmith (Full House
  limitation); the live engine plays unity clips directly.
- Not built: multi-select, copy/paste, automation, markers.
- **Not heard:** nothing here has been listened to by the PM. Click-free
  handover while editing during playback is the existing Clockwork machinery
  and has not been auditioned for slip, gain or fade edits.

## Evidence

Unit and component tests:

- `tests/frontend/arrangement/first-cut.test.js` (15 tests): slip arithmetic at a
  non-unity stretch rate and nonzero offsets (sample-accurate plan frames,
  bounds, undo), trim/split/duplicate continuing the source exactly, fit to
  tempo keeping the in-point, reopen compiling the identical plan, no-op edits,
  gain and fade gestures, phrase detection, the Producer batch equalling the
  hand edits, and the first-Play cue.
- `NEGATIVE CONTROL`s: a split that converts beats to source seconds without the
  stretch rate lands 1000+ frames away and fails the contiguity check; a "slip"
  implemented as a move fails the position check; the first-Play cue test fails
  with the fix removed.
- `tests/frontend/first-cut-panel.test.js` (6 tests): the inspector in-point,
  keyboard slip, the affordances and hint, and the Producer's Hear it / Hear
  mine / Keep / Undo with the musician's move kept.

Browser journey, real Chromium, audio output disabled
(`node tests/browser/first_cut_daw.js <studio-url> <out-dir>`, 48 checks, three
consecutive passes):

- B Vocals trimmed by dragging the end handle, moved by pointer to bar 9 (beat
  32), slipped by dragging the slip bar to 14.876 s (6 bars of source) with the
  clip still at bar 9; one undo step; Shift-drag slip; start-edge trim
  distinguished from slip; gain −3 dB by dragging the grip; fade-in by dragging
  to one beat, then the exact value.
- The drawn waveform correlates 0.985 with the decoded peaks at the new in-point.
- Play from a cue at bar 7: digital silence until the clip's onset at beat
  32.10, then the edited clip. Same window at 0 dB is 3.17 dB louder than at
  −3 dB; the slipped window is 12.3 dB quieter than the unslipped one against
  11.8 dB predicted from the decoded stem.
- Undo walks back through fade, gain, slip and move; Redo restores the clip
  exactly. Save, close the page, reopen: identical project.
- Export (48 kHz, stereo, 24-bit) of the soloed vocal: correlation 0.909 with the
  decoded stem at the slipped in-point (lag 2 frames); 0 against the stem from
  its start (negative control); silence before bar 9; −3.000 dB against a 0 dB
  export of the same arrangement; the one-beat fade rises 0.11, 0.32, 0.58, 0.90
  of the unfaded level across its four quarters (linear: 0.125, 0.375, 0.625,
  0.875).
- Producer on B Drums: the idea (`slipClip`, `moveClip`, `setClipGain`,
  `setClipFades` in one `batch`) leaves the project untouched until Hear it,
  matches the same commands applied by hand exactly, and is fully reversible;
  Hear mine keeps a musician's −9 dB; Keep then Undo restores position, in-point
  and fade. The Producer started no playback.
- Accessibility audit clean at 1440 and 390 px; no horizontal overflow at 390.

Regression at the final commit: see the report in the session (npm test, pytest,
Full House journey 54/54, Hear it 26/26, For Your Ears 20/20, Black Tie 41 rows).

## Demo (about two minutes)

```sh
PYTHONPATH=src .venv/bin/python -m twobecomeone.cli web --port 8792 --data-dir <seeded data dir>
```

Seeded as in `docs/full-house-daw.md`. Open `http://127.0.0.1:8792/#/studio/arrangement`.

1. Bring in B (60 s from 30 s). Set Snap to Bar. Press `-` a few times, then `+` once.
2. Drag B Vocals' right edge in to bar 7 (leaves room to slip), then drag the
   clip body to bar 9.
3. Drag the striped bar along the clip's bottom edge left by a few bars. The
   waveform and the *Plays from* readout change; the clip stays at bar 9.
4. Drag the dB pill down about 15 px (−3 dB). Drag the top-left grip to one beat.
5. Click the ruler at bar 7, press Play: silence, then the edited clip at bar 9.
   (Listening level starts at −12 dB; audio is only ever started by Play.)
6. Ctrl+Z through the edits and Ctrl+Shift+Z back. Save, reload, Open.
7. Select B Drums, press *Ask for a clip idea*, then Hear it, Hear mine, Keep it.

## Static payload

1,245,532 bytes in 94 files under `studio_static`: +21,676 bytes over Full House
(`e37287f`, 1,223,856) and +461,844 over `main` (783,688). Growth is
`arrangement-panel.js` (+11 KB), `arrangement-producer.js` (+9 KB) and 1 KB of CSS.
The largest file is still the vendored `SignalsmithStretch.mjs` (114 KB).

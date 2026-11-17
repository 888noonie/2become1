# Stem Desk audible failure — diagnosis and repair, 2026-11-17

The owner opened the demonstration, loaded the original fixture and pressed
Play. The result was uncomfortable noise, and Solo/Mute appeared to behave like
Stop. That observation is the finding of record; the earlier automated passes
did not overrule it.

## 1. What was measured

The original fixture was four pure tones (110/440/1320 Hz) plus pink noise, not
music. Its separated files, measured with an independent PCM analysis:

| File | Peak | RMS | Audible? |
| --- | --- | --- | --- |
| original mix | −17.1 dBFS | −29.2 dBFS | — |
| vocals | −49.3 dBFS | **−68.8 dBFS** | effectively silent |
| drums | −47.0 dBFS | **−63.6 dBFS** | effectively silent |
| bass | −26.8 dBFS | −33.1 dBFS | yes |
| other | −18.7 dBFS | −31.6 dBFS | yes |

No clipping, correct 44.1 kHz stereo, 12.000 s everywhere. Demucs had put almost
all the energy into `bass` (the 110 Hz tone) and `other` (440/1320 Hz); its
`vocals` and `drums` outputs were near-silence. The reconstruction of the four
stems differed from the source by −23.7 dB relative to the mix — a large
residual, consistent with separating stationary test tones.

## 2. Was the graph or the controls at fault?

Both the actual stem files and the runtime were rendered through
`OfflineAudioContext` (real decoded media, no speakers):

| Scenario | RMS | Peak | Status |
| --- | --- | --- | --- |
| solo vocals | −68.8 dBFS | −49.3 dBFS | **playing** |
| solo drums | −63.6 dBFS | −47.0 dBFS | **playing** |
| solo bass | −33.1 dBFS | −26.8 dBFS | playing |
| solo other | −31.6 dBFS | −18.7 dBFS | playing |
| all four | −29.4 dBFS | −17.4 dBFS | playing |
| bass −12 dB | −31.4 dBFS | −18.8 dBFS | playing |
| Stop | −240 dBFS | 0 | ready |

- Solo kept the transport `playing`; it did not stop it.
- Muting drums removed only drums (residual 0.9965 of baseline, the drums' own
  contribution being negligible).
- The bass fader reduced only bass energy.
- Stop produced digital silence and released the status to `ready`.

**The mixer law was correct.** The perceived "Solo behaves like Stop" is what a
correct solo of a −69 dBFS stem sounds like. The failure was the fixture and,
secondarily, the absence of any honest indication that a stem was effectively
silent.

## 3. The repair

### 3.1 A musical fixture

`tests/browser/musical_fixture.py` generates an original 19.2 s, 100 BPM
A-minor arrangement: kick/snare/hi-hat pattern, bass line, pad and a
formant-shaped lead melody. It is synthesised here, so it is original, but it is
an arrangement rather than a studio recording. The generator is deterministic.

Real Demucs (`htdemucs@4.1.0`, CUDA) separates it into four usable stems:

| Stem | Peak | RMS | Content |
| --- | --- | --- | --- |
| vocals | −16.7 dBFS | −29.7 dBFS | formant lead (250–2000 Hz) |
| drums | −3.3 dBFS | −23.8 dBFS | rhythm transients |
| bass | −11.7 dBFS | −24.2 dBFS | low root notes |
| other | −13.2 dBFS | −28.4 dBFS | pad chords |

All four are within 6 dB of each other, no clipping, and the four-stem sum
reconstructs the mix to −29.3 dB relative residual.

### 3.2 Truthful silent-lane feedback

The runtime now measures each decoded lane's peak and RMS and reports
`silent` when RMS ≤ −50 dBFS. The label is descriptive only: the lane still
loads, still obeys mute/solo/gain and is never removed. The panel shows
"effectively silent in this separation" on such a lane, includes it in the
load message, and appends "This stem is effectively silent in this separation."
when it is soloed. That turns the exact failure mode into a truthful statement
instead of an apparent Stop.

**Mute, Solo and Gain semantics are unchanged.** No new mixer architecture, no
change to the shared clock, gain nodes, bounded memory or Action/Ghost paths.

### 3.3 A real-stem audio gate

`tests/browser/stem_desk_real_audio.js --stems <dir>` decodes actual separated
files and checks: each lane audible solo, transport still `playing` under solo,
no clipping, mute equals soloing the complement, solo equals muting the
complement, a gain change leaves other lanes bit-identical, and Stop is exactly
silent.

It is the gate the previous synthetic-tone test could not provide.

## 4. Negative control

Run against the original failed stems, the new gate fails exactly the two
silent lanes:

```
FAIL  solo vocals is audible — rmsDb -68.8
FAIL  solo drums is audible — rmsDb -63.6
13/15 real-stem checks passed (exit 1)
```

Against the musical stems it passes **15/15**. The old test's 8/8 result was
real for the graph but blind to the media, which is why it could not catch this.

## 5. Limits

- The musical fixture is an original synthetic arrangement, not a recording.
  It is suitable for a functionality audition; it is not a claim about
  production music separation quality.
- Audible acceptance remains the owner's judgement; neither the offline render
  nor the browser harness claims speaker output.
- The original failed fixture and its measurements are preserved under
  `/tmp/opencode/evidence/sound-check-failure/`.

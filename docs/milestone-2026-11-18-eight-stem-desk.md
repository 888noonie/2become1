# Milestone: eight-stem Stem Performance Desk, accepted 2026-11-18

Owner acceptance record for OPERATION OCTOPUSSY. The PM loaded two library
tracks, operated all eight lanes and confirmed the result was genuinely usable
by ear. That listening judgement is the acceptance gate; the automated evidence
below exists to make it reproducible, not to replace it.

## Accepted product

- **Two tracks × four stems** (vocals, drums, bass, other), eight lanes, one
  Stem Performance Desk panel.
- **One shared `AudioContext` clock.** At acceptance every lane was scheduled
  with the same `when` (context time + 0.05 s lead); a later entry-nudge slice
  keeps one clock and one Play but may move one group's onset by a stored
  millisecond offset. One Play/Stop, one position readout.
- **Independent lane Mute, Solo and Gain.** Mute/solo/gain are applied on each
  lane's own `GainNode`; the law is unchanged from the accepted four-stem desk:
  `anySolo ? lane.solo : !lane.muted`, multiplied by the clamped lane gain.
- **Per-track level and an equal-power A/B crossfader.** Group gain is
  `equalPowerGains(position) × dbToLinear(track level)`, so a crossfade move
  cannot overwrite a level the owner set. Centre is `1/√2` per side (≈ −3 dB).
- **Global Solo semantics.** Solo is evaluated across all eight lanes: soloing
  `A:vocals` silences both tracks except that lane. Releasing solo restores the
  stored mute flags. The panel states this before playback, and a soloed lane on
  a crossfaded-away track reports `effectiveGain: 0` rather than looking broken.
- **Truthful provenance.** Each lane shows `demucs · htdemucs@4.1.0 · device ·
  set <8 hex>`; the stem-set id distinguishes two tracks that both have a
  "vocals". No center/sides lane is ever labelled vocals.
- **Bounded, protected output.** 40 MiB per stem, 160 MiB per track, 320 MiB for
  the desk; a group over budget is refused non-destructively. The master feeds a
  soft-clip ceiling that is exactly linear below 0.8 and saturates at 1.0.
- **Honest tempo statement.** Tracks start together; they are **not**
  beat-matched, warped or time-stretched. One track keeps looping (accepted
  four-stem behaviour); two tracks play once and end with the longer lane.

## Evidence behind the acceptance

| Gate | Result |
| --- | --- |
| Frontend suite | 524/524 |
| Python suite | 580 passed, 1 skipped |
| Desktop browser journeys | 39 checks, 0 failures |
| Mobile browser journeys | 39 checks, 5 failures — pre-existing a11y findings |
| Two-track UI journey | 21/21 at 1280×800 and 390×844 |
| Two-track PCM (synthetic, `OfflineAudioContext`) | 8/8 |
| Two-track PCM (real Demucs stems, two tempos) | 8/8 |
| Single-desk regressions | 8/8 synthetic, 15/15 real stems |
| Owner-path live smoke | 13/13 |
| Independent reviews | Grok 4.5 final **PASS**; Codex GPT-6.2 Sol findings fixed and re-proved |

Measured audio: two-track midpoint peak −3.14 dBFS (no clipping); solo across
tracks correlation 1.000; crossfade endpoints ratio √2; short-lane wrap
eliminated (tail 4×10⁻¹⁷, status `ready` versus 0.244/`playing` before).
Memory: eight real stems decode to 51.56 MiB; three load/unload cycles hold flat
at 52.3 MB; the 320 MiB ceiling refuses a 118 s lane at 48 kHz with the real
byte counts.

Demonstration material: two original arrangements separated with the real
engine — Track A 100 BPM A-minor, 19.2 s; Track B 120 BPM G-minor, 16.0 s.

## Accepted code

| Item | Value |
| --- | --- |
| Repository | `888noonie/2become1` |
| Branch | `feature/octopussy-eight-stem` |
| **Accepted HEAD** | **`4265ac1abb0c4e470b713238d3957b2dd6cd8e2e`** |
| Base (previous accepted) | `bdad67a769a8eaca0ef0d9f77993f2927634a1b9` |
| Q build commit | `7eb5583bc6d2ad570f9a257a267e0fe7ecc316d4` |
| Local recovery reference | annotated tag `golden-tentacles-eight-stem-2026-11-18` |

## Known limitations, stated at acceptance

- **No beat matching.** Different tempos drift apart by design; a real tempo or
  phrase matcher is a separate contract with its own evidence.
- **Decoded memory is rate-dependent.** Chromium's `AudioContext` decodes at its
  own rate (48 kHz here), so the 40 MiB per-lane budget buys ≈109 s at 48 kHz
  and ≈119 s at 44.1 kHz. The ceiling is enforced per lane and refuses honestly.
- **No ramps.** Gain writes are direct assignments, so a very fast fader sweep
  can produce small zipper artefacts.
- **User-supplied stems are documented, not implemented.** Only stems already
  separated in the library are playable.
- **Headless PCM proves the graph, not speakers.** Audible acceptance is the
  owner's listening judgement, recorded here.

## Not included

No promotion, remote push, PR, production Studio replacement or canonical media
change. `main` remains `266ccd19`; the owner checkout remains `763e1d9`.

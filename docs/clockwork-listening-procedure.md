# OPERATION CLOCKWORK — Owner-Controlled Listening Procedure (Gate 9 / PM audition)

**Status: PREPARED — DO NOT RUN until the PM explicitly approves.** No audible
playback is started by this document. Gate 9 (real speaker latency, glitch-free
playback) and the PM's audible acceptance of the transport are both **deferred**
and remain **INCONCLUSIVE** until this procedure is executed under owner control.

This is the short, owner-controlled audition and loopback-measurement procedure
for Milestone C1. It is deliberately conservative: low volume, short duration,
an immediate stop, and no configuration changes.

---

## 1. Preconditions (verified present on this machine)

| Item | Value |
| --- | --- |
| Audio server | PipeWire (active), `pw-record` / `pw-cat` / `pw-cli` / `pactl` installed |
| Output device | **Headphones** sink: `alsa_output.pci-0000_35_00.6.HiFi__Headphones__sink` |
| Loopback capture source | its monitor: `alsa_output.pci-0000_35_00.6.HiFi__Headphones__sink.monitor` |
| Content | the C1 demo arrangement (eight stems, all originally synthesised — no licensed media) |
| Files touched | **none** — playback is non-destructive; original source files are never modified |

No audio-device configuration is changed by this procedure. It only *reads* the
existing monitor source and plays through the existing default sink.

---

## 2. Before you begin (owner safety steps)

1. **Put on the headphones** (or confirm the intended output) so you know what
   will sound and to avoid surprising anyone nearby.
2. **Set a low, safe system volume first** — about **30 % (≈ −18 dBFS master)**.
   The test tones are quiet (a −40 dBFS pilot); raise only if you cannot hear it.
3. Confirm you can reach the **stop mechanism** in §5 instantly (a key and a
   terminal command are both given).

---

## 3. Test duration and sequence (≈ 60–90 seconds total)

| # | Step | What you should hear | ≈ duration |
| --- | --- | --- | --- |
| 1 | **Play** the eight-stem arrangement | the full mashup (drums, bass, chords, vocal, pad, arp, perc, texture) | 10 s |
| 2 | **Stop**, then **restart** (Space) | clean stop to the cue, clean restart — **no click or pop** | 5 s |
| 3 | **Seek within a sustained pad** | the pad continues smoothly from the new spot — **no click** | 10 s |
| 4 | **Loop a short vocal phrase** | the phrase repeats with an even, brief crossfade — **no seam click, no dip/bump** | 15 s |
| 5 | **Seek across drum transients** | old audio drops out fast, new material at full level at once | 10 s |
| 6 | **Pilot-tone phase check** (auto) | a steady −40 dBFS pilot tone — should be continuous, no tick | 10 s |
| 7 | **Stop** | silence | — |

**Listen for (acceptance criteria):** no click/pop at Play, Stop, seek or loop;
the loop seam is an even crossfade (gains sum to unity — no level dip or bump);
a sustained pad never stutters or clicks on any transition; a deliberate
clip-attack still speaks (the transport start ramp is ≤ 2.5 ms attenuation).

---

## 4. Measurement method (Gate 9 loopback)

While the sequence plays, capture the sink monitor to measure real speaker
latency and seam behaviour. Run this in a terminal **before** step 1 (it records
for the whole sequence):

```bash
pw-record --target alsa_output.pci-0000_35_00.6.HiFi__Headphones__sink.monitor \
  --rate 48000 --channels 2 ~/.local/state/clockwork/gate9-loopback.wav
```

Then measure from `gate9-loopback.wav`:

- **Play-to-speaker latency:** the wall gap between issuing Play and the first
  transient appearing in the capture (cross-reference the in-graph tap timestamp).
- **Stop-to-speaker latency:** the gap between Stop and the captured signal
  reaching silence.
- **Seek response:** the captured seam; old material ≤ −40 dB within 10 ms, new
  material full-level within the 5 ms crossfade.
- **Loop discontinuity:** back-to-back loop seams; the pilot tone must show **no
  phase discontinuity** across a wrap (this is the glitch-free probe).
- **Underruns / glitches:** audible ticks and pilot-phase jumps count as failures.

**No glitch-free or speaker-latency number is claimed until this capture is
taken and measured.** Headless Chromium results do **not** substitute for it.

---

## 5. Stop mechanism (immediate, at any moment)

Any ONE of these stops playback at once:

- Press **Space** (Play/Stop toggle — stops and returns to the cue).
- Press **Esc** in the demo page (aborts the transport).
- In a terminal: `pkill -f realtime-engine` (or close the browser tab).
- Hardware: the headphones output mute / volume-down on the keyboard.

To stop the loopback recording: `Ctrl-C` in the `pw-record` terminal.

---

## 6. After the audition (owner/PM verdict)

Record against each §3 step: **PASS / FAIL / note**. Then:

1. Fill the Gate 9 measurements (§4) into `docs/all-the-time-milestone-c1.md` §9
   and set its status from INCONCLUSIVE to measured.
2. Record the PM's audible acceptance (or findings) in the C1 evidence doc.
   **No audible PASS is claimed until this verdict is written.**

Nothing in this procedure mutates state, media or configuration. It is read-only
apart from writing one capture WAV under `~/.local/state/clockwork`.

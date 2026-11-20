# Clockwork — Owner-Controlled Listening Procedure (C1 audition)

**Status: READY FOR THE OWNER — NOT RUN.** Revised by OPERATION THE GOLDEN EAR II
after the controls it describes were built and tested. Nothing in this document
has been played on the owner's speakers or headphones. The owner decides whether
and when to run it. No audible PASS exists until the owner writes one (§6).

The earlier version of this file described a demo page, Space/Esc bindings and a
`pkill` stop that did not exist (Grok N3). This version describes only controls
that exist on branch `fix/clockwork-rescue` and pass tests (see §7).

---

## 1. What you will hear

8 seconds of **synthesised** material, generated in the page itself (no library
media is read, written or changed):

| Track | Material | Path |
| --- | --- | --- |
| 1 | sustained pad (220/275/330 Hz) | unstretched: sample-exact bypass |
| 2 | drum-like clicks + noise bursts on every beat | unstretched: sample-exact bypass |
| 3 | bass, 110 Hz, per-beat envelope | unstretched: sample-exact bypass |
| 4 | arpeggio, stretched ×1.2 | Signalsmith (inside the measured 0.857–1.2 range) |

All four tracks start together on one clock. **This is not beat matching** and
makes no tempo or phrase-alignment claim.

---

## 2. Start the page (no sound yet)

In a terminal, from the repair worktree:

```bash
cd ~/MISIX-worktrees/clockwork-rescue && node tools/clockwork-audition/serve.mjs
```

Then open **http://127.0.0.1:8777/tools/clockwork-audition/** in your browser.

- The server listens on loopback only and serves files read-only. It does not
  touch the Studio on port 8765 or `~/.local/share/2become1`.
- **Loading the page plays nothing and opens no audio device.** The page says
  "Audio is off". An audio context is created only when you press **Play**.
- No pilot tone and no automatic sequence: every sound follows your key or click.

---

## 3. Before you press Play

1. Choose the output first (headphones recommended) and set the **system volume
   low**, about 30 %.
2. The page's **Monitor level** starts at **−24 dB** and cannot go above −6 dB.
   Leave it at −24 dB for the first listen.
3. Find **Stop** (the red button) and remember **Esc**. Either stops at any time.

---

## 4. Controls (all of them exist and are tested)

| Control | Action |
| --- | --- |
| **Play** button | prepares on first use (silent), then plays from the cue |
| **Stop (Esc)** button / **Esc** key | fades out over 10 ms and returns to the cue; works from anywhere on the page, including while preparing |
| **Space** | Play ⇄ Stop, exactly one action per press (it never also clicks a focused button) |
| **Jump to 2 s / Jump to 6 s** | seek: two-voice handover at the new position, about 115 ms after the press |
| **Loop 2 s–4 s** | loop on/off, before or during playback. While it is on, Play or a Jump from outside 2–4 s starts at 2 s (the page lists a `LOOP_ENTRY` notice); from inside, playback starts where it is. Switching it off continues forward and stops at the 8 s end |
| **Monitor level** | −48 … −6 dB, applied as a 50 ms ramp |
| **Release audio device** | closes the audio context entirely (closing the tab does the same) |
| State line | phase (`audio off` / `preparing` / `starting` / `playing` / `seeking` / `stopping` / `stopped` / `failed`), position, loop |
| Errors and warnings | every refusal, warning or failure the engine reports |
| Engine diagnostics | timing terms with their provenance, voice counts, supplied Signalsmith lead |

**Second stop path.** If the transport has not reached `stopped` 600 ms after a
Stop, the page suspends the whole audio context and says `STOP_WATCHDOG`. A later
Play disarms that watchdog.

**Last resort.** Close the browser tab, or use your keyboard's mute key. There is
no shell command that stops browser audio; the earlier `pkill` advice was wrong.

---

## 5. Suggested sequence (about 60–90 s, your pace)

| # | Do | Listen for |
| --- | --- | --- |
| 1 | **Play** | all four tracks start together; no click at the start |
| 2 | **Esc** after a few seconds | a clean fade to silence; the state reads `stopped` |
| 3 | **Space** (play), then **Space** (stop) | a clean restart from the cue, then a clean stop |
| 4 | **Play**, then **Jump to 6 s** while the pad sustains | the old audio is gone within ~5 ms of the handover, with no doubled audio, click or gap |
| 5 | **Loop 2 s–4 s** (it turns on wherever you are) | playback moves to 2 s within ~0.1 s, then repeats 4 s → 2 s; Position stays between 2.00 and 4.00 |
| 6 | Let the loop run at least 5 passes (≥ 10 s, past the 8 s end) | it does not stop; the drum hit at each seam lands on time; the pad does not dip, click or double; no stale audio |
| 7 | **Jump to 6 s** while looping | it stays in the loop (re-enters at 2 s) |
| 8 | **Esc**, then **Play** (loop still on) | silence; then playback starts at 2 s and loops again |
| 9 | **Loop 2 s–4 s** off while playing | playback carries on forward past 4 s and stops by itself at 8 s |
| 10 | **Release audio device** | the device is released |

Stop at any time if anything is too loud or wrong.

### Optional loopback capture (only if you want speaker-path numbers)

This *reads* your sink's monitor and writes one WAV under `~/.local/state`. It
changes no audio configuration. Run it in a second terminal **before step 1**,
and press `Ctrl-C` after step 10:

```bash
pw-record --target alsa_output.pci-0000_35_00.6.HiFi__Headphones__sink.monitor --rate 48000 --channels 2 ~/.local/state/clockwork/audition-loopback.wav
```

Use the `__Speaker__sink.monitor` target instead if you listen on the speakers.
`pactl info` shows which sink is the default.

---

## 6. After the audition (the owner's verdict)

Record **PASS / FAIL / note** for each step in §5, plus anything the page listed
under Errors and warnings. Only that written verdict is an audible acceptance.
Until then the C1 transport is **not** accepted by ear, and no "click-free" or
"glitch-free" claim is made.

---

## 7. What has been verified without your speakers (so you know what is new)

- **Loop repair (THE BROKEN RECORD).** Your verdict on `1fb993f` was: Play,
  Stop and Seek work; Loop 2–4 s does not. Cause: a loop only took effect when
  playback started before 4 s, so from 6 s it ran to the 8 s end and stopped;
  and a Loop pressed before the first Play never reached the engine. Both are
  fixed and covered by tests that fail on `1fb993f`. Real Chromium (output
  disabled): the page loops 2–4 s with 3 wraps in 7 s past the 8 s end, no
  deadline miss; offline PCM from outside the loop equals the ideal loop to
  1.3e-7 with every seam transient on its exact frame.

- Engine-level tests on the actual `RealtimeEngine` (simulated device clock):
  Stop completes and parks once; seek handovers leave no old audio; loop seams are
  complementary; the voice ledger matches the real graph; late scheduling is
  detected.
- Real Chromium AudioWorklets, offline render: after a seek the old audio is at
  −166 dB (bypass) and −70 dB (Signalsmith) 10 ms after the handover. After Stop
  the output is exactly 0. Loop seams match the ideal looped signal to 1.1e-7.
- Real Chromium, live clock, **with audio output disabled and muted** (PipeWire
  verified: no playback stream ever appeared): this page's Play, Esc, Space, seek,
  loop and Release flow; 16 of 16 repeated runs with no deadline miss.
- **Not verified:** your device's real output latency, behaviour under your own
  system load, and anything a human ear would judge. That is this procedure's job.

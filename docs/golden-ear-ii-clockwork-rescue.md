# OPERATION THE GOLDEN EAR II — Clockwork Rescue (C1 live transport repair)

- **Branch:** `fix/clockwork-rescue` (local only; worktree `~/MISIX-worktrees/clockwork-rescue`)
- **Base:** `feature/all-the-time @ ec7408594d47c8870a946aa9d7fb25d1fd013c60`
- **Untouched:** `main @ 28eef69`, `feature/all-the-time`, `feature/the-visitor`, `design/golden-ear @ aef4b9d`.
- **Not done:** no push, no merge, no Studio change, no media, credential or device change.

**Input.** The task brief carried Grok's independent C1 audit. It gave a NO-GO for a
PM listening trial and for the Milestone D UI, with BLOCKING findings N1–N3, MAJOR
findings N4–N6, and lifecycle findings. No separate audit file was on disk, so
every finding was reproduced **from the code** before it was repaired (§2).

**Scope.** `realtime-engine.js` was rewritten. The other changes are small:
`voice-pool.js` gains a strict ledger; `transport.js` gains seek `keepCue`;
`voice-scheduler.js` gains `originSec`; `offline-render.js` gains the deferred
`arm`, the `destination` and `applyClipEnvelope` options; `time-math.js` gains an
explicit routing policy; `limiter-worklet.js` now reports a fault immediately.
ProjectState, RenderPlan, the Signalsmith vendor code and the offline bounce are
unchanged in behaviour (§7).

---

## 1. Finding → repair map

| Grok | Defect reproduced from code (C1 `ec74085`) | Repair |
| --- | --- | --- |
| **N1** BLOCKING | `#doSeek` faded the outgoing voice at `mapper.secForFrame(seamFrame)`, the OLD epoch's time for the target frame. Reproduced exactly: origin 5.0 s, seek at 6.0 s to frame 240 000 → old gate `set@9.995=1, linear@10.000=0`, incoming open at ~6.1 s, about 3.9 s doubled. | The new epoch's origin is `now + startLead`. Its voices are reserved, built and armed **first**. Only then are the outgoing voices faded, over the same 5 ms window the incoming fade in, from that origin. A seek that supersedes a seek not yet heard cancels that seek's voices and retracts its un-begun handover, so the audio actually sounding keeps sounding. |
| **N2** BLOCKING | `tick()` returned early unless starting/playing/seeking, and stop completion lived only inside `fillWindow`. The engine stayed `stopping` at 100 s. | Pending-stop completion is serviced on every wake in any phase. The wake loop keeps running while a stop, a voice or an active phase needs service, then ends itself. `stopped` is delivered only after every connected voice is disconnected; it writes the parked cue once. A Play during Stop starts a new epoch and the superseded stop never parks. |
| **N3** BLOCKING | The listening procedure described a demo page, Space/Esc and a `pkill` stop that did not exist. | `tools/clockwork-audition/` holds the page, a loopback-only server and synthesised fixtures. It has explicit Play, a visible Stop, Esc = Stop, Space = Play/Stop, a state and error display, a −24 dB default level (max −6 dB, ramped), no autoplay and no pilot tone, and a Stop watchdog. It uses the actual engine and a real ProjectState. The procedure was rewritten only after the controls passed tests. |
| **N4** MAJOR | The horizon was a nominal 104 ms. The engine never called the tested arm sequence; it sent one future arm. No lead was measured, and lateness was not detected. | The timing terms are separated and labelled (§4). DSP voices are built unarmed. The engine measures `t0 − currentTime` and then sends **exactly** the legal Signalsmith pair: an arm in the past with compensated input, plus one future stop. A voice below the floor is never armed. A slow *first* batch re-anchors its epoch (`START_DELAYED`); a late voice inside a sounding epoch is an explicit `DEADLINE_MISS` stop. A rate outside 0.857–1.2, or any pitch shift, is reported `STRETCH_UNQUALIFIED`. |
| **N5** MAJOR | The pool auto-freed tail slots in `acquire()` while nodes stayed connected. An occurrence was marked scheduled before allocation, so after `POOL_EXHAUSTED` it was lost for good. A seek retired voices before checking capacity. Pool times mixed playback offsets with transport frames. | The pool is a strict ledger, `allocated → prepared → sounding → fading → disconnected → released`. It moves forward only, never reuses an id, and frees a slot only from `disconnected`, after the engine has really disconnected the nodes. An occurrence is marked scheduled only after a successful allocation; a refused one is retried. Play, seek and loop changes reserve capacity before anything destructive and refuse with `POOL_EXHAUSTED`, leaving the audible epoch untouched. Engine times are context seconds only. |
| **N6** MAJOR | `loopSeamWindow` was never called; repeated occurrences opened their gate at 1. | A clip crossing the loop end plays as two voices: the outgoing one post-rolls N/2 frames past *b*, the incoming one pre-rolls N/2 before *a*. They use complementary linear ramps over `[seam − N/2, seam + N/2]`, from `loopSeamWindow`, with exact source frames. A loop shorter than `max(1 beat, 2 × admission window)` is refused. |
| setLoop | It only reset `scheduledUntil`; the active map kept the old loop. | While playing, the map is re-anchored at the frame heard at `now + startLead`, through the normal handover (`seek` with `keepCue`). |
| units | Voice-pool times mixed playback offsets and absolute frames. | Removed: the engine owns release timing in context seconds. |
| scheduler | The host had to start the loop, and its first fill waited a wake. | Play, Seek, Stop and setLoop start the loop and fill immediately. |
| suspension | No context-state handling. | `suspended`/`interrupted` → rendering has halted, so voices are disconnected safely and the transport parks honestly (`CONTEXT_SUSPENDED`). `closed` → `FAILED`. Play refuses while a live context is not running. |
| reducer delivery | `started`, `seekDone` and `deadlineMiss` were never delivered. | Delivered by the engine itself, as is `arrangementEnd`. |
| non-finite | Detected only every 256 limiter blocks. | The limiter reports a new fault on the block it occurs. The engine goes to `FAILED`, fades and releases every voice, and calls `onFail`. |
| clock authority | — | One authority: the AudioContext clock. Wake timers are injectable and only wake the scheduler. |

**Found by the real-worklet checks, not by the simulation (and fixed):**

1. **Chromium's `cancelAndHoldAtTime(t)` inserts no hold point when no event lies
   after `t`.** A following `linearRampToValueAtTime` then ramps from the
   *previous* event, so a 5 ms handover became a one-second fade. The engine now
   mirrors every gate event in JS and anchors each hold with
   `setValueAtTime(held, t)`. The simulated AudioParam was changed to behave like
   Chromium, and a mutation check confirms the Node suite now catches this bug.
2. **The first Signalsmith node in a context costs 61–67 ms**, because it loads
   the module and compiles WASM. `prepare()` now warms it silently.
3. **Eight Signalsmith nodes built together take up to 52 ms, and a live clock
   catches up in bursts of up to 22.8 ms** (headless). The first batch therefore
   re-anchors its epoch against a measured clock reserve rather than failing.
4. **Audition page:** a Stop watchdog from an earlier Stop could suspend a later
   Play. It is now scoped to its own stop's epoch and disarmed by Play.

---

## 2. Engine-level tests (actual `RealtimeEngine`, simulated device clock)

`tests/frontend/arrangement/helpers/fake-audio.js` provides:

- a settable clock;
- AudioParam automation evaluated per Web Audio rules, including Chromium's
  `cancelAndHoldAtTime`;
- a node registry with real connect/disconnect edges, so tests count processors
  that are *actually* connected;
- a fake Signalsmith node that follows the vendored pop rule.

It proves lifecycle, timing and ownership. **It is not proof of audible
correctness.**

`c1-engine-repro.test.js` (2): **N1** (Grok repro, 6.0 / 6.104 / 10.0 s) and **N2**
(Stop at 100 s). Negative control: `node tests/browser/clockwork-rescue/legacy-control.mjs`
runs the same file against `ec74085`, and **both fail there** (N1: `gate 1` at
6.115 s; N2: `stopping`).

`realtime-engine-live.test.js` (28), all passing:

- **Timing and scheduler**
  - N4: the timing budget is separated and labelled (measured / assumed / configured)
  - the scheduler starts when Play is requested and stops after Stop completes
- **Stop (N2)**
  - Stop completes, isPlaying is false, the cue is parked once, processors return to baseline
  - Stop immediately after Play, with nothing ever sounding
  - Stop with no clip events left
  - repeated Play/Stop cycles park once each and return to baseline
  - Play during Stop begins a new epoch; old voices never re-open; the superseded stop never parks
- **Seek and stale work (N1)**
  - forward 4 s seek, and a backward seek (bypass + DSP): handover at now + lead, unity crossfade, old voice silent afterwards
  - rapid repeated seeks retire obsolete voices with no hidden nodes
  - Stop during a seek handover
  - no stale generation resumes after cancellation
- **Capacity and ledger (N5)**
  - pool overflow on seek refuses without discarding current audio
  - a refused occurrence is retried, and a late one is reported
  - the ledger and the real graph agree at every wake (8 tracks, loop, seeks)
- **Loop (N6)**
  - complementary seam envelopes on the exact loop samples, every pass exactly once
  - an interior pass never repeats stale audio; Stop and Seek during the loop
  - a too-short loop is refused; setLoop re-anchors the active mapping
- **Signalsmith arming (N4)**
  - Signalsmith receives exactly arm-now + one future stop, with the lead supplied
  - a slow first batch is re-anchored, never armed short
  - late scheduling inside a sounding epoch is detected and stops explicitly
  - a coarse live clock is reserved in the start lead
  - stretch outside the measured range is played but reported unqualified
- **Edges and safety**
  - frame-zero start
  - non-finite sample → safe failure
  - context suspension and recovery
  - arrangement end
  - no `.value` write on a connected node

Pure additions:

- `voice-pool` (3 strict-ledger tests, and the enum test updated);
- `transport-core` (`keepCue`);
- `voice-scheduler` (`originSec` against the pop model);
- `time-math` (routing policy).

`clockwork-audition.test.js` (8): no context on load; Play prepares the real
engine; Stop; Esc (including during prepare); Space (once per press); level
default, ramp and cap; seek, loop and error display; the Stop watchdog; a Play
disarming an earlier watchdog.

---

## 3. Bounded real-Chromium checks (`tests/browser/clockwork-rescue/run.mjs`)

All material is synthesised. Results are small JSON files in `~/.local/state/clockwork-rescue/`.

**offline**: the actual engine on an OfflineAudioContext with real Signalsmith and
limiter worklets, woken by `suspend()` every 1024 frames.

| Check | Result |
| --- | --- |
| Seek, rate 1: old audio just before the handover / 10 ms after / 1.2–1.6 s later | −0.15 dB / **−165.9 dB** / −165.9 dB |
| Seek, rate 1.2 (Signalsmith): same three windows | +0.04 dB / **−70.1 dB** / −62.0 dB |
| New material 10 ms after the handover | within 1 dB |
| Negative control, C1 seek | old tone still **+0.0 dB** later (detected) |
| Stop: output after the 10 ms fade + limiter | **0.0** (max abs); `stopped`, isPlaying false, 0 processors, 0 slots |
| Negative control, C1 stop | stays `stopping`, 2 slots held (detected) |
| Signalsmith supplied lead (offline) | 104 ms |
| Loop [1 s, 2 s) ×3, against the ideal looped signal | seams **1.07e-7**, interior 1.5e-8, transient onsets 0 frames |
| Non-finite sample in a source | `FAILED`/`NON_FINITE`, output finite, processors released |

**live**: real-time AudioContext with `--disable-audio-output --mute-audio`.
`pactl` sampled every 100 ms aborts on any new playback stream; across every
run, **0 streams were seen**. Repeated 8× per set (`live-repeat.sh 8`):

| Set | Passed | Deadline misses | Re-anchored starts | Min Signalsmith lead | Build max | Clock catch-up max | Wake lateness max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| audition (4 tracks, 1 DSP) | 8/8 | 0 | 2 | 78.7 ms | 23.3 ms | 10.1 ms | 0.9 ms |
| worst (8 DSP voices) | 8/8 | 0 | 8 | 70.7 ms | 52.2 ms | 22.8 ms | 4.8 ms |

Earlier iterations of this measurement, kept honest:

- Cold first Play: 1 deadline miss in 1 run, which led to the warm-up.
- Reserve of one burst: about 3 of 6 runs missed by under 1 ms, which led to
  the measured reserve.

**page**: the audition page itself, under the same no-device guarantees. All
checks pass:

- no AudioContext on load;
- Esc before Play opens nothing;
- Play → `playing`, Esc → `stopped`;
- Space → `playing`, then seek and loop with 0 deadline misses, Space → `stopped`;
- processors and slots back to baseline;
- exactly one context, created on the Play gesture;
- Release closes it.

---

## 4. Signalsmith scheduling and the timing budget

| Term | Value | Provenance |
| --- | --- | --- |
| Processor priming lead | 64 ms (+1 quantum = 66.7 ms required per voice) | **measured** (C1 sweep; default preset, rates 0.857/1/1.2, 0 st) |
| Build budget | 40 ms | **assumed**; measured 23 ms (audition) and 52 ms (8 DSP) → covered by re-anchoring |
| Start lead (Play/Seek response target) | 104 ms + one clock burst (≈114 ms live here) | derived |
| Clock burst | 10.0 ms | **reported** (`baseLatency`) |
| Clock catch-up reserve (first batch) | max(2 × burst, measured catch-up) = 20–23 ms | **measured** on the context (probe in `prepare`, then every wake) |
| Scheduler wake | 25 ms | configured (wakes only) |
| Wake jitter allowance | 15 ms | **assumed**; headless measured p99 ≤ 1 ms, max 4.8 ms |
| Admission window | start lead + wake + jitter ≈ 154 ms | derived |
| Device output latency | `outputLatency` (0 under fake output) | reported, **not measured at a speaker** |
| Audible response | Play ≈ start lead + output + 5 ms limiter; Stop ≈ 10 ms + output + 5 ms | **estimates**, not measured at a speaker |

The 104 ms value is **not** fully measured. Only the 64 ms priming floor is a
measurement. What the engine guarantees is that each Signalsmith voice is armed
with an observed lead of at least 66.7 ms, or not armed at all. The C1 sweep's
gaps remain gaps: two cells at rate 1.2 (transient) timed out, the preset sweep
is empty, and the 16 ms cell errored. Other presets, rates outside 0.857–1.2, and
any pitch shift are therefore *unqualified* and reported as such.

---

## 5. Voice capacity and lifecycle evidence

- Capacity is derived from 8 tracks: 16 sounding + 2 seam partners + 4 tails = 22.
  The graph limit is 32.
- Connected processors are counted from real node edges and checked at every wake:
  they equal the ledger's connected voices and never exceed capacity. The peak was
  16 during 8-track loops and seeks.
- Every completed voice history is forward-only and ends `disconnected → released`.
  There were 0 illegal transitions, 0 duplicate slot owners and 0 steals.
- After every Stop the processors and slots return to 0, both in the simulation
  and in live Chromium.

---

## 6. Stop, Seek and Loop summary

- **Stop** fades from the current time and completes on its own wakes. It parks the
  cue once and returns to baseline. It works immediately after Play, during a
  handover, during a loop, with no events left, and repeatedly.
- **Seek** leaves no old audio after the 5 ms handover, both on the device clock
  and in real-worklet PCM. Rapid seeks leave only the last epoch.
- **Loop** seams are complementary and sample-exact on phase-continuous material,
  and every pass is present exactly once.

---

## 7. Shared live/offline routing

Today one function, `clipRoute(rate, semitones, host)` in `time-math.js`, makes
the decision for both hosts, under two **declared** policies:

- `offline` is `stretch-all`, the accepted bounce, unchanged;
- `live` is `bypass-unity`.

Measured on a rate-1 clip, bounce (Signalsmith) vs live (bypass):

| Measure | Pad | Drums |
| --- | --- | --- |
| Level | −0.01 dB | +0.07 dB |
| Waveform residual (×RMS) | 1.18 (not identical) | 1.11 (not identical) |
| Transient envelope correlation | — | 0.999 |
| Signalsmith path vs bypass | — | 64 frames (1.3 ms) late |

Waveform-identical stretched or bypassed audio is **not** claimed.

- **The offline bounce is unchanged.** An 8-clip plan (stretch, pitch, fades,
  gains) rendered through the C1 `offline-render.js` and the repaired one differs
  by at most **5.96e-8**. That is exactly C1's *own* run-to-run variation:
  Chromium's offline render of this plan is not bit-repeatable even for unchanged
  code, with tens of thousands of 1-ULP differences.
- **Migration (not done).** Move the bounce to `bypass-unity` after the owner's
  listening sign-off, re-baselining the audited bounce artifact in the same
  change. Until then, live and bounce match in level and in timing within about
  1.3 ms for unstretched clips, not sample for sample.

---

## 8. Remaining numerical and audible limitations

1. **No owner listening has happened.** There is no audible PASS, and no
   "click-free" or "glitch-free" claim.
2. **Headless only.** Every live number comes from headless Chromium with a fake
   output stream. Real PipeWire latency, quantum and load behaviour on the
   owner's laptop are unmeasured.
3. **Seams.** A loop seam is exact only where the material across the loop end
   continues the material at the loop start. Otherwise the 2.5 ms window
   crossfades two different signals: correct in gain, but a short blend. A
   transient exactly at the loop start then plays at the crossfade weight
   (0.5 at the seam sample, 1.0 after 1.25 ms).
4. **Partial seam material.** A clip edge within 1.25 ms of a loop point has less
   pre- or post-roll material, so its seam window is partly empty.
5. **Signalsmith qualification.** Seek on Signalsmith material leaves −62 to −70 dB
   of old audio. That is gated stretch tail, not doubled audio. Priming is
   qualified only for the default preset, rates 0.857–1.2 and 0 semitones.
6. **Start lag.** A first batch of many Signalsmith voices starts up to about
   23 ms later than its target (`START_DELAYED`, reported). A late voice in a
   running epoch stops the transport (`DEADLINE_MISS`); it does not play
   attenuated.
7. **Display only.** `playhead()` reports the rendering position, not the speaker
   position, which is later by the output latency.
8. **Short loops.** Loops under `max(1 beat, ≈308 ms)` are refused.

---

## 9. Independent final review

See §12. It was filled in after the review ran.

---

## 10. Owner audition

`docs/clockwork-listening-procedure.md` (revised). Local URL:
**http://127.0.0.1:8777/tools/clockwork-audition/** (served by
`node tools/clockwork-audition/serve.mjs`). Nothing is launched automatically.

## 11. Static assets

`src/twobecomeone/studio_static` went from 1,059,807 bytes / 90 files (`ec74085`)
to 1,095,661 bytes / 90 files (+35,854 B, +3.4%).

- **Growth** is almost all `js/realtime-engine.js`, now 50,375 B. It is the rewrite
  with its ledger, handover, re-anchor and diagnostics code, plus
  `voice-pool.js`, `offline-render.js` and `time-math.js`.
- **Largest files:** `vendor/signalsmith-stretch/SignalsmithStretch.mjs` 113,867 B;
  `js/components/stem-desk-panel.js` 59,185 B; `js/runtime/ghost-controller.js`
  55,945 B; `js/realtime-engine.js` 50,375 B.
- **Audition tool:** 22.7 KB in `tools/clockwork-audition/`, outside
  `studio_static`; the Studio does not serve it.

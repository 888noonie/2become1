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
| **N1** BLOCKING | `#doSeek` faded the outgoing voice at `mapper.secForFrame(seamFrame)`, the OLD epoch's time for the target frame. Reproduced exactly: origin 5.0 s, seek at 6.0 s to frame 240 000 → old gate `set@9.995=1, linear@10.000=0`, incoming open at ~6.1 s, about 3.9 s doubled. | The new epoch's origin is `now + startLead`. Its voices are reserved, built and armed **first**. Only then are the outgoing voices faded, over the same 5 ms window the incoming fade in, from that origin. A seek that supersedes a seek not yet heard cancels that seek's voices and retracts its un-begun handover. Upcoming voices of the audible epoch (a loop-in partner, the next clip) keep playing up to the handover, so there is no dropout (fixed after the independent review, §9). |
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
| Seek, rate 1.2 (Signalsmith): same three windows | +0.04 dB / **−70.1 dB** / −62.0 dB (cause of the −62 dB residual not established; the old voice is disconnected ~130 ms after the handover, so it is not that voice's tail — most likely leakage of the new 900 Hz material into the 300 Hz Goertzel window) |
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

- Capacity is derived from 8 tracks: 16 sounding + 8 handover partners (one per track) + 4 tails = 28.
  The graph limit is 32. The earlier value, 22 (2 seam partners), refused ordinary 8-track use (§9).
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
  and in real-worklet PCM. It has no dropout before the handover, even next to a loop
  seam or clip boundary. With 8 tracks, a second seek 30 ms after the first is accepted
  and only the last target sounds. Two retargets within about 25 ms of each other
  *next to a loop seam* on 8 tracks are refused (`POOL_EXHAUSTED`, audio untouched; §8).
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
4. **Partial seam material.** A crossfade pair is formed only when the clip has
   material before *a* and after *b*. Otherwise the outgoing pass fades over the
   2.5 ms before *b* and the next pass starts with its own natural edge, a short
   dip, never more than unity. When a seam extension reaches the clip's own edge,
   the clip's fade is kept. A seek into the middle of a clip fade starts with the
   2.5–5 ms transport ramp, not the remaining musical fade.
5. **Signalsmith qualification.** After a seek on Signalsmith material, a −62 to
   −70 dB residual is measured at the old frequency. Its cause is not established
   (§3). Priming is qualified only for the default preset, rates 0.857–1.2 and
   0 semitones.
6. **Start lag.** A first batch of many Signalsmith voices starts up to about
   23 ms later than its target (`START_DELAYED`, reported). A late voice in a
   running epoch stops the transport (`DEADLINE_MISS`); it does not play
   attenuated.
7. **Display only.** `playhead()` reports the rendering position, not the speaker
   position, which is later by the output latency.
8. **Short loops.** Loops under `max(1 beat, ≈308 ms)` are refused.
9. **Rapid retargets.** On 8 tracks, two seeks or loop changes within about 25 ms
   *next to a loop seam* need up to 32 slots and are refused (`POOL_EXHAUSTED`).
   Playback is unchanged and the refusal is shown on the page.
10. **Crossfade law.** The 5 ms seek handover is linear: it sums to unity in gain,
    but on uncorrelated material it dips by about 2 dB RMS at its midpoint
    (measured 0.1414 → 0.1132).
11. **Not built.** A seek during the 10 ms stop fade is ignored by the reducer, as
    before. The engine has no `resume()` after `pause()`; the audition page has no
    Pause. Builds time out after 1 s of wall time (`VOICE_BUILD_TIMEOUT`, explicit
    failure).
12. **Simulation gaps** (named by the review). The simulated host does not model a
    buffer source running out, stop-before-start, or the clock moving while voices
    are armed (except where a test moves it), and most tests drive `tick()`
    directly. The wake loop, races and live clock are covered by the
    real-Chromium live and page checks, not by the simulation.

---

## 9. Independent final review

**Reviewer:** a Claude general-purpose subagent with a fresh context, launched by
the author's session. It did not write the code and was read-only on the repo. It
is the **same model family as the author** and is **not Grok**. Treat it as a
separate review, not a cross-vendor audit. Its scripts are kept in the session's
scratchpad (`.../scratchpad/review/r1–r5`).

**Reviewer verdict on `c44a8de`: CONDITIONAL GO.**

- **Confirmed:** both reproductions are genuine. The legacy control fails N1 and
  N2 for Grok's reasons. The offline numbers and the live-repeat numbers match the
  result files.
- **Noted:** N4–N6 have no negative control against `ec74085`.

| # | Severity | Finding (reviewer) | Status |
| --- | --- | --- | --- |
| 1 | MAJOR, confirmed | A seek cancelled the audible epoch's upcoming voices: a 50–100 ms dropout at a loop seam or clip boundary inside the start lead. | **Fixed.** Only voices of an unheard epoch, or starting after the handover, are cancelled. Re-running the reviewer's `r1` gives unity throughout. Test: *review 1*. A latent N6 pairing bug it exposed (1.5× gain when a clip starts exactly at *a*) was also fixed. Test: *review 1b*. |
| 2 | MAJOR, confirmed | A build that never resolves stopped the wake loop, with no error. | **Fixed.** The wake is re-armed before awaiting, and builds time out with an explicit `VOICE_BUILD_TIMEOUT`. Test: *review 2*. Re-running `r2`: wakes continue. |
| 3 | MAJOR, confirmed | The 22-slot pool refused normal 8-track seeks and loop-offs near seams. | **Fixed** for the reviewer's cases (`r3`: 30/120/200 ms all accepted; seek 50 ms before a seam accepted). Back-to-back retargets next to a seam are still refused safely (§8.9). Tests: *review 3* (three). |
| 4 | MINOR, confirmed | A hard onset at up to 0.5 gain, with the clip fade dropped, at a partial loop edge. | **Fixed.** The clip fade is kept when the extension reaches the clip edge (`r4`: gain at the seam is 0.021, against an ideal of 0.042). Test: *review 4*. |
| 5 | MINOR, plausible | The loop button could show "off" while the engine still loops. | **Fixed.** The button now reflects the engine's loop state. |
| 6 | MINOR | Holding Space toggled repeatedly. | **Fixed.** `ev.repeat` is ignored. |
| 7, 8 | MINOR | Seek during the stop fade is ignored; no `resume()`. | Documented (§8.11), not changed. |
| 9 | MINOR | The linear handover dips about 2 dB. | Documented (§8.10). |
| docs | — | Overstatements: the −62 dB "tail", "rapid seeks", the seam wording. | Corrected (§3, §6, §8). |

**Re-review not run.** The fixes were verified by re-running the reviewer's own
scripts and the full suites (§12). A second independent pass has not been run.

---

## 10. Owner audition

`docs/clockwork-listening-procedure.md` (revised). Local URL:
**http://127.0.0.1:8777/tools/clockwork-audition/** (served by
`node tools/clockwork-audition/serve.mjs`). Nothing is launched automatically.

## 11. Static assets

`src/twobecomeone/studio_static` went from 1,059,807 bytes / 90 files (`ec74085`)
to 1,097,975 bytes / 90 files at `06331d1` (+38,168 B, +3.6%; `c44a8de` was 1,095,661).

- **Growth** is almost all `js/realtime-engine.js`, now 52,689 B. It is the rewrite
  with its ledger, handover, re-anchor and diagnostics code, plus
  `voice-pool.js`, `offline-render.js` and `time-math.js`.
- **Largest files:** `vendor/signalsmith-stretch/SignalsmithStretch.mjs` 113,867 B;
  `js/components/stem-desk-panel.js` 59,185 B; `js/runtime/ghost-controller.js`
  55,945 B; `js/realtime-engine.js` 52,689 B.
- **Audition tool:** 22.7 KB in `tools/clockwork-audition/`, outside
  `studio_static`; the Studio does not serve it.

---

## 12. Final verification on the repaired HEAD (after the review fixes)

| Suite | Result |
| --- | --- |
| `npm test` (frontend, all) | 777 tests, **776 pass, 0 fail**, 1 skipped (pre-existing untracked bounce artifact) |
| `pytest -q` (Python, this checkout's `src`) | **630 passed, 1 skipped**. Run on `c44a8de`; the review fixes touch no Python. |
| `legacy-control.mjs` | C1 `ec74085`: N1 **fails**, N2 **fails** (detected) |
| Chromium offline + routing + page | **30/30 PASS**. Seek: old audio −165.9 dB (rate 1) / −70.1 dB (rate 1.2) 10 ms after the handover. Loop seams 1.07e-7 against the ideal. Stop output 0. The bounce is within C1's own 1-ULP variation. The page flow passes. |
| Chromium live, 6 runs per set (`live-repeat.sh 6`) | audition **6/6**, minimum Signalsmith lead 89.4 ms, 1 re-anchored start. Worst case (8 DSP) **6/6**, minimum lead 84.0 ms, 6 re-anchored starts, build max 54.8 ms, catch-up max 17.6 ms. Wake lateness max 2.4 ms. **0 deadline misses.** |
| PipeWire playback streams opened by any run | **0** |
| Reviewer's scripts `r1`–`r5` re-run | r1 unity throughout (no dropout); r2 wakes continue; r3 all accepted; r4 fade kept; r5 back-to-back retarget refused safely (documented) |

**Disk note.** The first pytest attempt filled `/tmp` (tmpfs). Only that run's own
`/tmp/pytest-of-richardn/pytest-2` (458 MB) was removed. The re-run used a
`--basetemp` under `~/.local/state`, which was removed afterwards. The older
`pytest-0` and `pytest-1` (2.7 GB each, from earlier sessions) were left in place.

## 13. Verdict and handover

**Owner audition: CONDITIONAL GO.**

- **Why this is ready.** The live engine now honours the stop, seek, loop,
  capacity and late-detection contracts, and the evidence comes from the engine
  itself and from real worklets. The audition page exists, is tested, and makes no
  sound until the owner presses Play.
- **What is still conditional:**
  1. The owner listens and writes the verdict (`docs/clockwork-listening-procedure.md` §6).
  2. Real-device latency and load are unmeasured.
  3. The limitations in §8 hold.
- **Milestone D (arrangement UI): still NO-GO** until the owner's listening
  verdict. This rescue did not start it.

**Open work**

1. The owner audition.
2. Optionally, a second independent (ideally cross-vendor) review of the review fixes.
3. Negative controls for N4–N6 against `ec74085`.
4. An equal-power or correlation-aware handover.
5. `resume()` after `pause()`.
6. Moving the bounce to `bypass-unity` after sign-off, with a new artifact baseline.
7. A preset sweep for Signalsmith qualification.

---

## 14. Addendum — OPERATION CLOCKWORK: THE BROKEN RECORD (loop repair)

**PM audible verdict on `1fb993f`:** Play, Stop and Seek work; Loop 2–4 s does
not. The page showed `stopped · 6.00 s · loop 2–4 s on · voices 0/28 · peak 8 ·
misses 0`.

**Root cause (two defects, both reproduced before fixing):**

1. `createTransportMap` only builds a loop when the start frame is before the
   loop end (`s0 < loop[1]`). The engine passed the requested position through
   unchanged, so Play, Seek or a live Loop switch from at or past 4 s (the page's
   Jump to 6 s, or simply pressing Loop after 4 s) built a map with **no loop**:
   it played to the 8 s arrangement end and stopped at the 6 s cue, exactly the
   PM's display. A start before 2 s did reach the loop, but via an unasked-for
   lead-in.
2. The audition page kept `loopOn` in its own state. A Loop pressed while audio
   was off (before the first Play, or after Release) was shown as on but never
   given to the engine created at Play.

**Correction (minimal):** `RealtimeEngine.#loopEntry` — with a loop set, a Play,
Seek or live loop-change position outside `[a, b)` enters at `a`; a position
inside is kept. The move is reported as a `LOOP_ENTRY` notice (`onNotice`) only
after admission succeeds, and counted in `diagnostics().loopEntries`. The page
applies its loop to a newly prepared engine (and turns the button off if the
engine refuses it) and lists notices. No change to TransportMap, the voice
scheduler, gate envelopes, Signalsmith arming or the pool.

**Regressions** (`tests/frontend/arrangement/realtime-engine-live.test.js`,
`BROKEN RECORD:` tests; `tests/frontend/clockwork-audition.test.js`): on
`1fb993f` five fail — loop from 6 s, loop from 0 s, loop switched on past 4 s,
Seek to 6 s while looping, and the page's Loop-before-Play — and the in-range
cases pass, matching the verdict. After the fix all pass. Each loop test drives
the actual engine for 12 s of device clock (past the 8 s end): at least four
4→2 s wraps, heard position always in `[2 s, 4 s)`, per-track gate sum ≤ 1 (no
doubled audio), no deadline miss, Stop completes with 0 processors and 0 slots,
forward-only voice lifecycles. Also covered: Play inside the loop keeps the
position; loop-off continues forward (strictly increasing) past 4 s and stops at
the end; a loop shorter than the horizon is refused; pool exhaustion at a loop
handover refuses without touching current audio. Two earlier tests that started
before the loop were moved inside it (their lead-in is no longer the behaviour).

**Real Chromium** (`run.mjs`, output disabled and muted, PipeWire stream count
never rose above its baseline):
- offline PCM, Play from 5 s with loop [1 s, 2 s): equals the ideal loop from
  1 s — interior error 1.5e-8, seams 1.3e-7, all 4 seam transients on their
  exact frame, still playing; the inside-start N6 check is unchanged (1.07e-7);
- page: Loop switched on at ~6.5 s → 3 wraps in 7 s of real clock, heard
  position always in 2–4 s, still playing after the 8 s end, Jump to 6 s
  re-enters the loop, 0 deadline misses, **high-water 8 connected processors /
  8 pool slots (capacity 28)**, back to 0/0 after Stop;
- live:audition and live:worst: unchanged PASS (min supplied Signalsmith lead
  84.7–89.4 ms, 0 misses); seek/stop/non-finite and the bounce (≤ 1 ULP of C1)
  unchanged.

`npm test`: 785 tests, 784 pass, 0 fail, 1 pre-existing skip. Python untouched
(not re-run). Static assets: 1,097,975 → 1,099,378 B (+1,403 B, the loop-entry
rule and its notice), 90 files.

**Remaining audible limitations:** the loop-entry jump (e.g. from 6 s to 2 s) is
a seek handover, so it carries the documented ~2 dB dip of the 5 ms crossfade on
unrelated material; the playhead shows the target during the ~104 ms handover
lead; Stop returns to the cue (2 s after a Play that entered the loop). The
loop seams themselves remain complementary (sum exactly 1). Not verified by ear.

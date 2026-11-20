# OPERATION THE GOLDEN EAR — Milestone C architecture and UX assessment

Date: 2026-11-20
Author: Claude Opus 5.5 (independent architecture and UX review)
Branch: `design/golden-ear` (local only), cut from `feature/all-the-time @ 462dba9`
Scope: design, analysis and one disposable feasibility probe. **No product code was
changed.** Main, the arrangement branch, the Visitor candidate, production media,
recovery artifacts and credentials are untouched. Nothing was pushed or merged.

Companion files in this folder:

- `arrangement-concept.html` / `.png` — annotated Black Tie arrangement concept (§F)
- `probe/` — the disposable Signalsmith probe (`probe.js`, driver, `probe-results.json`)

## 0. Verified starting position

| Reference | Verified |
| --- | --- |
| `main` | `28eef69bbda41eafae469d8d5b78ea6b12a614fc` |
| `feature/all-the-time` | `462dba92720b3d1a1a33b8b6dab10ca68a84d094`, clean worktree at `~/MISIX-worktrees/all-the-time` |
| `feature/the-visitor` | `e9ae93d107ac5d59f445e1fde21048b95d347f2d`, separate worktree; **not** merged or used here |
| Disk at start | `/home` 8.3 GiB free (95%); `/tmp` tmpfs **461 MiB free (94%)**. It has filled up again since the last cleanup. Nothing was deleted. Every probe output stayed under `~/.local/state/the-golden-ear` (40 KiB) with `TMPDIR` pointed there |

Read for this review: `AGENTS.md`, `docs/black-tie.md`, both milestone documents,
`project-state.js`, `edit-api.js`, `render-plan.js`, `offline-render.js`,
`limiter-worklet.js`, `capture-worklet.js`, `click-guard.js`, the vendored
`SignalsmithStretch.mjs` worklet wrapper, the GATE 5 harness in
`tests/browser/daw/bounce.js` and the accepted Black Tie captures.

## Summary for the PM

1. **The "250 ms DSP delay" does not exist.** GATE 5 delayed playback by
   0.25 s on purpose (`offline-render.js:252`, `startDelaySec = 0.25`) and then
   compared the result against that same 0.25 s (`tests/browser/daw/bounce.js:717`,
   `expectedLagMs: startDelaySec * 1000`). The 255 ms it measured is that
   0.25 s plus the limiter's 5 ms lookahead. Signalsmith's own 120 ms latency is
   compensated inside its worklet, because it reads ahead in the buffered source.
   What the stretch engine really costs the transport is a **scheduling horizon**:
   a start must be scheduled about 64 ms ahead, or it begins up to 21 dB too quiet.
   This was measured in the probe (§D).
2. **The vendored Signalsmith node keeps only one pending future change.**
   Every `schedule()` call discards all changes still waiting
   (`SignalsmithStretch.mjs:91–94`). If the scheduler naively queues loop wraps or
   seeks on one node, events will be lost without any error. The design gives
   every clip *occurrence* its own short-lived voice from a pool (§A).
3. **A seek or loop wrap on one voice smears about 40 ms of stale audio** over the
   new material. It does not click, but the old audio stays audible. Handing over
   to a second, pre-rolled voice with a 5 ms crossfade removes it: the stale
   material is −69 dB after 10 ms (§E).
4. **Fine-scale real-time/offline parity cannot be reached with this DSP, and it
   should not be a goal.** Two offline renders of the same clip, shifted by
   exactly 128 frames, already differ sample by sample (normalized RMS
   difference 0.8–1.1), while their 10 ms envelopes still agree at 0.998–0.999.
   Acceptance should rely on onset timing and envelope tolerances. Clips with
   no stretch and no pitch shift should bypass the DSP so they stay exact (§D, §G).
5. **The click gate passes non-finite audio.** NaN or Infinity at a boundary
   returns `passed: true`, and frame 0 cannot be scored at all
   (`click-guard.js:88`, reproduced). It must stay diagnostic only. Click safety
   is designed into the gain stages instead (§E).
6. **Verdict: CONDITIONAL GO** for the transport slice in §G, with three
   conditions (§I). The arrangement UI comes after the transport has proven itself
   to the ear.

---

## A. Architecture decision record

### ADR-C1: Voice-per-occurrence transport on the existing shared graph

**Context.** Milestone B built a single graph (`buildArrangementGraph`) that
creates one Signalsmith node per clip. It schedules each node once, gates its
audible edge with a sample-accurate clip-gain envelope, and runs the same code
offline and live. That is the right foundation. It has no transport: one start,
a timer to finish (`offline-render.js:265`), and no seek, loop or edit-while-playing.

Constraints found in the vendored wrapper (MIT, `SignalsmithStretch.mjs:22–343`):

- The processor **re-seeks every 128-frame render quantum**. On each
  `process()` it rebuilds the analysis buffer from the buffered source at the
  position its time map gives, then calls `_seek()` and `_process()` (lines
  245–335). Seeking is therefore built in, and the input position is always
  derived from the time map, never from accumulated state. That is good news:
  a position error cannot build up over time.
- The time map holds **the current segment plus at most one pending change**.
  `schedule()` pops every segment whose output time is at or after "now" before
  pushing the new one (lines 91–94).
- `seek`, `flush` and `reset` are not exposed; `latency()` reports input plus
  output latency (120 ms at the default preset).
- An inactive node still calls `_process` on zeros: 8 idle nodes cost 1.0% of
  real time, against 15% for 8 active nodes (probe E5).

**Decision.**

1. **ProjectState stays the only source of truth for music.** The runtime never
   writes clip, track or loop data. The transport keeps a *parked position* and
   writes it to `transport.playheadBeat` only on Stop, Pause, or a seek while
   stopped. It never writes per frame: every write clones and validates the
   whole project.
2. **RenderPlan stays the pure contract.** It needs one small addition: the
   source *handles* (frames available before and after each region) for
   pre-roll. Plan generations are numbered.
3. **A pure scheduler** (`voice-scheduler.js`) turns the plan and the transport
   map into *occurrences*: (clip, pass, output start frame, source frame at that
   start, end frame, gates), within a look-ahead window. It is testable in Node
   with a fake clock.
4. **A voice pool** (`realtime-engine.js`). A voice is a Signalsmith node, or a
   bypass `AudioBufferSourceNode`, plus a clip-gain stage and a transport-gate
   stage. **Each occurrence gets its own voice.** Each voice receives exactly two
   `schedule()` calls: *arm*, which is current at once, then *stop*. This is
   always legal under the one-pending-change rule. Seeks, loop wraps and
   edit swaps hand over between two voices with a short crossfade. The pool
   is sized by concurrency, not by clip count: 8 tracks × 2 overlapping
   occurrences + 8 for seams = **24 voices**, under the existing
   `MAX_CLIPS_PER_GRAPH = 32`.
5. **Bypass voices.** A clip with rate exactly 1 and 0 semitones plays through
   `AudioBufferSourceNode.start(when, offset)`. It is sample-exact, matches
   offline exactly, has no algorithmic latency and needs no priming. The
   accepted Performance Desk material uses no stretch, so it keeps its exact
   sound. The colour change when a clip moves in or out of stretch is
   documented, not hidden.
6. **The audio clock owns time.** Every audible event is a context-time value
   computed from integer frames. `setTimeout` only *wakes the scheduler* every
   25 ms to fill the look-ahead window; it never decides when anything sounds. The
   playhead is drawn from `AudioContext.getOutputTimestamp()` (§D). The
   animation frame only paints.
7. **One limiter and mixer chain**, as in Milestone B. Live parameter changes
   always ramp; nothing writes `.value` on a running graph.

**Alternatives considered.**

| Option | Why not now |
| --- | --- |
| One node per clip, rescheduled for seeks and loops | Measured ~40 ms stale smear per seek (E3), and lost events from the one-pending-change rule |
| A first-party AudioWorklet processor that hosts the Signalsmith WASM with its own sample-accurate event queue | Best long-term shape: render-thread scheduling, no main-thread jitter, one processor per track. It needs C++/WASM build tooling the repo does not have, and it rewrites a component Milestone B qualified. **Deferred to Milestone D**, once the pool design has proven the musical behaviour |
| Render the timeline ahead into a ring buffer (bounce-ahead) | Simple and parity-friendly, but every edit, mute or loop change waits for a re-render. That costs instrument feel and CPU |
| Another stretch library (Rubber Band WASM, SoundTouch) | No demonstrated benefit, and it reopens Milestone B's qualification |
| `MediaElement` or `HTMLAudio` transport | Not sample-accurate; no shared clock with the graph |

**Consequences.** The main thread stays in the scheduling loop, so its jitter
must fit inside the horizon slack (§D, tested in B7). Every audible change has
a defined seam with a defined gain shape, which makes click safety testable as
arithmetic (§E). Offline rendering can later run *the same scheduler*, driven by
`OfflineAudioContext.suspend()` hooks, so offline and live share their seams
(Milestone D).

---

## B. Component and data-flow diagram

```
                ┌──────────────────────────── main thread ─────────────────────────────┐
 UI gestures ──►│ EditEngine (Milestone A)                                              │
 (Black Tie)    │   ProjectState vN ──snapshot──► compileRenderPlan (pure) ──► Plan gN  │
                │        ▲ parked position only (stop / pause / seek while stopped)     │
                │        │                                                     │       │
 Transport  ───►│ TransportController (state machine §C)                       ▼       │
 commands       │   play / pause / stop / seek / setLoop      PlanDiff(gN-1 → gN)       │
 (Space, ruler) │        │ epoch e, origin (ctxFrame0, transportFrame0), loop L        │
                │        ▼                                             │               │
                │ TransportMap: ctxFrame ⇄ transportFrame (integer, unrolled passes)   │
                │        │                                             │               │
                │ scheduler tick (wakes every 25 ms; never times audio) ◄──────────────┘
                │   occurrencesInWindow(plan, map, [now+H, now+H+W))   (pure, tested)  │
                │        │ voice orders (epoch, generation, frames)                    │
                │ VoicePool (24) ── feeder: shared decoded asset store → addBuffers    │
                │        │            windows of 1 s, dropBuffers behind               │
                │ Playhead: getOutputTimestamp() → heard ctx time − limiter latency    │
                │           → TransportMap⁻¹ → bar·beat (painted on animation frame)   │
                └────────┼──────────────────────────────────────────────────────────────┘
                         │ schedule(arm) / schedule(stop) / AudioParam automation
                ┌────────▼──────────────── audio render thread ────────────────────────┐
                │ voice: Signalsmith worklet | AudioBufferSource (bypass)               │
                │   → clipGain (ProjectState fades, sample-accurate; offline-identical) │
                │   → transportGate (runtime anti-click: start/stop/seek/loop seams)    │
                │ track: EQ lowshelf/peak/highshelf → volume·mute/solo (ramped) → pan   │
                │ master gain → limiter worklet (5 ms lookahead, finite-sample guard)   │
                │   → destination → device (baseLatency + outputLatency)               │
                └──────────────────────────────────────────────────────────────────────┘
```

Runtime-only state (never serialised): transport epoch, origin pair, loop
unrolling counter, voice assignments, feeder windows, plan generation in use,
last heard position. If any of it is lost, nothing is lost musically: Stop,
then Play, rebuilds it from ProjectState.

**Stale-work rule.** Every voice order, feeder fill and async completion carries
`(epoch, generation)`. A completion from an older epoch is discarded and its
voice returns to the pool with its gate held at 0. That is how no repeated or
stale audio can survive a Stop, Seek or loop edit.

---

## C. Transport state machine

| State | Meaning | Audible |
| --- | --- | --- |
| `unprepared` | No plan, or assets not decoded | silent |
| `preparing` | Decoding assets, creating the voice pool, loading worklet modules | silent |
| `stopped` | Parked at position P (beat); voices idle | silent |
| `starting` | Start time T_s scheduled; voices arming; heard time < T_s | silent |
| `playing` | Heard time ≥ T_s | sound |
| `seeking` | Seam time T_k scheduled; old voices fade out by T_k, new voices fade in | sound |
| `stopping` | Gate ramps scheduled to 0 by T_e; voices released after T_e + tail | fading |
| `failed` | Unrecoverable: worklet `processorerror`, context closed, decode failure | silent |

Transitions (anything not listed is a no-op that returns the current state, never an error):

| From | Command or event | To | Notes |
| --- | --- | --- | --- |
| unprepared | `prepare(plan)` | preparing | |
| preparing | ready | stopped | P = `ProjectState.transport.playheadBeat` |
| preparing | failure | failed | message names the asset and the code |
| stopped | `play()` | starting | T_s = now + H (§D); epoch++ |
| stopped | `seek(b)` | stopped | P = b, written to ProjectState as the parked position |
| starting | heard ≥ T_s | playing | |
| starting / playing | `seek(b)` | seeking | T_k = now + H; epoch++; voices of the old epoch fade out by T_k |
| seeking | heard ≥ T_k | playing | a newer `seek` while seeking retargets; unheard voices are recycled silently |
| starting / playing / seeking | `pause()` | stopping → stopped | P = heard position at T_e |
| starting / playing / seeking | `stop()` | stopping → stopped | P = the cue (the last Play or seek origin), the usual "return to cue" behaviour |
| playing | arrangement end reached and no loop | stopping → stopped | P = cue |
| any running | **deadline miss** | stopping → stopped | see failure behaviour |
| any | context `statechange` to `suspended`, `interrupted` or `closed` | stopped or failed | an honest message: "Audio output stopped by the system at bar 9.3" |
| failed | `prepare(plan)` | preparing | |

**Seek semantics.** `seek(b)` takes a beat, which is converted once to an integer
transport frame f = round(b × spb × sr). Each clip c that covers f gets a
new occurrence whose source frame is
`c.sourceStartFrame + round((f − c.timelineStartFrame) × c.rate)`. This is the
Milestone A convention, and the only formula. Clips that start after f are
scheduled normally. A seek outside every clip is legal and plays silence until
the next region. A seek past the arrangement end parks there and plays silence.
With a loop active, a seek that lands outside the loop plays on into the loop
when it is reached (the usual DAW convention), unless the PM chooses "seek
inside the loop only". This is an open UX choice, recorded in §H.

**Loop handling.** The loop is [a, b) in integer frames, with L = b − a of at
least one beat and at least 2 × H (shorter loops are refused with
`LOOP_TOO_SHORT`). The transport map unrolls passes, so
`ctxFrame(pass k, f) = originCtxFrame + (f − a) + k × L`. That is exact integer
arithmetic, with no drift after any number of passes. A clip that crosses b ends
its occurrence at b, and the next pass starts a new occurrence at a. Those two
occurrences overlap in a symmetric 2.5 ms crossfade centred exactly on the seam
(§E). Its centre is the musical boundary, so no timing moves.

**Failure behaviour.**

- *Deadline miss*: a scheduler tick finds that an order it should already have
  sent would land with less than 1 quantum of horizon. For example, the main
  thread stalled for 80 ms during garbage collection or a heavy layout. The
  engine does **not** play late or half-primed material. It schedules a 10 ms
  fade on every gate, enters `stopped` at the heard position and reports
  "Playback could not keep up and stopped at bar 9.3. Press Play to continue."
  A counter records it. Three misses in 60 s offer "Reduce load: freeze
  stretched tracks", a Milestone D render-ahead option.
- *Underrun* (the device starved even though scheduling was on time) cannot be
  observed in this Chromium (`renderCapacity` is undefined, confirmed again in
  probe E1). It is qualified by the loopback rig in §G (B7), never inferred
  from CPU benchmarks.
- *Non-finite samples*: the limiter replaces NaN or ±Infinity with 0, counts
  them and reports them through its existing stats message. The first one moves
  the transport to `failed`, and the message names the track.

---

## D. Latency strategy

### D.1 What the "~250 ms" really was

| Layer | Value | Evidence | Compensation |
| --- | --- | --- | --- |
| Signalsmith algorithmic latency | 120 ms in total at the default preset (`latency()`); 80/60/40 ms with `blockMs` 80/60/40; 140 ms "cheaper" | probe E1 | **Already compensated inside the worklet.** `process()` reads the source at `currentTime + outputLatency` (`SignalsmithStretch.mjs:246`), so audio emitted at time t corresponds to time-map position t. Milestone B measured a +2.1 ms onset (S3) and +78 samples (S7) |
| What that latency costs instead | **Priming horizon**: a start scheduled < 64 ms ahead begins quiet (21 ms ahead: −21 dB; 43 ms: −5 dB; ≥ 64 ms: within ±0.8 dB from the first 5 ms), for both tone and percussion | probe E7 | Schedule horizon H = 85 ms (64 ms plus 21 ms of main-thread slack) |
| Cold-activation leak | A voice that activates while ungated emits pre-roll material ~53 ms (2,545 frames) **before** its scheduled start | probe E2 | The clip-gain gate stays at 0 until the region edge (already in `offline-render.js:171`); keep it in the live path |
| Pre-roll (source) | Regions are sliced exactly at `sourceStartFrame` (`offline-render.js:141`), so the analysis window sees zeros before the edge | code | Feed handles of up to 120 ms × rate where the asset has them; the gate defines the edge |
| Limiter lookahead | 5 ms (240 frames) added to all output | `limiter-worklet.js`, Milestone B §3 | Offline trims it; live subtracts it in the playhead mapping |
| Render quantum | 128 frames (2.67 ms); time-map changes take effect per quantum | code | Content position is interpolated continuously; audible edges come from sample-accurate gain automation, not from segment activation |
| Browser and device output | `baseLatency` 10.7 ms; `outputLatency` 32–40 ms (headless; varies between runs) | probe E1 | Included automatically in `getOutputTimestamp().contextTime`; to be verified on the target machine with the loopback rig |
| Harness start delay | **250 ms**, chosen by GATE 5 | `offline-render.js:252`, `bounce.js:717` | Not a property of the engine. GATE 5's "measured 255 vs 250 expected" was harness offset + limiter |
| Measurement method | GATE 5 searches lag in whole milliseconds (`bounce.js:151`) and captures with one `postMessage` per quantum (375/s, `capture-worklet.js:22`) | code | Up to 0.5 ms of residual misalignment alone pulls down 1 ms envelope correlation; use sub-sample alignment (§G) |

### D.2 Why fine-scale parity is not the target

Probe E4 rendered the same stretched clip offline at shifted start frames, then
shifted each result back. Offline re-renders at the same start are bit-identical
(max difference 0). A shift of 37, 64, 101, **128** or **1,440** frames, however,
changes the waveform:

| rate | shift (frames) | 1 ms envelope corr | 10 ms envelope corr | normalized RMS diff |
| --- | --- | --- | --- | --- |
| 1 | 37 / 64 / 101 / 128 / 1440 | 0.95 / 0.70 / 0.99 / 0.93 / 0.82 | 0.999 / 0.997 / 1.000 / 0.999 / 0.998 | 0.67 / 1.32 / 0.60 / 0.81 / 1.10 |
| 0.857 | 37 / 64 / 101 / 128 / 1440 | 0.96 / 0.97 / 0.99 / 0.92 / 0.91 | 1.000 / 1.000 / 1.000 / 0.999 / 0.998 | 0.95 / 0.79 / 0.98 / 0.94 / 1.00 |

The phase vocoder's analysis grid is anchored to the processor's own running
state, not to the content. Any two renders that start that grid at different
points produce different sample-level output, with the same 10 ms musical
envelope. A live context starts the grid at an arbitrary point, so **live and
offline audio will never be sample-identical for stretched clips.** GATE 5's 10 ms
correlation of 0.84 is much lower than the ≥ 0.997 that grid phase alone
explains. The rest is most likely the measurement method above. That is a
hypothesis, to be re-measured with the §G method, not a conclusion.

Acceptance therefore separates four properties:

| Property | Bypass voices (rate 1, 0 st) | Stretched voices |
| --- | --- | --- |
| Sample-accurate timing (where a region starts and ends) | exact, 0 frames | edges exact (gain gate); content onset ±128 frames |
| Stable state semantics (same ProjectState → same plan) | exact | exact |
| Numerical tolerance against offline | ≤ 1e-6 per sample | 10 ms envelope corr ≥ 0.99, level ±0.5 dB per 100 ms |
| Bit-for-bit reproducibility | across offline renders (to be pinned) | not claimed; offline differs in the float32 LSBs (Milestone B §11.3) |

### D.3 Responsiveness without a dishonest playhead

- **Acknowledge immediately, sound on time.** Play, Stop and cue changes repaint
  within the next animation frame (≤ 16 ms). The ruler shows a dashed *cue* line
  at the new position at once. The solid *playhead* moves only when the heard
  time reaches T_s.
- **Asymmetric by design.** Stop needs no priming: the gates are scheduled to
  reach 0 at now + 2 quanta + 10 ms ≈ 15 ms, plus device latency. Play and seek
  need H = 85 ms. Musicians forgive a slightly late start far more readily than
  a late stop.
- **Heard position**:
  `heardCtx = ts.contextTime + (rafNow − ts.performanceTime)/1000 − limiterLatency`,
  where `ts = ctx.getOutputTimestamp()`. That value is then mapped through
  TransportMap⁻¹ (taking account of loop passes and seams) to bar·beat·tick.
  Before T_s the readout holds the cue position. The playhead is never
  extrapolated past the last seam the transport map knows about.
- **Budgets**, to be measured on the target laptop and recorded:

| Measure | Target | Gate |
| --- | --- | --- |
| UI acknowledgement of any transport command | ≤ 16 ms | automated |
| Play or seek → first sound (H + limiter + device) | ≤ 150 ms (H 85 + 5 + device ≈ 45–60) | loopback |
| Stop → silence | ≤ 40 ms + device | loopback |
| Displayed playhead vs heard transient | ≤ ±17 ms (one 60 Hz frame); in-graph ≤ ±3 ms | loopback / tap |
| Scheduler tick lateness (p99 / max) | ≤ 10 ms / ≤ 40 ms (slack = H − 64 − 1 quantum) | automated soak |

- **Warm-up.** The voice pool and worklet modules are created during `preparing`
  (8 live node creations took 2.6–12.2 ms each in probe E1), never on Play. A
  smaller `blockMs` (60 ms → horizon about 32–40 ms) is a tuning option that must
  be judged by ear, because it trades away stretch quality. It is not
  recommended without a listening test.

---

## E. Click safety by construction

### E.1 Two gain stages with different jobs

| Stage | Owner | Shape | Offline bounce |
| --- | --- | --- | --- |
| `clipGain` | ProjectState (`fadeInBeats`, `fadeOutBeats`, micro-fades 0.015 beats, clip gain) | musical, as edited | **identical** |
| `transportGate` | runtime | anti-click only: start 2.5 ms, stop 10 ms, seek seam 5 ms, loop seam 2.5 ms crossfade, all linear | absent (gate ≡ 1) |

The two multiply. A transport gate never changes an edit, and an edit never
depends on transport history. Tests can measure each stage on its own.

### E.2 Rules

1. **Start** (Play, from any position): every voice gate ramps 0→1 over 120
   frames starting at T_s. This is attenuation within the first 2.5 ms, not a
   time shift: content timing is unchanged.
2. **Stop and pause**: gates ramp to 0 over 480 frames ending at T_e. Voices are
   released after T_e + 120 ms (DSP tail) + 5 ms (limiter).
3. **Hard seek**: old voices fade to 0 over 240 frames ending at T_k. New voices,
   armed with their source position at least 64 ms earlier (§D), fade in from
   T_k. Measured in probe E3: stale material −69 dB after 10 ms, the new
   material at full level immediately, and no sample step larger than the
   content's own (0.0865 against a natural 0.0864).
4. **Loop wrap**: the outgoing and incoming occurrences overlap 60 frames on each
   side of b and a, with complementary linear gates whose sum is exactly 1 at
   every sample. This needs 60 frames of source past b and before a. Where a
   region edge coincides with the seam, the clip's own fade governs and the gate
   is 1.
5. **Split**: no transport action is needed. The split children share their
   boundary frame (Milestone B repair #2), each carries the 0.015-beat
   micro-fade, and the source is continuous across them. Playback through a
   split is two abutting occurrences, each with its own micro-fade. That makes
   the same brief, intended dip the offline bounce has, and the transport adds
   nothing at that point.
6. **Clip moved, trimmed or re-stretched while playing**: PlanDiff marks the
   clip. If none of its occurrences is sounding or inside the horizon, its future
   is simply rescheduled. If one is, the change is applied as an *edit seam* at
   T_c = now + H: the old voice fades out over 240 frames and a new pre-rolled
   voice with the new geometry fades in, exactly like a seek but for that clip
   only. Clip gain alone is an AudioParam ramp with no voice swap.
7. **Mute, solo, track volume, pan and EQ**: `cancelAndHoldAtTime(now)` followed
   by a linear ramp over 480 frames (10 ms) that starts at the next quantum.
   Nothing ever writes `.value` while the graph is running.
   `offline-render.js:97–119` sets `.value` only at build time, which is
   correct offline but must not be reused for live updates.
8. **Frame 0**: a clip at timeline frame 0 played from frame 0 gets its own
   micro-fade, multiplied by the 2.5 ms start gate. The first output sample is
   exactly 0. The tests assert this explicitly, rather than relying on BDI,
   which cannot score frame 0 (`click-guard.js:88` throws for `boundary < 1`).
9. **Non-finite samples** are invalid output (§C), never a "passed" measurement.

### E.3 Tests that do not depend on BDI

| Test | Oracle | Fixtures |
| --- | --- | --- |
| Gate arithmetic (Node) | For every seam type: gate values exactly 0 or 1 at the ends, per-sample step ≤ 1/ramp, complementary pairs sum to 1 ± 1e-9 | pure functions |
| Envelope probe (browser) | A constant 1.0 source through a voice outputs exactly clipGain × transportGate; compare with the expected envelope ≤ 1e-6 | DC source |
| Exact continuity (bypass) | Output equals Σ source[n − offset] × envelope, computed independently; tolerance 1e-6. Any unintended discontinuity fails | index-encoded source (§G) |
| Silence stays silent | Seams between silent regions: max abs ≤ 1e-7 | silence |
| Spectral splatter (stretched and bypass) | Energy above 6 kHz in a 10 ms window across the seam ≤ +6 dB over a steady window of the same content | sine 440 at phases 0°/90°/180°/270° and at a peak, beating pad 220 + 221.5 Hz, noise percussion, silence→tone, silence→noise |
| Stale content | After a seek or wrap from tone A to tone B, A is ≤ −40 dB within 10 ms of the seam | probe E3 pattern |
| Finite output | Every captured sample `Number.isFinite`; the limiter's non-finite counter is 0 | all |
| BDI (supplementary) | Reported for every seam, never gating; first fixed to fail on non-finite input and to report frame-0 seams as "unscorable" | all |
| Listening | PM: start and stop on a sustained pad; a 1-bar vocal loop for 2 minutes; 20 seeks on drums; mute toggles on bass; solo sweeps | demo arrangement |

Negative controls (each must fail): no transport gate; loop wrap by single-voice
time-map jump (E3: −6 dB stale at 0 ms, −33 dB at 30 ms); a `.value` mute step; a
NaN injected into one voice (the old BDI passes it, the new finite check fails it).

---

## F. Professional UX proposal

Concept: `arrangement-concept.png` (static, 1440 px wide, Black Tie tokens;
the waveforms are synthetic placeholders).

### F.1 Hierarchy

| Layer | Where it lives | Who it serves |
| --- | --- | --- |
| **Performance** | The accepted desk: two banks, Load A/B, crossfader, channel strips. Unchanged and still the default | Mashup makers trying two songs together |
| **Arrangement** | Second mode of the same Studio (a Performance / Arrangement switch in the header), with the same transport bar. Eight lanes in two banks: copper A (tracks 1–4) and aqua B (tracks 5–8) | Building the song over time |
| **Clip editing** | Directly on the lanes (move, trim handles, split at playhead) plus the **Inspector** in the right column when a clip is selected | Precise shaping |
| **Mixing** | Lane headers carry Mute, Solo and a peak meter only. The full faders, EQ and crossfader stay on the Performance desk, so the controls are not duplicated | Balance |
| **AI Producer** | Right column below the Inspector. Proposals draw on the lanes as dashed, gold, unfilled clips labelled "Proposed" (`--color-ghost`); committed clips are always solid | Assistance, never authority |

**Approachable and precise at once.** Choices are musical by default: bars and
beats, snap on and adapting to zoom, gain in dB, fades in beats. Precision is
always one step away and never in the way: an "Exact values" disclosure shows
frames, source seconds and stretch rate; a modifier key disables snap; and
there are keyboard nudges by snap unit and by tick. The entry path for a
mashup maker is **Send to arrangement** from the Performance desk. It
translates the two loaded groups into eight lanes, one clip per stem at bar 1
(Milestone A §9). Each stem keeps its provenance label, and beat sync is
offered only where a tempo was measured.

### F.2 Rules carried from Black Tie

- Bank identity is in labels ("TRACK 5 · B", "B Vocals"), not only in colour.
- Focus uses `--color-focus`. All targets are at least 44 × 44 CSS px; trim handles
  are 6 px visually with a 44 px hit zone.
- Only one engine plays at a time. Switching modes stops the other engine,
  and each keeps its own `AudioContext` (the AGENTS rule of one context per
  mounted panel).
- Never claim beat matching. The transport bar keeps the sentence "Tracks
  start on one clock…".
- Producer: Preview or Audition shows the proposal; only Approve applies it,
  through `applyProposal(..., {approved: true})`; playback stays a separate user
  action.
- The Visitor candidate's proposal marks and section timeline stay separate.
  If they are accepted later, the ghost-clip styling should share their tokens.

### F.3 Waveforms, meters, playhead: rendering budget

- Peaks are computed once per asset hash in a Worker from the PCM already
  decoded. Min/max pairs are stored as Int8 at 256, 1,024, 4,096 and 16,384
  frames per bucket, about 0.3% of the float PCM size for all four levels. They are drawn per lane on a
  canvas and redrawn only on zoom or scroll.
- The playhead is a separate layer moved by `transform: translateX`, with no
  layout per frame and no allocation in the animation-frame loop.
- Peak meters come from one `AnalyserNode` per track (8), read at 30 Hz into
  preallocated arrays, showing peak hold and a clip indicator. They report
  sample peak, not true peak, consistent with the limiter's claim.

### F.4 Keyboard and touch

| Key | Action |
| --- | --- |
| Space | Play or stop (stop returns to the cue) |
| K | Pause (park at the heard position) |
| Home / End | Cue to start / end |
| ← → | Move the cue by a bar; with Shift, by a beat |
| L | Loop on or off (loop = selection, or the current 4 bars) |
| Tab / arrows inside lanes | Roving focus between clips; ↑↓ changes lane |
| Alt + ← → | Nudge the selected clip by one snap unit; with Shift, by one tick |
| S | Split the selected clip at the playhead |
| [ / ] | Trim the start or end to the playhead |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (history from Milestone A) |

Position is announced through a polite live region on stop, seek and selection
("Bar 9, beat 1"), never continuously. On touch, tap selects, a press held for
150 ms then dragged moves the clip, the handles trim, and pinch zooms. At 390 px
the lanes become a scroll view with the inspector as a bottom sheet. Precise
dragging stays a desktop task, and numeric steppers cover it on phones.

### F.5 The first interaction to build: "locate and listen"

Before any editing gesture, build **ruler click (or Home, arrows, Space) → hear
it from there, with a playhead you can trust**, over eight read-only lanes with
real cached waveforms. Every later edit is judged by ear against this playhead.
If it lies, nothing else can be trusted.

Test: a 120 BPM arrangement with a single-sample impulse at every bar on track 1
and a sustained pad on track 5.

1. Keyboard only, cue to bar 5 and Play. The first impulse is heard at bar 5
   within the latency budget, and the displayed playhead crosses bar 5 within
   ±17 ms of the loopback-captured impulse.
2. Repeat from 20 seeded positions, including inside a clip, on a clip edge and
   at frame 0.
3. A screen reader announces "Bar 5, beat 1" on the cue.
4. Run the same at 390 × 844 with touch emulation.
5. The PM listens and confirms that the pad does not click at Play, Stop or seek.

Then build split at the playhead (S) as the first edit.

**Missing API**: `edit-api.js` has no delete or remove-clip operation (it offers
load/move/trim/split/stretch/pitch/gain/fades/track/transport only). The
arrangement editor needs one, with undo, before Milestone D's editing UI.

---

## G. Smallest executable Milestone C slice — "C1 Transport Core"

**In scope**: `transport.js` (state machine and TransportMap, pure),
`voice-scheduler.js` (pure occurrence planning), `realtime-engine.js` (voice pool,
gates, feeder, ramped mute/solo/volume), a non-finite guard in
`limiter-worklet.js`, a BDI repair (non-finite → flagged; frame 0 → "unscorable"),
a harness page and driver. **Out of scope**: any Black Tie UI change, clip edits
while playing (C2), offline-via-scheduler (D), long-recording streaming beyond
the accepted per-stem budget (D).

**Fixtures** (all synthesised in-page; no production media; outputs JSON only,
under `~/.local/state`, not `/tmp`):

- *Index-encoded source*: L[n] = (n mod 4096)/4096 and R[n] = ⌊n/4096⌋/4096.
  The source frame playing at any output sample decodes exactly from the pair.
  This is the exact source-offset oracle for bypass voices.
- An impulse click track (one sample at 1.0 per beat); sine 440 at four phases;
  a beating pad 220 + 221.5 Hz; noise percussion; silence; and the existing
  8-track `tests/browser/daw/arrangement-script.js`.

**Tests and tolerances**

| ID | Proves | Method | Accept |
| --- | --- | --- | --- |
| T1 | State machine | Node, fake clock: every row of §C, plus no-op rows, supersession and epoch increments | all pass |
| T2 | Clock arithmetic | TransportMap round trips; 10,000 loop passes | exact integer equality |
| T3 | Seek source offsets | 200 seeded beats (inside, on edges, at 0, past the end) × rates {1, 0.857, 1.2, 2}, compared with an independent formula checker (no engine imports) | exact frames; **negative control** (timeline rate) fails |
| T4 | Gate arithmetic | §E.3 row 1 | exact |
| B1 | Start and stop accuracy | Offline (suspend-driven ticks) and live with the in-graph tap: impulse positions | bypass 0 frames; stretched onset ≤ 128 frames; first sample after a frame-0 start = 0 |
| B2 | Stop is silence | Captured after T_e + 125 ms | max abs ≤ 1e-7; no voices active |
| B3 | Seek correctness | Index-encoded bypass: 50 seeks, decode the source frame after the gate opens | exact |
| B4 | Loop repeatability | 2-bar loop × 20 passes | bypass: every pass ≤ 1e-6 of pass 1 (offline: identical); stretched: pass-to-pass 10 ms env corr ≥ 0.99, seam onsets ±128 frames; seam gates sum to 1 |
| B5 | Click safety matrix | §E.3 rows 2–8 across start, stop, seek, loop, mute and solo | all pass; the 4 negative controls fail |
| B6 | Playhead alignment | Live: `heardPosition()` against tap-derived position, sampled on animation frames for 30 s | in-graph ≤ ±3 ms; heard position never ahead of the tap |
| B7 | Endurance and underruns | Live, 10 min of loop playback with 8 stretched voices: tick-lateness histogram, pool high-water mark, heap after GC; loopback: `pw-record` of the sink monitor with a −40 dBFS pilot tone checked for phase discontinuities | 0 deadline misses; pool ≤ 24; heap growth ≤ 5 MB; 0 pilot discontinuities. If the loopback is unavailable: **INCONCLUSIVE**, never PASS |
| B8 | Live vs offline (characterisation) | Same plan, tap capture, alignment by sub-sample cross-correlation on the impulse track | bypass ≤ 1e-6; stretched per §D.2. Report the GATE 5 re-measurement |

**Instrumentation**: scheduler tick lateness, voice-pool occupancy,
deadline-miss counter, limiter non-finite counter, and the
`getOutputTimestamp` mapping log. Everything is exposed through
`engine.diagnostics()` and summarised in the evidence document.

**Static assets**: estimated at +20–30 KB of readable modules. Record the total,
the file count and the delta per policy.

**Exit evidence**: green T and B tables, the four negative controls detected, the
probe-style numbers re-measured on the target machine, an evidence document,
an independent review, and **the PM's listening on the demo arrangement**.

---

## H. Risks and blockers (ranked)

| # | Severity | Finding | Evidence | Type |
| --- | --- | --- | --- | --- |
| 1 | **Blocker (designed out)** | The node keeps one pending time-map change; queued events are silently dropped | `SignalsmithStretch.mjs:91–94`; reproduced while building the probe (queued segments vanished) | Architecture: voice-per-occurrence (§A) |
| 2 | **Blocker (designed out)** | A single-voice seek or wrap leaves ~40 ms of stale audio | E3: A at −6 dB at the seam, −33 dB at 30 ms, < −40 dB only at 40 ms | Architecture: two-voice seams (§E) |
| 3 | **Blocker (designed out)** | Starts scheduled < 64 ms ahead are under-primed (−21 dB at 21 ms); cold activation leaks ~53 ms early | E7, E2 | Horizon H = 85 ms, gate held at 0 before the edge |
| 4 | **High** | The click gate passes NaN and Infinity; frame 0 cannot be scored | `click-guard.js:88`; reproduced: `gateBoundaries` → `passed: true` | Fix in C1; never an acceptance oracle |
| 5 | **High** | Underrun telemetry unavailable | `ctx.renderCapacity` undefined (E1) | Loopback rig (B7); claims stay INCONCLUSIVE until measured |
| 6 | **High (documentation)** | Milestone B §5 reports a 250 ms DSP delay that is the harness's own 0.25 s start offset; the 0.84 / 0.43 correlations come from a 1 ms-step alignment | `offline-render.js:252`, `bounce.js:151,717` | Correct the record; re-measure with B8 |
| 7 | Medium | No real-time mixer updates exist; build-time `.value` writes would click if reused live | `offline-render.js:97–119` | C1 ramps |
| 8 | Medium | Memory: per-clip slice copies duplicate PCM across split children, and every node receives its whole slice at once | `offline-render.js:141–147` | Shared asset store + 1 s feeder windows: ≤ 24 voices × ~2 MB |
| 9 | Medium | `MAX_CLIPS_PER_GRAPH = 32` limits offline export by clip count | `offline-render.js:23` | Milestone D: offline through the scheduler with suspend ticks |
| 10 | Medium | ProjectState carries `playheadBeat` and `isPlaying`; per-frame writes would clone and validate the project | `project-state.js:83–89` | Parked position only |
| 11 | Medium (UX) | No delete-clip edit; loop/seek-outside-loop convention undecided | `edit-api.js` operation list | API addition before Milestone D; PM choice |
| 12 | Low | Test capture allocates and posts every quantum; the limiter allocates when its input is missing | `capture-worklet.js:17,22`, `limiter-worklet.js:117` | Test-only; preallocate |
| 13 | Low | `startRealtime` reads `ctx.currentTime` before awaiting module loads | `offline-render.js:258` | Superseded by the transport |
| 14 | Low | Long recordings beyond the accepted 40 MiB/stem decoded budget | AGENTS.md budgets | Milestone D: windowed decode (the server already cuts sections) |

**Can wait for Milestone D**: the first-party WASM processor with a render-thread
event queue, offline export through the scheduler, a render-ahead "freeze",
long-recording streaming, a smaller `blockMs`, true-peak metering, and the full
editing UI.

---

## I. Final recommendation

**CONDITIONAL GO** for Milestone C, starting with the C1 Transport Core slice.

Conditions:

1. Adopt voice-per-occurrence with two-voice seams and H = 85 ms. Do not build
   the transport by rescheduling one node per clip.
2. Correct the Milestone B §5 latency record, and re-measure live/offline
   agreement with sub-sample alignment (B8) before any parity statement.
3. No glitch-free claim until the loopback rig (B7) runs on the target laptop,
   and no audible acceptance until the PM has listened.

### Exact first engineering assignment

> **OPERATION — C1 TRANSPORT CORE.** On `feature/all-the-time` (from `462dba9`),
> in a new local branch, implement `js/arrangement/transport.js`,
> `voice-scheduler.js` and `realtime-engine.js` as specified in
> `docs/golden-ear/milestone-c-transport-and-ux.md` §A–§E. Add a non-finite
> guard and counter to `limiter-worklet.js`, and make `click-guard.js` flag
> non-finite input and report frame-0 boundaries as unscorable. Deliver tests
> T1–T4 (Node) and B1–B8 (headless Chromium plus a PipeWire loopback driver),
> with the four negative controls, using only synthesised fixtures. Keep outputs
> under `~/.local/state` and check `df -h /tmp /home` before each run. No Black
> Tie UI changes, no clip edits during playback, no new dependencies, no push,
> no merge. Exit with the evidence document, static-asset totals, an independent
> review of the final HEAD and a PM listening checklist.

## Appendix — probe record

Disposable, headless Chromium (`/usr/bin/chromium`), 48 kHz, vendored
Signalsmith 1.4.0, run on 2026-11-20. The raw numbers are in
`probe/probe-results.json`.

| ID | Question | Result |
| --- | --- | --- |
| E1 | Latency per configuration; construction cost; browser telemetry | 120 / 140 / 80 / 60 / 40 ms; live construction 2.6–12.2 ms per node; `baseLatency` 10.7 ms, `outputLatency` 32–40 ms; `renderCapacity` undefined; `getOutputTimestamp` present |
| E2 | Cold vs warm activation (500 ms horizon) | Cold leaks content from ~53 ms before T; within ~2 dB of warm in the first 5 ms |
| E3 | Seek and wrap stale content | Single voice: A −6 dB at 0 ms → −52 dB at 40 ms, B within 1 dB at 20 ms. Two voices with a 5 ms crossfade: A −38 dB in the first 10 ms window, −69 dB after; B within 0.1 dB at once; max step = the content's own |
| E4 | Start-phase dependence | See §D.2; same-start re-renders are bit-identical |
| E5 | CPU of idle vs active voices | 10 s offline: none 3 ms, 8 idle 102 ms, 8 active 1,495 ms (load 0.15) |
| E6 | Rate-0 "armed" voice as a fast start | Not a substitute: percussion −10 dB for 10 ms, recovering at 40 ms |
| E7 | Horizon sweep | 21 ms: −21 dB; 43 ms: −5 dB; 64 ms and above: ±0.8 dB from the first 5 ms |

Probe caveats: these were offline renders. The suspend-based scheduling stands
in for live message timing, and the live device path was not measured: the
headless output is not the laptop's speakers. CPU figures come from one
headless run on this machine.

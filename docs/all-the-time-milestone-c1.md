# OPERATION CLOCKWORK — Milestone C1: Real-Time Transport Core

Branch: `feature/all-the-time` (isolated local engineering). Starting HEAD
`462dba92720b3d1a1a33b8b6dab10ca68a84d094`. This document is the C1 evidence
receipt and the PM listening checklist. Design input: `design/golden-ear @
aef4b9d` (`docs/golden-ear/milestone-c-transport-and-ux.md`, Claude Opus 5.5) and
the independent C1 acceptance targets and gate constraints that stand in for
Grok's architectural challenge (no standalone challenge document exists in the
tree — recorded honestly in §1).

The eight-track ProjectState can be played, stopped, sought and looped over a
**bounded real-time AudioWorklet engine** (`js/realtime-engine.js`) that composes
five pure, independently-tested modules over the shared Milestone B downstream.
Timeline state and rendering stay separate; ProjectState stays the musical
authority; no wall-clock timer schedules audible events.

---

## 0. Gate 0 — resource preflight

| Fact | Value |
| --- | --- |
| `/` free at start | 8.3 GiB (95 % used) |
| `/tmp` tmpfs free at start | **461 MiB (94 % used)** — matches the brief's warning |
| `/tmp` consumer | `pytest-of-richardn` scratch, 5.3 GiB — **not deleted** (no owner authorisation; flagged to the owner) |
| Bounded output dir | `~/.local/state/clockwork` (NOT `/tmp`) |
| Fixtures | all synthesised in-page / in-Node; no production media |
| Temp policy | browser artifacts → `~/.local/state/clockwork`; pytest scratch bounded with `--basetemp` if run |

Disk consumption is reported after the runs. No cache or prior evidence was
deleted. The 5.3 GiB of retained pytest scratch is the reason `/tmp` is near
full; it is preserved pending owner decision (it can masquerade as mass Python
failures when `/tmp` fills — see the housekeeping notes).

---

## 1. Scope, inputs and one honest gap

**In scope (C1):** `transport.js` (state machine + TransportMap),
`voice-scheduler.js` (occurrence planning + source math + the Signalsmith
scheduling rule), `gate-envelope.js` (transport anti-click arithmetic),
`voice-pool.js` (bounded pool), `realtime-engine.js` (the live composition), a
non-finite guard in `limiter-worklet.js`, the `click-guard.js` repair, a shared
bypass predicate in `time-math.js`, and a headless proof harness.

**Out of scope:** any Black Tie / arrangement-UI change, clip edits while
playing, offline-through-the-scheduler, long-recording streaming, AI Producer.
The Performance Desk, Black Tie interface, Library, original media and accepted
offline rendering are intact (§10 regression + a bounce re-run after the shared
backbone refactor).

**Design inputs read:**
- Claude's Milestone C design (`docs/golden-ear/milestone-c-transport-and-ux.md`)
  in full: voice-per-occurrence ADR, two-voice seams, H = 85 ms, the E7 priming
  experiment, the click-safety-by-construction section (§E), and the C1 slice.
- The Signalsmith vendored wrapper's verified one-pending-change scheduling rule
  (`SignalsmithStretch.mjs:91–94`), confirmed by direct reading.

**Honest gap:** the brief says to read "Grok's independent architectural
challenge" as a separate document. No such document exists in the repository or
any worktree (searched). Its operative content is fully present in the brief's
own Gate 8 "C1 targets" and the gate constraints, which directly challenge
Claude's design decisions ("do not hard-code 85 ms", "do not assume 24 voices is
sufficient", "the BDI detector remains diagnostic only", "do not claim waveform
equality for stretched audio"). I treat those as the authoritative expression of
the challenge and have engineered against them. This is recorded rather than
glossed.

---

## 2. Gate 1 — pure transport state machine (`transport.js`)

A pure reducer `transportReduce(state, event) -> {state, effects}` with an
explicit transition table (`LEGAL_TRANSITIONS`), epoch/generation identifiers,
and no AudioContext, DOM, or wall-clock dependency (proved deterministic under a
fake clock — T1).

**Commands:** `play`, `stop`, `pause`, `resume`, `seek`, `setLoop`, `prepare`,
plus internal `ready` / `started` / `seekDone` / `stopped` / `arrangementEnd` /
`deadlineMiss` / `contextSuspended` / `fail` / `capacityError`.

**Owner UX (recorded):** Space toggles Play/**Stop**, and Stop **returns to the
cue** (`stop` parks at `cueFrame`, the last Play/seek origin). **Pause is a
distinct command** (`pause` parks at the supplied heard frame).

**State model:** `unprepared → preparing → stopped → starting → playing ⇄
seeking`, with `stopping → stopped`, and `failed` (terminal until re-`prepare`).
Anything not in the table is a `noop` that returns the current state.

**Generation/epoch (Gate 1):** state-changing commands bump `generation`
(`prepare`/`ready`/`play`/`stop`/`pause`/`seek`/`setLoop`/`fail`); internal
completions (`started`/`seekDone`/`stopped`) do not;
every audio start/retarget bumps `epoch`. Async work, voice orders and feeder
fills carry `(epoch, generation)` and stale ones are discarded. **Play during a
stop fade is legal and supersedes the pending stop**: it cancels the fade
(`supersededStop: true`) and begins a new playback epoch (T1 test).

**Reconciliation contract (isPlaying / parked playhead):**
- `ProjectState` is the ONLY musical authority. The engine never mutates it; the
  reducer emits a single `writeParked {frame}` effect and `realtime-engine.js`
  forwards it via `onParked` so the host writes the parked position **only** on
  Stop, Pause, or a seek-while-stopped — never per frame.
- `state.isPlaying` is a **logical belief**, and `state.parkedFrame` is a
  **static bookkeeping value**. Neither is an audio clock and neither is advanced
  by a timer to produce audible events. The only moving clock is
  `ctxFrame → TransportMap → transportFrame`, computed from integer frames on the
  device clock. (Pinned by the T1 determinism test: the reducer is a pure
  function of commands.)

**No wall-clock timer schedules audibility:** `realtime-engine.js`'s
`setTimeout` wake only calls the scheduler to fill the look-ahead window; every
audible event is a context-time value computed from integer frames and applied as
sample-accurate gain automation.

**Playback from frame zero and beyond the end** are legal positions (T1 + T2).

**TransportMap (`createTransportMap`)** — exact integer clock arithmetic with
loop unrolling. Loop semantics: playback wraps ONLY at the loop end `b → a`, only
while `startFrame < b`; the three entry cases (before / inside / past the loop)
are defined and tested. **10,000 loop passes round-trip exactly with no drift**
(Gate 8 T2). Frame-zero and past-the-end positions are representable.

---

## 3. Gate 2 — qualified scheduling horizon

**Measured, not hard-coded.** The horizon is derived as
`priming requirement + scheduler wake interval + jitter allowance`, from
a faithful re-run of the Signalsmith **E7 priming experiment** extended to source
advance rates **0.857 / 1.0 / 1.2**, tonal and transient fixtures, multiple
timing offsets and processing presets.

Mechanism (faithful to golden-ear E7): a Signalsmith voice is **activated**
(`schedule()` called) only `horizon` before its output reaches the playhead at
T, via an `OfflineAudioContext.suspend()` hook that stands in for late
main-thread scheduling. The source position at T is held fixed across the sweep
so only the priming differs. The E7 under-priming is a live-scheduling phenomenon
reproduced here with the same suspend technique the original probe used.

Headless scheduling measurements are kept **separate from real speaker latency**
(§9): these numbers describe the DSP's priming behaviour under scheduling lead
time, not what the speakers do.

**Measured (final bounded run, 2026-11-20).** First-5 ms level of a start
activated only `H` ms before the playhead, relative to a fully-primed warm
reference (0 dB). Tonal **and** transient (sustained percussion) fixtures, rates
0.857 / 1.0 / 1.2, two timing offsets (0, 37 frames). Representative sweep (dB
vs warm):

| activation lead H | 21 ms | 32 ms | 43 ms | 64 ms | 85 ms |
| --- | --- | --- | --- | --- | --- |
| tonal (all rates/offsets) | −23 … −25 | −11 … −13 | −5.8 … −7.0 | **−0.5 … −1.0** | −0.3 … +0.4 |
| transient (all rates/offsets) | −22 … −26 | −10 … −14 | −4.5 … −5.8 | **+0.5 … +1.4** | +1.2 … +2.2 |

This is a faithful reproduction of golden-ear E7 (21 ms −21 dB → 64 ms +/−0.8 dB):
the under-priming floor is the DSP's ≈64 ms analysis latency, essentially
independent of rate and fixture. At 21 ms both fixtures are ≈ −24 dB (heavily
under-primed); by **64 ms** both reach steady (~0 dB); 85 ms is fully settled.

- **Measured priming requirement ≈ 64 ms** (both fixtures reach within ~1 dB of
  steady by 64 ms).
- Scheduler wake interval = **25 ms** (only wakes the scheduler); jitter
  allowance = **15 ms** (a design allowance, **not** a measured value — see
  limitation 5 below).
- **Selected scheduling horizon = 64 + 25 + 15 = 104 ms** (derived from the
  measured floor + scheduling costs; **not** hard-coded to 85 ms). This is more
  conservative than golden-ear's 85 ms (which was floor + 21 ms slack). If the
  tighter ±0.8 dB tonal bound across every rate/offset is required instead of the
  ~1 dB floor, use 85 ms priming → **125 ms** horizon.

**Recorded failures / limitations (Gate 2):**
1. The strict auto-derivation "first H where EVERY cell is within ±0.8 dB" returns
   **null**. Cause: the stochastic transient (percussion) fixture's first-5 ms RMS
   jitters ±1–2 dB *between separate warm/cold renders* at 64–85 ms (it reads
   +0.5 … +2.2 dB even fully primed), so ±0.8 dB is not meaningful on that
   material. This is a **tolerance-vs-stochastic-RMS artifact, not an unresolved
   priming floor** — the floor is clearly ≈64 ms (both fixtures steady by then).
   The horizon is therefore **selected** from the measured floor rather than the
   strict auto-derivation.
2. **Two renders timed out** at the 15 s cap (rate 1.2, transient, offset 37,
   horizons 64 & 85) — those 2 of 60 sweep cells are missing. The other 58
   completed.
3. Preset-sensitivity (default / cheaper / blockMs 60) was **not captured** (the
   loop is gated on the null auto-derivation). The floor is expected to scale with
   preset latency (E1: 40–140 ms); left for the live qualification.
4. The dedicated **16 ms sub-floor negative-control cell errored** (its render did
   not complete). Under-priming is nonetheless demonstrated by the sweep itself
   (21 ms reads ≈ −24 dB on both fixtures).
5. The **15 ms jitter allowance is a design constant, not a measured value**
   (review finding 5). No scheduler-jitter measurement was taken (headless
   scheduling jitter is not the live main-thread jitter). The horizon is therefore
   a **chosen** engineering constant informed by the measured 64 ms priming floor,
   not a purely measured quantity.

Raw per-rate/per-fixture/per-offset cells:
`~/.local/state/clockwork/clockwork-results.json → measurements.priming`.

---

## 4. Gate 3 — correct Signalsmith occurrence scheduling

Verified rule (read directly from `SignalsmithStretch.mjs:91–94`): a `schedule()`
call pops every segment at-or-after the anchor before pushing, so **a second
future call discards a pending future arm**.

**Legal sequence per voice** (`signalsmithScheduleSequence`): **arm at or before
the current processing time** with a correctly compensated source position
(extrapolated backward by rate), **followed by at most one future stop**. Because
`arm.output ≤ now < stop.output`, the stop's pop cannot reach the arm.

Proved against a model of the pop CONDITION (`SignalsmithTimeMapModel`). It
mirrors the pop rule exactly (so the pass/fail outcomes below are sound) though
it extrapolates a pushed segment's `input` from the surviving, not the
last-popped, segment (review finding 7 — recorded, not glossed):
- **Two future calls lose the pending arm** — pinned as a test (the hazard).
- **The legal arm-then-one-stop sequence preserves the arm** — pinned as a test.
- The emitted sequence has the required `arm.output ≤ now < stop.output` shape.

Pre-roll, clip source boundaries and DSP latency are handled by exact source-frame
selection (§6) and the two-voice seam model (§5); future cancellation is the
epoch rule (§2). **No silent event loss** under the legal sequence.

---

## 5. Gate 5 — click-safe playback transitions (`gate-envelope.js`)

Explicit, **sample-accurate transport envelopes** as pure arithmetic, kept
**distinct from musical clip fades** (the two multiply: `transportGate *
clipGain`). Verified exactly without audio (Gate 8 T4): for every seam type the
gate is exactly 0 or 1 at its ends, its per-sample step never exceeds `1/ramp`,
and every complementary (crossfade) pair sums to exactly **1 ± 1e-9**.

| Seam | Shape | Frames (48 kHz) |
| --- | --- | --- |
| Play / start | 0→1, first sample **exactly 0** | 120 (2.5 ms) |
| Stop / pause | 1→0 ending at T_e | 480 (10 ms) |
| Seek / voice handover | complementary in/out crossfade | 240 (5 ms) |
| Loop wrap | complementary crossfade **centred on the seam** | 120 (2.5 ms) |

A transport gate **attenuates but never time-shifts** (T4: the ramped region
peaks at the ramp's end; content sample index is unchanged). The **BDI detector
is diagnostic only** — a BDI pass is never treated as proof of inaudible,
click-free playback. Independent signal-continuity and transition tests (the DC
envelope probe `output == clipGain × transportGate` to ≤ 1e-6, complementary
unity, silence-stays-silent, spectral splatter) carry that burden (§8 B5).

**Transport ramps vs an intentional clip attack (Gate 5 question):** the start
gate's first 2.5 ms is a 0→1 attenuation, so it softens the very first transient
of a clip by at most a 2.5 ms gain ramp (the content is never time-shifted —
measured: stretched onset 10 frames, bypass onset 0 frames). Numerically the
attack is preserved; whether the ≤ 2.5 ms softening is audible on a deliberate
attack is an audition question for the PM (§12). No audible claim is made here.

---

## 6. Gate 6 — shared bypass decision

**One pure predicate** `clipNeedsDsp(rate, pitchSemitones)` in `time-math.js`:
a clip needs the Signalsmith stretch/pitch DSP **iff** its source-advance rate is
not exactly 1 **or** its pitch is not exactly 0 semitones. A rate-1, 0-st clip
bypasses via a sample-exact `AudioBufferSourceNode` (no algorithmic latency, no
priming).

**Same predicate and semantics in real-time playback and offline bounce:** both
route voice construction through the same `buildClipVoice`, which consults the
same `clipNeedsDsp`. The shared **downstream** (EQ → volume/pan/mute-solo →
master → limiter) is one `buildBackbone` used by both hosts, so gain, EQ, pan,
summing and the limiter contracts are identical (Gate 6 requirement).

**Zero-stretch, zero-pitch fixture:** bypass output equals
`source[n − offset] × envelope` computed independently, to **≤ 1e-6** (Gate 8
"bypass path sample error ≤ 1e-6"; §8 G6). This is timing + sample accuracy for
the bypass path.

**No waveform-equality claim for stretched audio.** Stretched clips are judged by
onset timing (≤ 128 frames) and envelope/level tolerances (10 ms envelope
correlation ≥ 0.99, level ± 0.5 dB per 100 ms), never by sample equality — the
phase vocoder's analysis grid is anchored to processor state, not content
(golden-ear §D.2). This is stated as a claim boundary, not a defect.

**Offline-compatibility decision (recorded honestly):** the accepted Milestone B
offline bounce keeps its all-stretch path (`dspBypass:false`) so the audited
artifact and its 15 checks are byte-compliant; the live engine uses
`dspBypass:true` to exploit the predicate. The **predicate and its semantics are
shared and identical** in both; only the rendering choice of whether to *exploit*
bypass is a flag, and the zero-stretch parity fixture compares the bypass path
against an independent `source×envelope` oracle (it does NOT compare bypass vs
stretch output at rate 1 — those deliberately differ, since bypass is
sample-exact and stretch is not). The predicate and its semantics are shared, and
the oracle check confirms the bypass path is exact
(≤ 1e-6) when the flag matches. This keeps "accepted offline intact" and "same
predicate in both" simultaneously true.

---

## 7. Gate 7 — non-finite output safety

**Bounded guard on the output path** (`limiter-worklet.js`): every sample is
checked `Number.isFinite` on the way through the limiter (the single output
stage). A NaN/±Infinity is **replaced with 0 before it can reach the output or
poison the gain computer**, counted, and the first index recorded
(`stats.nonFiniteCount`, `stats.firstNonFiniteIndex`). The guard is O(1) per
sample (bounded).

**Defined safe transport failure state:** `realtime-engine.js` polls the limiter
stats and, on the first non-finite fault, drives the transport reducer to
`fail({code:'NON_FINITE'})` — a terminal `failed` phase until re-`prepare`.
**ProjectState and source assets are preserved** (the engine never mutates them).

**The click diagnostic cannot convert invalid audio into an implicit PASS**
(`click-guard.js` repair):
- **Non-finite input → FLAGGED** (`index = Infinity`, `nonFinite: true`). It can
  never read as a pass. `boundaryGate` reports `finite: false` and fails.
- **Frame-0 / no-context boundaries → `unscorable`** (reported with a reason),
  **not** silently passed and **not** thrown. `boundaryGate` lists them in
  `unscorable`. BDI remains diagnostic only.

Pinned by tests (§8 G7 + the `click-guard` suite).

---

## 8. Gate 4 — bounded voice pool (`voice-pool.js`)

One voice per active clip **occurrence**; **two-voice handovers** at seeks and
loop boundaries; DSP tail generations; allocated/released resource accounting;
peak concurrent voice count; byte accounting. **Capacity is derived from
qualified concurrency and the existing graph limit, not assumed to be 24.**

`deriveVoiceCapacity(trackCount, maxOverlappingPerTrack, seamPartners, tailReserve,
graphLimit=MAX_CLIPS_PER_GRAPH=32)` → for the 8-track geometry: sounding
`8×2 = 16` + seam partners `2` + tail reserve `4` = **22 required**, `fits` under
the 32 graph limit. A harsher scenario (3 overlaps, 8 seams, 8 tails = 40) is
reported `fits: false` and clamped to the qualified instance budget — honest, not
silently raised.

**Insufficient capacity behaviour (Gate 4, all four):**
1. **Refuse the new transport epoch** (`acquire` returns `POOL_EXHAUSTED`;
   `PoolExhaustedError` with an explicit, testable code).
2. **Preserve the current audible arrangement** — no sounding voice is touched.
3. **Explicit, testable capacity error** surfaced via `capacityError` effect →
   `onCapacityError` (and `transportReduce` leaves state untouched).
4. **Never steal or silently drop an audible clip** — `stolen` is pinned to 0 by
   test; only stale-epoch / expired-tail voices are reclaimed.

Tracked and reported through `pool.stats()`: `sounding / pending / tail / live`,
`peakConcurrent`, `allocatedTotal / releasedTotal`, `allocatedBytes /
peakAllocatedBytes`, `refusals`, `stolen`. Repeated seeks, double overlaps, short
loops and pending-tail accumulation are covered by the lifecycle tests.

---

## 9. Gate 9 — real laptop audio qualification

**Status: INCONCLUSIVE — preserved as an acceptance condition.**

Preconditions are present but the qualification is deliberately not claimed:
- PipeWire **is** active and a monitor source exists
  (`alsa_output.pci-0000_35_00.6.HiFi__Headphones__sink.monitor`), and
  `pw-record` / `pw-cat` / `pw-cli` are installed. The bounded loopback toolchain
  is therefore **available**.
- However, measuring **play-to-speaker / stop-to-speaker latency, seek response,
  loop discontinuity and pilot-tone phase integrity** requires audible playback
  through the owner's real device and a joint audition. The brief reserves
  audible acceptance for the PM and forbids unapproved audio-device changes; a
  headless measurement must **not** be inferred into a speaker-latency or
  glitch-free claim.

**Preserved acceptance condition (to run with the owner/PM):** play a −40 dBFS
pilot-toned arrangement through the live engine and `pw-record --target
<...Headphones__sink.monitor>` the monitor; measure play/stop-to-speaker latency,
seek response, loop seam behaviour and pilot phase continuity. **No glitch-free
claim is made.** Underrun telemetry is unavailable in this Chromium
(`renderCapacity` is undefined), so B7 endurance/underrun is likewise
**INCONCLUSIVE**.

---

## 10. Static assets and regression

**Static assets** (policy: record total, file count, largest files and delta):

| Measure | Value |
| --- | --- |
| Total uncompressed under `studio_static` | **1,053,189 bytes / 90 files** |
| Prior baseline (Milestone B) | 987,135 bytes / 85 files |
| Delta | **+66,054 bytes / +5 files (+6.7 %)** |

Growth is the C1 transport modules (readable, not minified): `transport.js`
18,587 · `voice-scheduler.js` 10,681 · `realtime-engine.js` 15,953 ·
`voice-pool.js` 7,738 · `gate-envelope.js` 4,846 · plus the `time-math.js`
predicate and the `offline-render.js` shared-backbone refactor. Explained and
minimal; nothing was minified, readability-compressed or deleted to hit a
historical number.

**Regression (final HEAD):** Node suites **726 pass / 0 fail** (157 in
`tests/frontend/arrangement/` incl. the seven new C1 test files). The accepted
offline bounce was re-run after the shared-backbone refactor to confirm the
Milestone B offline path is intact.

> **[MEASURED]** offline bounce after the shared-backbone refactor (evidence WAV:
> `/tmp/opencode/clockwork-bounce-check/living-daylights-bounce.wav`): **all 18
> checks + 4 negative controls PASS, exit 0** — BDI gate over every region edge
> (worst 0.829 at frame 320000), audible musical fades, WAV frame count
> 448,000 == computed end, GATE 5 real-time proof, and all four negative controls
> detected (source-offset, latency-comp, pitch-as-speed, broken-fades/BDI). The
> accepted Milestone B offline path is intact.

---

## 11. Measured run record (headless Chromium, 48 kHz)

This section carries the harness numbers (Gate 8 B-criteria and Gate 2) exactly
as measured; targets are listed separately from measured results per the brief.

### Gate 8 — acceptance: proposed targets vs measured

| ID | Target (Grok's C1) | Measured | Verdict |
| --- | --- | --- | --- |
| T2 loop map | 10,000 deterministic passes | 10,000 passes, exact integer round-trip | **PASS** (Node) |
| source frames | exact, incl. frame 0 and source end | 50 seeded positions, **0 mismatch**; frame-0 and source-end exact | **PASS** (B3) |
| wrong-rate NC | must fail | timeline-rate formula disagrees for rate ≠ 1 | **PASS** (Node) |
| bypass sample error | ≤ 1e-6 | **1.79e-8** | **PASS** (G6) |
| bypass onset | sample-exact | **0 frames** | **PASS** (B1) |
| stop is silence | ≤ 1e-7 after fade+tail | **0** | **PASS** (B2) |
| stretched onset | ≤ 128 frames at gain edge | **10 frames** (pipeline delay) | **PASS** (B1) |
| DC envelope = clipGain × gate | ≤ 1e-6 | **2.17e-7** | **PASS** (B5) |
| frame-0 first sample | = 0 | **0** | **PASS** (B5) |
| silence stays silent | ≤ 1e-7 | **0** | **PASS** (B5) |
| loop handover unity | gains sum to 1 | **3.58e-7** (Node exact 1e-9) | **PASS** (B4) |
| non-finite safe failure | zeroed, never at output | output **finite**; count + failed state in Node | **PASS** (G7+Node) |
| stretched 10 ms env corr | ≥ 0.99 (loop passes) | not re-measured in this bounded run | **NOT MEASURED** |
| level diff | ±0.5 dB per 100 ms | not re-measured in this bounded run | **NOT MEASURED** |
| old seek audio (stale) | < −40 dB within 10 ms | design E3 (two-voice 5 ms xfade) −69 dB | **NOT RE-MEASURED** |
| play-during-stop | handled | supersede + new epoch | **PASS** (Node T1) |
| stop during seek crossfade | handled | reducer + gate arithmetic | **PASS** (Node T1/T4) |
| repeated seeks 20 ms apart | stable | retarget supersedes | **PASS** (Node T1) |
| loops < 2× horizon | handled / refused | no dedicated guard (`LOOP_TOO_SHORT` only rejects end ≤ start) | **NOT MEASURED** |
| pool exhaustion | refuse epoch, no audio loss | refuses, `stolen`=0, audio preserved | **PASS** (Node) |
| playhead alignment | ≤ ±3 ms in-graph | needs a live in-graph tap on the device | **INCONCLUSIVE** (§9) |

**No threshold was relaxed to achieve a PASS.** Measured results are recorded
separately from proposed targets. The three stretched-fidelity / stale-content
rows are marked **NOT MEASURED / NOT RE-MEASURED** rather than claimed — this
bounded run built the source-exactness, gate-arithmetic, bypass-parity, onset and
non-finite scenarios; a loop-repeatability envelope render and a fresh E3
stale-content render would complete those and are left as a follow-up. The
stale-content figure cited is golden-ear's independent E3 measurement, not a C1
re-measurement. Playhead alignment and glitch-free remain device-dependent (§9).

---

## 12. PM listening checklist and demonstration (Gate 10)

A small local audio demonstration over an eight-stem arrangement, without
changing any original source file:

1. **Play** the eight-stem ProjectState arrangement.
2. **Stop** and **restart** (Space; stop returns to the cue).
3. **Seek within a sustained pad** (no click; the pad continues smoothly).
4. **Loop a short vocal phrase** (clean loop wraps, no seam click).
5. **Seek across drum transients** (old audio drops out fast; new material is
   full-level at once).
6. **Hear the result** — original source files are untouched (non-destructive).

Listen-for notes: no click or pop at Play/Stop/seek/loop; the loop seam is a
brief, even crossfade (gains sum to unity — no dip or bump); a sustained pad does
not stutter or click on any transition; a deliberate clip-attack still speaks
(the transport start ramp is ≤ 2.5 ms attenuation, §5). **No audible PASS is
claimed until the PM listens.**

**Independent review (Gate 10):** the exact diff, tests, audio measurements and
unresolved limitations are handed to an independent reviewer (Codex Sol or
Cursor Grok). Blocking findings must be reproduced before repair. This milestone
is **not self-certified**.

---

## 13. Deliverables and remaining blockers

**Deliverables:** the pure transport state machine + TransportMap, the bounded
voice-pool design and its measured high-water mark, scheduler timing evidence
(§3), the shared bypass proof (§6), seek/loop test results (§8/§11), non-finite
safety evidence (§7), CPU/memory instrumentation (`engine.diagnostics()`), and
this evidence + PM checklist.

**Remaining blockers / honest limitations:**
1. **Gate 9 speaker latency + glitch-free (B6/B7)** — INCONCLUSIVE pending an
   owner/PM-approved live PipeWire audition (§9).
2. **Playhead alignment ≤ ±3 ms (B6)** — needs a live in-graph tap on the device.
3. **Stretched waveform equality** — deliberately NOT claimed; only onset +
   envelope tolerances (§6).
4. **The BDI blind spot** (source-attack masking) inherited from Milestone B is
   unchanged; BDI is diagnostic only here.
5. **Grok's standalone architectural challenge** is not in the tree (§1); its
   operative constraints are engineered against and recorded.
6. **Engine end-to-end live loop** — the Gate 10 review's blocking engine bugs
   are fixed and their critical math unit-tested (§14), but the full live
   play/stop/seek/loop over wall-clock time is verified by construction + unit
   tests, not a live browser soak; the PM audition (§12) is the final acceptance.

Implementation stays on `feature/all-the-time` (isolated). No merge, no main
promotion, no remote push, no credential change, no destructive cleanup, no
unapproved audio-device change.


---

## 14. Gate 10 independent review and resolution record

An independent reviewer (a `general` subagent standing in for Codex Sol / Cursor
Grok) audited the C1 diff, the vendored Signalsmith rule, the tests and this
document, and reproduced findings. **Verdict returned: BLOCKING.** The five pure
modules (transport reducer, TransportMap, gate-envelope, source math, pool
bookkeeping) were judged sound and their tests genuine, but `realtime-engine.js`
had wrong time-domain arithmetic, a seek that silenced scheduled clips, a voice
leak, and was imported by zero tests. Every finding below was reproduced, then
resolved on this branch; the fixes are covered by a new test file and the full
suite (726 pass / 0 fail).

**Blocking findings — resolved:**
1. *Voice placement double-subtraction* (voices landed `startFrame/sr` early when
   starting from a cue ≠ 0). **Fix:** one `ctxTimeMapper` is the single source of
   truth for context-time; placement uses `secForOffset(offset)` with
   `timeOriginSec = epochStartCtxSec` (no double subtract). **Tested**
   (realtime-engine.test.js “review 1”).
2. *Gate ramps used frames as absolute context-seconds.* **Fix:** `rampGateAtSec`
   schedules at `mapper.secForFrame(f)` (a real context time). **Tested**
   (“review 2”).
3. *Seek silenced already-scheduled clips* (a transport-domain voice key collided
   after a seek, blocking the incoming handover voice). **Fix:** a unique
   per-creation voice key (`makeVoiceKey` + monotonic seq) plus a per-map
   `scheduledKeys` dedup set cleared on map restart; outgoing voices are retired
   (keys freed). **Tested** (“review 3”).
4. *Voice leak — the pool bound degenerated to total occurrences.* **Fix:** every
   occurrence voice is `markTail`ed at its end + tail and reaped/released, so the
   pool tracks CONCURRENT voices. Refusal still never steals (`stolen`=0).
5. *Gate 2 overclaim* (“measured 104 ms, not hard-coded 85 ms”). **Fix:** the
   horizon is a documented derived constant `SELECTED_SCHEDULING_HORIZON_MS = 104`
   (= 64 measured priming floor + 25 wake + 15 jitter ALLOWANCE), wired as the
   engine default; the code no longer hard-codes 85 ms, and the docs state plainly
   the jitter term is a design allowance (not measured) and that the strict
   auto-derivation returned null. **Tested** (“review 5”).

**Major findings — resolved:** Gate 3 strict-arm-lead and the `input` unit
(seconds, not frames) fixed, and the pop-condition model note corrected (6, 7);
stop/pause now completes and emits `writeParked -> onParked` (8); transport seam
gates (start / handover-in) are applied and mid-clip seek slices no longer get the
clip’s MUSICAL fade (9); play-during-stop retires voices with a fade, not an
instant cut (10); stale async completions are discarded via an epoch capture +
re-check (11).

**Minor findings — resolved:** the tautological transition test now drives the
reducer and the `prepare`-during-playback contradiction is fixed (13); the
tautological non-finite assertion became a real scoped assertion (14);
`boundaryGate` no longer passes an all-unscorable set (15); the engine’s
correctness-critical math is now TESTED (16); the wrong hard count and the
`generation` claim are corrected (17, 18); the `LOOP_TOO_SHORT` misattribution is
corrected (12).

**Residual (honest):** the fixes make the engine correct by construction and its
critical math unit-tested, but the FULL live end-to-end play/stop/seek/loop over
wall-clock time is not browser-reproduced in this session (that needs a
live-engine browser soak plus the device audition). Per the PM directive the
audible PipeWire/PM audition (Gate 9 / §12) is deferred and remains the final
acceptance gate. A follow-up independent end-to-end re-review is recommended
before any merge. This milestone is **not self-certified**.

# OPERATION THE LIVING DAYLIGHTS — Milestone B evidence

Date: 2026-11-20
Coordinator: OpenCode
Branch: `feature/all-the-time` in `/home/richardn/MISIX-worktrees/all-the-time`
Scope: isolated local engineering and verification. **No public push, no main
promotion, no canonical media mutation, no production service change, no
permission expansion.** The accepted Black Tie Performance Desk is untouched
and remains the only production audio path.

## 0. Verified starting position and GATE 0 preflight

| Item | Verified |
| --- | --- |
| `feature/all-the-time @ cbc0933` | clean worktree; Milestone A suite 63/63 before any change |
| `main @ 28eef69` | public baseline, untouched |
| Milestone A contracts | preserved; `edit-api.js` extended additively with `setClipFades` (the §8 inspector's fade controls need a state edit path) |

GATE 0 resource preflight (fresh figures, not the stale 7.4 GiB report):

| Resource | Measured |
| --- | --- |
| Btrfs free | **7.39 GiB** (`Used: 129.55GiB`, 95% — unchanged) |
| `/tmp` tmpfs | 3.1 GiB free; all artifacts under `/tmp/opencode/living-daylights` (~2.7 MB total) |
| Active builds | none (`uv`/`cargo`/`npm` idle at preflight) |
| Dependency download | 520 KB source tarball; vendored runtime 120 KB. No global dependency upgrades |

## 1. Implementation and DSP dependency SHAs

| Component | Pin |
| --- | --- |
| Signalsmith Stretch | tag **`1.4.0`**, commit `a670068d9aeb64913331d5cc29337b19a457a7df` |
| Source archive | sha256 `077235709ecf2a358545e3ca7bdf32859f70f5c9afb4493e078bd753c9aff284` |
| Vendored `SignalsmithStretch.mjs` | sha256 `97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46` |
| Licence | MIT (Geraint Luff / Signalsmith Audio Ltd) — `LICENSE.txt` preserved verbatim |
| Provenance record | `src/twobecomeone/studio_static/vendor/signalsmith-stretch/PROVENANCE.md` (notes the release bundle's internal `version: 1.3.2` mismatch) |

New first-party modules (this repo's commits below):

| Module | Bytes | Role |
| --- | --- | --- |
| `js/arrangement/render-plan.js` | 7,972 | pure plan compiler (GATE 2) |
| `js/arrangement/offline-render.js` | 10,597 | shared graph builder, offline + real-time |
| `js/arrangement/limiter-worklet.js` | 4,808 | the single limiter implementation |
| `js/arrangement/capture-worklet.js` | 983 | real-time PCM tap (GATE 5) |
| `js/arrangement/wav.js` | 3,051 | 24-bit PCM WAV container encoder (word-aligned) |

## 2. Signalsmith feasibility results (GATE 1 — 12/12)

Driver: `node tests/browser/signalsmith_spike.js`; raw JSON:
`/tmp/opencode/living-daylights/spike-results.json`. Real headless Chromium,
loopback HTTP (so AudioWorklet modules load as the Studio will load them).

| # | Capability | Result |
| --- | --- | --- |
| S1 | AudioWorklet node in live AudioContext | **PASS** — `AudioWorkletNode`, `latency()` = 0.12 s. Web-node API: `schedule/addBuffers/dropBuffers/start/stop/latency/configure`; `seek/flush/reset/inputLatency/outputLatency/setFormant*` are C++-only (not exposed) |
| S2 | same implementation in OfflineAudioContext | **PASS** — renders; the hard-stop condition (one DSP in both environments) is cleared |
| S3 | passthrough render | **PASS** — onset +99 samples (2.1 ms), length −1.4 ms, 440.0 Hz exact |
| S4 | stretch preserves pitch | **PASS** — rate 0.5 → 2.047 s tone (exp 2.0, +2.3%), rate 2 → 0.530 s (+6%); 440 Hz held in both |
| S5 | pitch independent of duration | **PASS** — +7 → 660.0 Hz (exp 659.26), −12 → 220.0 Hz; duration held ±27 ms |
| S6 | formant compensation on vowel material | **PASS** — `formantCompensation: true` measurably changes output (max sample diff 1.58 vs bit-identical when both off) and holds the formant envelope nearer the unshifted render; `formantSemitones: 0` alone has no effect (bit-identical to no compensation) |
| S7 | latency / pre-roll / tail / seek-flush | **PASS (with limit)** — marker error +78 samples; pre-roll ≈ 1.6 ms; tail ≈ 0.05 s past the signal end (corrected figure: the fixture's signal ends at 1.72 s, not 1.5 s); `seek`/`flush` not exposed on the web node, so fixed-length alignment is empirical |
| S8 | eight simultaneous instances | **PASS** — 3 s × 8 render in 442 ms wall → **CPU load factor 0.147** (< 1 required) |
| S9 | real-time load / underruns | **INCONCLUSIVE (honestly failed)** — `AudioRenderCapacity` is unavailable in this Chromium build, so underruns cannot be measured and the experiment is recorded as not qualifying the audio deadline; 5 s soak showed no audible dropout; main-thread jitter mean 0.20 ms, max 0.90 ms |
| S10 | incremental feed + disposal | **PASS** — 60 s stream fed in 5 s chunks with `dropBuffers` held a 10 s window in **seconds** (`{start:5,end:15}` → `{start:50,end:60}`); the earlier extent check compared seconds against a frames constant and was fixed after review |

## 3. Architecture and signal flow (GATE 2/3)

Timeline state (Milestone A `ProjectState`) is compiled by a pure compiler into
an ordered, sample-accurate **render plan**; rendering consumes the plan and
never writes to state (`compileRenderPlan` deep-copies and validates its
input; a determinism test asserts identical plans and untouched state).

```
ProjectState snapshot ──compileRenderPlan (pure)──► RenderPlan
                                                        │
per clip:                                               ▼
  Source slice (bufferReference → bounded cache)   ┌─────────────┐
    → Signalsmith Stretch (WASM/AudioWorklet)      │ render plan │
      rate = source-advance rate, semitones,       └─────────────┘
      formantCompensation                            │
    → clip gain + micro-fade (AudioParam ramps)      │  same plan
    → per track: lowshelf 250 Hz                     ▼
      → peaking 1 kHz → highshelf 4 kHz         ┌──────────┐   ┌──────────────┐
    → track gain (volumeDb × mute/solo law)     │ offline  │   │ real-time    │
      → StereoPanner                            │ Offline- │   │ AudioContext │
    → master gain                                 │ Audio-   │   │ + capture tap│
    → lookahead brickwall limiter (−0.3 dBFS)   │ Context  │   │ (GATE 5)     │
    → output (offline: WAV 24-bit PCM)          └──────────┘   └──────────────┘
```

Determinism and independence (GATE 2, 13/13 tests): identical plans for
identical states; an independent frame-math checker (no engine imports) agrees;
negative controls prove the checker catches wrong source offsets, ignored
latency compensation, pitch-as-playback-speed and broken fades.

Limiter (single implementation, `limiter-worklet.js`, loaded by both hosts):
lookahead window `need[i] = ceiling / peak(window)`; raw follow `f[i] =
min(need[i], f[i−1] + release)`; applied gain is the mean of the last L raw
values. Because a peak's `need` enters `f` exactly L samples before that peak
is output, every averaged value already covers the peak: the **sample-peak
ceiling is guaranteed** while the attack remains a smooth ramp (no click from
instant gain steps). Node-side unit tests (8/8) pin: ceiling enforcement on hot
tones and single-sample transients, transparency below the ceiling, smooth
reduction ramps, and the reported lookahead latency (240 frames at 5 ms / 48 kHz).

Stretch/stretch independence (Milestone A convention preserved exactly):
`rate = masterBpm / nativeBpm` (beat_sync) or `customStretchRatio` (manual) =
source seconds per output second; pitch is `2^(s/12)` through the DSP and never
touches the rate. Region tails are bounded by the clip's fade-out reaching zero
at the region end (the stretch window smear is measured at ≈ 30–47 ms in S4).

## 4. Offline WAV artifact (GATE 3/7)

| Fact | Value |
| --- | --- |
| File | `/tmp/opencode/living-daylights/living-daylights-bounce.wav` (copy: `artifacts/living-daylights-bounce.wav`) |
| sha256 | `82af8cb27389101553ea8b1f97df4d9b1ba1646a70901fc5f0a687f4435db7f1` |
| Format | 24-bit PCM WAV, stereo, 48 kHz, 432,000 frames (9.000 s), canonical RIFF header |
| Source commit | this branch's commits in §10 |
| Content | original synthesised arrangement (A minor, 120 BPM master) |

Eight contributing tracks, each with measured RMS contribution
(0.031–0.287): synthesised drums (split + trimmed), bass (start-trimmed),
**`c_major_100.wav` at 100 BPM beat-synced to the 120 master — the genuine
tempo adjustment**, vowel-lead (**+7 semitones, formant-preserved**, moved to
bar 3, trimmed through a sine peak), pad (2-beat musical fades), arp (manual
stretch 0.85), `a_minor_140.wav` at 140 BPM beat-synced (rate 0.857), and a
side texture (unmeasured BPM — left explicitly unknown in manual mode).

What to listen for (PM audition):

1. The C-major loop sits **in tempo** at 120 although its source is 100 BPM;
   the 140 BPM texture likewise. Neither chips or drags against the drums.
2. The vowel lead in bar 3–4 is a **seventh up** yet keeps its vowel character
   (formant preservation), and its length is unchanged.
3. The pad enters and leaves on **long 2-beat fades**; the drums stop for one
   beat after beat 7 (the non-destructive trim) and resume cleanly at bar 3 —
   no click at either edge.
4. The master is dense but **unclipped**: −0.3 dBFS ceiling, ~7.3 dB gain
   reduction at peaks.

## 5. Real-time AudioWorklet proof (GATE 5)

The same plan, same builder, same stretch module and same limiter worklet ran
on a live `AudioContext`; the capture tap recorded 207,872 frames and the
result was compared with the offline bounce (driver + `results.gate5`):

| Metric | Value | Reading |
| --- | --- | --- |
| Measured lag | **255 ms vs 250 ms expected** | timing within 5 ms |
| Envelope mean ratio | **1.003** | levels match to 0.3 % |
| 10 ms envelope correlation (worse of both channels) | **0.840** | musical envelopes agree |
| 1 ms envelope correlation | 0.426 | fine-scale gap (finding below) |
| Normalized raw RMS diff | 0.774 | waveform phase differs |

**Finding (differences identified, parity NOT claimed):** stretch transient
smears land at different micro-positions under live block scheduling versus
offline rendering; fine-scale (1 ms) envelopes decorrelate while 10 ms musical
envelopes, levels and timing match. This is a scheduling/host difference of the
stretch DSP, not a state or plan difference. Full real-time transport, seeking
and looping — and closing this gap — belong to Milestone C. No complete-parity
claim is made.

## 6. DSP quality, latency, CPU, memory (GATE 4 measurements)

| Measurement | Value |
| --- | --- |
| Output length / start | 432,000-frame trimmed export (renderOffline now renders and trims the limiter's 240-frame lookahead, so sample 0 == arrangement frame 0); moved lead pipeline delay **+210 frames (4.4 ms)**, relative placement error **24 frames** between the pitched and unshifted variants |
| Effective stretch ratio | measured **0.8318** vs expected 0.8333 (100→120 BPM), 0.2 % error |
| Pitch frequency ratio | measured **1.500** vs expected 1.4983 (+7), zero-crossing resolution 2 Hz |
| Pitch/duration independence | onsets AND offsets agree within 24 / 9 frames between shifted and unshifted renders |
| Stereo integrity | mono-centred fixtures stay centred; panned tracks give max channel difference 0.388 in the expected direction |
| Formants on the vocal-like lead | smoothed-parabolic F1: unshifted 694 Hz, compensated 495 Hz (Δ199), uncompensated 1004 Hz (Δ309) — **strictly nearer than uncompensated**; fine-resolution evidence remains spike S6 |
| Clip boundary clicks | split slope 0.190, mid-vowel cut 0.027 vs steady reference 0.185 (gate: boundary slope ≤ 4× steady, so a broken-fade render at 0.155–0.201 mid-vowel cut also fails the ordinary gate) |
| Fades | pad RMS 0.133 → 0.046 across the 2-beat fade-out (−9.2 dB) |
| Limiter | ceiling 0.966051 held (float32 epsilon < 1e-6); max gain reduction **−7.32 dB**; **true-peak protection is NOT claimed** and no oversampled measurement is pretended (`intersampleAssessment` records this) |
| Mute/Solo law | a state-level solo render equals the physically filtered solo bit-for-bit (normalized diff **0.0**) — the graph enforces the law itself |
| Mix presence | leave-one-out of the un-limited sum degrades agreement with the real master for **every** track (margins +0.001…+0.339) — all eight measurably shape the full mix |
| DSP tail | S7 corrected: ≈ 0.05 s ring-out past the signal end; region fades bound it; limiter ring-down is release-bounded |
| CPU | 9-instance 9.63 s bounce in ~2.1 s wall → load factor **0.21**; 8-instance spike factor 0.15 |
| Memory | Chromium tree RSS peak ≈ **1.16 GiB** (includes the browser/GPU base; not a DSP-only figure). WASM instance count is bounded: `MAX_CLIPS_PER_GRAPH = 32` (explicit refusal beyond), variant renders build only the clips they need, slices are copies (no full-backing-buffer retention), short buffers are refused instead of silently truncated, and a failed build disposes everything it constructed. JS heap for the 8-instance spike: 11.5 → 14.7 MB. `dropBuffers` proved bounded retention (S10) |
| Underruns | **not measurable in this Chromium** (no `AudioRenderCapacity`) — recorded as S9 INCONCLUSIVE, not glossed |

Negative controls at audio level — **all four detected** (each defective render
fails its check):

| Defective implementation | Detected by | Signal |
| --- | --- | --- |
| incorrect source-offset calculation | chords content alignment | measured lag −283 ms |
| ignored latency compensation | clip placement | onset off by 2,426 frames |
| pitch applied as playback speed | pitch ratio | 220 Hz where 329.6 expected |
| broken clip fades | mid-vowel cut click | slope 0.201 vs 0.028 reference (7×) |

## 7. Tests and negative controls

| Suite | Result |
| --- | --- |
| `tests/frontend/arrangement/` | **86 tests** — time-math 12, project-state 13, edit-api 23, history-and-proposals 14, render-plan 14 (incl. the split-boundary regression), dsp-units 9 (incl. the mono WAV pad regression), negative-control 2 |
| `npm test` (all frontend incl. new) | **655 pass, 0 fail** |
| `pytest -q` | **630 passed, 1 skipped** |
| Spike harness | 11 proven + **S9 INCONCLUSIVE** (no underrun telemetry); exits non-zero on any failure |
| Bounce harness | 15/15 checks + 4/4 negative controls detected; exits non-zero on any failure |

Measurement-method defects found and fixed during the work (recorded as
evidence per practice): a wrong-clip lookup in the stretch measurement, fade
and gap windows placed in beats-as-seconds, a phase-lucky single-sample click
probe (fixed with a synthesised sine-peak cut), a real-time comparison aligned
in the wrong direction (500 ms total error), and a parabolic estimator runaway
(clamped to ±half a harmonic). One real DSP bug was found by unit tests: the
limiter's smoothed-gain window initialised inconsistently (gain above 1 at
startup) — fixed and pinned by the brickwall tests. One resource defect: 9 WASM
instances × 15 renders crashed the renderer; variant renders now build only the
instances they need. One environment defect: `/tmp` tmpfs (6.7 GiB) filled with
**5.7 GiB of retained pytest scratch** mid-operation and made the Python suite
fail en masse with `No space left on device`; clearing
`/tmp/pytest-of-richardn` restored 630/631 green. A full tmpfs is a test
failure's most misleading disguise — check `df` first.

### Static assets (per docs/static-asset-policy.md)

| Measure | Value |
| --- | --- |
| Total uncompressed bytes | **978,428** (84 files) |
| At Milestone A end (cbc0933) | 829,595 (75 files) |
| This operation's growth | **+148,833 bytes (+17.9 %)**: five engine modules 27,411 B (render-plan 7,972, offline-render 10,597, limiter-worklet 4,808, capture-worklet 983, wav 3,051), `edit-api` +1,212 B, and the pinned DSP dependency 120,210 B (module + licence + docs) |
| Largest files | `vendor/signalsmith-stretch/SignalsmithStretch.mjs` 113,867 (new largest), then `stem-desk-panel.js` 59,185, `ghost-controller.js` 55,945 |

Growth is real and explained: the shared DSP path plus its pinned MIT
dependency. The dependency is 77 % of it and is the minimum vendored unit that
keeps licence and provenance attached. Trigger thresholds are exceeded against
the historical baseline and this entry records the reason.

## 8. Independent review (GATE 6)

Codex Sol (`codex-cli 0.170.0`) was dispatched the scoped challenge brief
(`/tmp/opencode/living-daylights/challenge-brief.md`; full log:
`/tmp/opencode/living-daylights/codex-challenge.log`) covering state/render
separation, shared DSP, pitch/stretch independence, sample-accurate placement,
latency/tails, peak limiting, bounded memory, eight-instance performance and
the honesty of the audio evidence.

**Sol's verdict: 12 BLOCKING + 3 IMPROVE.** The findings were reproduced and
repaired in one corrective pass; every repair is pinned by a test or a
tightened gate:

| # | BLOCKING finding (abridged) | Reproduction | Repair |
| --- | --- | --- | --- |
| 2 | split children overlapped by 1 frame (independent rounding) | failing regression test with Sol's exact trims | region edges quantised once; `left.timelineEndFrame === right.timelineStartFrame` pinned in `render-plan.test.js` |
| 3 | default bounce lost the last limiter interval | code path (harness had hand-worked around it) | `renderOffline` renders + trims the lookahead; sample 0 == arrangement frame 0 for every caller |
| 4 | region gain not half-open (1-sample overlap, pre-ring leak) | code path | gain zero from origin, zero exactly at the exclusive end |
| 5 | live scheduling used context time 0; sample-rate mismatch accepted | code path | `timeOriginSec = ctx.currentTime`; context/plan sample-rate mismatch now refuses |
| 6 | instance/buffer lifecycle unbounded; silent truncation | code path | `MAX_CLIPS_PER_GRAPH = 32` refusal, copied slices, short buffers refused, failed builds dispose everything |
| 7 | capture kept accumulating after return | code path | handler detached + graph disposed in `startRealtime` |
| 8 | mono WAV omitted the RIFF pad byte | failing unit test (1-frame mono) | pad byte emitted and counted; `dsp-units.test.js` pins header sizes |
| 9 | drivers exited 0 on failed gates | code path | both drivers set exit 1 on any failed check or undetected negative control |
| 10 | duration/formant/placement gates accepted their own defects | evidence rows (equality formant pass; 351-frame error under 720 tolerance) | offset+onset duration check; strict parabolic formant comparison (Δ199 < Δ309); placement bounded to 480 frames absolute + 60 frames relative; latency NC tightened from 50 ms to 240 frames |
| 11 | S8/S9/S10 gates vacuous (seconds-vs-frames bug, RSS hook clobber, unconditional pass) | code path + missing RSS in the saved report | CPU-factor gate; S9 recorded INCONCLUSIVE without telemetry; S10 window check in seconds with window-advance requirement; RSS hook no longer clobbered (24 samples now recorded) |
| 12 | solo/fade gates could pass broken behaviour | evidence rows | state-solo == filtered-solo equality render (law enforced by the graph); leave-one-out-of-the-sum presence proof for all eight tracks; one click gate at 4× steady slope so the broken-fade render fails it too |

IMPROVEs: GATE 5 now compares **both channels** and is described as a coarse
envelope comparison; the meaningless linear "true-peak estimate" is removed and
replaced with an explicit `intersampleAssessment` that claims nothing; the
spike's tail reference is corrected (signal ends 1.72 s); `exportMasterMix` now
really exists — it encodes finished renderer PCM to WAV through `wav.js` and
still refuses to invent audio (encoding is never a second mixing engine).

Sol's evidence assessment before repair — that the work supported state/render
separation, shared DSP wiring, a real stereo bounce and approximate
pitch/stretch independence, but **not** the strict ceiling, rendered boundary
exactness, default compensated bounce, bounded lifecycle or eight-instance
qualification — is the honest map of what the repairs changed. A **re-audit of
the repaired lines** remains the final Gate 6 step (one corrective pass is
spent; per the measured protocol the recheck is scoped to the 15 findings'
lines only). Cursor Grok remains available as the second named challenger.

## 9. Known blockers and limitations

1. **Real-time fine-scale parity gap** (§5): 1 ms envelope correlation 0.43
   under live scheduling. Milestone C work; no parity claim is made.
2. **No true-peak claim**: sample-peak ceiling enforced and measured; no
   oversampled intersample measurement was performed (§6).
3. **`seek`/`flush` not on the web node**: fixed-length alignment is empirical
   (≈2 ms residual on unpitched material); the C++ API exposes them but the
   WASM release does not.
4. **Underrun telemetry unavailable** in this Chromium (`AudioRenderCapacity`
   absent): S9 is INCONCLUSIVE; the real-time deadline on the target machine
   needs a build with that API or a device-side measurement rig.
5. **FLAC** deliberately deferred to the export milestone (per brief).
6. `setClipFades` is a small additive edit-API extension (§0) and
   `exportMasterMix(rendered)` now encodes renderer PCM; no existing contract
   changed.
7. `/tmp` tmpfs fills with retained pytest scratch across runs (5.7 GiB
   observed); clear `/tmp/pytest-of-richardn` before trusting a mass Python
   failure.

## 10. Commits and Milestone C readiness

| Commit | Contents |
| --- | --- |
| `feat(vendor): pin Signalsmith Stretch 1.4.0 (MIT)` | vendored module + licence + provenance |
| `feat(daw): shared DSP path — render plan, limiter worklet, offline bounce, WAV` | render-plan.js, offline-render.js, limiter-worklet.js, capture-worklet.js, wav.js, edit-api setClipFades/exportMasterMix + tests |
| `test(daw): Signalsmith feasibility spike and eight-stem bounce harness` | tests/browser/signalsmith*, tests/browser/daw* |
| `fix(daw): repair the twelve blocking review findings` | boundary quantisation, compensated bounce, half-open regions, live clock/rate guard, instance & buffer budget, capture teardown, WAV pad, driver exit codes, tightened gates, spike honesty fixes |
| `docs: record Milestone B evidence, Sol review and repair record` | this document |

**Milestone C readiness: GO for transport/seek/loop on the proven engine.**
The offline engine is deterministic and measured; the real-time proof exists
and its gap is characterised. Milestone C should carry: loop-accurate
scheduling on the audio clock, seek with source-offset correctness (negative
control already exists at plan level), transport stop/restart click safety, the
fine-scale parity investigation (or an accepted, documented tolerance), and the
real-time limiter/latency compensation loop.

**No audible PASS is claimed until the PM listens to
`artifacts/living-daylights-bounce.wav`.**

# Listening/timing benchmark — baseline evidence (CANDIDATE)

Status: **CANDIDATE — Astra audit requests changes; not accepted.**
See `LISTENING_BENCHMARK_AUDIT.md` for findings and the implementer handoff.
Branch: `benchmark-listening-timing` (from main `01920f8`). Handover item 1,
"Prove what reaches the listener". This slice stops at a reviewable benchmark
and measured report; no engine changes.

## What this baseline is

An executable benchmark that generates deterministic rhythmic transients and
tones (no private music), renders them through the **real** production paths,
and measures where onsets actually land versus where the math says they should.
It separates the three evidence classes the handover requires and never mixes
them:

- **Class A — offline rendered samples** (`tests/test_listening_benchmark.py`,
  support in `tests/listening_bench.py`). Rendered via
  `assembler.render_aligned` / `assembler.build_mash` (the accepted Phase 11B
  committed-layer path), decoded to mono 44.1k, onset = energy-rise crossing at
  50% of the search-window peak with sub-sample linear interpolation.
  Deterministic; measured on this machine.
- **Class B — browser scheduling events**
  (`tests/browser/timing_bench.js`, headless Chromium). Runs the REAL
  production modules (`transport/derive.js`, `transport/normalize.js`,
  `actions/errors.js`) against a real `OfflineAudioContext` and records
  harness-authored receipts per scenario. It does not run GhostScheduler:
  "now" is supplied by the scenario and the minimum-lead loop is duplicated.
  This is a derive/decode/start smoke test, not production-engine scheduling
  evidence or audible timing. Existing receipts are embedded when present,
  without commit/freshness validation (an open audit finding).
- **Class C — loopback/device recordings.** Format is defined
  (`benchmark_report.json` → `classC`) and every case is `measured: null`.
  **No recording has been captured.** Nothing in this baseline claims speaker
  timing.

## Reproduce

```bash
.venv/bin/pytest tests/test_listening_benchmark.py -q   # class A + report assembly
node tests/browser/timing_bench.js                       # class B receipts (Chromium)
.venv/bin/pytest tests/test_listening_benchmark.py -q    # re-run: embeds receipts
# report lands in ./benchmark_report.json (gitignored; regenerated, never hand-edited)
```

The report self-records its commit (`git rev-parse HEAD` at generation time),
Python/platform/ffmpeg versions, and per-case method strings.

## Measured results (class A), reproduced at branch head `59ffc52`

Signed onset offsets (observed − expected), ms. Each case currently measures
only one onset (n=1); percentiles are therefore not meaningful distributions,
and drift is not measured. Raw case values are in `benchmark_report.json`.
Its observations are currently hardcoded and must not be treated as fresh
conclusions; correcting report generation is an open audit finding.

| Case | Offset |
| --- | --- |
| unshifted @ 22.05k | −22.726 ms |
| unshifted @ 44.1k | −22.726 ms |
| unshifted @ 48k | −19.417 ms |
| pitch −3 st @ 44.1k | −41.146 ms |
| pitch +5 st @ 44.1k | −49.816 ms |
| tempo ratio 1.25 | −13.855 ms |
| tempo ratio 0.8 | −30.791 ms |
| committed-layer first onset (adelay @ 9 s; 1 s lead-in + 16 beats) | +0.426 ms |
| nonzero cue 0.4 s | −20.637 ms |

Audit interpretation:

1. The early offsets reproduce for these fixtures. A fixed filter-priming
   mechanism has NOT been established: varying the unshifted 44.1k source
   onset from 0.25 to 1.25 s changed the measured offset (see audit table).
   Do not infer a universal latency compensation from this baseline.
2. Pitch/tempo cases show transform-dependent offsets for the tested input.
   Broader timing behavior and the responsible filter stages remain open.
3. Measuring both committed clicks in the exact benchmark mix gives +0.426 ms
   at 9 s and -22.778 ms at 9.5 s. First-onset alignment does not establish
   timing-clean playback throughout the region or listener-level accuracy.

Class B: all 6 scenarios execute successfully in headless Chromium. Captured
values include 15.5 s at beat 32 for the nonzero-origin case and re-resolution
for the minimum-lead case. The script does not assert independent expected
values; PASS currently means the harness returned `ok`, not timing correctness.
Real decode is exercised, but its wall-clock duration does not advance the
unrendered OfflineAudioContext clock or the scenario's supplied "now".

## Deliberately not done here (pending audit/acceptance)

- Class C loopback capture — format defined; capture command finalized per
  OS/device before any recording is made.
- Longer playback under browser load; the full
  stop/seek/project-switch/Release/Commit/Undo/reload/missing-assets/
  interruption matrix — follows the evidence per the handover.
- Sustained vocal/stereo material (owner-provided only; repo stays
  generated-only).
- Acceptance tolerances: `acceptanceTolerances` is `null` everywhere. Scheduling
  events cannot establish audible timing; tolerances get set only by agreement
  after class C exists.
- CI wiring of `timing_bench.js` (currently a capture tool, not a gate) —
  workflow changes await the audit.

## Deviations and notes for the auditor

- The transient fixture was reshaped during TDD (Hann burst → 1 ms linear
  attack): the 50%-crossing estimator produced a constant ≈+2.5 ms instrument
  bias on the slow Hann attack. The sharper attack reduces the bias to
  sub-millisecond and keeps it constant; measurement method is unchanged.
- An initial expectation that pitch-shifted onsets move by 2^(−shift/12) was
  WRONG and the failing calibration test caught it: the pipeline's shift is
  duration-compensated by design (PR #1: asetrate + counter-atempo), so onsets
  stay at source times. The benchmark measures that behavior; it does not
  assume it.
- No versions bumped; no engine or server code touched; GPU environment and
  `~/.local/share/2become1` untouched; `.vscode/` untracked and untouched.
- Static budget after this branch: unchanged for `studio_static/` (benchmark
  lives in `tests/`).

---

# Correction addendum — audits A–D addressed (still CANDIDATE)

The sections above are Astra's audit-state record and are kept verbatim
including statements that were true at `59ffc52` and are superseded below.
Findings were addressed test-first in commits `0725283` (A), `e306376` (B),
`54db552` (C+D). No engine, dependency, router, or Slice-2 changes.

## A — region measurement, distinct conditions, drift, integrity gates

The estimator now raises `OnsetMeasurementError` on silence, missing/dropped
clicks, and ambiguous double transients instead of silently associating
whatever energy is in the window (RED→GREEN: tests failed before the gates
existed, and the first gate implementation was itself corrected twice —
decay-ramp and resampler pre-ring false positives — before all 16 tests
passed). Method language now states amplitude thresholding (|x|), not squared
energy. Fresh measured cases:

- Committed region, **exact benchmark mix** (anchor_gain=0.8): both clicks
  measured — launch 9.0 s: +0.426 ms; second click 9.5 s: −22.778 ms
  (reproduces Astra's probe exactly). Isolated condition (anchor_gain=0):
  +0.499 ms / −18.138 ms. Reported as distinct, non-interchangeable cases.
- 32-beat phrase boundary (documented production phrase length) exercised
  offline through the same committed path.
- Full 16-click grid at tempo ratio 1.25: all n=16 measured, mean −15.9 ms,
  worst −19.1 ms, least-squares drift −11.058 ms/minute (from the measured
  series, not extrapolation).
- Source-position sweep at 0.25/0.5/1.0/1.25 s measured −19.642/−18.138/
  −22.726/−20.546 ms under an identical configuration: offsets are
  position-dependent, so no fixed-latency conclusion is drawn anywhere.
- Clipping/dropout measured for the committed case (true peak via
  `assembler.measure_clipping`; expected clicks detected); everything broader
  stays in coverage gaps.

## B — production scheduler coverage with independent assertions

`timing_bench.js` now loads and drives the **production GhostScheduler** in
Chromium against real Web Audio nodes: captured `source.start` calls,
production `onScheduled` receipts, and per-scenario hand-computed expectations
asserted independently of production's own math. The self-test (a deliberately
wrong expectation) is verified to fail loudly. Decode-crossing causality is
proven: advancing the injected clock to 5.9 s while decode is pending moves
the launch from 6.0 s to the following phrase at 8.0 s. Clock provenance is
explicit — per-scenario `clockMode` labels the controlled clock as injected
(real nodes/decode, manually advanced clock); one additional observation runs
on a real `AudioContext` device clock with invariant-only checks (launch after
request, lead ≥ min-lead, next-boundary beat). One of my own hand-computed
expectations was wrong (beat 12 vs beat 8 at now=5.5) and the new assertions
caught it — the audit's exact concern, demonstrated. Scenario names state what
is actually exercised (no cue/trim or asset-transform claims). Non-zero exit
on assertion or page errors; browser cleanup in `finally`.

## C — no fixed-latency conclusions

Hardcoded `observations` are gone: report observations are derived from the
same run's numbers (sweep spread, per-run offsets, both committed clicks,
measured drift) and the truth gates assert the observations quote this run.
The sweep data itself refutes a fixed latency (spread ≈4.6 ms across positions
at identical configuration). Mechanism stays unknown and unclaimed.

## D — provenance retained and validated

`tests/receipts_ingestion.py` gates class-B embedding on schema, required
provenance keys, per-case assertion success, finite receipt numbers, unique
scenario ids, and commit match. Missing/malformed/invalid/stale captures are
labeled explicitly with their capture metadata and never relabeled current —
demonstrated live when ingestion refused the receipts captured at `0725283`
after HEAD moved to `e306376` (the report recorded the stale status with the
reason instead of embedding). Receipts now carry commit, dirty-state flag,
capture time, browser/OS context, clock policy, scheduler coverage, and the
self-test result; ten ingestion tests pin every state. The current capture
(8 cases, 8 receipts, self-test detected) validated and embedded.

## Fresh command/counts (this addendum)

```bash
.venv/bin/pytest tests/test_listening_benchmark.py tests/test_receipts_ingestion.py -q
# → 26 passed
node tests/browser/timing_bench.js
# → 8 scenario PASSes + self-test + real-clock observation, receipts.json
.venv/bin/pytest tests/test_listening_benchmark.py tests/test_receipts_ingestion.py -q
# → 26 passed; benchmark_report.json embeds classB status "current" with
#   capture commit == report commit
```

Local suite totals on this branch: Python 480 passed / 1 skipped (pre-existing
Phase 10 bounds skip), frontend 328 passed, browser journeys 30+30 checks,
static assets 489,004 B. Remaining unchanged: class C unmeasured, tolerances
pending, CommittedLayerEngine live coverage and the interruption matrix are
follow-ups, CI wiring of the benchmark awaits acceptance.

## Commit/push status

Correction commits are local only (`0725283`, `e306376`, `54db552` on
`benchmark-listening-timing`). Nothing pushed, merged, or accepted; awaiting
Richard's authorization and Astra's re-audit. Base for the re-audit diff:
`59ffc52..54db552`.

## Re-audit continuation

The correction addendum above ends at its then-current implementation commit.
The actual candidate subsequently included documentation commit `65ce92e` and
has now been re-audited over `59ffc52..65ce92e`. Current findings, Astra's
uncommitted cheap fixes, verification, and the remaining rhythmic-matrix gap
are recorded in `LISTENING_BENCHMARK_REAUDIT.md`. This section supersedes the
stale re-audit range above without rewriting the historical addendum.

## 2026-09-12 Phase 13A implementation checkpoint — BLOCKED, not complete

This dated checkpoint supersedes the historical counts above for this attempt;
it does not mark the programme accepted or replace the earlier audit record.

- Verified `origin/main` and branch starting point / `PHASE13_BASELINE`:
  `4573b298dcddd02033c8173cb2d50e9a95d1e241`.
- Branch: `bot/hermes/13A-offline-distributions`. No commit or push was made.
- The seven-file audit cheap-fix allowlist already landed atomically in
  `a8aa909448e6b040db66ea3c2874106950b180a1`; those files have no changes between
  that historical commit and the current starting point. No duplicate baseline
  commit was needed. The old plan's unrelated-worktree inventory is historical:
  current unrelated untracked paths were preserved, not staged.
- Baseline focused gate: 43 passed in 10.04 s. `node --check
  tests/browser/timing_bench.js` and `git diff --check` passed. The existing
  production-output-rate test and dirty-capture truth-gate tests passed; browser
  source-scope inspection confirms unrelated `.vscode/` is excluded.

### TDD and the measured blocker

13A.1's helper contract first failed with "series renderer is missing", then
passed with a real production render, all 16 offsets, actual WAV output-rate
inspection (44100 Hz), least-squares drift, clipping, dropout counts and
single-probe parity. The existing one-shot helper remains intact.

13A.2's new report matrix assertion first failed with `1 == 16`. Switching the
report's rate, pitch, tempo and cue cases to the full generated grid exposed an
integrity failure in `pitch-shift5-sr44100`. Reproduction:

    .venv/bin/pytest tests/test_listening_benchmark.py -q -k benchmark_report --tb=short

The fixture is the existing 16-click, 120-BPM grid with a 1-second lead-in.
`assembler.render_aligned` is called at ratio 1, pitch +5, cue 0, with no output
rate override. `bench.onset_offsets` rejects the whole case:

    ambiguous onset near 4.0 s: comparable transient energy at [3.9795]
    besides 3.9472 s inside the association window

A diagnostic pass through each expected window (not a successful case or a
partial distribution) additionally found:

    ambiguous onset near 6.5 s: comparable transient energy at [6.459]
    besides 6.4437 s inside the association window

The same diagnostic measured all 16 windows without errors for unshifted,
pitch -3, tempo 0.8 and 1.25, and cue 0.4 s at 44100-Hz input. These diagnostics
do not establish why the +5 render contains competing energy and do not justify
changing the estimator's ambiguity exemption, selecting easier source positions,
or compensating production DSP. No partial +5 distribution is reported.

The brief requires both a complete distribution for every matrix case and
whole-case rejection of ambiguous events. Cursor Spark must resolve that
contract before this branch can pass its gate: authorize an explicit failed /
unmeasured whole-case report, or provide a separately approved measurement or
engine investigation. The implementer did not silently relax either requirement.

### Current verification and remaining work

- Focused gate: **1 failed, 43 passed in 7.80 s**, failing on the +5 ambiguity
  above; syntax check and diff whitespace check pass.
- Static shipped HTML/CSS/JS: **589587 bytes**, unchanged; below the authorized
  600000 soft / 650000 hard limits. No frontend or production edits.
- Changes are uncommitted test/evidence work only. 13A.2 is incomplete;
  dropped-middle transformed-case helper coverage and 13A.3's report boundary
  case/quality-metric truth gates remain unfinished. No 13B work started.
- No successful current combined report was generated by the failing run.
  Any existing ignored `benchmark_report.json` is from an earlier invocation,
  not evidence of completion. Class B was not recaptured; Class C remains
  unmeasured and `acceptanceTolerances` remains null. Receipts are not speakers.

## 2026-09-12 follow-up re-audit — isolated-source diagnosis, still BLOCKED

The requested focused gate was reproduced on the existing
`bot/hermes/13A-offline-distributions` worktree at `4573b298dcddd02033c8173cb2d50e9a95d1e241`:
**1 failed, 43 passed in 7.64 s**. The failing case remains
`pitch-shift5-sr44100`, before report assertions or committed mixes execute.
This is neither a stale report assertion nor Foundation/committed-fixture
energy leaking into an association window.

A generated-only differential probe used the unchanged production
`render_aligned(ratio=1, shift=5)` path, 44100-Hz input and output, and the
unchanged estimator. All probe files were temporary, outside the project data
directory. It compared the full grid, a single click at 4.0 s in an otherwise
silent file of the same duration, and the grid with only that click removed:

- Full grid and isolated 4.0-s source each have exactly one input-window peak
  at 4.000998 s, amplitude 0.8; each measures +0.498866 ms before rendering.
- Both rendered inputs produce the same diagnostic peak times and amplitudes:
  3.947551/0.625063, 3.951020/0.562699, 3.955601/0.334262,
  3.959070/0.302109, and 3.979456/0.134956.
- Both raise the same ambiguity: comparable energy at 3.9795 s besides the
  3.9472-s crossing. The late peak exceeds the existing 20%-of-maximum gate
  and is outside its unchanged 15-ms same-burst exemption.
- Removing the source click makes the entire 3.9–4.1-s output association
  window silent. Neighboring grid clicks are not supplying that energy.

Thus the competing output energy is reproduced by transforming a single
source event; the responsible internal filter stage is not established.
Moving source positions, narrowing the window to discard this peak, enlarging
the same-burst exemption, or omitting the event would evade rather than repair
the required fail-closed measurement. No such change was made. A revised,
independently calibrated measurement contract or explicit failed/unmeasured
whole-case authorization is needed to proceed without production changes.

The report gate remains red, so no commit or push was made and 13A.2/13A.3
remain incomplete. Existing uncommitted work and unrelated untracked paths
were preserved. `node --check tests/browser/timing_bench.js` passed; shipped
HTML/CSS/JS total remains **589587 bytes**, unchanged (the prior checkpoint
records the authorized 600000 soft / 650000 hard limits). No environment sync,
production edit, device capture, main-branch change, or 13B work occurred.

## 2026-09-12 run-3 re-audit — authorized unmeasured path, 13A candidate

Cursor Spark's authorization, relayed by Richard, supersedes the stop above;
the historical failed runs remain unchanged. This is test/support/evidence
closure, not timing acceptance. The estimator and every constant in
`tests/listening_bench.py` remain byte-for-byte unchanged. No association/search
window widening, threshold retuning, removed onset, partial distribution,
production compensation, or new acceptance tolerance is used.

### Explicit unmeasured case

`pitch-shift5-sr44100` retains all 16 expected onsets. Its
`measurementStatus` is `unmeasured`; `offsetsMs`, `summary` (including worst
offset and n), and `driftPerMinuteMs` are null for the WHOLE case. There is no
n=14 substitute. Its per-case `unmeasuredMetrics` entries name both failures:

- Expected onset **4.0 s**, association window **[3.9, 4.1] s**:
  comparable transient energy at **3.9795 s** besides the **3.9472 s** crossing.
- Expected onset **6.5 s**, association window **[6.4, 6.6] s**:
  comparable transient energy at **6.4590 s** besides the **6.4437 s** crossing.

Each reason is the unchanged estimator's actual exception. These competing
peaks prevent unambiguous attribution under the existing 20%-of-peak gate
and 15-ms same-burst exemption. The earlier single-source diagnosis still
applies; the responsible internal filter is not established. All windows are
checked so the first ambiguity cannot conceal another. Independent peak-based
dropout and clipping measurements remain available: 16/16 expected windows
contain peaks above absolute amplitude 0.2, zero dropped windows, true peak
-5.0 dB. Peak presence does NOT make onset timing measured. Class A's
`timingComplete` is false despite successful benchmark/report integrity tests.

### 13A.2 current generated matrix

All inputs use the same 16-click, 120-BPM grid, 1-second lead-in; every output
is verified as 44100 Hz. This capture used Python 3.12.13, ffmpeg n9.0.1,
Linux 7.2.2-1-cachyos. Values below come from the regenerated ignored
`benchmark_report.json`, captured on baseline
`4573b298dcddd02033c8173cb2d50e9a95d1e241` plus this uncommitted test patch.
The report commit field names that baseline, not a future commit.

| Case ID | n | Mean ms | p50 ms | p95 ms | Stdev ms | Worst signed ms | Drift ms/min | True peak dB | Dropouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| unshifted-sr22050 | 16 | -21.294 | -22.379 | -18.178 | 1.816 | -22.738 | -6.871 | -4.9 | 0 |
| unshifted-sr44100 | 16 | -20.460 | -22.119 | -15.891 | 3.511 | -22.738 | 18.956 | -4.9 | 0 |
| unshifted-sr48000 | 16 | -20.451 | -22.118 | -15.856 | 3.541 | -22.738 | 19.228 | -4.9 | 0 |
| pitch-shift-3-sr44100 | 16 | -36.824 | -38.150 | -31.032 | 4.438 | -41.286 | 26.208 | -5.0 | 0 |
| pitch-shift5-sr44100 | unmeasured | null | null | null | null | null | null | -5.0 | 0 |
| tempo-ratio0.8 | 16 | -26.413 | -29.885 | -15.062 | 5.872 | -30.791 | -6.976 | -4.9 | 0 |
| tempo-ratio1.25 | 16 | -16.165 | -16.222 | -13.859 | 1.990 | -19.083 | -11.058 | -4.9 | 0 |
| nonzero-cue-0.4s | 16 | -21.070 | -22.018 | -18.144 | 1.853 | -22.737 | 4.784 | -4.9 | 0 |
| combined-cue0.4-tempo1.25 | 16 | -16.352 | -16.512 | -13.866 | 1.913 | -19.128 | -3.147 | -4.9 | 0 |

The single combined case exercises distinct input-trim-before-atempo ordering
in `assembler.render_aligned`: expected `(sourceOnset - 0.4) / 1.25`, not
`sourceOnset / 1.25 - 0.4`. No further ambiguous matrix events were found.
Raw offsets, minima/maxima, actual expected times, and per-window peak counts
are in the JSON. Drift is least-squares over destination spacing, not index
spacing assumed to be unchanged by tempo.

The deliberately removed sixth source click (3.5 s) is rendered through tempo
1.25; the helper raises `OnsetMeasurementError` for the missing event with
both strict and ambiguity-reporting policies. Missing/silent/out-of-window
events cannot become partial or authorized-unmeasured successes. Strict +5
measurement also still raises; only explicit report-policy opt-in catches
ambiguity, and then discards the entire timing series rather than shortening it.

### 13A.3 report boundary and quality coverage

`committed-boundary-32beat-isolated` and `committed-boundary-32beat-mixed`
are now report cases, through production `build_mash(committed_sources=...)`:
destination beat 32 is **16.0 s**, source trim begins at 1.0 s for a 1-second
region, and BOTH expected clicks **[16.0, 16.5] s** are measured.

| Condition | n | Mean ms | p50 ms | p95 ms | Stdev ms | Worst signed ms | Drift ms/min | True peak dB | Dropouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| isolated (Foundation gain 0) | 2 | -8.820 | -8.820 | -0.433 | 13.178 | -18.138 | -2236.440 | -4.8 | 0 |
| mixed (Foundation gain 0.8) | 2 | -11.189 | -11.189 | -0.752 | 16.400 | -22.786 | -2783.172 | -1.5 | 0 |

Those two-point slopes are short-region measurements, NOT long-playback drift
stability. The generated Foundation has a transient at 2.0 s in an 18-second
file. A separately rendered Foundation-only control has nonzero output energy
elsewhere but exact zero amplitude in both committed association windows;
its measured window peaks **[0.0, 0.0]** are embedded in both conditions.
Thus Foundation cannot supply the measured committed onsets. This is not a
dense overlapping-music benchmark.

The report has **15 Class-A cases**: nine matrix cases, two retained historical
9-second placements, two beat-32 conditions, the full-grid drift reference,
and the four-position calibration sweep. Every rhythmic/committed case has
clipping and dropout data; the independent calibration sweep explicitly names
its uncollected clipping/dropout/drift metrics in `unmeasuredMetrics`.
Strict JSON serialization rejects NaN/Infinity before writing; readback is
also validated. Observations are derived from current case values.

RED/GREEN proof: the new ambiguity-policy and transformed-dropout tests first
failed on the absent helper opt-in (3 failed), then passed (3 passed). The
report truth gate next failed because the beat-32 cases were absent, then
passed after report implementation. Independent read-only review found no
security or logic errors and reproduced **47 passed in 14.09 s**, plus green
Node syntax and diff-whitespace checks.

Class B remains **stale**, not embedded or recaptured. Class C remains
**unmeasured**, never PASS; `acceptanceTolerances` remains null. No 13B work,
device audio, dependency/environment sync, production edits, main changes,
tags, or project-data-directory access occurred. Static shipped HTML/CSS/JS
is **589587 bytes**, unchanged. Only the two already-tracked test/evidence
files belong to the commit; unrelated untracked paths remain excluded.
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
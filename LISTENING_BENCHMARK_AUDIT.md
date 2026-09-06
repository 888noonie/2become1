# Slice 1 — Astra audit and implementer handoff

Status: CHANGES REQUESTED. No merge or acceptance authorized by this audit.
Baseline: `01920f8`. Audited head: `59ffc523698bd68ce2416cddb5e8961b3af64d61`.
Branch: `benchmark-listening-timing`.

Richard remains the human relay. Implementer owns substantial code changes;
Astra owns review and the documentation/comment corrections described below.
No A2A/router work is in scope. Do not overwrite the uncommitted audit edits.
Do not touch `.vscode/`, credentials, dependency installations, or persistent data.
Do not compensate engine latency or start security/resource Slice 2 here.

## Verified evidence

- Remote branch and local HEAD matched the audited SHA.
- CI https://github.com/888noonie/2become1/actions/runs/34062058079 passed
  `test` and `browser-e2e` at that exact SHA. This does NOT mean the new timing
  browser script ran in CI; it is not wired into the workflow.
- Local full Python suite: 471 passed, 1 skipped (139.25 s), before comment edits.
  Targeted recheck identifies the skip at `tests/test_phase10a_bounds.py:115`:
  detected BPM 85.7 makes 64 beats exceed the fixture duration.
- Local full frontend suite: 328 passed, zero failures.
- Local listening benchmark: 7 passed; all nine Class A headline offsets reproduced.
- Local Chromium timing script: all six cases returned success, but see B below.
- Static assets: 489,004 bytes; production code unchanged by the branch.
- Full browser UI journeys were verified via existing head CI, not rerun locally
  for this documentation/comment-only audit patch.
- After edits: benchmark plus Phase 10 bounds tests returned 14 passed,
  1 skipped; Chromium returned six successes; report regeneration returned
  7 passed. JS syntax and `git diff --check` passed. The exact reproduction
  command below was executed and reproduced every additional probe value.

## A — High: measure the region, not only its first click

Locations: `tests/test_listening_benchmark.py`,
`test_phrase_launch_through_committed_layer_pipeline` and report assembly.

The committed fixture has two clicks, but only the first is measured. Using
exactly the committed benchmark mix (including anchor_gain=0.8):

| Expected onset | Observed minus expected |
| --- | --- |
| 9.0 s | +0.426172 ms |
| 9.5 s | -22.777583 ms |

An additional isolation probe with both base gains zero returned +0.498570 ms
and -18.138438 ms. These are separate conditions, not interchangeable results.
The exact-mix result alone defeats the prior broad timing-clean conclusion.
Every existing Class A report case has n=1; drift is not measured.

Required implementation:

1. Add measurement tests first: multi-onset fixtures, known displacement and
   drift, missing clicks, silence, and wrong-peak association. Define estimator
   calibration/bias explicitly; it currently thresholds absolute amplitude,
   not squared energy, despite its terminology.
2. Measure all expected committed clicks and a multi-beat rhythmic sequence
   through representative rate/pitch/tempo/cue paths. Report raw offsets,
   count, distributions and drift where actually measurable. Keep one-shot
   cases labeled as such. Do not promote a search-window clamp to an acceptance
   tolerance.
3. Separate an isolated committed-layer case from a mixed/routed case so the
   estimator cannot silently use Foundation energy to stand in for a layer.
4. Exercise an actual documented phrase boundary. Current offline launch is
   1 + 16 * 0.5 = 9 seconds; browser cases use 32-beat phrases. The evidence
   label has been corrected, but shared phrase semantics remain to be tested.
5. Add explicit clipping/dropout metrics or list them as unmeasured coverage
   gaps. Do not claim a complete listener benchmark from this bounded slice.

No engine correction is requested. A measured early onset is a finding, not
permission to redesign timing or hardcode compensation.

## B — High: exercise the actual scheduler and assert outcomes

Location: `tests/browser/timing_bench.js`, scenario runner and PASS decision.

The script imports derive/normalize/errors, not GhostScheduler. It duplicates
minimum-lead logic, supplies synthetic nowAudioTime while OfflineAudioContext
stays at zero, calls source.start itself and authors its own receipt. It never
starts rendering. `ok` is the only PASS criterion: wrong numeric outcomes need
not fail. Real decode latency does not advance the supplied clock.

Required implementation:

1. Run the production GhostScheduler in Chromium with real Web Audio nodes.
   Use the existing scheduling seams; avoid another copy of scheduler policy.
2. Capture actual calls to source.start and the production onScheduled receipt.
   Assert expected beat, launch time, start count, lead behavior and receipt
   parity against independent scenario expectations, not the same helper used
   by production. Demonstrate a deliberately wrong expectation fails.
3. Make clock provenance explicit. If a controlled clock is required for fast,
   deterministic tests, label it as injected rather than a running device clock.
   Include a real-clock observation if claiming live-clock scheduling coverage.
4. Make decode-crossing coverage causal: advancing the scheduling clock across
   a boundary while decode is pending must change the scheduler result.
5. `nonzero-cue` currently supplies no cue/trim field, and `tempo-ratio-1-25`
   changes only transport BPM. Rename to the behavior actually exercised or
   implement the claimed path. Neither name alone establishes asset transforms.
6. Report nonzero exit status for assertion/page errors; clean up browser
   resources on failure. Do not wire a misleading smoke test into CI.

CommittedLayerEngine coverage is distinct from GhostScheduler coverage. State
which is exercised; the longer live/lifecycle matrix remains a follow-up unless
Richard explicitly expands this slice.

## C — Medium: do not turn fixture offsets into a fixed-latency diagnosis

Locations: `tests/test_listening_benchmark.py`, hardcoded `observations`;
`LISTENING_BENCHMARK_EVIDENCE.md` (wording corrected by Astra).

Same render_aligned configuration (44.1k, ratio=1, shift=0), different source
onsets, same generated transient shape and 2-second duration:

| Source onset | Offset ms |
| --- | --- |
| 0.25 s | -19.641745 |
| 0.50 s | -18.138277 |
| 1.00 s | -22.726383 |
| 1.25 s | -20.546398 |

Required implementation:

- Remove fixed numeric conclusions from fresh report assembly; derive summaries
  from that run or preserve explicitly dated/reference baseline interpretations
  separately. A changed result must not retain a stale +0.43 ms conclusion.
- Add a source-position sweep. Isolate filters only if pursuing a causal claim;
  otherwise keep the mechanism unknown. Deterministic per fixture is not a
  universal fixed latency.
- Correct amplitude/energy method descriptions to match the implementation.
  Do not silently change the estimator without recalibration and new evidence.

## D — Medium: retain and validate browser provenance

Location: `tests/test_listening_benchmark.py`, optional receipts ingestion;
`tests/browser/timing_bench.js`, report construction.

An arbitrary existing receipts.json is embedded under today's outer commit and
Python environment. The browser artifact lacks a commit/timestamp; even its
executable-path metadata is discarded by the combined report.

Required implementation:

- Store per-class commit, source identity/dirty-state policy, capture time,
  browser version, OS and context/sample-rate/clock details. Do not label an
  executable path as a browser version or invent device buffer settings for an
  offline context.
- Preserve this metadata when embedding; never relabel old receipts as current.
- Validate schema, expected scenario IDs/count, unique IDs, success flags and
  finite numeric values. Stale, malformed, partial, failed and missing captures
  must fail clearly or be explicitly labeled unmeasured/unverified.
- Add tests for each of those ingestion cases and for matching fresh evidence.

## Cheap fixes already applied by Astra

- Evidence status changed to changes requested; removed fixed-latency and
  broad timing-clean interpretations and corrected the 9-second launch label.
- Described n=1, the unmeasured drift, synthetic browser clock, unasserted PASS
  and stale-provenance risk honestly.
- Corrected browser comments claiming GhostScheduler was loaded or receipts
  were read from source nodes; corrected the stale pitch expectation comment.
- No executable logic changed. The generated report's hardcoded observations
  and browser report note still require the substantive fixes above; correcting
  prose does not close A–D.

## Minimal reproduction of the additional audit probes

Run from the repo root with the existing venv. Temporary files only:

```bash
.venv/bin/python - <<'PY'
import sys, tempfile
from pathlib import Path
sys.path.insert(0, 'tests')
import listening_bench as b
from twobecomeone import assembler
with tempfile.TemporaryDirectory() as d:
    p = Path(d)
    src, out = p / 'source.wav', p / 'out.wav'
    signal, onsets = b.click_track(44100, 120, bars=4, lead_in=1)
    b.write_wav(src, signal, 44100)
    for anchor_gain in (0.8, 0.0):
        assembler.build_mash(
            assembler.MashSpec(anchor_path=src, lead_path=src,
                               lead_gain=0, anchor_gain=anchor_gain, duration=11),
            tempo_ratio=1,
            committed_sources=[dict(path=str(src), tempoRatio=1,
                sourceTrimStart=1, sourceTrimDuration=1, gainLinear=1,
                outputStart=9)], out=str(out))
        print('anchor_gain', anchor_gain,
              b.onset_offsets(b.read_wav_mono(out), 44100, [9, 9.5]))
    for onset in (.25, .5, 1, 1.25):
        b.write_wav(src, b.transient_signal(44100, onset), 44100)
        assembler.render_aligned(str(src), out, 1, 0)
        print('onset', onset,
              b.onset_offsets(b.read_wav_mono(out), 44100, [onset]))
PY
```

## Return contract and next planning checkpoint

Implement A–D test-first in bounded commits; retain this audit and reconcile
the evidence against measured results. Return exact base/head SHAs, changed
files, RED/GREEN evidence, commands/counts, report provenance and coverage gaps.
No merge or accepted status; Richard relays the result to Astra for re-audit.
Commit/push only when Richard authorizes them; this audit does not independently
grant repository write-to-remote permission.

After the correction re-audit, write the next tri-phase implementation plans
against the then-agreed exact baseline. Candidate priorities remain listener
coverage and session-token/resource hardening from CURSOR_HANDOVER.md. Do not
silently treat the whole listener matrix as finished or start the next slice
while this evidence remains misleading. Router orchestration is deferred.

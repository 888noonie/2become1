# Slice 1 listening benchmark — Astra re-audit

Status: **CONDITIONAL CHANGES REQUESTED**

Audited range: `59ffc523698bd68ce2416cddb5e8961b3af64d61..65ce92ee266fafaad5cc579251989cf71415f915`
Branch: `benchmark-listening-timing`
Remote branch at audit time: `59ffc523698bd68ce2416cddb5e8961b3af64d61`

The four correction commits are materially better and production code remains
untouched. Class B now executes GhostScheduler and asserts independently; the
onset estimator fails loudly on the tested integrity failures; observations are
run-derived; Class C stays unmeasured. Slice 1 is not yet accepted because
production-fidelity defects changed a headline result and a phrase-boundary
claim, and the requested rhythmic matrix is still only complete for one
transform path.

## Finding 1 — HIGH, cheap-fixed: input rate was mistaken for output rate

At audited head `65ce92e`, the 22.05/44.1/48-kHz fixture loops passed each input
rate into `assembler.render_aligned(..., sr=sr)`. In production,
`render_aligned` is called without that argument and its `sr` parameter is the
working/output rate, not input metadata (`src/twobecomeone/assembler.py:190-215`,
production callers at `assembler.py:334-378`). The source WAV already carries
its input rate.

Consequence: the published 48-kHz result (`-19.417 ms`) described a 48-kHz
output path that production does not use. With every input fixture rendered
through the production-default 44.1-kHz output, the three current unshifted
results are all `-22.726 ms` on this host. This does not change the conclusion
that offsets are observed rather than a fixed compensable latency, but it
changes a headline datum and proves the old rate comparison was mislabeled.

Astra's uncommitted TDD fix:

- Added a failing output-rate assertion (observed 22050 vs expected 44100).
- Removed input-rate values from the assembler output-rate argument in rate and
  pitch matrices and report assembly.
- Added `outputSampleRate: 44100` to report cases.
- Re-ran the benchmark: 17 passed; corrected report regenerated.

## Finding 2 — HIGH, cheap-fixed: “beat 32” was placed at destination beat 34

`tests/test_listening_benchmark.py` set the claimed beat-32 destination launch
to `1.0 + 32 * 0.5 = 17.0 s`. The one-second lead-in belongs to the source
fixture and is already removed by `sourceTrimStart=1.0`; `outputStart` is the
absolute destination timeline. At 120 BPM with destination beat 0 at time 0,
beat 32 is 16.0 seconds, matching production `resolveNextPhrase` math.

The separate test is corrected to 16.0 seconds. The generated report repeated
the source/destination confusion by calling its historical 9.0-second placement
a 16-beat phrase boundary; the audit patch now labels it as arbitrary destination
beat 18 and records source trim separately. The 32-beat observation remains
test-only until Phase 13A adds it to the generated report.

## Finding 3 — HIGH, remains for Phase 13A: only tempo has a rhythmic series

The original audit required multi-onset representative rate, pitch, tempo and
cue paths. At `tests/test_listening_benchmark.py:80-132` and report assembly,
unshifted-rate, pitch and cue headline cases still use one transient (`n=1`).
Only `drift-tempo-ratio-1.25-full-grid` measures the full 16-click series.

Therefore the implementation cannot yet report within-region displacement,
dropouts or drift for rate conversion, pitch shifts or nonzero cue. The coder's
claim that all A findings were closed was too broad. Phase 13A in the attached
plan makes this the first substantial correction rather than expanding engine
scope.

## Finding 4 — MEDIUM, cheap-fixed: onset association could claim an outside burst

A transient beginning at 0.895 s and measured against 1.0 s was reported as
`-104.490 ms` rather than rejected. Its decay leaked into the association
window; `locate_onset` then walked back outside that window to the stronger
burst. Astra added a RED test and now requires the resolved rise crossing to
remain inside the expectation's association bounds. Invalid zero, negative and
non-finite drift intervals now raise a bounded `ValueError` instead of emitting
warnings, nonsense slopes or NumPy linear-algebra errors.

## Finding 5 — MEDIUM, cheap-fixed: provenance validation accepted incomplete captures

At audited head, `tests/receipts_ingestion.py` required top-level key presence,
nonempty unique IDs and `case.ok`, but it accepted:

- any nonempty scenario subset instead of the expected eight IDs/count;
- `selfTestWrongExpectationDetected: false`, `measured: false`, or a nonzero
  top-level assertion count;
- a nonempty `assertionFailures` list hidden behind `ok: true`;
- non-finite numeric values outside three receipt fields;
- a receipt whose `proposalId` did not belong to its case;
- ill-typed capture metadata and boolean lookalikes such as integer `1`;
- a non-string/unhashable scenario ID could escape validation with `TypeError`;
- a capture with no policy proving the benchmark/production source scope was
  clean at the reported commit.

Astra added failing tests for each bypass, then implemented exact scenario-set,
truth-gate, typed metadata, recursive finite-number, bounded scenario-ID,
proposal-parity and source-scope checks.
The Chromium artifact now records both global dirtiness and
`benchmarkSourcesDirtyAtCapture` under the explicit policy
`commit match + clean benchmark source scope`. Unrelated `.vscode/` does not
invalidate source identity. Because these edits are not committed, a fresh
capture correctly reports the benchmark source scope dirty and Class B is
currently labeled `invalid`; after an authorized commit it must be recaptured.

## Finding 6 — MEDIUM, cheap-fixed: report claimed metrics it did not contain

The report prose said clipping/dropout were measured for committed cases, but
those cases contained no clipping or dropout fields. Astra added the real
`assembler.measure_clipping` result, expected/detected click counts and detected
peak times to both isolated and mixed committed cases, with report truth gates.
The stale per-case string `energy-rise` was corrected to `amplitude-rise`.

## Finding 7 — LOW, cheap-fixed: browser metadata and cleanup details

- OS `release` incorrectly contained Node's release name (`"node"`); it now uses
  `node:os.release()`.
- Harness bootstrap failure used `process.exit()` inside `try`, bypassing
  browser cleanup; it now throws through `finally`.
- A comment said `source.start` was not forwarded although the wrapper called
  the real method; wording now matches execution.
- The real-context observation could pass with a suspended clock at zero; it
  now resumes, waits and asserts both `running` state and clock advance.
- The comparator now checks returned-receipt/onScheduled-receipt parity, and
  controlled scenarios exercise the production constructor's default lead
  rather than injecting another hardcoded default.
- Ingestion now requires positive finite sample rate, clock/state shape and
  controlled `capturedStarts` parity with the receipt.

## Finding 8 — LOW, cheap-fixed: sweep test pinned the current defect

The position-sweep test required `spread > 0`, so a future perfectly aligned or
constant-offset render would fail the benchmark. It now requires all four
finite measurements and leaves position dependence as a run-derived
observation rather than a permanent invariant.

## What passed

Current shared worktree after cheap fixes:

- Full Python after all cheap fixes: **507 passed, 1 skipped** (the known Phase
  10 bounds skip).
- Frontend Node: **328 passed, 0 failed**.
- General browser journeys: **30/30 desktop and 30/30 mobile**.
- Ghost live journeys: **13/13 desktop and 13/13 mobile**.
- Focused benchmark/ingestion after all fixes: **43 passed**.
- Chromium scheduler benchmark: seven controlled scenarios, wrong-expectation
  self-test and one real-clock observation all PASS.
- JavaScript syntax, Python compile and `git diff --check`: clean.
- Static assets: **489,004 bytes**; unchanged and below 500,000.

Generated/ignored reports are not source commits. `.vscode/` remains untracked
and untouched. No dependency, production engine/server, persistent-data, push,
merge or history operation occurred.

## Coder assessment

**Yes—the coder is up to scratch for implementation.** The work shows useful
TDD behavior, good production-module tracing, honest correction of its own bad
expectations, and a sound separation of evidence classes. The Class-B rewrite
is a substantial improvement rather than benchmark theatre.

The limitation is self-audit precision: “all findings addressed” overstated the
result. The coder missed the `sr` parameter's production meaning, did not finish
the requested multi-onset matrix, and treated key presence as stronger schema
validation than it was. Keep this coder as the efficiency implementer, but keep
Astra's independent audit gate and require claim-to-acceptance-criterion mapping
in each return contract.

## Disposition and handoff

- Do not push the four prior correction commits yet as accepted evidence.
- Richard may authorize one bounded commit containing Astra's cheap fixes after
  reviewing this re-audit. Recapture Class B only after that commit so source
  identity can be current and clean.
- Continue with Phase 13A only after an exact baseline SHA is recorded.
- Phases 13B/C finish runtime/load and loopback evidence; they do not authorize
  timing compensation.
- Session-token/resource hardening follows as a separate security tri-phase.
- Router/A2A orchestration remains deferred.

Implementation plan:
`.hermes/plans/2026-09-07_000314-phase13-listener-truth-closure.md`

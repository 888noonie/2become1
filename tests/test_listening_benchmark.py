"""Executable listening/timing baseline — handover priority item 1.

Evidence classes stay separate:
  A. Offline rendered samples   (this file, assembler.render_aligned + build_mash)
  B. Browser scheduling events  (tests/browser/timing_bench.js, real Chromium)
  C. Loopback recordings        (format defined in listening_bench.loopback_report_skeleton;
                                 explicitly NOT measured — measured:false)

This test file IS the benchmark: when it passes it has produced a
benchmark_report.json with measured signed onset offsets, drift, distributions
and worst cases for class A, and a defined (never fabricated) class C format.
Scheduling receipts (class B) prove Web Audio intent, not audible timing;
acceptance tolerances are deliberately pending everywhere (None).
"""
from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest

from twobecomeone import assembler

import listening_bench as bench


# ---------------------------------------------------------------------------
# Fixtures: deterministic generated signals only
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def bench_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("listening_bench")


@pytest.fixture(scope="module")
def transients(bench_dir):
    """Transient fixtures at 22.05/44.1/48 kHz with known onset positions."""
    out = {}
    for sr in (22050, 44100, 48000):
        path = bench_dir / f"transient_{sr}.wav"
        bench.write_wav(path, bench.transient_signal(sr, onset=1.0, duration=2.0), sr)
        out[sr] = path
    return out


@pytest.fixture(scope="module")
def click_grid(bench_dir):
    """120 BPM click grid for phrase-launch and committed-layer cases."""
    path = bench_dir / "click_120bpm.wav"
    signal, onsets = bench.click_track(44100, bpm=120.0, bars=4, lead_in=1.0)
    bench.write_wav(path, signal, 44100)
    return path, onsets


# ---------------------------------------------------------------------------
# Measurement self-calibration — the estimator must see what we change
# ---------------------------------------------------------------------------

def test_onset_estimator_detects_shifted_signal_not_blind(bench_dir):
    """Self-calibration: two fixtures with genuinely different onsets (1.0 s
    vs 1.05 s) measured against the SAME probe onset must differ by ~50 ms.
    Proves the estimator tracks real displacement rather than a constant."""
    sr = 44100
    offsets_by_onset = {}
    for label, onset in (("a", 1.0), ("b", 1.05)):
        path = bench_dir / f"calib_{label}.wav"
        bench.write_wav(path, bench.transient_signal(sr, onset=onset, duration=2.0), sr)
        samples = bench.read_wav_mono(path)
        offsets_by_onset[label] = bench.onset_offsets(samples, bench.OUTPUT_SR, [1.0])[0]
    separation = offsets_by_onset["b"] - offsets_by_onset["a"]
    assert 25.0 <= separation <= 75.0, offsets_by_onset


# ---------------------------------------------------------------------------
# Class A — offline rendered samples
# ---------------------------------------------------------------------------

def test_unshifted_playback_preserves_onset_positions(bench_dir, transients):
    """Every input sample rate: render through render_aligned unshifted,
    measure signed onset offsets against the known fixture onsets."""
    for sr, path in transients.items():
        out = bench_dir / f"unshifted_{sr}.wav"
        assembler.render_aligned(str(path), out, tempo_ratio=1.0, semitone_shift=0)
        samples = bench.read_wav_mono(out)
        offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, [1.0])
        summary = bench.summarize(offsets)
        # Measured-observation gate, not an acceptance tolerance (pending).
        assert abs(summary["worstCaseMs"]) <= 200.0, summary


def test_input_rate_matrix_uses_production_44100_output(bench_dir, transients):
    """Input rate is a fixture property; production keeps 44.1 kHz output."""
    for input_sr, path in transients.items():
        out = bench_dir / f"production-output-from-{input_sr}.wav"
        assembler.render_aligned(
            str(path), out, tempo_ratio=1.0, semitone_shift=0)
        with wave.open(str(out), "rb") as rendered:
            assert rendered.getframerate() == bench.OUTPUT_SR


def test_pitch_shift_preserves_onset_positions(bench_dir, transients):
    """Nonzero pitch shifts: the pipeline compensates duration by design
    (asetrate + counter-atempo, the PR #1 correctness fix), so onsets stay at
    their source times. The benchmark measures that, it does not assume it."""
    for sr, path in transients.items():
        for shift in (-3, 5):
            out = bench_dir / f"shift{shift}_sr{sr}.wav"
            assembler.render_aligned(str(path), out, tempo_ratio=1.0,
                                     semitone_shift=shift)
            samples = bench.read_wav_mono(out)
            expected = [1.0]
            offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, expected)
            summary = bench.summarize(offsets)
            assert abs(summary["worstCaseMs"]) <= 200.0, summary


def test_tempo_ratio_scales_onset_times(bench_dir, transients):
    """Representative tempo ratios 1.25/0.8: onset times scale by 1/ratio
    exactly as the atempo chain dictates; measured, not assumed."""
    path = transients[44100]
    for ratio in (1.25, 0.8):
        out = bench_dir / f"tempo{ratio}.wav"
        assembler.render_aligned(str(path), out, tempo_ratio=ratio,
                                 semitone_shift=0, sr=44100)
        samples = bench.read_wav_mono(out)
        expected = [1.0 / ratio]
        offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, expected)
        summary = bench.summarize(offsets)
        assert abs(summary["worstCaseMs"]) <= 200.0, summary


def test_committed_placement_measures_all_committed_clicks(bench_dir, click_grid):
    """Audit A: measure the whole committed region, not only its first click.

    Exact committed benchmark mix (anchor_gain=0.8): the trimmed 1 s region
    contains two clicks, so expected onsets are the output placement AND the
    second click one beat later. The first click is not representative of the
    render path by itself (the file head absorbs part of the advance).
    """
    path, onsets = click_grid
    planned_launch = 9.0  # arbitrary destination placement; beat 18 at 120 BPM
    interval = 0.5

    committed = [{
        "path": str(path),
        "tempoRatio": 1.0,
        "sourceTrimStart": onsets[0],   # region starts at the first click
        "sourceTrimDuration": 1.0,
        "gainLinear": 1.0,
        "outputStart": planned_launch,
    }]
    spec = assembler.MashSpec(
        anchor_path=path, lead_path=path,
        lead_gain=0.0,  # silence the base Lead; only the committed layer sounds
        anchor_gain=0.8,
        duration=planned_launch + 2.0,
    )
    out = bench_dir / "committed_placement.wav"
    assembler.build_mash(spec, tempo_ratio=1.0, committed_sources=committed, out=str(out))
    samples = bench.read_wav_mono(out)
    expected = [planned_launch, planned_launch + interval]
    offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, expected)
    summary = bench.summarize(offsets)
    # Both clicks must be measured (n=2), each within the observation window.
    assert summary["n"] == 2, summary
    assert all(abs(o) <= 200.0 for o in offsets), offsets


def test_isolated_committed_layer_is_a_distinct_condition_from_mixed(
        bench_dir, click_grid):
    """Audit A: the estimator must not silently use Foundation energy in place
    of the layer. Isolated (anchor_gain=0) and mixed (anchor_gain=0.8) are
    separate conditions; both are measured over both clicks and reported as
    distinct cases whose offsets are NOT assumed interchangeable."""
    path, onsets = click_grid
    planned_launch = 9.0
    expected = [planned_launch, planned_launch + 0.5]
    by_condition = {}
    for condition, anchor_gain in (("isolated", 0.0), ("mixed", 0.8)):
        committed = [{
            "path": str(path), "tempoRatio": 1.0,
            "sourceTrimStart": onsets[0], "sourceTrimDuration": 1.0,
            "gainLinear": 1.0, "outputStart": planned_launch,
        }]
        spec = assembler.MashSpec(
            anchor_path=path, lead_path=path, lead_gain=0.0,
            anchor_gain=anchor_gain, duration=planned_launch + 2.0,
        )
        out = bench_dir / f"committed_placement_{condition}.wav"
        assembler.build_mash(spec, tempo_ratio=1.0, committed_sources=committed,
                             out=str(out))
        samples = bench.read_wav_mono(out)
        offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, expected)
        assert len(offsets) == 2, (condition, offsets)
        by_condition[condition] = offsets
    # The conditions are measured separately; record that they differ rather
    # than asserting which is "correct" (no engine change authorized).
    assert by_condition["isolated"] != by_condition["mixed"], by_condition


def test_32beat_phrase_boundary_launch_through_committed_pipeline(
        bench_dir, click_grid):
    """Audit A: exercise the documented production phrase length. The
    transport default is phraseBars=8 at 4/4 -> 32 beats per phrase (the same
    boundary the browser scheduler resolves). Launch the committed layer at
    beat 32 offline and measure every click of the committed region."""
    path, onsets = click_grid
    planned_launch = 32 * 0.5  # destination beat 32 at 120 BPM = 16.0 s
    committed = [{
        "path": str(path), "tempoRatio": 1.0,
        "sourceTrimStart": onsets[0], "sourceTrimDuration": 1.0,
        "gainLinear": 1.0, "outputStart": planned_launch,
    }]
    spec = assembler.MashSpec(
        anchor_path=path, lead_path=path, lead_gain=0.0, anchor_gain=0.8,
        duration=planned_launch + 2.0,
    )
    out = bench_dir / "phrase_launch_32beat.wav"
    assembler.build_mash(spec, tempo_ratio=1.0, committed_sources=committed,
                         out=str(out))
    samples = bench.read_wav_mono(out)
    offsets = bench.onset_offsets(samples, bench.OUTPUT_SR,
                                  [planned_launch, planned_launch + 0.5])
    assert len(offsets) == 2, offsets
    assert all(abs(o) <= 200.0 for o in offsets), offsets


def test_drift_measured_over_full_click_sequence(bench_dir, click_grid):
    """Audit A: drift requires a series. Render the whole 16-click grid through
    a representative tempo path and measure EVERY expected onset; report the
    distribution and least-squares drift from the actual measured series."""
    path, onsets = click_grid
    ratio = 1.25
    out = bench_dir / "drift_tempo1.25.wav"
    assembler.render_aligned(str(path), out, tempo_ratio=ratio,
                             semitone_shift=0, sr=44100)
    samples = bench.read_wav_mono(out)
    expected = [(1.0 + k * 0.5) / ratio for k in range(len(onsets))]
    offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, expected)
    summary = bench.summarize(offsets)
    assert summary["n"] == len(onsets), summary
    drift = bench.drift_per_minute(offsets, interval_s=0.5 / ratio)
    assert drift is not None
    assert all(abs(o) <= 200.0 for o in offsets), offsets


def test_source_position_sweep_records_all_positions(bench_dir):
    """Audit C: same render_aligned configuration, different source onsets —
    the offsets are recorded as a sweep. The test asserts the sweep is
    measured and reports its spread; it must NOT conclude a fixed latency."""
    sr = 44100
    sweep = []
    for onset in (0.25, 0.5, 1.0, 1.25):
        src = bench_dir / f"sweep_src_{onset}.wav"
        out = bench_dir / f"sweep_out_{onset}.wav"
        bench.write_wav(src, bench.transient_signal(sr, onset=onset), sr)
        assembler.render_aligned(str(src), out, tempo_ratio=1.0,
                                 semitone_shift=0, sr=sr)
        samples = bench.read_wav_mono(out)
        offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, [onset])
        sweep.append({"sourceOnsetSec": onset, "offsetsMs": offsets})
    offsets = [point["offsetsMs"][0] for point in sweep]
    assert len(sweep) == 4
    assert all(np.isfinite(offset) for offset in offsets), sweep


def test_missing_click_raises_not_misreports(bench_dir, click_grid):
    """Audit A: a dropped click must surface as an explicit measurement error,
    never as a silent wrong-peak association (the estimator used to latch onto
    whatever energy existed in the window)."""
    path, onsets = click_grid
    signal, _ = bench.click_track(44100, bpm=120.0, bars=4, lead_in=1.0)
    # Remove the 6th click (index 5, source onset 3.5 s).
    gap_start, gap_end = int(3.49 * 44100), int(3.52 * 44100)
    signal[gap_start:gap_end] = 0.0
    dropped = bench_dir / "dropped_click.wav"
    bench.write_wav(dropped, signal, 44100)
    assembler.render_aligned(str(dropped),
                             bench_dir / "dropped_rendered.wav",
                             tempo_ratio=1.0, semitone_shift=0, sr=44100)
    samples = bench.read_wav_mono(bench_dir / "dropped_rendered.wav")
    with pytest.raises(bench.OnsetMeasurementError):
        bench.onset_offsets(samples, bench.OUTPUT_SR, [3.5])


def test_all_silence_raises_not_zero(bench_dir):
    """Audit A: silence must be a measurement error, never a measured 0 ms."""
    silent = bench_dir / "silence.wav"
    bench.write_wav(silent, np.zeros(44100 * 2), 44100)
    samples = bench.read_wav_mono(silent)
    with pytest.raises(bench.OnsetMeasurementError):
        bench.onset_offsets(samples, bench.OUTPUT_SR, [1.0])


def test_ambiguous_double_transient_raises(bench_dir):
    """Audit A: two transients inside one search window must be flagged as
    ambiguous instead of silently reporting the stronger one."""
    sr = 44100
    signal = bench.transient_signal(sr, onset=1.0) \
        + bench.transient_signal(sr, onset=1.03)
    ambiguous = bench_dir / "ambiguous.wav"
    bench.write_wav(ambiguous, signal, sr)
    samples = bench.read_wav_mono(ambiguous)
    with pytest.raises(bench.OnsetMeasurementError):
        bench.onset_offsets(samples, bench.OUTPUT_SR, [1.0])


def test_transient_outside_association_window_raises_not_reattributes_tail():
    """A burst just outside the window can leak a decay tail into it; the
    estimator must not walk outside association bounds to claim that burst."""
    sr = 44100
    signal = bench.transient_signal(sr, onset=0.895)
    with pytest.raises(bench.OnsetMeasurementError):
        bench.onset_offsets(signal, sr, [1.0])


@pytest.mark.parametrize("interval", [0.0, -0.5, float("nan")])
def test_drift_rejects_invalid_interval(interval):
    with pytest.raises(ValueError, match="interval"):
        bench.drift_per_minute([0.0, 1.0], interval)


def test_estimator_calibration_and_polarity_documented(bench_dir):
    """Audit A/C: the estimator's instrument bias is measured and bounded, and
    the method's amplitude thresholding (|x|, NOT squared energy) is pinned by
    a polarity test so the description cannot silently drift."""
    sr = 44100
    path = bench_dir / "calib_bias.wav"
    bench.write_wav(path, bench.transient_signal(sr, onset=1.0), sr)
    samples = bench.read_wav_mono(path)
    offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, [1.0])
    # Instrument bias of the 50%-amplitude-rise crossing on a 1 ms attack.
    assert abs(offsets[0]) <= 1.5, offsets
    inverted = bench_dir / "calib_inverted.wav"
    bench.write_wav(inverted, -bench.transient_signal(sr, onset=1.0), sr)
    inverted_offsets = bench.onset_offsets(
        bench.read_wav_mono(inverted), bench.OUTPUT_SR, [1.0])
    # |x| thresholding: inverted polarity measures the same onset.
    assert abs(inverted_offsets[0] - offsets[0]) < 0.5, (offsets, inverted_offsets)


def test_clipping_and_dropout_recorded_for_committed_case(bench_dir, click_grid):
    """Audit A: clipping and dropout metrics are measured for the committed
    case (true peak via the production measure_clipping; dropout = expected
    clicks actually detected). Broader matrices stay listed as gaps."""
    path, onsets = click_grid
    planned_launch = 9.0
    committed = [{
        "path": str(path), "tempoRatio": 1.0,
        "sourceTrimStart": onsets[0], "sourceTrimDuration": 1.0,
        "gainLinear": 1.0, "outputStart": planned_launch,
    }]
    spec = assembler.MashSpec(
        anchor_path=path, lead_path=path, lead_gain=0.0, anchor_gain=0.8,
        duration=planned_launch + 2.0,
    )
    out = bench_dir / "committed_placement_clipping.wav"
    assembler.build_mash(spec, tempo_ratio=1.0, committed_sources=committed,
                         out=str(out))
    stats = assembler.measure_clipping(str(out))
    assert "true_peak_db" in stats, stats
    samples = bench.read_wav_mono(out)
    detected = [t for t in bench.peak_times(samples, bench.OUTPUT_SR, threshold=0.2)
                if planned_launch - 0.2 <= t <= planned_launch + 1.2]
    # Dropout check: both expected clicks are actually present in the region.
    assert len(detected) == 2, detected


def test_nonzero_cue_start_preserves_region_relative_layout(bench_dir, transients):
    """Nonzero cue: a trim starting inside the fixture moves the onset by
    exactly the trim amount, through the assembler's -ss path."""
    path = transients[44100]
    cue = 0.4
    out = bench_dir / f"cue_{cue}.wav"
    assembler.render_aligned(str(path), out, tempo_ratio=1.0, semitone_shift=0,
                             sr=44100, start=cue)
    samples = bench.read_wav_mono(out)
    offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, [1.0 - cue])
    summary = bench.summarize(offsets)
    assert abs(summary["worstCaseMs"]) <= 200.0, summary


# ---------------------------------------------------------------------------
# Report assembly — the executable baseline's deliverable
# ---------------------------------------------------------------------------

def _measure(case_id: str, source: Path, expected: float, bench_dir, *, ratio: float = 1.0,
             shift: int = 0, sr: int = 44100, start: float = 0.0,
             method: str) -> dict:
    """Render one class-A case through the real pipeline and measure it."""
    out = bench_dir / f"{case_id}.wav"
    assembler.render_aligned(str(source), out, tempo_ratio=ratio,
                             semitone_shift=shift, start=start)
    samples = bench.read_wav_mono(out)
    offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, [expected])
    return {
        "id": case_id,
        "inputSampleRate": sr,
        "outputSampleRate": bench.OUTPUT_SR,
        "tempoRatio": ratio,
        "semitoneShift": shift,
        "cueSec": start,
        "expectedOnsetsSec": [round(expected, 6)],
        "offsetsMs": offsets,
        "summary": bench.summarize(offsets),
        "method": method,
    }


def test_benchmark_report_is_complete_and_truthful(bench_dir, transients, click_grid):
    """Assemble benchmark_report.json: class A measured, class B captured by the
    browser journey when present, class C defined but explicitly not measured."""
    click_path, click_onsets = click_grid
    planned_launch = 9.0
    crossing_method = (
        "onset = amplitude-rise crossing at 50% of the search-window peak, "
        "sub-sample linear interpolation; deterministic"
    )

    class_a_cases = []

    # Unshifted playback at all three input rates.
    for sr, path in transients.items():
        case = _measure(
            f"unshifted-sr{sr}", path, 1.0, bench_dir, sr=sr,
            method=crossing_method + "; unshifted render",
        )
        case["driftPerMinuteMs"] = bench.drift_per_minute(case["offsetsMs"], 0.5)
        class_a_cases.append(case)

    # Nonzero pitch shifts at 44.1k (duration-compensated expected onset).
    for shift in (-3, 5):
        class_a_cases.append(_measure(
            f"pitch-shift{shift}-sr44100", transients[44100], 1.0, bench_dir,
            shift=shift,
            method=crossing_method + "; duration-compensated shift keeps "
                                     "onsets at source times (measured, PR #1 behavior)",
        ))

    # Representative tempo ratios.
    for ratio in (1.25, 0.8):
        class_a_cases.append(_measure(
            f"tempo-ratio{ratio}", transients[44100], 1.0 / ratio, bench_dir, ratio=ratio,
            method=crossing_method + "; expected onset scaled by 1/ratio (atempo design)",
        ))

    # Committed-layer placements through the real pipeline (build_mash),
    # per audit A: isolated and mixed conditions reported separately, both
    # clicks of the committed region measured. The historical 9-second case is
    # an arbitrary destination placement (beat 18 at 120 BPM), not a boundary.
    for condition, anchor_gain in (("isolated", 0.0), ("mixed", 0.8)):
        committed = [{
            "path": str(click_path), "tempoRatio": 1.0,
            "sourceTrimStart": click_onsets[0], "sourceTrimDuration": 1.0,
            "gainLinear": 1.0, "outputStart": planned_launch,
        }]
        spec = assembler.MashSpec(
            anchor_path=click_path, lead_path=click_path,
            lead_gain=0.0, anchor_gain=anchor_gain,
            duration=planned_launch + 2.0,
        )
        out = bench_dir / f"report-committed-placement-{condition}.wav"
        assembler.build_mash(spec, tempo_ratio=1.0, committed_sources=committed,
                             out=str(out))
        samples = bench.read_wav_mono(out)
        expected_onsets = [planned_launch, planned_launch + 0.5]
        offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, expected_onsets)
        clipping = assembler.measure_clipping(str(out))
        detected = [
            t for t in bench.peak_times(samples, bench.OUTPUT_SR, threshold=0.2)
            if planned_launch - 0.2 <= t <= planned_launch + 1.2
        ]
        class_a_cases.append({
            "id": f"committed-layer-placement-9s-{condition}",
            "anchorGain": anchor_gain,
            "destinationBeatAt120Bpm": 18,
            "sourceTrimStartSec": click_onsets[0],
            "plannedLaunchSec": planned_launch,
            "expectedOnsetsSec": expected_onsets,
            "offsetsMs": offsets,
            "summary": bench.summarize(offsets),
            "clipping": clipping,
            "dropout": {
                "expectedClickCount": len(expected_onsets),
                "detectedClickCount": len(detected),
                "detectedPeakTimesSec": detected,
            },
            "method": "adelay to an arbitrary 9.0-second output placement via build_mash "
                      "committed_sources; both committed clicks measured; "
                      "isolated (anchor_gain=0) and mixed (0.8) are distinct "
                      "conditions, not interchangeable results",
        })

    # Nonzero cue through the trim path.
    class_a_cases.append(_measure(
        "nonzero-cue-0.4s", transients[44100], 1.0 - 0.4, bench_dir, start=0.4,
        method=crossing_method + "; -ss trim at the cue",
    ))

    # Drift over the full 16-click grid (audit A: drift needs a series).
    drift_ratio = 1.25
    out = bench_dir / "report-drift-tempo1.25.wav"
    assembler.render_aligned(str(click_path), out, tempo_ratio=drift_ratio,
                             semitone_shift=0, sr=44100)
    samples = bench.read_wav_mono(out)
    drift_expected = [(1.0 + k * 0.5) / drift_ratio for k in range(len(click_onsets))]
    drift_offsets = bench.onset_offsets(samples, bench.OUTPUT_SR, drift_expected)
    class_a_cases.append({
        "id": "drift-tempo-ratio-1.25-full-grid",
        "tempoRatio": drift_ratio,
        "expectedOnsetsSec": [round(t, 6) for t in drift_expected],
        "offsetsMs": drift_offsets,
        "summary": bench.summarize(drift_offsets),
        "driftPerMinuteMs": bench.drift_per_minute(
            drift_offsets, interval_s=0.5 / drift_ratio),
        "method": crossing_method + "; every click of the 16-click grid "
                  "measured through the atempo chain",
    })

    # Source-position sweep (audit C): same configuration, different source
    # onsets. The sweep is reported; no fixed-latency conclusion is drawn.
    sweep_points = []
    for onset in (0.25, 0.5, 1.0, 1.25):
        src = bench_dir / f"report-sweep-src-{onset}.wav"
        out = bench_dir / f"report-sweep-out-{onset}.wav"
        bench.write_wav(src, bench.transient_signal(44100, onset=onset), 44100)
        assembler.render_aligned(str(src), out, tempo_ratio=1.0,
                                 semitone_shift=0, sr=44100)
        sweep_offsets = bench.onset_offsets(
            bench.read_wav_mono(out), bench.OUTPUT_SR, [onset])
        sweep_points.append({
            "sourceOnsetSec": onset,
            "offsetsMs": sweep_offsets,
            "summary": bench.summarize(sweep_offsets),
        })
    sweep_offsets = [p["summary"]["worstCaseMs"] for p in sweep_points]
    class_a_cases.append({
        "id": "source-position-sweep-44100-unshifted",
        "sweepPoints": sweep_points,
        "expectedOnsetsSec": [0.25, 0.5, 1.0, 1.25],
        "offsetsMs": sweep_offsets,
        "summary": bench.summarize(sweep_offsets),
        "method": crossing_method + "; render_aligned(ratio=1, shift=0, "
                  "44.1k) repeated at four source positions",
    })

    # Class B ingestion (audit D): validated provenance, or an explicit gap.
    import receipts_ingestion as ing
    class_b_record = ing.load_and_validate_receipts()
    class_b_cases = class_b_record["embeddedCases"]
    class_b_measured = class_b_record["captured"]
    class_b_status = class_b_record["status"]
    class_b_problems = class_b_record["problems"]

    class_c = bench.loopback_report_skeleton([
        {
            "id": "loopback-transient-44100",
            "fixture": "transient_44100.wav",
            "plannedOnsetSec": 1.0,
            "measured": None,
            "measuredOnsetSec": None,
            "offsetMs": None,
        },
    ])

    # Derived observations — computed FROM THIS RUN's measured numbers, never
    # hardcoded (audit C). Mechanism claims stay out; position dependence is
    # stated from the sweep that measured it.
    unshifted = [c["summary"]["worstCaseMs"] for c in class_a_cases
                 if c["id"].startswith("unshifted-")]
    sweep_worst = [p["summary"]["worstCaseMs"] for p in sweep_points]
    committed_mixed = next((c for c in class_a_cases
                            if c["id"] == "committed-layer-placement-9s-mixed"), None)
    drift_case = next((c for c in class_a_cases
                       if c["id"].startswith("drift-")), None)
    observations = [
        "Offsets are position- and transform-dependent, not a fixed latency: "
        f"the same render_aligned configuration measured at source onsets "
        f"{[p['sourceOnsetSec'] for p in sweep_points]} produced "
        f"{sweep_worst} ms (spread {round(max(sweep_worst) - min(sweep_worst), 3)} ms). "
        "The mechanism has not been isolated and is not claimed.",
        f"Unshifted renders this run measured {unshifted} ms across "
        "22.05/44.1/48k inputs (n=1 each; single-onset cases are labeled as "
        "such and cannot establish drift).",
    ]
    if committed_mixed is not None:
        observations.append(
            "Committed-layer 9.0-second placement (mixed condition, exact anchor_gain"
            f"=0.8 mix) measured both clicks: {committed_mixed['offsetsMs']} ms at "
            f"{committed_mixed['expectedOnsetsSec']} s. The two clicks differ; the "
            "first sits at the trim boundary and is not representative of the "
            "render path alone.")
    if drift_case is not None and drift_case["summary"]["n"] > 1:
        observations.append(
            f"Full 16-click grid at ratio 1.25: mean "
            f"{drift_case['summary']['meanMs']} ms, worst "
            f"{drift_case['summary']['worstCaseMs']} ms, "
            f"drift {drift_case['driftPerMinuteMs']} ms/minute (measured from "
            "this run's series).")
    observations.append(
        "Clipping and dropout were measured only for the committed phrase "
        "case (true peak via assembler.measure_clipping; expected clicks "
        "detected). Longer playback, the interruption matrix, and class C "
        "loopback remain unmeasured; tolerances remain pending.")

    report = {
        "schema": "2become1.listening-timing/1",
        "evidenceClass": "A_offline_rendered+B_browser_scheduling+C_loopback",
        "commit": bench.tested_commit(),
        "environment": bench.environment(),
        "acceptanceTolerances": None,
        "classA": {
            "measured": True,
            "cases": class_a_cases,
            "method": (
                "fixtures: deterministic transients generated in-test; "
                "rendered through assembler.render_aligned / build_mash; "
                "decoded at 44.1k; onset = amplitude-rise crossing at 50% of "
                "the association-window peak AMPLITUDE (|x|, not squared "
                "energy), sub-sample linear interpolation; deterministic; "
                "silence/missing/ambiguous windows raise "
                "OnsetMeasurementError instead of measuring"
            ),
            "observations": observations,
            "unshiftedWorstCasesMs": unshifted,
        },
        "classB": {
            "measured": class_b_measured,
            "status": class_b_status,
            "problems": class_b_problems,
            "evidence": (
                "current receipts capture validated by "
                "tests/receipts_ingestion.py (schema, per-case assertions, "
                "finite receipt numbers, unique scenario ids, commit match)"
                if class_b_measured else
                "NOT embedded: " + "; ".join(class_b_problems)
            ),
            "captureMeta": class_b_record["captureMeta"],
            "browser": class_b_record["browser"],
            "cases": class_b_cases,
            "method": "production runtime/ghost-scheduler.js GhostScheduler "
                      "driven in Chromium against real Web Audio nodes; "
                      "captured source.start calls; independent hand-computed "
                      "expectations; per-scenario clockMode labels synthetic "
                      "clocks (one real-AudioContext observation included)",
            "note": "Receipts prove Web Audio scheduling INTENT by the "
                    "production scheduler. They cannot establish audible/"
                    "sample timing. Class C is the class that can; it is "
                    "defined and unmeasured by design. CommittedLayerEngine "
                    "is not exercised here.",
        },
        "classC": class_c,
        "coverageGaps": [
            "loopback/device recordings not captured (class C measured:false)",
            "longer playback under browser load not exercised",
            "stop/seek/project switching/Release/Commit/Undo/reload/missing "
            "assets/interruption matrix not exercised (follows evidence)",
            "clipping/dropout measured only for the committed phrase case, "
            "not across all cases",
            "CommittedLayerEngine live behavior not exercised (separate from "
            "GhostScheduler)",
            "tolerances pending agreement; no acceptance claimed",
        ],
    }

    report_path = Path("benchmark_report.json")
    bench.write_json(report_path, report)

    # Truth gates on the report itself.
    assert report["acceptanceTolerances"] is None
    assert report["classC"]["measured"] is False
    assert all(case["measured"] is None for case in report["classC"]["cases"])
    assert len(class_a_cases) == 12  # 3 rates + 2 shifts + 2 ratios + 2 committed + cue + drift + sweep
    assert all(case["summary"]["n"] >= 1 for case in class_a_cases)
    committed_cases = [case for case in class_a_cases
                       if case["id"].startswith("committed-layer-placement-9s-")]
    assert committed_cases
    assert all(case["plannedLaunchSec"] == 9.0 for case in committed_cases)
    assert all("clipping" in case and "dropout" in case
               for case in committed_cases)
    assert all(case["dropout"]["detectedClickCount"]
               == case["dropout"]["expectedClickCount"] == 2
               for case in committed_cases)
    assert all("energy-rise" not in case["method"] for case in class_a_cases)
    if class_b_measured:
        assert report["classB"]["status"] == "current"
        assert report["classB"]["captureMeta"]["commit"] == report["commit"]
    else:
        assert report["classB"]["problems"]
    # Derived observations must quote THIS run's numbers, not stale constants.
    assert str(unshifted[0]) in observations[1]
    assert report_path.exists()
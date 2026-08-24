import json
import math
import struct
import wave
from pathlib import Path

import pytest

from twobecomeone import analyzer, assembler, cli, separator
from twobecomeone.common import UserError


FIXTURES = Path(__file__).with_name("fixtures")


def _synth_wav(path: Path, *, sr: int, bpm: float, root: float, mode: str,
               duration: float = 8.0, side_tone: bool = False) -> None:
    """Write a synthetic WAV for testing.

    If `side_tone` is True, add a 440 Hz tone panned hard left/right so that
    L-R cancellation isolates it (useful for testing the ffmpeg fallback).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    third = root * (2 ** (3 / 12)) if mode == "minor" else root * (2 ** (4 / 12))
    fifth = root * (2 ** (7 / 12))
    tones = [root, third, fifth, root * 2, root * 4]
    beat = 60.0 / bpm
    n = int(sr * duration)
    data = bytearray()
    for i in range(n):
        t = i / sr
        # mono center content
        s = sum(0.5 * math.sin(2 * math.pi * f * t) for f in tones) / len(tones)
        bp = (t % beat) / beat
        if bp < 0.05:
            s += 0.3 * math.sin(2 * math.pi * root * 0.5 * t)

        # stereo: left and right
        if side_tone:
            left = s + 0.5 * math.sin(2 * math.pi * 440 * t)
            right = s
        else:
            left = right = s

        left = max(-1, min(1, left)) * 0.8
        right = max(-1, min(1, right)) * 0.8
        data += struct.pack("<2h", int(left * 32767), int(right * 32767))
    w = wave.open(str(path), "wb")
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(bytes(data))
    w.close()


@pytest.fixture(scope="session", autouse=True)
def fixtures():
    _synth_wav(FIXTURES / "c_major_100.wav", sr=22050, bpm=100.0, root=261.63, mode="major")
    _synth_wav(FIXTURES / "a_minor_140.wav", sr=22050, bpm=140.0, root=220.00, mode="minor")
    _synth_wav(FIXTURES / "side_tone.wav", sr=22050, bpm=120.0, root=261.63, mode="major",
               side_tone=True)
    # silence and too-short fixtures are created inline below
    yield


class TestAnalyzer:
    def test_detect_bpm_known_100(self):
        x = analyzer.decode_mono(FIXTURES / "c_major_100.wav")
        bpm = analyzer.detect_bpm(x, 22050)
        assert 98 <= bpm <= 102, f"expected ~100, got {bpm}"

    def test_detect_bpm_known_140(self):
        x = analyzer.decode_mono(FIXTURES / "a_minor_140.wav")
        bpm = analyzer.detect_bpm(x, 22050)
        assert 135 <= bpm <= 145, f"expected ~140, got {bpm}"

    def test_detect_key_c_major(self):
        x = analyzer.decode_mono(FIXTURES / "c_major_100.wav")
        key = analyzer.detect_key(x, 22050)
        assert key["tonic"] == "C"
        assert key["mode"] == "major"

    def test_detect_key_a_minor(self):
        x = analyzer.decode_mono(FIXTURES / "a_minor_140.wav")
        key = analyzer.detect_key(x, 22050)
        assert key["tonic"] == "A"
        assert key["mode"] == "minor"

    def test_analyze_too_short(self, tmp_path):
        p = tmp_path / "short.wav"
        _synth_wav(p, sr=22050, bpm=100.0, root=261.63, mode="major", duration=0.05)
        with pytest.raises(UserError, match="too short"):
            analyzer.analyze(p)

    def test_analyze_silence(self, tmp_path):
        p = tmp_path / "silent.wav"
        w = wave.open(str(p), "wb")
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(bytes(22050 * 2))
        w.close()
        with pytest.raises(UserError, match="silent"):
            analyzer.analyze(p)


class TestAssembler:
    def test_semitones_relative_major_minor(self):
        assert assembler.semitones_to_match("C major", "A minor") == 0

    def test_semitones_enharmonic_keys(self):
        assert assembler.semitones_to_match("Db major", "C# major") == 0
        assert assembler.semitones_to_match("F# major", "Gb major") == 0

    def test_atempo_chain_bounds(self):
        for ratio in [0.1, 0.33, 0.9, 1.0, 1.5, 3.0, 5.0]:
            chain = assembler._atempo_chain(ratio)
            product = 1.0
            for f in chain:
                product *= float(f.split("=")[1])
            assert product == pytest.approx(ratio, rel=1e-6)

    def test_atempo_chain_rejects_invalid(self):
        for bad in (0, -1, float("nan"), float("inf")):
            with pytest.raises(UserError):
                assembler._atempo_chain(bad)

    def test_build_mash_no_clipping(self, tmp_path):
        spec = assembler.MashSpec(
            anchor_path=FIXTURES / "c_major_100.wav",
            lead_path=FIXTURES / "a_minor_140.wav",
            lead_gain=1.2, anchor_gain=1.2,  # deliberately hot
        )
        out = tmp_path / "mash.wav"
        assembler.build_mash(spec, 100.0 / 140.0,
                             assembler.semitones_to_match("C major", "A minor"),
                             str(out))
        stats = assembler.measure_clipping(str(out))
        assert stats["true_peak_db"] < 0.0, f"output clipped (true peak): {stats}"

    def test_build_mash_with_region(self, tmp_path):
        spec = assembler.MashSpec(
            anchor_path=FIXTURES / "c_major_100.wav",
            lead_path=FIXTURES / "a_minor_140.wav",
            anchor_start=2.0,
            lead_start=1.0,
            duration=3.0,
        )
        out = tmp_path / "mash_region.wav"
        assembler.build_mash(spec, 100.0 / 140.0,
                             assembler.semitones_to_match("C major", "A minor"),
                             str(out))
        assert out.exists()
        # Verify duration is ~3s
        dur = assembler._ffprobe_duration(str(out))
        assert 2.9 <= dur <= 3.1, f"expected ~3s, got {dur}s"

    def test_build_mash_region_tempo_ratio_gt_1(self, tmp_path, monkeypatch):
        # When tempo_ratio > 1 (lead slower than anchor), the lead must be trimmed
        # to render_duration * tempo_ratio before stretching.
        # Anchor 140 BPM, lead 100 BPM -> ratio 1.4, request 3s output.
        spec = assembler.MashSpec(
            anchor_path=FIXTURES / "a_minor_140.wav",
            lead_path=FIXTURES / "c_major_100.wav",
            anchor_start=2.0,
            lead_start=1.0,
            duration=3.0,
        )
        out = tmp_path / "mash_region_fast.wav"
        trim_durations = []
        real_render_aligned = assembler.render_aligned

        def capture_render_aligned(*args, **kwargs):
            trim_durations.append(kwargs.get("duration"))
            return real_render_aligned(*args, **kwargs)

        monkeypatch.setattr(assembler, "render_aligned", capture_render_aligned)
        assembler.build_mash(spec, 140.0 / 100.0,
                             assembler.semitones_to_match("A minor", "C major"),
                             str(out))
        dur = assembler._ffprobe_duration(str(out))
        assert 2.9 <= dur <= 3.1, f"expected ~3s, got {dur}s"
        assert trim_durations == [pytest.approx(3.0 * 1.4)]


class TestSeparator:
    def test_ffmpeg_fallback_honest_labels(self, tmp_path):
        result = separator.separate(str(FIXTURES / "side_tone.wav"), tmp_path, method="ffmpeg")
        assert "center" in result
        assert "sides" in result
        assert "vocals" not in result

    def test_demucs_loads_and_separates(self, tmp_path):
        pytest.importorskip("demucs")
        result = separator.separate(str(FIXTURES / "c_major_100.wav"), tmp_path, method="demucs")
        for stem in ["vocals", "drums", "bass", "other"]:
            assert stem in result
            assert result[stem].exists()
        # second call should reuse the cached model
        result2 = separator.separate(str(FIXTURES / "a_minor_140.wav"), tmp_path, method="demucs")
        assert "vocals" in result2

    def test_demucs_reports_cuda_when_available(self):
        pytest.importorskip("demucs")
        pytest.importorskip("torch")
        import torch
        if not torch.cuda.is_available():
            pytest.skip("CUDA not available on this host")
        # force a fresh load on cuda
        separator._demucs_separator = None
        separator._demucs_device = None
        separator._demucs_separator_instance()
        assert separator.demucs_device() == "cuda"

    def test_demucs_load_oom_falls_back_to_cpu(self, monkeypatch):
        demucs_api = pytest.importorskip("demucs.api")

        class CpuSeparator:
            pass

        cpu = CpuSeparator()
        attempts = 0

        def construct(**_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("CUDA out of memory")
            return cpu

        monkeypatch.setattr(demucs_api, "Separator", construct)
        separator._demucs_separator = None
        separator._demucs_device = None
        result = separator._demucs_separator_instance("cuda")
        assert result is cpu
        assert separator.demucs_device() == "cpu"

    def test_explicit_demucs_does_not_silently_change_method(self, tmp_path, monkeypatch):
        pytest.importorskip("demucs.api")
        monkeypatch.setattr(
            separator, "_demucs_separator_instance",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("model unavailable")),
        )
        with pytest.raises(UserError, match="Demucs failed to load"):
            separator.separate(str(FIXTURES / "c_major_100.wav"), tmp_path, method="demucs")


class TestCli:
    def test_json_stdout_is_valid(self, capsys):
        assert cli.main(["analyze", str(FIXTURES / "c_major_100.wav"), "--json"]) == 0
        captured = capsys.readouterr()
        assert captured.out
        data = json.loads(captured.out)
        assert "results" in data
        assert isinstance(data["results"], list)
        assert data["results"][0]["bpm"] > 0

    def test_mash_dry_run_creates_no_files(self, tmp_path, capsys):
        out = tmp_path / "dry_mash.wav"
        assert cli.main([
            "mash", str(FIXTURES / "c_major_100.wav"),
            str(FIXTURES / "a_minor_140.wav"),
            "-o", str(out), "--dry-run", "--json",
        ]) == 0
        assert not out.exists()
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["dry_run"] is True

    def test_mash_dry_run_with_stems_creates_no_files(self, tmp_path, capsys):
        out = tmp_path / "dry_stems.wav"
        stem_dir = tmp_path / "dry_stems_dir"
        assert cli.main([
            "mash", str(FIXTURES / "c_major_100.wav"),
            str(FIXTURES / "a_minor_140.wav"),
            "-o", str(out), "--dry-run", "--stems",
            "--stem-dir", str(stem_dir),
        ]) == 0
        assert not out.exists()
        assert not stem_dir.exists()

    def test_missing_file_concise_error(self, capsys):
        assert cli.main(["analyze", "/does/not/exist.wav"]) == 1
        captured = capsys.readouterr()
        assert "error" in captured.err.lower()
        assert "Traceback" not in captured.err

    def test_version_exits_cleanly(self):
        with pytest.raises(SystemExit) as exc:
            cli.main(["--version"])
        assert exc.value.code == 0

    def test_json_mash_stdout_single_object(self, capsys):
        assert cli.main([
            "mash", str(FIXTURES / "c_major_100.wav"),
            str(FIXTURES / "a_minor_140.wav"),
            "--json",
        ]) == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "output_path" in data
        assert "semitone_shift" in data

    def test_json_error_document(self, capsys):
        assert cli.main(["analyze", "/does/not/exist.wav", "--json"]) == 1
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "errors" in data
        assert len(data["errors"]) > 0

    def test_mash_region_cli(self, tmp_path, capsys):
        out = tmp_path / "cli_region.wav"
        assert cli.main([
            "mash", str(FIXTURES / "c_major_100.wav"),
            str(FIXTURES / "a_minor_140.wav"),
            "-o", str(out),
            "--anchor-start", "1.0",
            "--lead-start", "0.5",
            "--duration", "2.0",
            "--json",
        ]) == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "output_path" in data
        dur = assembler._ffprobe_duration(str(out))
        assert 1.9 <= dur <= 2.1, f"expected ~2s, got {dur}s"

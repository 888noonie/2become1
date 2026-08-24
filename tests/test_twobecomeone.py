import math
import struct
import wave
from pathlib import Path

import pytest

from twobecomeone import analyzer, assembler


FIXTURES = Path(__file__).with_name("fixtures")


def _synth_wav(path: Path, *, sr: int, bpm: float, root: float, mode: str,
               duration: float = 8.0) -> None:
    """Write a synthetic WAV for testing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    third = root * (2 ** (3 / 12)) if mode == "minor" else root * (2 ** (4 / 12))
    fifth = root * (2 ** (7 / 12))
    tones = [root, third, fifth, root * 2, root * 4]
    beat = 60.0 / bpm
    n = int(sr * duration)
    data = bytearray()
    for i in range(n):
        t = i / sr
        s = sum(0.5 * math.sin(2 * math.pi * f * t) for f in tones) / len(tones)
        bp = (t % beat) / beat
        if bp < 0.05:
            s += 0.3 * math.sin(2 * math.pi * root * 0.5 * t)
        s = max(-1, min(1, s)) * 0.8
        data += struct.pack("<h", int(s * 32767))
    w = wave.open(str(path), "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(bytes(data))
    w.close()


@pytest.fixture(scope="session", autouse=True)
def fixtures():
    _synth_wav(FIXTURES / "c_major_100.wav", sr=22050, bpm=100.0, root=261.63, mode="major")
    _synth_wav(FIXTURES / "a_minor_140.wav", sr=22050, bpm=140.0, root=220.00, mode="minor")
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

    def test_analyze_returns_duration(self):
        r = analyzer.analyze(FIXTURES / "c_major_100.wav")
        assert r.duration == pytest.approx(8.0, abs=0.1)
        assert isinstance(r.bpm, float)
        assert "tonic" in r.key


class TestAssembler:
    def test_semitones_relative_major_minor(self):
        assert assembler.semitones_to_match("C major", "A minor") == 0

    def test_semitones_tritone(self):
        assert assembler.semitones_to_match("C major", "F# major") in (6, -6)

    def test_atempo_chain_bounds(self):
        for ratio in [0.1, 0.33, 0.9, 1.0, 1.5, 3.0, 5.0]:
            chain = assembler._atempo_chain(ratio)
            product = 1.0
            for f in chain:
                product *= float(f.split("=")[1])
            assert product == pytest.approx(ratio, rel=1e-6)

    def test_build_mash_creates_output(self, tmp_path):
        spec = assembler.MashSpec(
            anchor_path=FIXTURES / "c_major_100.wav",
            lead_path=FIXTURES / "a_minor_140.wav",
        )
        out = tmp_path / "mash.wav"
        result = assembler.build_mash(spec, 100.0 / 140.0,
                                      assembler.semitones_to_match("C major", "A minor"),
                                      str(out))
        assert result.exists()
        assert result.stat().st_size > 0


class TestCliSmoke:
    def test_main_analyze(self):
        from twobecomeone.cli import main
        assert main(["analyze", str(FIXTURES / "c_major_100.wav")]) == 0

    def test_main_mash_dryrun(self):
        from twobecomeone.cli import main
        assert main([
            "mash",
            str(FIXTURES / "c_major_100.wav"),
            str(FIXTURES / "a_minor_140.wav"),
            "--dry-run",
        ]) == 0

    def test_main_version(self):
        from twobecomeone.cli import main
        with pytest.raises(SystemExit) as exc:
            main(["--version"])
        assert exc.value.code == 0

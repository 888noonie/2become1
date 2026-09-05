"""Measured pitch and timing regressions, using generated audio only."""
import subprocess

import numpy as np
import pytest

from twobecomeone import assembler
from twobecomeone.common import UserError


@pytest.mark.parametrize('sr', [22050, 44100, 48000])
@pytest.mark.parametrize('ratio,shift', [(1.0, 2), (1.25, -3), (0.8, 5)])
def test_alignment_preserves_requested_pitch_and_duration(tmp_path, sr, ratio, shift):
    source, output = tmp_path / 'source.wav', tmp_path / 'aligned.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    f'sine=frequency=440:sample_rate={sr}:duration=4', str(source)], check=True)
    assembler.render_aligned(str(source), output, ratio, shift)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output),
                          '-f', 'f32le', '-ac', '1', '-'], capture_output=True, check=True).stdout
    samples = np.frombuffer(raw, dtype=np.float32)
    assert len(samples) / 44100 == pytest.approx(4 / ratio, abs=0.08)
    middle = samples[10000:-10000]
    frequencies = np.fft.rfftfreq(len(middle), 1 / 44100)
    measured = frequencies[np.argmax(abs(np.fft.rfft(middle)))]
    assert measured == pytest.approx(440 * 2 ** (shift / 12), abs=1.0)


@pytest.mark.parametrize('flat,sharp', [('Bb','A#'), ('Db','C#'), ('Eb','D#'), ('Gb','F#'), ('Ab','G#')])
@pytest.mark.parametrize('mode', ['major', 'minor'])
def test_enharmonic_keys_match_in_both_directions(flat, sharp, mode):
    for other in ('C major', 'E minor'):
        assert assembler.semitones_to_match(f'{flat} {mode}', other) == assembler.semitones_to_match(f'{sharp} {mode}', other)
        assert assembler.semitones_to_match(other, f'{flat} {mode}') == assembler.semitones_to_match(other, f'{sharp} {mode}')


@pytest.mark.parametrize('key', ['', 'C', 'C major extra', 'H major', 'C dorian'])
def test_invalid_keys_raise_user_error(key):
    with pytest.raises(UserError):
        assembler.semitones_to_match(key, 'C major')

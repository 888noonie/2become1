import subprocess
import threading
import time

import numpy as np
import pytest

from twobecomeone import analyzer, common
from twobecomeone.common import UserError, CapabilityError
from twobecomeone.contracts import JobKind
from twobecomeone.jobs import JobEngine
from test_jobs import _make_store


def test_spectral_blocks_preserve_flux_and_chroma(monkeypatch):
    sr = 22050
    signal = np.random.default_rng(42).normal(size=sr * 3)
    spec, hop = analyzer._frames(signal, sr)
    expected = np.zeros(len(spec))
    expected[1:] = np.maximum(spec[1:] - spec[:-1], 0).mean(axis=1)
    expected_chroma = analyzer._chromagram(spec, sr).sum(axis=0)
    monkeypatch.setattr(analyzer, 'SPECTRAL_BLOCK_FRAMES', 7)
    flux, actual_hop = analyzer.spectral_flux(signal, sr)
    assert actual_hop == hop
    np.testing.assert_allclose(flux, expected)
    blocks = list(analyzer._spectral_blocks(signal, sr))
    assert max(len(s) for s, _ in blocks) <= 7
    np.testing.assert_allclose(sum(analyzer._chromagram(s, sr).sum(axis=0) for s, _ in blocks), expected_chroma)


def test_decode_rejects_overlong_audio_without_silent_truncation(tmp_path, monkeypatch):
    source = tmp_path / 'long.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    'sine=duration=2', str(source)], check=True)
    monkeypatch.setattr(analyzer, 'MAX_DECODE_SECONDS', 1)
    with pytest.raises(UserError, match='processing limit'):
        analyzer.decode_mono(source)


def test_audio_stage_timeout_becomes_user_error(monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs['timeout'])
    monkeypatch.setattr(common.subprocess, 'run', timeout)
    with pytest.raises(UserError, match='stage limit'):
        common.run_audio_process(['ffmpeg'])


def test_queue_capacity_is_released_after_completion(tmp_path):
    store = _make_store(tmp_path)
    engine = JobEngine(store, max_pending=1)
    unblock = threading.Event()
    def work(job_id, token):
        unblock.wait(3)
        return {}
    try:
        first = engine.submit(JobKind.RENDER, {}, work)
        with pytest.raises(CapabilityError, match='queue is full'):
            engine.submit(JobKind.RENDER, {}, work)
        unblock.set()
        deadline = time.monotonic() + 3
        while engine._tokens and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not engine._tokens
        engine.submit(JobKind.RENDER, {}, work)
    finally:
        engine.shutdown()
    assert store.get(first['id'])['status'] in {'complete', 'cancelled'}
    assert not engine._tokens

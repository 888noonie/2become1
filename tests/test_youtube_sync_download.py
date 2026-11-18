"""The synchronous YouTube downloader must not trust the caller URL or the child path."""

import subprocess

import pytest

from twobecomeone.common import MAX_MEDIA_BYTES, UserError
from twobecomeone import sources

VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
CANONICAL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
VIDEO_ID = "dQw4w9WgXcQ"


def _install_fake_ytdlp(monkeypatch, stdout: bytes = b""):
    calls = []

    def run(cmd, capture_output, timeout):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr=b"")

    monkeypatch.setattr(sources.shutil, "which", lambda _name: "/usr/bin/yt-dlp")
    monkeypatch.setattr(sources.subprocess, "run", run)
    return calls


def test_playlist_url_never_reaches_ytdlp(tmp_path, monkeypatch):
    calls = _install_fake_ytdlp(monkeypatch)
    with pytest.raises(UserError, match="video ID"):
        sources.from_youtube(
            "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
            tmp_path,
        )
    assert calls == []


def test_download_uses_the_canonical_watch_url_and_id_template(tmp_path, monkeypatch):
    expected = tmp_path / f"{VIDEO_ID}.mp3"
    expected.write_bytes(b"audio")
    calls = _install_fake_ytdlp(monkeypatch, stdout=str(expected).encode())
    result = sources.from_youtube(f"https://user:pass@www.youtube.com/watch?v={VIDEO_ID}", tmp_path)
    assert result == expected.resolve()
    argv = calls[0]
    assert argv[-1] == CANONICAL
    assert "user:pass" not in " ".join(argv)
    assert "--ignore-config" in argv
    assert "--max-filesize" in argv
    assert argv[argv.index("--max-filesize") + 1] == str(MAX_MEDIA_BYTES)
    assert argv[argv.index("-o") + 1].endswith("%(id)s.%(ext)s")
    assert "%(title)s" not in argv[argv.index("-o") + 1]


def test_a_symlink_printed_by_the_child_is_not_the_download(tmp_path, monkeypatch):
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"secret")
    work = tmp_path / "work"
    work.mkdir()
    planted = work / f"{VIDEO_ID}.mp3"
    planted.symlink_to(outside)
    _install_fake_ytdlp(monkeypatch, stdout=str(planted).encode())
    with pytest.raises(UserError, match="work directory"):
        sources.from_youtube(VIDEO, work)
    assert outside.read_bytes() == b"secret"

"""Queue acquisition planning. No downloads and no network."""

import json

from twobecomeone.queue_acquisition import (
    asset_from_import_job,
    plan_youtube_acquisition,
    separation_request,
)

VIDEO = "dQw4w9WgXcQ"
CANONICAL = f"https://www.youtube.com/watch?v={VIDEO}"
JOB_ID = "job_abc12345"
TRACK_ID = "abcdef0123456789"


def test_youtube_urls_canonicalize_and_accept():
    urls = [
        f"https://youtu.be/{VIDEO}",
        f"https://www.youtube.com/watch?v={VIDEO}",
        f"https://www.youtube.com/shorts/{VIDEO}",
    ]
    for url in urls:
        plan = plan_youtube_acquisition(url, target_deck="B")
        assert plan == {
            "schema": "acquisition-plan/v1",
            "ok": True,
            "canonicalUrl": CANONICAL,
            "targetDeck": "B",
        }


def test_playlist_and_garbage_reject_bad_url():
    for url in (
        "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
        "not a url",
        "",
    ):
        plan = plan_youtube_acquisition(url)
        assert plan["ok"] is False
        assert plan["status"] == "rejected"
        assert plan["error"]["code"] == "BAD_URL"


def test_bad_deck_rejects():
    plan = plan_youtube_acquisition(f"https://youtu.be/{VIDEO}", target_deck="C")
    assert plan["ok"] is False
    assert plan["status"] == "rejected"
    assert plan["error"]["code"] == "BAD_DECK"

    asset = asset_from_import_job(
        {"id": JOB_ID, "status": "queued", "result": None, "error": None},
        canonical_url=CANONICAL,
        target_deck="both",
    )
    assert asset["ok"] is False
    assert asset["error"]["code"] == "BAD_DECK"


def test_queued_and_running_jobs_have_no_track():
    for status in ("queued", "running"):
        asset = asset_from_import_job(
            {"id": JOB_ID, "status": status, "result": {"path": "/tmp/nope.mp3"}, "error": None},
            canonical_url=f"https://youtu.be/{VIDEO}?t=1",
            target_deck="A",
        )
        assert asset["ok"] is True
        assert asset["status"] == status
        assert asset["jobId"] == JOB_ID
        assert asset["trackId"] is None
        assert asset["canonicalUrl"] == CANONICAL
        assert asset["targetDeck"] == "A"
        assert "/tmp/nope.mp3" not in json.dumps(asset)


def test_complete_job_sets_track_id():
    asset = asset_from_import_job(
        {
            "id": JOB_ID,
            "status": "complete",
            "result": {"track_id": TRACK_ID, "path": "/var/lib/media/secret.mp3"},
            "error": None,
        },
        canonical_url=CANONICAL,
    )
    assert asset["ok"] is True
    assert asset["status"] == "complete"
    assert asset["trackId"] == TRACK_ID
    assert asset["jobId"] == JOB_ID
    assert "/var/lib/media/secret.mp3" not in json.dumps(asset)
    assert "path" not in asset


def test_complete_job_without_track_id_fails_closed():
    for result in (None, {}, {"path": "/tmp/only-a-path.mp3"}, {"track_id": "  "}):
        asset = asset_from_import_job(
            {"id": JOB_ID, "status": "complete", "result": result, "error": None},
            canonical_url=CANONICAL,
        )
        assert asset["ok"] is False
        assert asset["status"] == "failed"
        assert asset["trackId"] is None
        assert "/tmp/only-a-path.mp3" not in json.dumps(asset)


def test_failed_job_is_not_ok():
    asset = asset_from_import_job(
        {"id": JOB_ID, "status": "failed", "result": None, "error": "yt-dlp failed"},
        canonical_url=CANONICAL,
    )
    assert asset["ok"] is False
    assert asset["status"] == "failed"
    assert asset["error"] == {"code": "JOB_FAILED", "message": "yt-dlp failed"}

    cancelled = asset_from_import_job(
        {"id": JOB_ID, "status": "cancelled", "result": None, "error": None},
        canonical_url=CANONICAL,
    )
    assert cancelled["ok"] is False
    assert cancelled["status"] == "failed"
    assert cancelled["error"]["code"] == "JOB_FAILED"
    assert cancelled["error"]["message"] == "cancelled"


def test_missing_job_id_rejects():
    asset = asset_from_import_job(
        {"status": "queued", "result": None, "error": None},
        canonical_url=CANONICAL,
    )
    assert asset["ok"] is False
    assert asset["status"] == "rejected"
    assert asset["error"]["code"] == "ASSET_JOB"


def test_bad_canonical_url_on_job_rejects():
    asset = asset_from_import_job(
        {"id": JOB_ID, "status": "queued", "result": None, "error": None},
        canonical_url="https://example.com/watch?v=dQw4w9WgXcQ",
    )
    assert asset["ok"] is False
    assert asset["error"]["code"] == "BAD_URL"


def test_separation_request_token():
    empty = separation_request("")
    assert empty["ok"] is False
    assert empty["code"] == "BAD_TRACK"
    assert separation_request("short")["ok"] is False
    assert separation_request("../etc/passwd")["ok"] is False

    accepted = separation_request(TRACK_ID)
    assert accepted == {
        "ok": True,
        "trackId": TRACK_ID,
        "method": "auto",
        "note": "existing separation job; not started",
    }
    assert "vocal" not in json.dumps(accepted).lower()

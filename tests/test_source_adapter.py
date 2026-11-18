"""Source classification. No network, no yt-dlp, no job engine."""

from twobecomeone.source_adapter import classify, validate

VIDEO = "dQw4w9WgXcQ"
CANONICAL = f"https://www.youtube.com/watch?v={VIDEO}"
TRACK = "abcdef0123456789"
STAGED = "ca2c95fd0f794f1db8d90fa06df8c232.wav"


def test_two_slots_hand_off_to_the_existing_youtube_import():
    for slot in ("A", "B"):
        handoff = validate(f"https://youtu.be/{VIDEO}", slot=slot, authorised=True)
        assert handoff == {
            "ok": True,
            "slot": slot,
            "kind": "youtube",
            "canonical_url": CANONICAL,
            "submit": "submit_youtube_import",
        }


def test_a_public_youtube_link_is_not_authorisation():
    rejected = validate(f"https://www.youtube.com/watch?v={VIDEO}", slot="A", authorised=False)
    assert rejected["ok"] is False
    assert rejected["code"] == "NOT_AUTHORISED"
    assert "canonical_url" not in rejected


def test_a_private_or_non_youtube_address_is_unsupported():
    for raw in (
        "http://192.168.1.10/watch",
        "http://10.0.0.2/audio.wav",
        "http://127.0.0.1:8765/api/tracks",
        "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    ):
        rejected = validate(raw, slot="B", authorised=True)
        assert rejected["code"] == "UNSUPPORTED_SOURCE", raw


def test_a_youtube_url_without_a_video_id_is_rejected():
    rejected = validate(
        "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
        slot="A",
        authorised=True,
    )
    assert rejected["code"] == "BAD_URL"


def test_a_staged_upload_names_the_existing_upload_import():
    handoff = validate(STAGED, slot="A", authorised=True)
    assert handoff["ok"] is True
    assert handoff["submit"] == "submit_upload_import"
    assert handoff["staging_key"] == STAGED


def test_a_path_is_not_a_staging_key():
    for raw in ("../secret.wav", "incoming/song.wav", "song.txt"):
        rejected = validate(raw, slot="A", authorised=True)
        assert rejected["code"] == "BAD_STAGING_KEY", raw


def test_a_library_id_assigns_a_deck_and_does_not_import():
    handoff = validate(TRACK, slot="B", authorised=True)
    assert handoff == {
        "ok": True,
        "slot": "B",
        "kind": "library",
        "track_id": TRACK,
        "submit": "assign_deck",
    }
    assert classify(TRACK)["kind"] == "library"


def test_a_short_token_is_not_a_track_id():
    rejected = validate("short", slot="A", authorised=True)
    assert rejected["code"] == "BAD_TRACK"

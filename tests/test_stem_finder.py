"""Stem Finder (OPERATION STEM FINDER, Act I).

Renamed stems are discoverable through the existing Library catalogue. Search
still paginates and counts tracks; each track carries only the validated
``(stem_set_id, role)`` assets that genuinely matched. No second catalogue, no
second pagination and no audio is copied or renamed.
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

import pytest

from twobecomeone.studio import StudioService

ROLES = ("vocals", "drums", "bass", "other")
ROLE_FREQ = {"vocals": 440.0, "drums": 220.0, "bass": 110.0, "other": 330.0}
STEM_MATCH_KEYS = {
    "stem_set_id", "role", "display_name", "custom_name", "available",
    "method", "audio_url", "matched", "track_id", "track_name",
}


def _wav(path: Path, *, freq: float, duration: float = 1.2, rate: int = 22050) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(duration * rate)
    data = bytearray()
    for index in range(frames):
        value = int(0.2 * 32767 * math.sin(2 * math.pi * freq * index / rate))
        data += struct.pack("<h", value) * 2
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(data)
    return path


def _add_track(
    service: StudioService,
    root: Path,
    name: str,
    *,
    freq: float,
    source: str = "local",
) -> dict:
    path = _wav(root / "mixes" / f"{name}.wav", freq=freq)
    if source == "local":
        with path.open("rb") as handle:
            track = service.ingest(handle, path.name, source_kind="local")
    else:
        track = service.ingest_path(
            path,
            source_kind=source,
            source_ref="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        )
    return service.update_track(track["id"], display_name=name)


def _add_quad(
    service: StudioService,
    root: Path,
    track: dict,
    tag: str,
    labels: dict[str, str] | None = None,
    *,
    offset: float = 0.0,
) -> str:
    entries = []
    for role in ROLES:
        path = _wav(
            root / "stems" / tag / f"{role}.wav",
            freq=ROLE_FREQ[role] + offset,
        )
        with path.open("rb") as handle:
            key = service.stage_upload(handle, path.name)
        entries.append({
            "role": role,
            "staging_key": key,
            "original_name": path.name,
        })
    result = service.import_stem_set(track["id"], entries)
    if labels:
        service.set_stem_names(result["stem_set_id"], labels)
    return result["stem_set_id"]


@pytest.fixture
def library(tmp_path):
    service = StudioService(tmp_path / "data")
    try:
        paper = _add_track(service, tmp_path, "Paper Lanterns", freq=196.0)
        paper_set = _add_quad(
            service, tmp_path, paper, "paper",
            {"vocals": "Lead Vox", "other": "Lead Guitar"},
            offset=1.0,
        )

        night = _add_track(
            service, tmp_path, "Night Drive", freq=220.0, source="youtube",
        )
        night_set = _add_quad(
            service, tmp_path, night, "night", {"vocals": "Lead Vocal"},
            offset=3.0,
        )

        unrelated = _add_track(service, tmp_path, "Unrelated", freq=247.0)

        corrupt = _add_track(service, tmp_path, "Corrupt Stem", freq=262.0)
        corrupt_set = _add_quad(
            service, tmp_path, corrupt, "corrupt", {"vocals": "Ghost Vox"},
            offset=5.0,
        )
        (service.stem_dir / corrupt_set / "vocals.wav").unlink()

        trashed = _add_track(service, tmp_path, "Trashed Take", freq=277.0)
        trashed_set = _add_quad(
            service, tmp_path, trashed, "trashed", {"vocals": "Lead Trash"},
            offset=7.0,
        )
        service.trash_track(trashed["id"])

        yield service, {
            "paper": paper,
            "paper_set": paper_set,
            "night": night,
            "night_set": night_set,
            "unrelated": unrelated,
            "corrupt": corrupt,
            "corrupt_set": corrupt_set,
            "trashed": trashed,
            "trashed_set": trashed_set,
        }
    finally:
        service.close()


def _items(page: dict) -> list[dict]:
    return page["items"]


def _only(page: dict) -> dict:
    assert page["total"] == 1, page
    assert len(page["items"]) == 1, page
    return page["items"][0]


def _stems(item: dict) -> list[dict]:
    return item["match"]["stems"]


class TestStemDiscovery:
    def test_a_renamed_stem_is_found_by_its_new_name(self, library):
        service, ids = library
        item = _only(service.list_tracks_page(query="Lead Vox"))

        assert item["id"] == ids["paper"]["id"]
        assert item["name"] == "Paper Lanterns"
        assert item["match"]["track"] is False
        assert len(_stems(item)) == 1
        stem = _stems(item)[0]
        assert (stem["stem_set_id"], stem["role"]) == (ids["paper_set"], "vocals")
        assert stem["display_name"] == "Lead Vox"
        assert stem["custom_name"] is True
        assert stem["available"] is True
        assert stem["method"] == "imported"
        assert stem["audio_url"] == (
            f"/api/stems/{ids['paper_set']}/audio?name=vocals"
        )
        assert stem["matched"] == ["label"]
        assert stem["track_id"] == ids["paper"]["id"]
        assert stem["track_name"] == "Paper Lanterns"

        # Custom labels are case-insensitive, like the rest of Library search.
        assert _only(service.list_tracks_page(query="lead vox"))["id"] == ids["paper"]["id"]

    def test_a_stem_match_is_a_small_fixed_shape_without_media_paths(self, library):
        service, _ids = library
        stem = _only(
            service.list_tracks_page(query="Lead Vox")
        )["match"]["stems"][0]

        assert set(stem) == STEM_MATCH_KEYS
        blob = json.dumps(stem)
        assert str(service.data_dir) not in blob
        for forbidden in (
            "paths_json", "names_json", "provenance_json", "content_sha256",
            "metadata_json", ".wav",
        ):
            assert forbidden not in blob

    def test_the_original_source_track_remains_identifiable(self, library):
        service, ids = library
        item = _only(service.list_tracks_page(query="Lead Vox"))
        stem = _stems(item)[0]

        # The stable identity points at a real Library track that is unchanged.
        source = service.get_track(stem["track_id"])
        assert source["id"] == ids["paper"]["id"]
        assert source["name"] == "Paper Lanterns"
        assert source["name"] == stem["track_name"]
        assert service.stem_audio_path(stem["stem_set_id"], stem["role"]).is_file()
        # The parent track keeps its exact source identity and size.
        assert item["source"] == source["source"]
        assert item["size_bytes"] == source["size_bytes"]

    def test_a_source_track_name_search_reaches_its_stems(self, library):
        service, ids = library
        item = _only(service.list_tracks_page(query="Paper"))

        assert item["id"] == ids["paper"]["id"]
        assert item["match"]["track"] is True
        assert {stem["role"] for stem in _stems(item)} == set(ROLES)
        assert all("track" in stem["matched"] for stem in _stems(item))
        # The custom label is still shown, not replaced by the role.
        vocals = next(s for s in _stems(item) if s["role"] == "vocals")
        assert vocals["display_name"] == "Lead Vox"

    def test_clearing_a_custom_name_restores_the_role_label(self, library):
        service, ids = library
        service.set_stem_names(ids["paper_set"], {"vocals": None})

        # The old label no longer matches anywhere.
        assert service.list_tracks_page(query="Lead Vox")["total"] == 0

        # The role token now finds the stem, shown under its role name.
        page = service.list_tracks_page(query="vocals")
        paper = next(i for i in page["items"] if i["id"] == ids["paper"]["id"])
        vocals = next(s for s in _stems(paper) if s["role"] == "vocals")
        assert vocals["display_name"] == "vocals"
        assert vocals["custom_name"] is False
        assert vocals["matched"] == ["role"]

        # A different custom label on another role is untouched.
        page = service.list_tracks_page(query="Lead Guitar")
        paper = next(i for i in page["items"] if i["id"] == ids["paper"]["id"])
        assert [s["role"] for s in _stems(paper)] == ["other"]

    def test_two_stems_with_similar_names_remain_distinct_assets(self, library):
        service, ids = library
        page = service.list_tracks_page(query="Lead")
        assert page["total"] == 2
        by_track = {item["id"]: item for item in page["items"]}
        paper_stems = _stems(by_track[ids["paper"]["id"]])
        night_stems = _stems(by_track[ids["night"]["id"]])

        assert {(s["stem_set_id"], s["role"]) for s in paper_stems} == {
            (ids["paper_set"], "vocals"),
            (ids["paper_set"], "other"),
        }
        assert [(s["stem_set_id"], s["role"]) for s in night_stems] == [
            (ids["night_set"], "vocals"),
        ]
        assert ids["paper_set"] != ids["night_set"]

        # Near-identical labels stay separated by their own identities.
        assert _only(service.list_tracks_page(query="Lead Vox"))["id"] == ids["paper"]["id"]
        assert _only(service.list_tracks_page(query="Lead Vocal"))["id"] == ids["night"]["id"]

    def test_two_sets_with_the_same_role_and_similar_names_stay_distinct(
        self, library, tmp_path,
    ):
        service, ids = library
        entries = []
        for role in ROLES:
            path = _wav(
                tmp_path / "stems" / "paper-second" / f"{role}.wav",
                freq=ROLE_FREQ[role] + 11.0,
            )
            with path.open("rb") as handle:
                key = service.stage_upload(handle, path.name)
            entries.append({
                "role": role,
                "staging_key": key,
                "original_name": path.name,
            })
        second = service.import_stem_set(ids["paper"]["id"], entries)
        assert second["stem_set_id"] != ids["paper_set"]
        service.set_stem_names(second["stem_set_id"], {"vocals": "Lead Vox"})

        page = service.list_tracks_page(query="Lead Vox")
        assert page["total"] == 1
        item = _only(page)
        vocals = [s for s in _stems(item) if s["role"] == "vocals"]
        assert len(vocals) == 2
        assert {s["stem_set_id"] for s in vocals} == {
            ids["paper_set"], second["stem_set_id"],
        }
        assert all(s["display_name"] == "Lead Vox" for s in vocals)
        assert all(s["available"] is True for s in vocals)

    def test_track_match_and_stem_match_are_distinguished_in_one_response(
        self, library, tmp_path,
    ):
        service, ids = library
        single = _add_track(service, tmp_path, "Lead Single", freq=311.0)

        page = service.list_tracks_page(query="Lead", limit=10)
        assert page["total"] == 3
        by_id = {item["id"]: item for item in page["items"]}
        assert set(by_id) == {
            ids["paper"]["id"], ids["night"]["id"], single["id"],
        }
        # A track-name match with no matching stem says so explicitly.
        assert by_id[single["id"]]["match"] == {"track": True, "stems": []}
        # A stem-only match is not mislabelled as a track-name match.
        assert by_id[ids["paper"]["id"]]["match"]["track"] is False
        assert by_id[ids["paper"]["id"]]["match"]["stems"]


class TestPaginationAndFilters:
    def test_a_track_with_several_matching_stems_counts_once(self, library):
        service, _ids = library
        page = service.list_tracks_page(query="Lead")
        # Paper has two matching stems; Night has one. Two tracks, not three.
        assert page["total"] == 2
        assert len(page["items"]) == 2
        assert len({item["id"] for item in page["items"]}) == 2

    def test_pagination_is_by_track_not_by_stem(self, library):
        service, ids = library
        seen = []
        for offset in (0, 1, 2):
            page = service.list_tracks_page(
                query="Lead", status="all", limit=1, offset=offset,
            )
            assert page["total"] == 3
            assert len(page["items"]) <= 1
            seen.extend(item["id"] for item in page["items"])
        assert len(seen) == 3
        assert len(set(seen)) == 3
        assert set(seen) == {
            ids["paper"]["id"], ids["night"]["id"], ids["trashed"]["id"],
        }

        beyond = service.list_tracks_page(
            query="Lead", status="all", limit=1, offset=3,
        )
        assert beyond["total"] == 3
        assert beyond["items"] == []

    def test_library_status_and_source_filters_still_apply(self, library):
        service, ids = library

        active = service.list_tracks_page(query="Lead", status="active")
        assert active["total"] == 2
        assert ids["trashed"]["id"] not in {item["id"] for item in active["items"]}

        trash = service.list_tracks_page(query="Lead", status="trash")
        assert trash["total"] == 1
        assert trash["items"][0]["id"] == ids["trashed"]["id"]
        assert trash["items"][0]["match"]["stems"][0]["display_name"] == "Lead Trash"

        everything = service.list_tracks_page(query="Lead", status="all")
        assert everything["total"] == 3

        youtube = service.list_tracks_page(
            query="Lead", status="active", source="youtube",
        )
        assert youtube["total"] == 1
        assert youtube["items"][0]["id"] == ids["night"]["id"]

        local = service.list_tracks_page(
            query="Lead", status="all", source="local",
        )
        assert local["total"] == 2
        assert {item["id"] for item in local["items"]} == {
            ids["paper"]["id"], ids["trashed"]["id"],
        }

    def test_sort_applies_to_stem_only_matches(self, library):
        service, _ids = library
        page = service.list_tracks_page(
            query="Lead", status="all", sort="name", limit=10,
        )
        names = [item["name"] for item in page["items"]]
        assert names == sorted(names, reverse=True)
        assert names == ["Trashed Take", "Paper Lanterns", "Night Drive"]


class TestCorruptDataAndCompatibility:
    def test_missing_stem_media_creates_no_false_match(self, library):
        service, ids = library
        # The corrupt track's vocals file was deleted; its custom label is gone.
        page = service.list_tracks_page(query="Ghost Vox")
        assert page["total"] == 0
        assert page["items"] == []

        # A role search does not advertise the missing vocals lane either.
        page = service.list_tracks_page(query="vocals")
        assert ids["corrupt"]["id"] not in {item["id"] for item in page["items"]}

        # The track is still findable by its own name, and only its valid roles
        # are listed. The missing vocals lane is never advertised.
        page = service.list_tracks_page(query="Corrupt")
        item = _only(page)
        assert item["match"]["track"] is True
        assert "vocals" not in {stem["role"] for stem in _stems(item)}
        assert {stem["role"] for stem in _stems(item)} == {
            "drums", "bass", "other",
        }

    def test_malformed_paths_create_no_stem_matches(self, library):
        service, ids = library
        with service._connect() as conn:
            conn.execute(
                "UPDATE stem_sets SET paths_json = ? WHERE id = ?",
                ("{not json", ids["paper_set"]),
            )
        assert service.list_tracks_page(query="Lead Vox")["total"] == 0
        page = service.list_tracks_page(query="Paper")
        item = _only(page)
        # No stem match survives, so the ordinary track result keeps its
        # original shape and advertises no stem at all.
        assert "match" not in item

    def test_unrelated_library_search_and_default_listing_are_unchanged(self, library):
        service, ids = library

        # The default listing keeps its shape and count; no match object.
        default = service.list_tracks_page(limit=10)
        assert default["total"] == 4
        assert all("match" not in item for item in default["items"])
        assert default["items"][0]["id"] not in {
            ids["trashed"]["id"],
        }

        # A plain track-name search still returns the original track fields
        # and no stem-match object, because no stem matched the query.
        item = _only(service.list_tracks_page(query="Unrelated"))
        assert "match" not in item
        original = service.get_track(ids["unrelated"]["id"])
        for key in ("id", "name", "duration", "bpm", "key"):
            assert item[key] == original[key]

        # No match at all is still empty, not an error.
        empty = service.list_tracks_page(query="no-such-recording-anywhere")
        assert empty["total"] == 0
        assert empty["items"] == []

    def test_crate_carries_the_same_match_without_losing_readiness(self, library):
        service, ids = library
        page = service.list_crate_page(query="Lead Vox")
        assert page["total"] == 1
        item = page["items"][0]
        assert item["track_id"] == ids["paper"]["id"]
        assert item["match"]["track"] is False
        stem = item["match"]["stems"][0]
        assert (stem["stem_set_id"], stem["role"]) == (ids["paper_set"], "vocals")
        assert stem["display_name"] == "Lead Vox"
        # The existing readiness summary and actions are still the track's.
        assert item["stems"]["status"] == "quad"
        assert item["stems"]["available"] is True
        assert item["actions"]

        # A track with two matching stems is still one Crate row.
        page = service.list_crate_page(query="Lead")
        assert page["total"] == 2
        assert len({item["track_id"] for item in page["items"]}) == 2


class TestHttp:
    @pytest.mark.anyio
    async def test_tracks_and_crate_routes_expose_stem_matches(self, tmp_path):
        pytest.importorskip("fastapi")
        import httpx
        from twobecomeone.webapp import create_app

        data = tmp_path / "data"
        service = StudioService(data)
        try:
            track = _add_track(service, tmp_path, "Paper Lanterns", freq=196.0)
            set_id = _add_quad(
                service, tmp_path, track, "paper",
                {"vocals": "Lead Vox"},
            )
        finally:
            service.close()

        app = create_app(data)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://localhost",
        ) as client:
            tracks = await client.get("/api/tracks", params={"q": "Lead Vox"})
            assert tracks.status_code == 200, tracks.text
            body = tracks.json()
            assert body["total"] == 1
            item = body["items"][0]
            assert item["id"] == track["id"]
            assert item["match"]["track"] is False
            stem = item["match"]["stems"][0]
            assert (stem["stem_set_id"], stem["role"]) == (set_id, "vocals")
            assert stem["display_name"] == "Lead Vox"
            assert stem["available"] is True
            assert stem["track_id"] == track["id"]
            assert stem["track_name"] == "Paper Lanterns"

            crate = await client.get("/api/crate", params={"q": "Lead Vox"})
            assert crate.status_code == 200, crate.text
            crate_item = crate.json()["items"][0]
            assert crate_item["track_id"] == track["id"]
            assert crate_item["match"] == item["match"]
            assert crate_item["stems"]["status"] == "quad"

            # The existing audio route named by the match still plays.
            audio = await client.get(stem["audio_url"])
            assert audio.status_code == 200
            assert audio.headers["content-type"].startswith("audio/")

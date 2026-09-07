"""Audit D: receipts ingestion validation — every labeled state.

The combined benchmark report embeds class-B captures only when they are
provably current and well-formed. These tests pin each ingestion state:
missing, malformed, invalid (bad provenance / failed case / non-finite
numbers), stale (captured at another commit), and current (fresh matching
evidence). The real capture is validated too, and stale/malformed captures
must never be relabeled as current.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

import receipts_ingestion as ing


@pytest.fixture
def commit(tmp_path_factory):
    """A fake-but-stable commit SHA so tests never depend on the real HEAD."""
    return "0123456789abcdef0123456789abcdef01234567"


def _write_capture(path: Path, payload, commit: str) -> Path:
    if isinstance(payload, dict):
        payload = {**payload, "commit": commit}
        path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        path.write_text(payload, encoding="utf-8")
    return path


def _valid(commit: str) -> dict:
    return ing._valid_payload(commit)


def test_missing_capture_labeled_missing(tmp_path, commit):
    record = ing.load_and_validate_receipts(
        tmp_path / "absent.json", current_commit_sha=commit)
    assert record["captured"] is False
    assert record["status"] == "missing"
    assert "timing_bench" in record["problems"][0]


def test_malformed_capture_labeled_malformed(tmp_path, commit):
    path = _write_capture(tmp_path / "receipts.json", "{not json", commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["captured"] is False
    assert record["status"] == "malformed"


def test_missing_provenance_keys_are_invalid(tmp_path, commit):
    payload = _valid(commit)
    del payload["capturedAt"]
    del payload["browser"]
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("'capturedAt'" in p for p in record["problems"])
    assert record["captureMeta"]["capturedAt"] is None


def test_partial_capture_missing_case_fields_is_invalid(tmp_path, commit):
    payload = _valid(commit)
    del payload["cases"][0]["receipt"]["resolvedBeat"]
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("'resolvedBeat'" in p for p in record["problems"])


def test_failed_case_is_invalid_not_embedded(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["ok"] = False
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert record["embeddedCases"] == []
    assert any("did not pass" in p for p in record["problems"])


def test_nonfinite_receipt_number_is_invalid(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["receipt"]["launchAudioTime"] = float("inf")
    path = _write_capture(tmp_path / "receipts.json", json.dumps(payload), commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("finite" in p for p in record["problems"])


def test_duplicate_case_ids_are_invalid(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"].append(copy.deepcopy(payload["cases"][0]))
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("duplicated" in p for p in record["problems"])


def test_stale_capture_rejected_and_labeled_with_capture_meta(tmp_path, commit):
    payload = _valid("deadbeef" * 8)
    path = _write_capture(tmp_path / "receipts.json", payload, "deadbeef" * 8)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["captured"] is False
    assert record["status"] == "stale"
    assert "deadbeef" in record["problems"][0]
    assert record["captureMeta"]["commit"] == "deadbeef" * 8
    assert record["embeddedCases"] == []


def test_current_capture_embeds_cases_and_preserves_provenance(tmp_path, commit):
    path = _write_capture(tmp_path / "receipts.json", _valid(commit), commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["captured"] is True
    assert record["status"] == "current"
    assert len(record["embeddedCases"]) == len(ing.EXPECTED_SCENARIO_IDS)
    assert record["embeddedCases"][0]["receipt"]["resolvedBeat"] == 32
    meta = record["captureMeta"]
    assert meta["capturedAt"] == "2026-09-06T00:00:00Z"
    assert meta["commit"] == commit
    assert meta["repoDirtyAtCapture"] is False
    assert record["browser"]["name"] == "chromium"


@pytest.mark.parametrize(("field", "value"), [
    ("selfTestWrongExpectationDetected", False),
    ("measured", False),
    ("assertionFailureCount", 1),
    ("benchmarkSourcesDirtyAtCapture", True),
])
def test_failed_capture_level_truth_gate_is_invalid(
        tmp_path, commit, field, value):
    payload = _valid(commit)
    payload[field] = value
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any(field in problem for problem in record["problems"])


def test_missing_or_unexpected_scenario_set_is_invalid(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"].pop()
    payload["cases"][0]["scenario"] = "unexpected-scenario"
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("scenario set" in problem for problem in record["problems"])


def test_nonempty_case_assertion_failures_cannot_hide_behind_ok(
        tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["assertionFailures"] = ["hidden failure"]
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("assertionFailures" in problem for problem in record["problems"])


def test_nonfinite_nonreceipt_number_is_invalid(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["decodeMs"] = float("nan")
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("non-finite number" in problem for problem in record["problems"])


def test_receipt_must_belong_to_its_scenario(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["receipt"]["proposalId"] = "another-proposal"
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("proposalId" in problem for problem in record["problems"])


def test_case_requires_clock_sample_rate_and_state_shape(tmp_path, commit):
    payload = _valid(commit)
    del payload["cases"][0]["sampleRate"]
    payload["cases"][1]["states"] = "started"
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("sampleRate" in problem for problem in record["problems"])
    assert any("states" in problem for problem in record["problems"])


def test_controlled_start_must_match_receipt(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["capturedStarts"] = [99.0]
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert any("capturedStarts" in problem for problem in record["problems"])


def test_capture_metadata_requires_typed_nonempty_provenance(tmp_path, commit):
    payload = _valid(commit)
    payload.update({
        "capturedAt": None,
        "repoDirtyAtCapture": "unknown",
        "browser": [],
        "os": "linux",
        "contextKind": None,
        "clockPolicy": "",
        "schedulerCoverage": None,
        "selfTestWrongExpectationDetected": 1,
        "measured": 1,
        "assertionFailureCount": False,
    })
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert record["captured"] is False
    assert any("metadata" in problem or "truth gate" in problem
               for problem in record["problems"])


def test_unhashable_scenario_id_is_invalid_not_an_exception(tmp_path, commit):
    payload = _valid(commit)
    payload["cases"][0]["scenario"] = ["not", "an", "id"]
    path = _write_capture(tmp_path / "receipts.json", payload, commit)
    record = ing.load_and_validate_receipts(path, current_commit_sha=commit)
    assert record["status"] == "invalid"
    assert record["captured"] is False
    assert any("case id" in problem for problem in record["problems"])


def test_real_capture_ingests_or_reports_its_true_state():
    """The live artifact, when present, must be honestly labeled."""
    record = ing.load_and_validate_receipts()
    if not (Path(ing.RECEIPTS_PATH).exists()):
        assert record["status"] == "missing"
        return
    assert record["status"] in {"current", "stale", "invalid"}
    if record["status"] != "current":
        assert record["problems"], "non-current captures must carry reasons"
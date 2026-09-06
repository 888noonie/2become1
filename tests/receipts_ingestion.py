"""Class-B receipts ingestion: provenance retention + validation (audit D).

The combined report embeds ``tests/browser/artifacts/timing_bench/receipts.json``
only when the capture is provably current and well-formed. Stale, malformed,
partial, failed, or missing captures are labeled explicitly — never silently
relabeled as current evidence.
"""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

RECEIPTS_PATH = Path("tests/browser/artifacts/timing_bench/receipts.json")

REQUIRED_TOP_KEYS = (
    "schema", "evidenceClass", "generatedBy", "capturedAt", "commit",
    "repoDirtyAtCapture", "browser", "os", "contextKind", "clockPolicy",
    "schedulerCoverage", "selfTestWrongExpectationDetected", "measured",
    "assertionFailureCount", "benchmarkSourcesDirtyAtCapture",
    "sourceIdentityPolicy", "cases",
)
REQUIRED_RECEIPT_KEYS = (
    "proposalId", "launchAudioTime", "requestedAt", "resolvedBeat",
    "gridRevision",
)
EXPECTED_SCENARIO_IDS = (
    "next-phrase-boundary-32beat",
    "on-boundary-advances-to-following-32beat",
    "nonzero-clock-origin-32beat",
    "destination-tempo-150-32beat",
    "min-lead-advances-to-following-32beat",
    "decode-instant-4beat-phrases",
    "decode-crossing-4beat-phrases",
    "real-clock-observation-4beat-phrases",
)


def _nonfinite_number_paths(value, path: str = "$") -> list[str]:
    """Return JSON paths containing NaN/infinity (bool is not numeric here)."""
    if isinstance(value, bool) or value is None:
        return []
    if isinstance(value, (int, float)):
        return [] if math.isfinite(value) else [path]
    if isinstance(value, list):
        return [problem for index, item in enumerate(value)
                for problem in _nonfinite_number_paths(item, f"{path}[{index}]")]
    if isinstance(value, dict):
        return [problem for key, item in value.items()
                for problem in _nonfinite_number_paths(item, f"{path}.{key}")]
    return []


def current_commit() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True,
        check=True).stdout.strip()


def _valid_payload(commit: str) -> dict:
    """A minimal well-formed capture for validation tests (audit D)."""
    return {
        "schema": "2become1.listening-timing/1",
        "evidenceClass": "B_browser_scheduling",
        "generatedBy": "tests/browser/timing_bench.js",
        "capturedAt": "2026-09-06T00:00:00Z",
        "commit": commit,
        "repoDirtyAtCapture": False,
        "benchmarkSourcesDirtyAtCapture": False,
        "sourceIdentityPolicy": "commit match + clean benchmark source scope",
        "browser": {
            "name": "chromium", "version": "test", "executablePath": "/test",
        },
        "os": {"platform": "linux", "release": "test", "node": "test"},
        "contextKind": "OfflineAudioContext + AudioContext observation",
        "clockPolicy": "per-scenario clockMode",
        "schedulerCoverage": "GhostScheduler only",
        "selfTestWrongExpectationDetected": True,
        "measured": True,
        "assertionFailureCount": 0,
        "cases": [{
            "scenario": scenario,
            "exercises": "test",
            "clockMode": "injected-controlled",
            "sampleRate": 44100,
            "assertionFailures": [],
            "ok": True,
            "receipt": {
                "proposalId": scenario,
                "launchAudioTime": 16.0,
                "requestedAt": 5.0,
                "resolvedBeat": 32,
                "gridRevision": "bench-grid-1",
            },
            "capturedStarts": [16.0],
            "states": ["fetching", "decoding", "scheduled", "started"],
            "decodeMs": 1.0,
            "clockAtReturn": 5.0,
        } for scenario in EXPECTED_SCENARIO_IDS],
    }


def load_and_validate_receipts(path: Path = RECEIPTS_PATH,
                               *, current_commit_sha: str | None = None
                               ) -> dict:
    """Return a labeled ingestion record for the receipts capture.

    Never raises for a bad capture: a failed validation is itself the
    evidence ("unmeasured/unverified") so the combined report can state the
    gap honestly.
    """
    commit = current_commit_sha if current_commit_sha is not None else current_commit()
    result: dict = {
        "captured": False,
        "status": "missing",
        "commit": commit,
        "embeddedCases": [],
        "browser": None,
        "captureMeta": None,
        "problems": [],
    }
    if not path.exists():
        result["status"] = "missing"
        result["problems"] = [
            f"no receipts capture found at {path}; run "
            f"node tests/browser/timing_bench.js to capture class B"]
        return result
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        result["status"] = "malformed"
        result["problems"] = [f"unreadable receipts file: {exc}"]
        return result
    if not isinstance(payload, dict):
        result["status"] = "malformed"
        result["problems"] = ["receipts payload is not an object"]
        return result

    problems: list[str] = [
        f"non-finite number at {path_with_nonfinite}"
        for path_with_nonfinite in _nonfinite_number_paths(payload)
    ]
    for key in REQUIRED_TOP_KEYS:
        if key not in payload:
            problems.append(f"missing provenance key '{key}'")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        problems.append("no cases captured")
        cases = cases if isinstance(cases, list) else []
    for field, expected in (
        ("schema", "2become1.listening-timing/1"),
        ("evidenceClass", "B_browser_scheduling"),
        ("generatedBy", "tests/browser/timing_bench.js"),
        ("sourceIdentityPolicy", "commit match + clean benchmark source scope"),
    ):
        if payload.get(field) != expected:
            problems.append(
                f"capture-level truth gate '{field}' is "
                f"{payload.get(field)!r}, expected {expected!r}")
    for field, expected in (
        ("selfTestWrongExpectationDetected", True),
        ("measured", True),
        ("benchmarkSourcesDirtyAtCapture", False),
    ):
        if payload.get(field) is not expected:
            problems.append(
                f"capture-level truth gate '{field}' is "
                f"{payload.get(field)!r}, expected boolean {expected!r}")
    assertion_count = payload.get("assertionFailureCount")
    if type(assertion_count) is not int or assertion_count != 0:
        problems.append(
            "capture-level truth gate 'assertionFailureCount' is "
            f"{assertion_count!r}, expected integer 0")
    if not isinstance(payload.get("capturedAt"), str) or not payload["capturedAt"]:
        problems.append("capture metadata 'capturedAt' is missing or not a string")
    if not isinstance(payload.get("commit"), str) or not payload["commit"]:
        problems.append("capture metadata 'commit' is missing or not a string")
    if type(payload.get("repoDirtyAtCapture")) is not bool:
        problems.append("capture metadata 'repoDirtyAtCapture' is not boolean")
    for field in ("contextKind", "clockPolicy", "schedulerCoverage"):
        if not isinstance(payload.get(field), str) or not payload[field]:
            problems.append(f"capture metadata '{field}' is missing or not a string")
    browser = payload.get("browser")
    if not isinstance(browser, dict) or any(
            not isinstance(browser.get(key), str) or not browser[key]
            for key in ("name", "version", "executablePath")):
        problems.append("capture metadata 'browser' is incomplete or ill-typed")
    os_meta = payload.get("os")
    if not isinstance(os_meta, dict) or any(
            not isinstance(os_meta.get(key), str) or not os_meta[key]
            for key in ("platform", "release", "node")):
        problems.append("capture metadata 'os' is incomplete or ill-typed")
    seen_ids: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            problems.append("case is not an object")
            continue
        scenario_id = case.get("scenario")
        if not isinstance(scenario_id, str) or not scenario_id \
                or scenario_id in seen_ids:
            problems.append(f"case id missing or duplicated: {scenario_id!r}")
            continue
        seen_ids.add(scenario_id)
        sample_rate = case.get("sampleRate")
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, float)) \
                or not math.isfinite(sample_rate) or sample_rate <= 0:
            problems.append(f"case '{scenario_id}' sampleRate is not positive and finite")
        if not isinstance(case.get("clockMode"), str) or not case["clockMode"]:
            problems.append(f"case '{scenario_id}' clockMode is missing")
        states = case.get("states")
        if not isinstance(states, list) or "started" not in states:
            problems.append(f"case '{scenario_id}' states must include 'started'")
        if case.get("ok") is not True:
            problems.append(f"case '{scenario_id}' did not pass its assertions")
        if case.get("assertionFailures") != []:
            problems.append(
                f"case '{scenario_id}' assertionFailures is not empty")
        receipt = case.get("receipt")
        if not isinstance(receipt, dict):
            problems.append(f"case '{scenario_id}' has no receipt")
            continue
        if receipt.get("proposalId") != scenario_id:
            problems.append(
                f"case '{scenario_id}' receipt proposalId does not match")
        for key in REQUIRED_RECEIPT_KEYS:
            if key not in receipt:
                problems.append(f"case '{scenario_id}' receipt missing '{key}'")
        for key in ("launchAudioTime", "requestedAt", "resolvedBeat"):
            value = receipt.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) \
                    or value != value or value in (float("inf"), float("-inf")):
                problems.append(
                    f"case '{scenario_id}' receipt '{key}' is not a finite number")
        if scenario_id != "real-clock-observation-4beat-phrases":
            starts = case.get("capturedStarts")
            launch = receipt.get("launchAudioTime")
            if not isinstance(starts, list) or len(starts) != 1 \
                    or isinstance(starts[0], bool) \
                    or not isinstance(starts[0], (int, float)) \
                    or not math.isfinite(starts[0]) \
                    or not isinstance(launch, (int, float)) \
                    or abs(starts[0] - launch) > 1e-6:
                problems.append(
                    f"case '{scenario_id}' capturedStarts must contain its "
                    "receipt launchAudioTime exactly once")
    if set(seen_ids) != set(EXPECTED_SCENARIO_IDS) \
            or len(cases) != len(EXPECTED_SCENARIO_IDS):
        problems.append(
            "captured scenario set does not match the expected benchmark set: "
            f"got {sorted(seen_ids)!r}, expected "
            f"{sorted(EXPECTED_SCENARIO_IDS)!r}")
    if problems:
        result["status"] = "invalid"
        result["problems"] = problems
        result["captureMeta"] = {
            "capturedAt": payload.get("capturedAt"),
            "commit": payload.get("commit"),
            "repoDirtyAtCapture": payload.get("repoDirtyAtCapture"),
        }
        return result

    capture_commit = payload.get("commit")
    if capture_commit != commit:
        result["status"] = "stale"
        result["problems"] = [
            f"receipts captured at commit {capture_commit}, current HEAD is "
            f"{commit}; re-run node tests/browser/timing_bench.js"]
        result["captureMeta"] = {
            "capturedAt": payload.get("capturedAt"),
            "commit": capture_commit,
            "repoDirtyAtCapture": payload.get("repoDirtyAtCapture"),
        }
        return result

    result.update({
        "captured": True,
        "status": "current",
        "embeddedCases": cases,
        "browser": payload.get("browser"),
        "captureMeta": {
            "capturedAt": payload.get("capturedAt"),
            "commit": capture_commit,
            "repoDirtyAtCapture": payload.get("repoDirtyAtCapture"),
            "benchmarkSourcesDirtyAtCapture":
                payload.get("benchmarkSourcesDirtyAtCapture"),
            "sourceIdentityPolicy": payload.get("sourceIdentityPolicy"),
            "os": payload.get("os"),
            "contextKind": payload.get("contextKind"),
            "clockPolicy": payload.get("clockPolicy"),
            "schedulerCoverage": payload.get("schedulerCoverage"),
            "selfTestWrongExpectationDetected":
                payload.get("selfTestWrongExpectationDetected"),
        },
    })
    return result
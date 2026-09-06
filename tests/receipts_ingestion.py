"""Class-B receipts ingestion: provenance retention + validation (audit D).

The combined report embeds ``tests/browser/artifacts/timing_bench/receipts.json``
only when the capture is provably current and well-formed. Stale, malformed,
partial, failed, or missing captures are labeled explicitly — never silently
relabeled as current evidence.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

RECEIPTS_PATH = Path("tests/browser/artifacts/timing_bench/receipts.json")

REQUIRED_TOP_KEYS = (
    "schema", "evidenceClass", "generatedBy", "capturedAt", "commit",
    "repoDirtyAtCapture", "browser", "os", "contextKind", "clockPolicy",
    "schedulerCoverage", "selfTestWrongExpectationDetected", "measured",
    "assertionFailureCount", "cases",
)
REQUIRED_RECEIPT_KEYS = (
    "proposalId", "launchAudioTime", "requestedAt", "resolvedBeat",
    "gridRevision",
)


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
        "browser": {"name": "chromium", "version": "test"},
        "os": {"platform": "linux"},
        "contextKind": "OfflineAudioContext + AudioContext observation",
        "clockPolicy": "per-scenario clockMode",
        "schedulerCoverage": "GhostScheduler only",
        "selfTestWrongExpectationDetected": True,
        "measured": True,
        "assertionFailureCount": 0,
        "cases": [{
            "scenario": "next-phrase-boundary-32beat",
            "exercises": "test",
            "clockMode": "injected-controlled",
            "sampleRate": 44100,
            "assertionFailures": [],
            "ok": True,
            "receipt": {
                "proposalId": "next-phrase-boundary-32beat",
                "launchAudioTime": 16.0,
                "requestedAt": 5.0,
                "resolvedBeat": 32,
                "gridRevision": "bench-grid-1",
            },
            "capturedStarts": [16.0],
            "states": ["fetching", "decoding", "scheduled", "started"],
            "decodeMs": 1.0,
            "clockAtReturn": 5.0,
        }],
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

    problems: list[str] = []
    for key in REQUIRED_TOP_KEYS:
        if key not in payload:
            problems.append(f"missing provenance key '{key}'")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        problems.append("no cases captured")
        cases = cases if isinstance(cases, list) else []
    seen_ids: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            problems.append("case is not an object")
            continue
        scenario_id = case.get("scenario")
        if not scenario_id or scenario_id in seen_ids:
            problems.append(f"case id missing or duplicated: {scenario_id!r}")
            continue
        seen_ids.add(scenario_id)
        if case.get("ok") is not True:
            problems.append(f"case '{scenario_id}' did not pass its assertions")
        receipt = case.get("receipt")
        if not isinstance(receipt, dict):
            problems.append(f"case '{scenario_id}' has no receipt")
            continue
        for key in REQUIRED_RECEIPT_KEYS:
            if key not in receipt:
                problems.append(f"case '{scenario_id}' receipt missing '{key}'")
        for key in ("launchAudioTime", "requestedAt", "resolvedBeat"):
            value = receipt.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) \
                    or value != value or value in (float("inf"), float("-inf")):
                problems.append(
                    f"case '{scenario_id}' receipt '{key}' is not a finite number")
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
            "os": payload.get("os"),
            "contextKind": payload.get("contextKind"),
            "clockPolicy": payload.get("clockPolicy"),
            "schedulerCoverage": payload.get("schedulerCoverage"),
            "selfTestWrongExpectationDetected":
                payload.get("selfTestWrongExpectationDetected"),
        },
    })
    return result
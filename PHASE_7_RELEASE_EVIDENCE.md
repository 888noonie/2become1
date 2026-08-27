# Phase 7 Release Evidence — V0.3.0 Candidate

**Prepared by:** Hermes (implementation and verification owner)
**Date:** 2026-08-27
**Baseline:** `v0.3-workspace` at `879defd`
**Status:** Accepted and pushed; final checkpoint CI/tag sequence in progress

This document records the evidence for Phases 7A, 7B, and 7C. Hermes did not
commit, tag, push, purge media, or modify the Ghost scope. The working tree is
left uncommitted for Sol's independent audit.

---

## 1. Changed files, grouped by phase

### Phase 7A — Automated acceptance

- `tests/browser/fixture_server.py` (new) — real FastAPI app against a temp
  data root; stubs only `acquisition.download_youtube` (external network) and
  leaves the ffmpeg center/side + render paths real.
- `tests/browser/run.js` (new) — browser harness driving system Chromium via
  `playwright-core` (never downloads a browser); 30 checks across the primary
  journeys plus a deterministic accessibility audit.
- `tests/browser/chromium.js` (new in Sol audit) — validates explicit, common
  system, and Playwright-managed executable paths without accepting a missing
  fallback.
- `tests/browser/a11y.js` (new) — dependency-free accessibility checker
  (accessible names, image alt, heading order, tabindex, 44px targets,
  reduced-motion, live regions).
- `tests/browser/screenshots.js` (new) — visual QA capture across 4 viewports.
- `tests/browser/__init__.py` (new) — package marker.
- `tests/test_browser_fixture.py` (new) — 10 focused tests for every fixture
  helper.
- `package.json` / `package-lock.json` — added `playwright-core@1.62.1`
  (dev-only) and a `test:browser` script.
- `.github/workflows/test.yml` — added a distinct `browser-e2e` job with
  failure artifacts.
- `.gitignore` — ignore `tests/browser/artifacts/`.

### Phase 7B — Real-system hardening

- `tests/test_phase7b_migration.py` (new) — migration/restart verification
  against the V0.2 fixture and a temporary copy of the real database.
- `tests/test_phase7b_security.py` (new) — 7 tests pinning the network-exposure
  gate and truthful reporting.
- `src/twobecomeone/webapp.py` — `_network_exposure(host)` now reports the
  actual bind host; `create_app(..., bind_host=...)` threads it through;
  `_is_loopback_host()` added.
- `src/twobecomeone/cli.py` — added `--allow-network` flag and
  `_require_allow_network()` gate; `cmd_web` refuses non-loopback binds without
  the flag.
- `src/twobecomeone/studio_static/styles/studio.css` — brand link/mark now use
  `--target-min` (44px) instead of a literal 42px.
- `src/twobecomeone/jobs.py` — retry clones now reference the immediate source
  job through `parent_job_id`, preserving truthful history lineage.
- `src/twobecomeone/studio_static/js/components/analysis-dialog.js` and
  `stem-dialog.js` — corrected dialog subsection heading levels exposed by the
  expanded accessibility gate.
- `tests/browser/hardware_smoke.py` (new) — bounded real CUDA Demucs + render
  smoke test against a temp root.

### Phase 7C — Release candidate

- `src/twobecomeone/__init__.py` — `__version__` bumped `0.2.0` → `0.3.0`.
- `pyproject.toml` — `version` bumped `0.2.0` → `0.3.0`.
- `tests/test_phase7c_version.py` (new) — 6 tests asserting Python, frontend,
  lockfile, changelog, CLI, and sdist policy agreement.
- `uv.lock` — synchronized to `0.3.0`; offline regeneration also restored the
  declared `httpx>=0.28` dependency and removed stale unrelated `httpx2`
  entries.
- `tests/verify_release_artifacts.py` and explicit Hatch sdist allowlist — fail
  if private/internal/generated material enters either release archive.
- `CHANGELOG.md` (new) — user-visible V0.3 journey, compatibility, migration,
  security, limitations, lawful-media reminder.
- `README.md` — Arch-native install, `--allow-network`, browser tests, backup/
  recovery, current boundaries.

---

## 2. Defects found, root causes, fixes, and regressions

### Defect 1 — Network-exposure gate missing (release blocker)

- **Root cause:** Section 13 of the implementation plan requires an
  `--allow-network` flag for non-loopback binding and truthful exposure
  reporting, but the CLI only exposed `--host` and `_network_exposure()`
  hardcoded `loopback_only: True` regardless of the actual bind.
- **Fix:** Added `_is_loopback_host()`, threaded the bind host through
  `create_app(..., bind_host=...)`, and added `--allow-network` +
  `_require_allow_network()` to the CLI.
- **Regression:** `tests/test_phase7b_security.py` (7 tests) — loopback
  detection, exposure reporting, and the allow-network gate (refuse without
  flag, permit with flag, loopback always permitted).

### Defect 2 — Brand link below the 44px touch target

- **Root cause:** `.brand-mark` used a literal `42px` height/width, and the
  `.brand` link had no `min-height`, so the brand link measured 42px tall at
  mobile widths.
- **Fix:** Both now use `var(--target-min)` (44px).
- **Regression:** The browser accessibility audit's 44px target check now
  passes at 390px (0 moderate findings).

### Defect 3 — Retry provenance lost its parent

- **Root cause:** `clone_for_retry()` copied the failed job's existing
  `parent_job_id` (usually null) instead of referencing the job being retried.
- **Fix:** Retry clones now set `parent_job_id` to the immediate source job ID.
- **Regression:** Store-level lineage assertion plus browser retry from failed
  history through a newly completed render.

### Defect 4 — Release metadata and lock drift

- **Root cause:** `package.json`, `package-lock.json`, and `uv.lock` were not
  included in the original version synchronization. The stale Python lock also
  resolved the declared `httpx` extra as unrelated `httpx2` packages.
- **Fix:** All project/lock declarations now report `0.3.0`; `uv lock --offline`
  restored `httpx 0.28.1`; regressions pin versions and declared dependency
  names.

### Defect 5 — Browser harness isolation and coverage gaps

- **Root cause:** fixed port 8871 collided with a live local server, temporary
  roots were not deleted, the test-network monkeypatch leaked across pytest
  tests, Chromium fallback accepted a missing path, and accessibility ran only
  against Studio.
- **Fix:** ephemeral loopback ports, awaited process teardown plus temp cleanup,
  scoped monkeypatch restoration, shared validated Chromium resolution, and
  all-view/dialog/result audits. The gate now also covers cue/analysis restore,
  stem audition/selection, rename/new-mix, and retry lineage.
- **Regression:** 30 checks pass at both release viewports.

### Defect 6 — Private conversation leaked into source archive

- **Root cause:** Hatch's default broad sdist selection included untracked
  workspace material, including `Sol to Sol.txt`.
- **Fix:** An explicit public-source allowlist and archive verifier exclude the
  transcript, internal plans/evidence, Ghost document, generated artifacts,
  dependency trees, and Git data. CI now builds and verifies both archives.

### Defect 7 — Queued cancellation raced worker startup

- **Root cause:** cancellation read a queued status, then used a second
  compare-and-swap after the worker could already have claimed the job. That
  valid ordering raised `InvalidTransition`; the inverse ordering could also
  make a worker try to start an already-cancelled job.
- **Fix:** queued cancellation is now one conditional update. A worker that
  wins observes the persisted request and cancellation token; a cancellation
  that wins is treated by the later worker as a normal terminal outcome.
- **Regression:** deterministic tests cover both race orderings, including
  proving that a cancelled queued job never invokes its run function.

### Defect 8 — Browser stem assertion raced asynchronous tray refresh

- **Root cause:** the journey waited for the separation job's terminal status,
  but asserted the tray before the subsequent stem-list request had necessarily
  rendered on slower CI workers.
- **Fix:** the journey now waits for the Center and Sides rows themselves—the
  exact state the assertion is intended to verify.
- **Regression:** the 30-check desktop journey passes locally after reproducing
  the CI ordering; the final checkpoint runs both desktop and mobile journeys.

---

## 3. Exact commands and pass counts

| Check | Command | Result |
|---|---|---|
| Python suite | `.venv/bin/pytest -q` | **290 passed** |
| Node unit suite | `npm test` | **102 declarations across 14 files passed** |
| Browser E2E (desktop) | `node tests/browser/run.js --viewport 1280x800` | **30 checks, 0 failures** |
| Browser E2E (mobile) | `node tests/browser/run.js --viewport 390x844` | **30 checks, 0 failures** |
| JS syntax (shipped) | `node --check` over all `studio_static/js/*.js` | all pass |
| JS syntax (harness) | `node --check` over `tests/browser/*.js` | all pass |
| Diff check | `git diff --check` | clean |
| Build | `uv build --wheel --sdist` | `2become1-0.3.0` wheel + sdist |
| Wheel version | inspect METADATA | `Version: 0.3.0` |
| Archive safety | `.venv/bin/python tests/verify_release_artifacts.py` | clean |

---

## 4. Browser viewports, accessibility, screenshots, bundle size

- **Viewports exercised:** 1440×1100, 1280×800, 820×1180, 390×844 (visual QA
  capture) plus 1280×800 and 390×844 (E2E assertions).
- **Accessibility:** 0 serious, 0 moderate, 0 info findings across Studio,
  Library, Activity, Engine, source/stem/analysis dialogs, and completed-result
  state at both 1280×800 and 390×844. The audit covers accessible names,
  image alt, heading order, positive tabindex, 44px touch targets,
  reduced-motion, and live regions.
- **Keyboard:** focus trap, Escape close, and focus return verified in the
  browser harness.
- **Screenshots:** `tests/browser/artifacts/` — 17 refreshed PNGs (4 views × 4
  viewports + loading state). Engine truthfully shows `0.3.0`; Activity includes
  retryable failed history. All were inspected after regeneration.
- **Frontend size:** **247,010 bytes** uncompressed (under the 350 KB budget).

---

## 5. Migration, restart, CUDA/Demucs, render, peak, network evidence

- **Migration:** V0.2 fixture migrates in place through all 8 numbered
  migrations; seed rows survive; the app opens over the migrated DB. The real
  local DB is already at migration version 7 (2 tracks, 6 jobs, 1 project, 1
  stem set) and a temporary copy opens cleanly with row counts unchanged.
- **Restart:** queued/running jobs are marked `interrupted` (not failed/
  cancelled) on startup; recovery offers retry/resume.
- **CUDA/Demucs:** real Demucs separation ran on the RTX 4050
  (`preferred=cuda`, `device=cuda`, `oom_fallback=False`).
- **Render:** real ffmpeg render produced 4.0s output at **-6.5 dBFS** true
  peak (below 0 dBFS).
- **Network smoke:** YouTube is reachable (HTTP 200), but the connection is
  documented as slow (40–80 KB/s), so a full real import was recorded as
  **environment-blocked** rather than performed.

---

## 6. Dependencies added

- `playwright-core@1.62.1` — **dev-only**, drives the existing system Chromium
  (`/usr/bin/chromium`); it never downloads a browser. CI installs its own
  known Chromium via the full `playwright` CLI in the separate `browser-e2e`
  job.

---

## 7. Deviations, environment-blocked checks, known limitations

- **Deviation (fix):** the network-exposure gate was missing and is now
  implemented per section 13. This is a security-policy fix, reported here for
  Sol/Richard authorization as required by the shared execution rules.
- **Environment-blocked:** real YouTube import (slow network); recorded as
  blocked, not passed.
- **Known limitations:** unchanged from the plan — beat/downbeat are
  suggestions; ffmpeg fallback is center/side, not vocal isolation; Demucs is
  serialized; three-plus-track composition is deferred.

---

## 8. Confirmation of constraints

Hermes did **not** commit, tag, push, purge media, change branches, or modify
the Ghost scope (`docs/V1_GHOST_ARCHITECTURE.md` was read but not implemented).
The existing working-tree changes to `CODEX.md` and
`V0.3_IMPLEMENTATION_PLAN.md` (the Phase 7 setup edits) and the untracked
`Sol to Sol.txt` were preserved. Richard's media under
`~/.local/share/2become1` was never modified; all destructive/error-path
testing used temporary data roots.

---

## 9. Sol independent audit

Sol read the actual working tree and applied only the bounded corrections in
Defects 3–8. Focused regressions, the complete Python/Node suites, expanded
desktop/mobile browser gates, JavaScript syntax, lock consistency, frontend
budget, CLI fail-secure behavior, clean build, and archive inspection pass.

The real CUDA/Demucs run was not repeated because it had already succeeded on
the RTX 4050 and no production Demucs path changed. The one-shot smoke tool now
allows a one-hour slow-download window and explicitly releases cached CUDA
memory on teardown. No persistent project/media path was written during audit.

Implementation/audit commit `e2326d6` is pushed to `v0.3-workspace`. GitHub
Actions run `33116091840` completed successfully: both the 289-test/unit/build/
archive job and the 30-check desktop/mobile browser job are green. The
`v0.3.0` tag is authorized only after the documentation checkpoint containing
this acceptance record passes its own CI; the tag must point exactly to that
green checkpoint commit.

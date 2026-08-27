# Phase 7 — V0.3 Release Tri-Phase Plan

- **Audience:** Hermes (implementation and verification owner)
- **Baseline:** `v0.3-workspace` at `879defd`
- **Status:** Approved next implementation plan
- **Scope:** Quality, release evidence, documentation, and V0.3 release candidate
- **Ownership:** Hermes edits and tests but does not commit, tag, or push. Gemini
  Pro reviews and advises without editing. Sol audits, applies only justified
  narrow fixes, commits, pushes, monitors CI, and authorizes release actions.

## 1. Outcome

Close V0.3 through one bounded group of three phases:

1. **Phase 7A — Automated acceptance:** add browser-level primary-flow and
   accessibility coverage and make it a distinct CI gate.
2. **Phase 7B — Real-system hardening:** exercise migrations, recovery,
   security, responsive UI, and the local CUDA/media path; repair only defects
   exposed by that evidence.
3. **Phase 7C — Release candidate:** finish public documentation and version
   metadata, assemble reproducible evidence, and hand a clean release candidate
   to Sol.

The group is reviewed as a whole after Hermes compacts. It must not grow into a
feature phase.

## 2. Scope lock

### In scope

- automated browser tests for the V0.3 primary journeys;
- accessibility, responsive, console-error, and focus behavior verification;
- migration, restart/recovery, safe-path, and compatibility evidence;
- a bounded real CUDA Demucs and two-track render smoke test;
- release documentation, screenshots, recovery instructions, and version bump;
- narrow fixes for defects directly discovered by this release work.

### Out of scope

- Ghost layers, generic Actions, Producer AI, phrase/chorus detection, or live
  Web Audio mixing;
- a Redux/frontend-framework adoption;
- three-plus-track composition, clip timelines, plugins, automation, or cloud;
- dependency upgrades unrelated to the acceptance harness;
- schema or API expansion unless a demonstrated V0.3 release blocker requires
  it and is reported before implementation;
- deleting or rewriting Richard's existing media, projects, or immutable job
  history.

The future Ghost direction is preserved in
`docs/V1_GHOST_ARCHITECTURE.md`; reading it does not authorize implementation.

## 3. Shared execution rules

Before editing, Hermes must:

1. read `CODEX.md`, `V0.3_IMPLEMENTATION_PLAN.md`, this file,
   `PHASE_6_5_MIXER_ESSENTIALS_PLAN.md`, and the relevant current code/tests;
2. confirm branch `v0.3-workspace`, HEAD `879defd`, and no unexpected tracked
   changes; preserve the untracked design transcript `Sol to Sol.txt`;
3. record the exact baseline Python test count, frontend declaration count,
   frontend byte size, and current CI result;
4. use temporary data roots for destructive/error-path testing and treat
   `/home/richardn/.local/share/2become1` as irreplaceable user data;
5. keep the repository green at the end of each subphase and record evidence in
   a single release evidence document.

Hermes may make working-tree edits across all three phases but must not commit,
tag, push, release, force-push, purge media, or change branches. If a fix changes
scope, persistence, security policy, dependency strategy, or an existing API
contract, stop and report it for Sol/Richard authorization.

## 4. Phase 7A — Automated acceptance

### Goal

Turn the browser behavior already checked manually into a deterministic local
and CI acceptance gate without making CI depend on YouTube, CUDA, Richard's
media, or a persistent home-directory database.

### Tasks

1. Add a browser-test harness around system Chromium locally. Use a dev-only
   browser dependency and configure it to reuse `/usr/bin/chromium`; do not
   download a second local browser implicitly. CI may install/cache its own
   known Chromium runtime in a separate `browser-e2e` job.
2. Start the real FastAPI application against a temporary data root and stub at
   the application/service boundary only for external network and expensive GPU
   work. Exercise real routing, StateStore, DOM, API serialization, persistence,
   job coordination, and audio-control UI.
3. Cover these primary journeys:
   - first run -> create project -> import/fixture two tracks -> assign decks;
   - existing Library selection -> swap -> cue/analysis change -> refresh and
     restore;
   - separation completion -> truthful stem audition/select -> plan;
   - preview -> full render -> result play/download/rename -> new mix;
   - failed/interrupted job -> retry or resume -> terminal recovery;
   - cancel/invalid/offline behavior without lost user edits.
4. Run at least one desktop and exact 390x844 automated viewport. Assert no
   uncaught page/console errors, no page-level horizontal overflow, and usable
   sticky/dialog behavior.
5. Add automated accessibility checks for the primary populated Studio,
   Library, Activity, Engine, dialogs, and result states. Also explicitly test
   keyboard order, focus trap/return, accessible names, reduced motion, status
   announcements, and enabled 44px targets where automation is reliable.
6. Keep existing Node unit tests. Browser tests are an additional tier, not a
   replacement, and must have deterministic setup/teardown with no orphaned
   server/browser processes.
7. Add a distinct GitHub Actions browser job with artifacts on failure
   (screenshots, trace/report, and safe server log). Mock network/GPU paths and
   never upload audio or sensitive local paths as artifacts.

### Required tests/evidence

- focused tests for every harness helper or backend fixture added;
- complete Python and Node unit suites;
- complete browser suite using system Chromium locally;
- CI workflow syntax/review and proof the browser job is separate;
- frontend remains below 350 KB uncompressed, excluding dev dependencies and
  test assets.

### Exit gate

Phase 7A exits only when the primary V0.3 browser journeys run repeatably from a
clean temporary data root, accessibility checks have no unexplained serious or
critical findings, failures retain diagnostic artifacts, all existing suites
remain green, and no process/data leakage remains after teardown.

## 5. Phase 7B — Real-system hardening

### Goal

Verify claims that mocks cannot prove and fix only release-blocking defects
revealed by the evidence.

### Tasks

1. Verify numbered migration from checked-in V0.2 fixtures and from a backup or
   temporary copy of the real local database. Never run destructive migration
   experiments against the only live copy. Record row/media invariants and
   application restart success.
2. Run security/failure checks for managed-root containment, traversal and
   symlink rejection, hostile text rendering, upload/download limits, common
   error envelopes, loopback default, network-exposure warning, cancellation,
   and finalization cleanup. Add regressions for any defect found.
3. Repeat populated visual and keyboard QA at 1440x1100, 1280x800, 820x1180,
   and exact emulated 390x844. Inspect Studio, Library, Activity, Engine,
   dialogs, loading, failure, progress, and completed-result states. Record
   screenshots deliberately; do not merely capture them.
4. Complete a bounded manual hardware smoke using permitted media:
   - one lawful YouTube import with real progress/artwork if network conditions
     allow, otherwise record it as a separately blocked environmental check;
   - two real tracks through plan, preview, full render, playback, and download;
   - one Demucs separation showing the actual selected device and truthful OOM
     fallback behavior if encountered;
   - verify expected duration, audible alignment/transition, and output true
     peak below 0 dBFS;
   - restart during a controlled temporary resumable import and confirm honest
     recovery without damaging the real library.
5. Verify clean start/stop and recovery instructions on this CachyOS/Arch
   machine. Documentation should use Arch-native commands locally and explain
   that CI's `apt-get` line is Ubuntu-runner-specific, not user setup guidance.
6. Apply only narrow fixes backed by a reproduced failure. Every fix receives a
   regression test and is rerun through the affected browser/manual path.

### Required tests/evidence

- exact commands, test counts, browser viewports, bundle bytes, and relevant
  hardware/capability output;
- before/after description for each defect fixed;
- sanitized screenshot paths and a concise manual listening result;
- explicit `pass`, `fail`, or `environment-blocked` for each hardware/network
  smoke item—never convert an unperformed check into a pass.

### Exit gate

Phase 7B exits only when no known release blocker remains, temporary-copy
migration/restart succeeds, all responsive/accessibility states are inspected,
the local two-track flow succeeds, CUDA/Demucs truthfulness is recorded, every
code correction has regression coverage, and all automated suites remain green.

## 6. Phase 7C — Release candidate

### Goal

Produce an auditable V0.3.0 candidate. Hermes prepares it; Sol owns final
acceptance, commit, push, CI monitoring, tag, and release authorization.

### Tasks

1. Reconcile every item in section 2 and section 16 of
   `V0.3_IMPLEMENTATION_PLAN.md` against evidence. Mark only demonstrated items
   complete and list any honest residual limitation.
2. Update README and durable docs to match the shipped product: CachyOS/Arch
   installation and launch, optional Demucs/CUDA, API/product architecture,
   local-first/security boundaries, backup/recovery, browser support, test
   commands, and current limitations.
3. Add or update release notes/changelog with the user-visible V0.3 journey,
   compatibility guarantees, migration behavior, known limitations, and a
   clear lawful-media reminder.
4. Replace stale screenshots with the inspected release views. Do not commit
   temporary profiles, traces, user media, absolute private paths, tokens, or
   unsanitized logs.
5. Bump both package version declarations from `0.2.0` to `0.3.0` and add a
   regression asserting they agree. Do not tag or publish.
6. Update `CODEX.md`, `V0.3_IMPLEMENTATION_PLAN.md`, and the release evidence
   document to the candidate checkpoint. Do not declare release acceptance or
   invent commit/CI identifiers that do not yet exist.
7. Run the final verification from a cleanly restarted application:
   - full Python suite;
   - full Node unit suite;
   - full browser E2E/accessibility suite;
   - syntax checks for all shipped JavaScript;
   - `git diff --check`;
   - frontend size budget;
   - build wheel/sdist and inspect contents/version;
   - review `git status` for accidental media, secrets, caches, and artifacts.

### Exit gate

Phase 7C exits when the working tree contains a coherent, tested V0.3.0 release
candidate; every release claim maps to recorded evidence; no generated/private
artifact is staged; no known release blocker remains; and Hermes provides Sol
the handoff specified below without committing, tagging, or pushing.

## 7. Hermes handoff package

After all three phases, Hermes compacts and reports:

- changed files grouped by 7A, 7B, and 7C;
- defects found, root causes, fixes, and regression tests;
- exact commands and pass counts for Python, Node, browser, syntax, build, and
  diff checks;
- browser viewports, accessibility results, screenshot/artifact locations, and
  frontend byte size;
- migration, restart, CUDA/Demucs, render, peak, and network-smoke evidence;
- dependencies added and why each is test-only or otherwise necessary;
- deviations, `environment-blocked` checks, and known limitations;
- confirmation that Hermes did not commit, tag, push, purge media, or modify
  the Ghost scope.

Gemini Pro then receives the plan, Hermes's compact, and the diff under an
advice-only instruction. It reports possible correctness, security,
accessibility, test, and release-evidence gaps without editing files.

Sol then independently reads the actual diff and evidence, reproduces the
high-risk checks, applies only narrow justified fixes, reruns affected and full
suites, commits, pushes, waits for green CI, and reports whether the candidate
is authorized for `v0.3.0` tagging. Tagging is a distinct final action and must
not happen before that authorization.

## 8. Final release gate owned by Sol

Sol may authorize and create `v0.3.0` only when:

- all Phase 7A/7B/7C exit gates are satisfied;
- the release commit is clean, pushed, and exactly identified;
- Python, Node, browser, build, and CI jobs are green at that commit;
- version metadata and built artifacts report `0.3.0`;
- migrations preserve existing data and the real local workspace remains safe;
- documentation and known limitations are truthful;
- the tag points to the audited green release commit.

If any gate fails, the candidate remains unreleased and the next work is a
small corrective plan—not an expansion into V1 features.

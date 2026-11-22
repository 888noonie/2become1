---
name: release-gates
description: >
  Fast-forward 2become1 to the existing public main after the gates pass.
  Use when promoting a verified HEAD. Refuse a force push or a dirty personal tree.
---

# Integration, review, and release

## When to use

A branch is ready for the existing GitHub repo `888noonie/2become1`. The PM has already authorised an ordinary fast-forward. Do not ask again for that. If a mandatory gate fails, stop.

## Problem

This machine has a dirty main checkout, several worktrees, a shared virtualenv, little free disk, and a broken NVIDIA driver. A promotion that ignores any of those will publish the wrong tree or destroy local recovery.

## Source of truth

- `AGENTS.md`
- `docs/the-maestro.md`
- Remote `origin`: `https://github.com/888noonie/2become1.git`
- Local recovery refs from the Golden Record promotion, not pushed: `backup/main-before-golden-record` (`28eef69`) and `backup/golden-record-release` (`cbe6984`)

## Boundaries

Push only `main`, and only with a fast-forward. Do not push experiment branches, backup refs, source audio, or session data. Do not delete worktrees or historical branches. Do not repair CUDA, upgrade packages, or download model weights as part of a release.

## Invariants

- Fetched `origin/main` is an ancestor of the release HEAD. If it is not, stop and report the divergence.
- The main checkout may contain untracked personal files (a bankruptcy PDF, `Mock Images/`, session notes, listener experiments). Stage paths by name. Never `git add -A` there.
- The worktree `.venv` is a symlink to `/home/richardn/2become1/.venv`, whose editable install points at the main checkout's `src`. Python tests of a worktree need `PYTHONPATH=src` and a check that `twobecomeone.__file__` is that worktree.
- Disk truth is `df -h /` and `sudo btrfs filesystem usage /`. Do not use `du` for free space. Snapshot deletion is on hold.
- Heavy tests run one at a time. Frontend and browser journeys do not need the GPU.
- Leave a server already bound to port 8765 running. Test servers bind `127.0.0.1` on another port and a temporary data dir.

## Procedure

1. Confirm the branch, exact HEAD, and a clean tracked tree.
2. Run `npm test`, then `PYTHONPATH=src .venv/bin/pytest -q` from the worktree.
3. Run the Maestro, Chorus Fit, Black Tie, Draw Levels, and Full House Chromium journeys on loopback with synthetic or cached fixture songs.
4. Scan `origin/main..HEAD` for audio, credentials, `.env`, virtualenvs, and `node_modules`. A substring inside the vendored Signalsmith bundle is not a key.
5. `git fetch origin`. Create local backup refs for the old main and the release HEAD. In the main checkout, `git merge --ff-only <release>`. `git push origin main`. Fetch again and compare `origin/main` to the release SHA.
6. Commit documentation after that push, then fast-forward it the same way.

## Failure modes

- Pytest collecting against `/home/richardn/2become1/src` while the worktree has the change. That looks like a missing module, not a product failure.
- `llama-server` exiting with SIGSEGV because the NVIDIA module and userspace disagree. Record it. Do not block the keyword-path release on it and do not "fix" the driver.
- A force push, or a merge commit, when the remote moved. Stop.
- Promoting from the dirty main tree and sweeping personal files into the commit.

## Tests

The release command set is the procedure above. Record passed, failed, skipped, and unrun. Historical counts are not a substitute.

## Recovery

The backup refs point at the pre-promotion main and the release commit. To undo a local fast-forward that has not been pushed, check out the backup ref. If it has been pushed, do not rewrite it; add a revert commit.

## What not to do

Do not use `--force`. Do not rewrite history. Do not create a second repository. Do not prune worktrees. Do not describe the promotion as musical acceptance.

# Contributor skill handoffs

Repository skills in this directory were written by Grok against the published code on `main`. A local skill counts only after that agent's own file exists.

`docs/golden-encore-opus` is a local branch and worktree at `/home/richardn/MISIX-worktrees/golden-encore`. It has no commit of its own. Claude Opus left uncommitted notes there. Those notes were checked against `time-math.js`, `automation.js`, `producer-intent.js`, `project-state.js`, `daw-session.js`, and `arrangement-producer.js`, then folded into `skills/black-tie-daw/SKILL.md`, `skills/clockwork-audio/SKILL.md`, `skills/autonomous-producer/SKILL.md`, and `skills/audio-validation/SKILL.md`. Claude Sonnet has no separate commit.

## Codex

Saved by Codex during this release. Verified file: `~/.codex/skills/2become1-audio-review/SKILL.md`. It points at the three repository skills and does not copy them. The git tree was not changed by that run.

## Claude Sonnet

Pending. `~/.claude/skills` exists, and Sonnet has not written a file there.

When Sonnet runs, save `~/.claude/skills/2become1-sonnet-craft/SKILL.md` for direct waveform editing, Draw Levels pointer and keyboard behaviour, focus staying on the selected point, and the musical flow of Black Tie. Source of truth: `skills/black-tie-daw/SKILL.md`, `skills/clockwork-audio/SKILL.md`, `tests/browser/final_movement_levels.js`, `tests/browser/black_tie_encore.js`. Write it from Sonnet's own session.

## Claude Opus

Saved by Claude Opus. Verified file: `~/.claude/skills/2become1-opus-craft/SKILL.md`. It points at the repository skills. There is still no Claude commit on `docs/golden-encore-opus`.

## Hermes

Pending. Hermes was not run in this session, so no Hermes skill file was written.

When Hermes is available, write only `~/.hermes/skills/software-development/2become1-release/SKILL.md` in the existing Hermes skill format. Do not edit the git repo or push. Cover resource-aware testing on a small btrfs disk, `PYTHONPATH=src` for a shared virtualenv, local backup refs before a fast-forward, and never staging personal files. Point at `skills/release-gates/SKILL.md`.

# Contributor skill handoffs

Repository skills in this directory were written by Grok against `cbe6984` and the files on `main`. A local skill counts only after that agent's own file exists. Claude Sonnet and Claude Opus have no skill directory on this machine (`~/.claude` has no `skills/` tree and `claude` is not on `PATH`).

## Codex

Saved by Codex during this release. Verified file: `~/.codex/skills/2become1-audio-review/SKILL.md`. It points at the three repository skills and does not copy them. The git tree was not changed by that run.

## Claude Sonnet

Pending. No local skill system was available.

When a Claude skill directory exists, save a short skill for direct waveform editing, Draw Levels pointer and keyboard behaviour, focus staying on the selected point, and keeping the musical flow of Black Tie. Source of truth: `skills/black-tie-daw/SKILL.md`, `skills/clockwork-audio/SKILL.md`, `tests/browser/final_movement_levels.js`, `tests/browser/black_tie_encore.js`.

## Claude Opus

Pending. No local skill system was available.

When a Claude skill directory exists, save a short skill for Black Tie integration, arrangement timing, Producer proposal semantics (Preview does not apply; Hear it / Hear mine / Reject), touch targets, and export evidence. Source of truth: `skills/black-tie-daw/SKILL.md`, `skills/audio-validation/SKILL.md`, `docs/black-tie.md`, `docs/full-house-daw.md`.

## Hermes

Pending. Hermes was not run in this session, so no Hermes skill file was written.

When Hermes is available, write only `~/.hermes/skills/software-development/2become1-release/SKILL.md` in the existing Hermes skill format. Do not edit the git repo or push. Cover resource-aware testing on a small btrfs disk, `PYTHONPATH=src` for a shared virtualenv, local backup refs before a fast-forward, and never staging personal files. Point at `skills/release-gates/SKILL.md`.

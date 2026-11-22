---
name: black-tie-daw
description: >
  Edit the 2become1 eight-lane arrangement: waveforms, source slip, trim,
  fades, pitch, stretch, and EQ, while keeping the accepted Black Tie mixer.
  Use when changing arrangement-panel, the edit API, or the arrangement CSS.
---

# Black Tie arrangement DAW

## When to use

Changing how a musician moves, trims, fades, pitches, stretches, or equalises clips on the eight arrangement lanes.

## Problem

The arrangement is one project the musician edits directly. A visual or editing change must keep source timing, undo, and the accepted mixer hierarchy.

## Source of truth

- `src/twobecomeone/studio_static/js/components/arrangement-panel.js`
- `src/twobecomeone/studio_static/js/arrangement/edit-api.js`
- `src/twobecomeone/studio_static/js/arrangement/project-state.js`
- `src/twobecomeone/studio_static/styles/arrangement.css`
- `docs/black-tie.md`, `docs/full-house-daw.md`, `docs/first-cut-direct-control.md`
- `AGENTS.md` Stem Performance Desk section, for the desk only

## Boundaries

The arrangement panel owns the eight lanes. The Stem Performance Desk remains the two-group, eight-stem mixer in `AGENTS.md`. Do not give the arrangement a second audio context or a second transport. Signalsmith stretch is the vendored file under `studio_static/vendor/signalsmith-stretch/`.

## Invariants

- Eight lanes: A and B, vocals, drums, bass, other.
- A start trim moves the timeline start and the source offset together. A slip changes the source offset and leaves the timeline start.
- Stretch follows tempo and does not change pitch. Pitch does not change duration or offset.
- Fades, clip gain, track EQ, pan, and level are project state and undo as gestures.
- Lane labels use the real stem role. Never label center, sides, or imported material as vocals or Demucs.
- Desktop `1280x800` and phone `390x844` stay usable. Black Tie at `e53b266` is the accepted mixer look.

## Procedure

1. Serve this checkout on `127.0.0.1` with a temporary `--data-dir`. Leave port 8765 alone.
2. Use the synthetic Midnight Circuit and Paper Lanterns stems, not the musician's library.
3. Run `node tests/browser/full_house_daw.js <url> <out-dir>` and `node tests/browser/black_tie_ux.js <out-dir> <url>`.
4. Copy screenshots out of the repo and delete any in-tree copy.

## Failure modes

- A trim that moves the start and leaves the source offset, so the wrong bars play.
- Stretch that also retunes, or pitch that changes length.
- A second `AudioContext` added to "support" the arrangement.
- Screenshots or a scratch data dir left tracked.

## Tests

```bash
npm test
node --test tests/frontend/arrangement-panel.test.js tests/frontend/first-cut-panel.test.js tests/frontend/arrangement/full-house.test.js tests/frontend/arrangement/edit-api.test.js
```

## Recovery

Revert the editing commit. Do not reset `main`. The desk contracts in `AGENTS.md` are unchanged by an arrangement revert.

## What not to do

Do not redesign Black Tie. Do not bind `0.0.0.0`. Do not point a test server at `~/.local/share/2become1`. Do not treat a green layout check as the PM's listening acceptance.

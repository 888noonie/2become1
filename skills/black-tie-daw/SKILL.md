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
- Touch targets in the arrangement are at least 44 px high (`.daw .button`, lane heads in `arrangement.css`). A narrow layout stacks controls; it does not shrink them.
- The original source audio is never rewritten. Every edit is a clip field (`timelineStartBeat`, `sourceOffsetSec`, `durationBeats`, gain, fades, pitch, stretch) over an untouched asset.

## Source-offset arithmetic

- Source seconds advance at `sourceAdvanceRate(clip, asset, masterBpm)` (`time-math.js`): `masterBpm / asset.nativeBpm` for beat-sync, `customStretchRatio` for manual. Beat-sync throws while `nativeBpm` is unknown, so guard the call. Seconds on the timeline are `beats * 60 / masterBpm`; seconds of source are that times the rate.
- To start a clip later without changing what is heard at a given moment, move and slip together: `sourceOffsetSec += (newStart - oldStart) * (60 / masterBpm) * rate`, and shorten by the same beats. `resumeAfter` in `producer-intent.js` is the worked example.
- A passage is cut from the stem file at a sample index (`startFrame / sampleRate`), one source bar early, so its in-point inside the cut is non-zero. A bar number in the source song is not a project bar: map it with `arrangementBeatForSource` (`chorus-fit.js`).
- Apply length changes as shrink, then slip, then grow (`clipCommands`), so every step stays inside the asset.
- `MIN_CLIP_DURATION_BEATS` is 1/64. `MIN_CLIP_GAIN_DB` is −24, so clip gain cannot silence a clip. `MIN_VOLUME_DB` is −60 for lanes.

## Reversibility

Every musical edit must be undoable, and Hear mine / Undo restore by writing the previous field values back. A deleted clip can only be recreated with a load (`loadStemToTrack` with `reuseAsset`). An automatic write that deletes a musician's clip without one cannot be put back. Move or trim instead.

## Procedure

1. Seed a temporary data dir with the synthetic Midnight Circuit and Paper Lanterns stems, and serve it on a spare loopback port. Leave port 8765 alone. The recipe is in `docs/full-house-daw.md`:
   ```bash
   .venv/bin/python tests/browser/for_your_ears_fixture.py --out "$T/fixture"
   PYTHONPATH=src .venv/bin/python tests/browser/for_your_ears_seed.py --data-dir "$T/demo" --fixture "$T/fixture"
   PYTHONPATH=src .venv/bin/python -m twobecomeone.cli web --port 8791 --data-dir "$T/demo"
   ```
   `$T` is any scratch directory outside the repo.
2. Run `node tests/browser/full_house_daw.js http://127.0.0.1:8791 "$T/out"` and `node tests/browser/black_tie_ux.js "$T/out" http://127.0.0.1:8791`. Note the argument order: `black_tie_ux.js` takes the output directory first.
3. Always pass an output directory outside the repo. The defaults (`full-house-out`, …) are relative and land in the checkout.
4. Copy screenshots out of the repo and delete any in-tree copy.

## Failure modes

- A trim that moves the start and leaves the source offset, so the wrong bars play.
- Stretch that also retunes, or pitch that changes length.
- A second `AudioContext` added to "support" the arrangement.
- Screenshots or a scratch data dir left tracked.
- A later start written without the matching slip, so the clip replays its opening at the new position.
- Clip gain used to "mute" a clip. It stops at −24 dB.

## Tests

```bash
npm test
node --test tests/frontend/arrangement-panel.test.js tests/frontend/first-cut-panel.test.js tests/frontend/arrangement/full-house.test.js tests/frontend/arrangement/edit-api.test.js
```

## Recovery

Revert the editing commit. Do not reset `main`. The desk contracts in `AGENTS.md` are unchanged by an arrangement revert.

## What not to do

Do not redesign Black Tie. Do not bind `0.0.0.0`. Do not point a test server at `~/.local/share/2become1`. Do not treat a green layout check as the PM's listening acceptance.

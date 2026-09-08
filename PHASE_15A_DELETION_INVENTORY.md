# Phase 15A — Deletion inventory and projected post-wiring payload

Status: leaf PASSED (Sol, `d8e59f7`). This document is the next authorized
unit — inventory + projection only. The six-file wiring is NOT started.

## Current payload

Measured with the canonical shipped-source rule (HTML + CSS + JS only):

```
find src/twobecomeone/studio_static -type f \
  \( -name '*.html' -o -name '*.css' -o -name '*.js' \) \
  -printf '%s\n' | awk '{t+=$1} END {print t}'
```

Result: **499,988 / 500,000 bytes** (12 bytes headroom, not ~148 — Sol's
numerical correction is accepted).

## What the wiring actually supersedes (measured, not estimated)

The wiring replaces the singleton deck path with the LiveMixer. The following
regions are superseded and will be rewritten in place (roughly byte-neutral
replacement, NOT net deletion):

| Region | File | Bytes |
|---|---|---|
| Deck transport block (play/pause/stop buttons) | `components/deck.js:241-302` | 2,249 |
| Deck `getTime`/`onSeek` (reads `audioController.time`/`.seek`) | `components/deck.js:424-437` | 479 |
| Deck audio-tick subscription (`audioController.on('time')`) | `components/deck.js:489-498` | 355 |
| Ghost `_destinationOwnedAndPlaying` (reads `audioController.current/.playing`) | `runtime/ghost-controller.js:150-165` | 644 |
| Ghost `elementSeconds` reads (`audioController.time`) | `runtime/ghost-controller.js:570-580` | 437 |
| App `audioController.on` → `playback` slice wiring | `app.js:55-75` | 701 |
| **Total superseded** | | **4,865** |

## What the wiring adds (measured/estimated)

| Addition | File | Bytes |
|---|---|---|
| New `decks` slice + `decks/set` reducer | `state.js` | ~800 |
| Mixer construction + injection | `app-context.js` | ~300 |
| Mixer `on()` → `decks` slice wiring (replaces the 701 B above) | `app.js` | ~700 |
| Mixer A/B commands (replace the 2,249 B transport above) | `components/deck.js` | ~2,200 |
| **Net additive (adds minus replaced)** | | **~1,100** |

## Honest projection

The wiring is **byte-neutral replacement, not a source of headroom**. The
superseded deck path (~4,865 B) is rewritten to equivalent mixer calls, and
the genuinely new surface (the `decks` slice + mixer construction) is ~1,100 B
of net growth.

Projected post-wiring payload: **~501,100 bytes — over the 500,000 ceiling by
~1,100 bytes.**

## The 15–20 KB headroom target is not achievable from the wiring alone

Sol's target of 15–20 KB post-wiring headroom cannot be met by the wiring's own
supersession, because the wiring replaces code rather than deleting it. The
singleton `audio.js` (3,565 B) is NOT deletable: it remains the exclusive
preview/audition channel for library, stem-dialog, render-result, and
render-actions (the approved footer/library product decision). The committed
layer already runs on its own AudioContext and is untouched.

Reaching 15–20 KB headroom requires one of:

1. **A genuine dead-code removal** elsewhere in the static tree (not yet
   identified; the largest files — `ghost-controller.js` 53 KB, `plan.js`
   27 KB, `studio.css` 24 KB — are explicitly off-limits for opportunistic
   trimming per Sol).
2. **A budget decision from Richard** to raise the ceiling, or to authorize a
   specific, behavior-bearing deletion with replacement-test coverage.

## Recommendation

Do not begin the six-file wiring on the current 12-byte headroom. The wiring
will land ~1.1 KB over budget. Before wiring, either (a) identify and remove a
genuinely dead ~16–21 KB of static code with replacement tests, or (b) obtain
Richard's sign-off on a budget change. This is a decision for Richard/Sol, not
a silent coder override.

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

Result at `e39898f`: **499,988 uncompressed bytes**. The 500,000-byte ceiling
that made this 12 bytes of headroom is **retired** (Richard, 2026-09-12).
Through Phases 14–16: soft checkpoint **600,000**, hard ceiling **650,000**.
Report the total on every frontend-bearing PR. Do not delete behaviour,
compress readability, or minify merely to pass the number.

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

Projected post-wiring payload: **~501,100 bytes** (~1,100 net additive). That
fits the Phases 14–16 hard ceiling of 650,000. It would have missed the retired
500,000 ceiling; that is why wiring was held, not because the mixer itself is
too large.

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

Richard signed off on (2) on 2026-09-12: hard ceiling 650,000 through Phases
14–16, soft checkpoint 600,000. The 15–20 KB headroom hunt is no longer a
precondition for wiring. After Phase 16, replace byte-counting with measured
initial-load, startup, memory, and audio-performance budgets.

## Recommendation

The old 12-byte headroom is not a reason to withhold wiring. The projected
~501,100-byte tree is inside the new ceiling. Six-file wiring is still a
separate authorization: do not start it in the 14B.1 cycle (held with 14B.2,
14B.3, Producer UI, and audible Wax work). When Richard names wiring, do not
delete behaviour or minify to "make room."

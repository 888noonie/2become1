---
title: "Phase 15 — DJ dual-deck + stem-stack live mixer"
status: PROPOSED — execute only after Richard authorizes an exact baseline
planning_baseline: f9bd2592eae545120178a8f2aac7114c14cbdaf9
owner: Hermes B
independent_auditor: Sol
---

# Phase 15 — Three-bus live mixer

> Tracked mirror of the Sol-authored plan at
> `.hermes/plans/2026-09-07_022700-phase15-three-bus-live-mixer-tri-phase.md`.
> This file is the durable repo copy for cross-session continuity.

## Product acceptance

Richard must be able to hear all of these concurrently:

1. Foundation deck A;
2. Lead deck B;
3. one committed stem stack whose prepared asset contains 1–4 stem loops.

Deck A/B need independent play/pause/seek/gain and a real live equal-power
crossfader. The stem stack remains exactly one committed layer and one prepared
asset; "multi-stem output" means the audible composite contains all enabled stem
components with inspectable per-component provenance and baked gains.

The current baseline cannot satisfy this. `audio.js` owns one Audio element and
its `play()` calls `stop()` first. The existing test explicitly requires playing
B to stop A. The current FUN blend slider edits render settings; it is not a live
crossfader.

## Sequencing

- Phase 14A interaction prototype may be accepted independently.
- Phase 14B persistent crate and non-destructive loop specifications may proceed.
- Do not complete Phase 14C by wiring a stack into the old singleton path.
- Execute Phase 15A and 15B before Phase 14C's live integration; Phase 15C is the
  convergence point for Phase 14C's prepared stack.
- Phase 13 evidence-class rules remain binding. Receipts prove scheduling intent,
  not audible output. Acceptance tolerances remain human decisions.

## Architecture decision

Create one application-owned `LiveMixer` with one shared `AudioContext` and three
named buses: `deckA`, `deckB`, and `stemStack`.

Deck A and B use separate private `HTMLAudioElement`s connected through
`MediaElementAudioSourceNode`s into independent gain nodes and the common master.
This supports streaming/seek without decoding whole tracks. Neither element is a
visible native player. Set same-origin/CORS policy before assigning `src`.

The stem stack uses one decoded `AudioBufferSourceNode` per scheduled stack
instance, routed into the third bus. It does not create one live source per stem.
Phase 14 server preparation remains responsible for slicing/transforming/mixing
its components into the one stack asset.

Retire the "one active Audio element" policy deliberately, not accidentally.
Preserve the real invariant: one visible player surface, one shared audio graph,
two deck transports, and at most one committed stem-stack layer.

All runtime objects stay outside StateStore. Store only bounded serializable deck,
mixer and stack status. Library stem/render previews remain an explicit exclusive
preview channel and may not steal or reset live deck ownership without warning.

# Phase 15A — Independent dual-deck runtime

## Goal

Replace singleton source ownership with two independently controllable deck
transports while preserving existing library/render preview behavior and honest
lifecycle cleanup.

## TDD tasks

1. Add a leaf `runtime/live-mixer.js` with injected AudioContext/media-element
   factory/timers for tests. Do not put DOM/window imports in the runtime.
2. RED contract:
   - loading/playing A never stops B and vice versa;
   - independent pause, stop, seek, ended, error and source replacement;
   - project switch and shutdown stop/disconnect both decks and stack;
   - rapid source changes cannot publish stale play/error state;
   - AudioContext suspended/closed states are explicit and never called playing;
   - same element is wrapped by `createMediaElementSource` once only;
   - no runtime object survives in store snapshots.
3. Define serializable per-deck state: source identity, ownership generation,
   playing/paused/ended/error, media time/duration and context-clock observation.
4. Adapt `audio.js` behind a compatibility facade for non-live previews. Do not
   silently preserve old deck call sites against the wrong bus.
5. Wire DJ/FUN deck controls to explicit A/B commands. Both play buttons may be
   active simultaneously and announce independently.
6. Update Ghost/Committed ownership checks to read Lead deck B transport from the
   new mixer, never an ambiguous global `current` source.
7. Add a real-browser journey proving A and B media elements advance together,
   pausing one does not stop the other, and teardown leaves neither advancing.

## Acceptance

- Two generated public click/music fixtures play concurrently in real Chromium.
- Observed A/B clocks advance over the same wall-clock interval.
- Existing library/render preview behavior has an explicit tested policy.
- No autoplay; context starts only after a user gesture.
- Full frontend/browser gates pass at both viewports and static bytes stay within
  500,000.

# Phase 15B — Beat sync and live crossfader

## Goal

Turn the two transports into DJ decks: choose a master, align the follower at a
future beat boundary, and route a real equal-power crossfader to deck bus gains.

## TDD tasks

1. Define the transport contract from effective BPM, first beat, grid revision,
   media time and AudioContext time. Missing/stale grids fail closed.
2. Use production transport math to derive the next safe quantized start. Assert
   expectations independently; do not copy scheduler output into expected values.
3. Select A or B as master. Starting follower resolves its media offset and
   context launch time against the master's advancing clock.
4. Apply bounded playback-rate tempo matching only with explicit displayed ratio
   and browser pitch-preservation capability/state. Never claim pitch preservation
   merely because a property was set.
5. Implement the live crossfader as AudioParam gain changes on A/B buses using
   equal-power coefficients. Keep render blend settings separate unless the user
   explicitly copies the live value into the render plan.
6. Handle seek, nudge, pause, ended, loop/restart, master change, late decode,
   suspended context and source replacement without stale scheduled starts.
7. Add clipping/headroom monitoring at the master. Do not normalize invisibly;
   surface attenuation/limiter policy before enabling it.
8. Evidence:
   - Class A: generated two-deck render/onset fixtures;
   - Class B: production schedule/AudioParam receipts and observed source clocks;
   - Class C1: selected OS sink-monitor capture of actual browser output;
   - Class C2 remains optional physical acoustic capture.

## Acceptance

- Real Chromium proves A+B remain audible contributors at center crossfader,
  only A at hard-left and only B at hard-right.
- Multiple expected onsets are measured for both decks at varied BPM/grid/cue
  positions; no n=1 timing-clean claim.
- Crossfader movement changes live bus gains, not just saved render settings.
- Unsupported pitch-preservation or loopback states remain unmeasured, never PASS.

# Phase 15C — Add the committed stem-stack bus

## Goal

Converge Phase 14C with the shared mixer so A + B + one prepared stack can sound
simultaneously and stop cleanly.

## TDD tasks

1. Route the authoritative Phase 14 prepared stack asset into `stemStack`; never
   trust client media paths or reconstruct components in the browser.
2. Preserve all component hashes, stem-set/method/model, region/grid revisions,
   gains and transforms in the committed layer and prepared-asset manifest.
3. Quantize stack launch/repeats against the selected master deck through the
   production scheduler. Re-resolve future instances against the live clock.
4. Give the stack its own bounded gain/mute bus while preserving one-layer Undo.
   Per-stem live faders are out of scope because components are baked into one
   asset; changing a component requires a new prepared proposal/asset.
5. Lifecycle matrix: A/B pause/stop/ended/seek/replacement, master swap, stack
   Undo, reload, project switch, missing stack asset, context suspend/resume/close,
   and failed projection refresh.
6. Add an adversarial real-browser three-bus harness with distinguishable
   frequency/click signatures. Assert that captured output contains non-silent
   contributions from A, B and stack during the same interval.
7. Measure clipping/dropout and every expected onset. A scheduler receipt alone
   cannot satisfy the simultaneous-audio criterion.
8. Keep Fever/Bloom presentation separate from mixer truth. No trophy may imply
   audible success when any bus is unavailable or muted by error.

## Acceptance

- A, B and the one multi-stem prepared stack contribute concurrently in a real
  browser and C1 capture.
- Independent deck controls and crossfader remain correct while stack plays.
- One committed stack limit, Undo, reload and render parity remain intact.
- Full pytest/npm/browser/ghost/live-mixer gates pass; CI runs deterministic
  dual-viewport journeys; static assets remain <= 500,000 bytes.
- Independent Sol audit maps every simultaneous-output claim to evidence before
  merge or product-closure language.

# Explicit non-goals

- Four independently streamed stem nodes or multiple committed layers;
- scratch/timecode emulation, jog-wheel motor physics or network streaming;
- silent auto-sync when grids are missing/low-confidence;
- AI bridge generation, QR collaboration or REC automation;
- claiming physical-speaker timing from browser events;
- replacing user media, changing default audio devices or adding dependencies
  without explicit approval.

# Hermes B return contract

After each sub-phase, stop for audit and return exact baseline/head SHAs, changed
paths, RED/GREEN commands, full test counts, both viewport results, static bytes,
source/clock/capture provenance, unsupported cases and deviations. Preserve
`.vscode/`, `Mock Images/`, audit records and other-session work. Do not merge,
push, invent tolerances or mark accepted without Richard's explicit authority.

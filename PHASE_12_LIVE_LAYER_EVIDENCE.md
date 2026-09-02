# Phase 12 — Live Committed-Layer Engine: Evidence

**Status:** CANDIDATE — awaiting Sol's independent audit (12C.5). NOT accepted.
**Branch:** `phase12-live-layer-hermes`
**Baseline:** `62b9c645de4fa67ff7c38d0cd5fc1bea482e1a25` (Sol plan-amendment parent)
**Head:** `bbe66b2` (see commit list below)
**Author:** Hermes, on Richard's authorization, under the branch/audit/merge protocol.

---

## 1. What was built

A live committed-layer engine: after Commit, the committed Ghost layer plays
**audibly during the live session**, looped on phrase boundaries in sync with
the playing Lead, with its auditioned gain applied, appearing and vanishing as
it is committed and undone. This closes Phase 11's acknowledged limitation #4
("Commit does not add a persistent live-layer engine").

The engine is a **session player, not a render path**: it adds audible
playback only; the export/parity pipeline stays exactly as Phase 11 left it.

### Commits (reviewable, narrow, TDD-first)

| SHA | Scope |
|---|---|
| `0034110` | 12A.0 single committed-layer gate (`L_LAYER_LIMIT`) + frontend parity + preview-entry disable |
| `c11ebd3` | 12A.2/12A.3 pure `resolveLivePlacement` resolver + `L_LAYER_INVALID` |
| `69259c6` | 12A.1/12A.4/12A.5 `CommittedLayerEngine` (sync/suspend/loop/teardown) |
| `a618fa6` | 12A.6 controller wiring (authoritative sync, suspend/resume, Undo, teardown) |
| `f990e53` | 12B.1–12B.4 UI truthfulness (badge, copy, aria-live, slice) |
| `bbe66b2` | 12B.5 browser journey + CI wiring + app-context engine factory |

---

## 2. Binding Sol amendments — implementation map

1. **Lead is the clock authority** — `_liveTransportProvider` re-proves Lead
   ownership (`_destinationOwnedAndPlaying`) and carries the layer's
   server-authored `destinationGridRevision` (A7/A3 parity with the preview path).
2. **Authoritative sync, not optimistic add** — one idempotent
   `engine.sync(committedLayers)` path; commit success, hydration refresh,
   reconciliation, and owned Lead play all converge through it. A failed
   post-commit projection refresh is an honest idle/error state, never a
   client-invented layer.
3. **Separate scheduled from live** — `scheduled` = a future
   `AudioBufferSourceNode.start(when)` is armed; `live` begins only when the
   launch boundary has actually passed, and persists across looped instances.
4. **Transport changes suspend, not destroy** — pause/stop/ended/seek call
   `suspend()` (cancel timers + stop sources, keep an idle entry); a later
   owned Lead play re-syncs. Only project switch / app shutdown destroy.
5. **Legacy conflicts fail honestly** — a multi-layer projection is refused
   with `L_LAYER_LIMIT`; the engine never chooses one silently.
6. **Undo ordering is durable-first** — the layer keeps playing while Undo is
   pending; on server confirmation `remove()` stops it immediately; a failed
   Undo leaves playback and projection unchanged.
7. **No timer-drift claim** — loop wakes use injected, cancellation-safe
   `setTimer`/`clearTimer`; every wake re-resolves against the live Lead
   clock. `setInterval` is never used.
8. **Browser proof is CI-hard** — `ghost_live_ux.js` (and the existing
   `ghost_commit_ux.js`) are wired into `.github/workflows/test.yml` at both
   viewports, with failure-artifact upload.
9. **Audibility wording stays bounded** — evidence proves decoded asset, gain
   routing, scheduled source, boundary passage, cancellation, and visible
   state. It does **not** prove physical speaker output.
10. **No premature acceptance** — this branch is a candidate; Sol audits,
    Richard decides, only post-merge target-branch CI marks Phase 12 accepted.

---

## 3. Gates (all green locally)

| Gate | Result |
|---|---|
| Python suite | **431 passed, 1 skipped** (includes 4 new `test_phase12a_layer_limit.py`) |
| Node suite | **317 passed** (includes 15 live-resolver, 16 engine, 12 wiring, 8 view, 4 dispatcher, 4 preview-entry) |
| Browser — live journey (desktop 1280×800) | **8/8** |
| Browser — live journey (mobile 390×844) | **8/8** |
| Browser — commit journey (desktop) | **15/15** (regression) |
| Static size | **483,402 / 500,000 bytes** (~16.6 KB headroom) |
| `node --check` sweep | clean |
| `git diff --check` | clean |

### Browser journey checks (ghost_live_ux.js, both viewports)
1. Commit arms a truthful live state (`scheduled` or `live`)
2. Layer goes `live` while the Lead plays (boundary passed)
3. Pause drops the layer to `idle` (suspend, not destroy)
4. Confirmed Undo removes the live layer immediately
5. Reload hydrates `idle` with no autoplay
6. Accessibility audit clean (0 serious / 0 moderate / 0 info)
7. No horizontal overflow
8. No uncaught console/page errors

---

## 4. Measured phrase-boundary placement

The pure resolver (`transport/live.js`) places the layer's absolute launch
beat on the Web Audio clock using the same formulas as `resolveNextPhrase`:

```
launchAudioTime = startedAtAudioTime + (launchBeat - beatAtStart) / (tempoBpm / 60)
```

Unit-verified cases (15): on-boundary, mid-phrase, past-instance whole-phrase
stepping, finite-minimum-lead skip (`LIVE_MIN_LEAD_SECONDS = 0.25`), layer
longer than a phrase, tempo-ratio variance, gain linear from `gainDb`, nonzero
transport origin, and the failure paths (`T_TRANSPORT_NOT_PLAYING`,
`L_LAYER_INVALID`, `T_INVALID_TIME`). The asset ring duration derives from the
semantic region span at the baked `targetBpm` (mirrors `_resolve_committed_layer`).

---

## 5. Honest limitations (unchanged from the plan)

- **HTML-media vs Web Audio clock drift (accepted).** Media-clock phrase
  boundaries vs `AudioContext.currentTime` are not sample-identical. The
  engine re-resolves placement each phrase against the live media clock, so
  drift is bounded per-phrase, never accumulated. No sample-accuracy claim.
- **Live engine is a session player, not a render path.** It adds audible
  playback only; export/parity stays Phase 11.
- **One active Ghost / one committed layer.** Fixed policy; multi-layer is a
  later phase. The single-layer gate is enforced server-side (`L_LAYER_LIMIT`)
  and mirrored in the dispatcher and preview entry.
- **Automation cannot prove physical speaker output.** Evidence proves decoded
  asset, gain routing, scheduled source, boundary passage, cancellation, and
  visible state — scheduling intent, not sample/speaker accuracy.

---

## 6. Deviations from the plan

- **None material.** One design correction during 12A (recorded in the commit
  history): the engine's `live` state persists across looped instances once a
  launch boundary has passed (Amendment 3), rather than returning to
  `scheduled` between instances. This is the correct reading of "separate
  scheduled from live" and is covered by the engine tests.
- The existing `ghost_commit_ux.js` browser assertion was updated because the
  committed-layer copy changed from "Included in the next preview/render" to
  the truthful live-state copy (the render-inclusion line is now a secondary
  note). This is a direct consequence of the plan's 12B.1 requirement.

---

## 7. Handoff to Sol (12C.5)

- **Baseline SHA:** `62b9c645de4fa67ff7c38d0cd5fc1bea482e1a25`
- **Head SHA:** `bbe66b2` (feature branch `phase12-live-layer-hermes`)
- **Diff:** `git diff 62b9c645..bbe66b2`
- **CI run URL:** (populated after push — see the branch's Actions run)
- **Evidence file:** this document
- **Deviations:** section 6 above

Sol should re-run: focused math/runtime/backend tests, full Python/Node
suites, desktop/mobile browser journeys, static-size and release-artifact
checks, and visually inspect both viewports. Findings are fixed and re-audited
before Sol recommends a merge. Richard decides what merges; only the
post-merge `v0.3-workspace` CI run marks Phase 12 accepted.

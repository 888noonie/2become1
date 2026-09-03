# Phase 12 — Live Committed-Layer Engine: Evidence

**Status:** CORRECTED CANDIDATE — Sol's independent 12C.5 audit is locally
green; awaiting exact-head CI and Richard's merge decision. **NOT accepted.**
**Branch:** `phase12-live-layer-hermes`
**Baseline:** `62b9c645de4fa67ff7c38d0cd5fc1bea482e1a25` (Sol plan-amendment parent)
**Corrective implementation:** `85c22a8` (Sol audit-fix commit; evidence updates follow it)
**Head:** the exact branch tip reported with the final CI handoff (`git rev-parse HEAD`)
**Authors:** Hermes implemented the candidate; Sol independently audited and
corrected it under Richard's branch/audit/merge protocol.

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
| `8b6e0b3` | 12C evidence + candidate-only continuity update |
| `919d03d` | Original candidate CI reference |
| `85c22a8` | Sol audit corrections: grid parity, reconciliation, Web Audio cleanup, stronger proof |

---

## 2. Binding Sol amendments — implementation map

1. **Lead is the clock authority** — `_liveTransportProvider` re-proves Lead
   ownership (`_destinationOwnedAndPlaying`), carries the server-authored grid
   revision, and rejects any live Lead BPM/origin/interval drift with
   `GHOST_GRID_STALE` before scheduling (A7/A3 parity with the preview path).
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
   pending; on confirmation the reduced authoritative projection is passed to
   `sync()` and stops it immediately; failed Undo leaves playback/projection
   unchanged, and a late response from an old project cannot touch the new one.
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
| Node suite | **328 declarations across 37 files** (includes 17 live-resolver, 20 engine, 5 permanent adversarial, 12 wiring) |
| Browser — live journey (desktop 1280×800) | **13/13** |
| Browser — live journey (mobile 390×844) | **13/13** |
| Browser — V0.3 inherited journey | **30/30 at both viewports** |
| Browser — Ghost UX inherited journey | **18/18 at both viewports** |
| Browser — commit journey | **15/15 at both viewports** |
| Browser — scheduler journey | **8/8 at both viewports** |
| Static size | **488,960 / 500,000 bytes** (11,040-byte headroom) |
| Release archives | clean wheel + sdist verified by `tests/verify_release_artifacts.py` |
| `node --check` sweep | clean |
| `git diff --check` | clean |

### Browser journey checks (ghost_live_ux.js, both viewports)
1. Commit arms a truthful live state (`scheduled` or `live`).
2. Layer goes `live` while the Lead plays (boundary passed).
3. The committed layer genuinely disables new Preview entry.
4. Confirmed Undo stops a layer while it is live.
5. Pause drops a second committed layer to `idle` (suspend, not destroy).
6. A later owned Lead play resumes it to `scheduled`/`live`.
7. Reload hydrates `idle` with no autoplay.
8. Accessibility audit is clean (0 serious / moderate / info).
9. No horizontal overflow.
10. No uncaught browser errors.
11. A fresh default-policy context also hydrates idle.
12. User-gesture Lead play resumes under Chromium's normal autoplay policy.
13. The fresh context has no uncaught browser errors.

---

## 4. Measured phrase-boundary placement

The pure resolver (`transport/live.js`) places the layer's absolute launch
beat on the Web Audio clock using the same formulas as `resolveNextPhrase`:

```
launchAudioTime = startedAtAudioTime + (launchBeat - beatAtStart) / (tempoBpm / 60)
```

Unit-verified cases (17): on-boundary, mid-phrase, past-instance whole-phrase
stepping, finite-minimum-lead skip (`LIVE_MIN_LEAD_SECONDS = 0.25`), layer
longer than a phrase, tempo-ratio variance, gain linear from `gainDb`, nonzero
transport origin, and the failure paths (`T_TRANSPORT_NOT_PLAYING`,
`L_LAYER_INVALID`, `T_INVALID_TIME`). Closed-form phrase stepping rejects an
extreme finite legacy beat in bounded time, and out-of-contract gain is
refused. The asset ring duration derives from the semantic region span at the
baked `targetBpm` (mirrors `_resolve_committed_layer`).

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

### Sol 12C.5 audit findings and closure

The first candidate was **not** merge-ready. Sol's fresh-eyes audit found and
reproduced three blockers before recommending any merge:

1. The live transport carried the committed grid revision but did not compare
   the current Lead BPM/origin/interval with the committed transform facts.
2. Ambiguous commit and Undo reconciliation hydrated StateStore without always
   converging the live engine from that same authoritative projection.
3. Ended/cancelled Web Audio sources removed their source reference but left
   connected `GainNode`s behind.

Commit `85c22a8` closes all three with permanent adversarial coverage. It also
adds cancellation-safe asset fetches, cleanup on `source.start()` failure,
closed-form bounded placement math, stale-project Undo protection, truthful
re-resolved scheduled beats, a real disabled Preview control, and a browser
journey that no longer masks Chromium's normal autoplay policy. Sol re-ran all
12C.1–12C.2 gates and visually inspected both full-page viewports after these
corrections.

---

## 7. Corrected candidate handoff to Richard

- **Baseline SHA:** `62b9c645de4fa67ff7c38d0cd5fc1bea482e1a25`
- **Corrective code SHA:** `85c22a8`
- **Head SHA + exact-head CI:** reported in Sol's final handoff after both
  required feature-branch jobs finish; the document deliberately does not
  hard-code its own commit SHA (which would necessarily become stale).
- **Diff:** `git diff 62b9c645..phase12-live-layer-hermes`
- **Original candidate CI:** https://github.com/888noonie/2become1/actions/runs/33696807371
  (superseded by the corrected exact-head run in Sol's final handoff).
- **Evidence file:** this document
- **Audit findings/corrections:** section 6 above

Sol has completed the independent local 12C.5 audit and corrective re-audit.
Richard still decides whether and what to merge. Only a green post-merge
`v0.3-workspace` CI run may mark Phase 12 accepted.

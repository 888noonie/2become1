# Phase 11 — Solid Ghost evidence

**Date:** 2026-08-29  
**Baseline:** `4189dcc` on `v0.3-workspace`  
**Scope:** human Commit, immutable launch receipt, project-owned render input,
real preview/render inclusion, append-only Undo, reload durability.

## Result

Phase 11 is complete and independently audited locally. The exact Ghost that
crossed the audition launch boundary can be committed, survives restart,
enters the existing server preview/render pipeline from its pinned immutable
asset, and can be undone without deleting either history or audio provenance.
Producer access and any persistent live-layer playback engine remain deferred.

No Migration 11 was added. `revert_commit` uses the existing append-only
`actions` ledger and the additive projection shape is normalized when older
snapshots are loaded.

## Final gates

| Gate | Command | Result |
|---|---|---|
| Python | `.venv/bin/pytest -q` | **427 passed, 1 skipped** |
| Frontend | `npm test` | **256 declarations across 29 files, 0 failed** |
| Solid Ghost desktop | `node tests/browser/ghost_commit_ux.js --viewport 1280x800` | **15 checks, 0 failures** |
| Solid Ghost mobile | `node tests/browser/ghost_commit_ux.js --viewport 390x844` | **15 checks, 0 failures** |
| Phase 10 Ghost UX desktop | `node tests/browser/ghost_ux.js --viewport 1280x800` | **18 checks, 0 failures** |
| Phase 10 Ghost UX mobile | `node tests/browser/ghost_ux.js --viewport 390x844` | **18 checks, 0 failures** |
| Phase 9 scheduler | `node tests/browser/ghost_scheduler.js` | **8 checks, 0 failures** |
| V0.3 acceptance | `node tests/browser/run.js --viewport 1280x800` | **30 checks, 0 failures** |
| JavaScript syntax | `find src/twobecomeone/studio_static tests/browser -type f -name '*.js' -print0 \| xargs -0 -n1 node --check` | **clean** |
| Whitespace | `git diff --check` | **clean** |

The strict static allowance was measured with the same shipped-source rule as
Phase 10:

```bash
find src/twobecomeone/studio_static -type f \
  \( -name '*.html' -o -name '*.css' -o -name '*.js' \) \
  -printf '%s\n' | awk '{total += $1} END {print total}'
```

Result: **428,147 bytes**, strictly below Richard's **500,000-byte** allowance.
No runtime dependency was added.

## Acoustic and render proof

- The browser journey performs a real server-rendered 12-second preview after
  Commit and asserts its completed job reports `committed_layer_count = 1`.
  The render window is deliberately cued over the immutable accepted launch;
  this avoids falsely claiming inclusion when a layer is genuinely outside a
  bounded preview window.
- The committed render-parity coverage is layered and explicit about the
  loudnorm boundary. The shared mastering stage is absolute loudness
  normalization (`loudnorm=I=-16`), so an isolated absolute level after it is
  unmeasurable by design; every level assertion below is therefore pre-limiter,
  exactly where the tri-phase plan's binding ±0.5 dB tolerance applies:
  - `volume` primitive: ffmpeg's gain at -6 dB measures within ±0.5 dB RMS.
  - Chain parity: the planner's real resolved layer facts (path, tempo ratio,
    source trim, planned gain) replayed through the exact `build_mash`
    committed chain (trim → stretch → `volume`) measure the auditioned
    -3 dB within ±0.5 dB RMS against an ungained baseline of the same
    chain — planner math and chain execution agree.
  - Placement parity: a real render with the base tracks silenced (gains 0)
    contains only the committed layer; silencedetect places its audible
    onset at the planned `outputStart` (6.57 s measured vs 6.565 s planned)
    and its audible span at the planned `outputDuration` (5.60 s) within
    the window — the layer demonstrably enters the real mixed output, not
    just the plan.
- Planner tests cover tempo ratios below, equal to, and above 1; overlay and
  transition offsets; non-zero Lead cue; head and tail clipping; and complete
  out-of-window exclusion. The corrected ffmpeg clock uses division by the
  tempo ratio.
- Missing, unpinned, hash-mismatched, path-invalid, or undecodable committed
  assets fail the shared planner with a stable layer-identifying error. Direct
  submission and retry perform this preflight before creating a new job row.

## Sol audit corrections

The final audit found and fixed issues not covered by Hermes's initial green
counts:

0. The pre-push closure (post-audit, by Hermes): the shipped
   `test_isolated_committed_gain_is_within_half_db` only exercised ffmpeg's
   `volume` primitive, so the original evidence overclaimed "gain before the
   shared mastering limiter". Two proofs were added — chain parity (planner
   facts replayed through the exact committed chain, ±0.5 dB RMS pre-limiter)
   and placement parity (a real isolated render audibly places the layer at
   its planned outputStart/outputDuration) — and this evidence file was
   corrected to state exactly what is measured, and where the loudnorm
   boundary makes level claims unmeasurable by design.
1. The frontend render body did not send `project_id`, so UI renders omitted
   committed layers. It now sends only project scope—never layer IDs or paths.
2. Direct render submission originally queued before committed-asset preflight.
3. Head clipping advanced the source offset without shortening the phrase;
   planning now performs an exact interval intersection.
4. A distinct second Undo returned a no-op but still appended a ledger row;
   it now returns `L_ALREADY_REVERTED` with zero mutation.
5. The production scheduler emits `resolvedBeat`; the controller's lifecycle
   fact used the test-only `launchBeat` name, causing real Commit to fail. Both
   presentation and durable facts now use the production receipt correctly.
6. Old Phase 10 snapshots lacked `revertedLayers`; additive load normalization
   now preserves hydration compatibility without a schema migration.
7. Commit/Release and rapid Undo calls now share explicit in-flight barriers;
   ambiguous outcomes reconcile against authoritative projection state.
8. Commit or Undo invalidates the old render plan immediately. Render actions
   remain disabled until a fresh server-authored plan arrives.
9. Frontend permission and dispatcher parity now explicitly deny Producer
   `revert_commit` with `P_ACTOR_NOT_ALLOWED`.
10. Project/track identity enforcement is applied when Ghost inputs exist,
    preserving ordinary V0.3 autosave/plan behavior for projects without them.

## Browser proof

At both 1280×800 and 390×844, Chromium proves: Commit appears only after the
launch boundary; the durable list and truthful copy appear; the transient
tether disappears; reload restores the layer; the real render pipeline uses
one committed layer; Undo requires confirmation; one revert survives reload;
history remains visible; Undo is at least 44 px; accessibility is clean; no
page overflow or uncaught console error occurs.

## Known limitations retained deliberately

1. HTML media and Web Audio use independent clocks; there is no sample-accuracy
   claim. The accepted launch receipt is deterministic render authority.
2. Musical policy remains fixed at 4/4 with 8-bar phrases and one active Ghost.
3. Lead stop cancels runtime work but never makes a creative rejection.
4. Commit does not add a persistent live-layer engine. The UI truthfully says
   the layer enters the next preview/render; audible committed playback comes
   through that existing output pipeline.
5. Undo is one-way in this phase. It retains the commit row, revert row, pinned
   asset, accepted proposal, and full provenance; redo and asset retention
   policy are future work.
6. Producer access, automatic acceptance, live warping, automatic separation,
   arbitrary layer editing, and a DAW timeline remain out of scope.
7. Legacy committed records without a canonical launch receipt fail render
   planning clearly rather than defaulting to beat zero.

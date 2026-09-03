# Codex continuity handoff — 2BECOME1 V0.3

Updated: 2026-08-30

Owner: Richard (`richardn`)

Repository: `/home/richardn/2become1`

Authoritative plan: `V0.3_IMPLEMENTATION_PLAN.md`

This file is the durable context for a fresh Codex/Hermes conversation. Read it
before changing the repository. V0.3 implementation and its Phase 7 release
tri-phase are accepted and closed. The `v0.3.0` tag is the authoritative
release pointer after this checkpoint's CI is green.

## Next authorized implementation boundary

On 2026-08-30 Richard explicitly authorized a functionally progressive
UI/UX/frontend build of the Ultimate Deck. A **Sol-audited UI slice** is now
present at pushed checkpoint `b460591`: persistent DJ/FUN views, seven
project-backed FUN pads, single-player Foundation/Lead audition, and real
render-plan controls for beat-derived length, equal-power blend and
overlay/transition. CI run `33282392237` is green (test 4m11s, browser-e2e
3m15s). Evidence and the exact audit boundary are in
`ULTIMATE_DECK_UI_EVIDENCE.md`. This slice does not authorize or implement
Phase 12 audio-engine work; loops, stutter, reverse, multi-source live mixing,
Producer, battle and collab remain deferred.

Phase 11 Solid Ghost was explicitly authorized by Richard, implemented from
the Sol-audited tri-phase plan, independently audited locally on
2026-08-29, and accepted by green CI on 2026-08-29 (run 33276217128: test
4m10s, browser-e2e 3m16s, desktop and mobile both green) for push
`c04f35d` on `v0.3-workspace`. It adds human Commit, immutable accepted-launch
provenance, project-owned render inclusion, reload durability, and append-only
Undo. Evidence lives in `PHASE_11_SOLID_GHOST_EVIDENCE.md`, including the
pre-push render-parity closure (chain parity and placement parity proofs).

No Phase 12 implementation boundary is authorized. Do not infer permission to
add Producer access, redo, live warping, automatic separation, arbitrary layer
editing, a persistent live-layer engine, or a rewrite of V0.3's single active
HTML audio player. The next implementation session must begin with a fresh,
repository-aware, Richard-approved tri-phase plan.

## Phase 12 — CORRECTED CANDIDATE (Sol audit + feature CI green, NOT accepted)

On 2026-09-02 Richard authorized Phase 12 (the live committed-layer engine)
under the branch/audit/merge protocol in
`PHASE_12_LIVE_LAYER_TRI_PHASE_PLAN.md` (Sol-amended). Hermes implemented it
on the dedicated feature branch `phase12-live-layer-hermes` from exact
baseline `62b9c645`, TDD-first, in reviewable commits beginning with
`0034110`, `c11ebd3`, `69259c6`, `a618fa6`, `f990e53`, and `bbe66b2`.

**This is a corrected candidate, not an acceptance.** Sol's independent 12C.5
audit initially refused the candidate over missing live-grid parity,
reconciliation/runtime divergence, and connected `GainNode` cleanup. Corrective
commit `85c22a8` closes those blockers and strengthens browser/adversarial
proof. Richard decides what merges; only a green post-merge `v0.3-workspace`
CI run marks Phase 12 accepted. Do not mark accepted or rewrite feature-branch
history.

Corrected local gates (all green): 431 Python tests (1 skipped), 328 Node test
declarations across 37 files, live browser journey 13/13 at both viewports,
all inherited journeys at both viewports, and static 488,960 bytes under the
500,000-byte ceiling. Release archives, `node --check`, and `git diff --check`
are clean. Full evidence and the audit boundary are in
`PHASE_12_LIVE_LAYER_EVIDENCE.md`.

## Verified checkpoint

- **Ultimate Deck UI accepted:** checkpoint `b460591` is pushed on
  `v0.3-workspace`; CI run `33282392237` is green for both required jobs. DJ
  retains the accepted precision Studio; FUN adds seven project-backed pads,
  truthful single-player audition, and saved render controls. Local closure:
  427 Python tests (1 skipped), all 30 frontend test files, inherited Chromium
  30/30, focused desktop/mobile FUN proofs, zero overflow, and 450,008 static
  bytes under the 500,000-byte ceiling.

- **Phase 11 final local audit:** human Commit is gated by the durable launch
  receipt; accepted assets are verified and pinned; committed layers hydrate
  and enter the shared preview/render planner; human Undo appends exactly one
  `revert_commit` while retaining history and the asset. Final gates: 427
  Python tests (1 skipped), 256 frontend declarations, Solid Ghost 15/15 at
  desktop and mobile, inherited Ghost UX 18/18 at both viewports, scheduler
  8/8, and V0.3 acceptance 30/30. Static payload was 428,147 bytes under the
  500,000-byte limit. Phase 11 was accepted by green CI run `33276217128`.

- Branch: `v0.3-workspace`, tracking `origin/v0.3-workspace`.
- **Phase 8 accepted:** `044cb03` supplies the strict V1 Action/proposal
  contracts, permission and lifecycle policy, reducers, in-memory provenance
  proof, and deterministic DeckTransport phrase-boundary mathematics.
- **Phase 9 accepted:** `f110a2d` supplies migrations 8–9, the project-scoped
  append-only Action ledger and projection snapshot, reload hydration, managed
  exact-vocal Ghost assets, guarded asset serving/pinning/GC, and the injected
  Web Audio scheduler. The audit moved ffmpeg preparation outside SQLite write
  transactions, strictly validates asset IDs, preserves unexpired auditions,
  enforces a 250 ms scheduling lead, captures server grid/stem provenance, and
  proves projection rebuilds without asset I/O.
- **Phase 10 final local audit:** migration 10 and durable lifecycle facts,
  server-bounded Ghost regions, production hydration/transport/controller
  wiring, visible phrase selection/status/tether/Release/Retry UX, and all 12
  Sol amendments pass locally: 398 Python tests (1 skipped), 247 frontend test
  declarations, 18/18 Ghost UX checks at desktop and mobile, 8/8 scheduler
  checks, and 30/30 inherited browser checks. Shipped static size was 402,590
  bytes under Richard's 500,000-byte allowance. Phase 10 was accepted before
  the Phase 11 checkpoint recorded above.
- Phase 9 final gates: 356 Python tests, 200 Node test declarations, and 8/8
  real-Chromium Ghost checks at both 1280×800 and 390×844. Python/JavaScript
  syntax and `git diff --check` were clean.
- Accepted Phase 6.5 implementation: `61579e4` (`Complete Phase 6.5 two-deck
  mixer essentials`), based on accepted Phase 6 HEAD `8a4c14a`.
- Final acceptance verification: 260 Python tests and all 102 frontend test
  declarations across 14 Node files pass. All changed/new JavaScript syntax
  checks and `git diff --check` pass. The uncompressed frontend is 246,951
  bytes, below the 350 KB budget.
- Populated Chromium QA passed at 1440×1100, 1280×800, 820×1180, and exact
  emulated 390×844. At 390px, `scrollWidth === clientWidth === 375`, no element
  exceeded the viewport, there were no browser errors, all 38 mixer controls
  were labeled, all enabled targets met the 44px rule, and all 34 enabled
  controls appeared in keyboard tab order.
- Application version is `0.3.0`; the annotated `v0.3.0` release tag points to
  `216bc4a` and both branch and tag CI runs are green.
- Phase 7 is split into 7A automated acceptance, 7B real-system hardening, and
  7C release-candidate closure. Hermes edits/tests without committing, tagging,
  or pushing; Gemini Pro is advice-only; Sol owns audit, narrow fixes, commit,
  push, CI monitoring, and tag authorization.
- The post-V0.3 Ghost/Action direction is preserved in
  `docs/V1_GHOST_ARCHITECTURE.md`. Phase 10 adds the first visible Ghost Phase B
  workflow to the accepted Phase 8–9 foundations; Ghost Phase C and all later
  architecture remain unauthorized implementation.
- **Phase 7 accepted:** implementation/audit commit `e2326d6` is pushed. CI run
  `33116091840` is green for both the main 289-test/unit/build/archive job and
  the 30-check desktop/mobile browser job. Evidence is in
  `PHASE_7_RELEASE_EVIDENCE.md`. Version is `0.3.0` across Python, frontend,
  and lock declarations; frontend size is 247,010 bytes. The network gate is
  fail-secure, retry lineage is preserved, browser fixtures are isolated, and
  release archives exclude private/internal files.
- The acceptance-only server/browser processes were stopped after QA. Start a
  new loopback server when needed.
- Persistent data root: `/home/richardn/.local/share/2become1`.
- The server is loopback-only. Preferred audio device is CUDA; Demucs 4.1.0,
  PyTorch 2.13.0, ffmpeg, and yt-dlp are available on this machine.

## Historical Phase 5 acceptance record

The 2026-08-25 final corrective pass resolved all six re-audit blockers:

1. **Selected stems now reach `MashSpec`.** `_compute_arrangement()` resolves the
   concrete audio path via `_resolve_stem_variant()` for every non-`full`
   variant, so a `lead_variant=center` render actually mixes the center stem,
   never the full track. `_run_render()` now runs `_ensure_stem_variant()` for
   legacy `use_vocals=true` BEFORE planning, so on-demand vocals are separated
   before the stem path is resolved.
2. **The autosave race is fixed.** Reconciliation is now dirty-field based
   (timestamp-independent): a field re-edited while a PATCH is in flight keeps
   its newer local value, and a failed queued write leaves the newer edit
   visible. `save()` no longer starts an orphaned debounce timer while a flush
   is in flight.
3. **Stem managed-root validation is consistent.** A new `_validated_stem_path()`
   helper validates every advertised stem against the dedicated `stems/` root
   (never the broad data root), so a corrupt row pointing at `tracks/...` is
   neither advertised nor playable.
4. **The analysis dialog shows all three layers.** Detected, override, and an
   explicit "Effective (used for mixing)" row are rendered separately.
5. **The separation tray no longer refetches on playback ticks** and renders
   structured `progress_detail` (the CUDA OOM warning) as text, never
   `[object Object]`.
6. **Source-time arithmetic is correct.** The lead source time is the capped
   `duration.output` MULTIPLIED by the tempo ratio (matching the renderer's
   `lead_trim_duration = render_duration * tempo_ratio`), never divided and
   never the uncapped requested duration.

Regression coverage was added for every blocker (backend `test_phase3.py` and
frontend `studio_phase5_audit.test.js`). Both full suites pass, the populated
browser flow renders correctly at all four target sizes with no 390px overflow,
and CI run `32901853798` is green at `b7c0db0`.

The final Codex acceptance audit found and fixed three narrow uncovered edges in
`d3cc6a6`: full-project PATCH responses now preserve newer dirty fields even
when the older request wrote a different field; stem paths must be relative,
under `stems/`, and filename-matched to their exact variant while path and
metadata select the same newest stem set; and cached stem-tray controls repaint
correctly when playback stops or changes owner without network refetches. The
structured CUDA warning test now exercises the real SSE callback and exact text.

No Phase 5 exit-gate blocker remained. Phase 6 and 6.5 have since completed as
recorded in the verified checkpoint above.

If the old server process is no longer alive, start it from the repository with:

```bash
.venv/bin/twobecomeone web --host 127.0.0.1 --port 8871
```

Do not replace, purge, or recreate Richard's persistent data directory.

## Delivered history

| Phase | Commit(s) | Result |
|---|---|---|
| 0 — contracts/migrations | `3d5d847` | Domain contracts and transactional numbered migrations |
| 1 — job engine | `ffbd2db` | Persistent state machine, cancellation/retry/restart, two executors, SSE |
| 2 — acquisition | `121d846`, `eab8e7d`, `20e1253` | Async imports, safe subprocesses, progress, resume, managed ingestion |
| 2.9 — corrections | `7b9a0ae` | Live progress, opaque staging, waveform persistence, race-safe dedupe |
| 3 — library/projects/stems | `9a5fafe` | Library CRUD, LWW projects, effective analysis, cached separation, variants |
| 3.9 — corrections | `919df7c` | Secure artwork, YouTube thumbnails, atomic stems, OOM warning propagation |
| 4 — UI foundation | `564c7da`, `64b33f7` | Backend facts plus framework-free SPA shell, Library, Activity, Engine, source flow |
| 4 hardening | `51d6aa2`, `c0b8b56`, `b87cec3`, `20ab875` | CI, YouTube `Path` fix/hardening, and first-paint fixes |
| 5 — Studio & Plan | `823113e`, `4779fd4`, `cd21d23`, `417abdc`, `c3316f8`, `d243353`, `b7c0db0`, `d3cc6a6` | Accepted after corrective passes and final independent adversarial audit |
| 6 — Preview/render/history | `2b087f8`, `e0a34a1`, `f18be40`, `6f285dd`, `8a4c14a` | Accepted backend/frontend render journey, recovery, result actions, and responsive hardening |
| 6.5 — Mixer essentials | `61579e4` | Accepted output BPM, two-source alignment, transitions, gain/pan/EQ, strict persistence, and accessible controls |
| 7 — Quality and release | `e2326d6`, `v0.3.0` | Accepted browser/a11y gate, security and retry hardening, release docs/version, clean artifacts, and green CI |
| 8 — V1 Action/transport foundation | `044cb03` | Strict Action contracts, policy/lifecycle reducers, provenance proof, and deterministic deck transport |
| 9 — V1 durable/acoustic plumbing | `f110a2d` | Durable ledger/projection, managed vocal assets, hydration, and deterministic Web Audio scheduling bridge |

## Current product state

Richard successfully imported two YouTube tracks, assigned one Foundation and
one Lead, and confirmed their normalized artwork and detected analysis in the
Library. Their current display names are the controlled yt-dlp ID filenames
(`HkrZigV2Aq4.mp3` and `44uHNFwk_EU.mp3`). The sanitized YouTube title remains
in metadata. Do not silently rewrite an explicitly user-renamed track; title
presentation can be improved separately while retaining Rename as the source of
truth.

The Studio route is the accepted Phase 5 implementation with persisted project
lifecycle, dual decks, server-authored waveforms, beat-snap cue controls,
analysis correction, truthful stem separation/playback, grouped arrangement
controls, serialized autosave, and a renderer-shared exact arrangement plan.

Phase 10 connects the accepted Phase 8–9 foundations to normal Studio boot for
the first deterministic human Ghost preview. Phase 11 makes that audition
solid: human Commit pins the exact launched asset, a durable layer list survives
reload, the existing server preview/render pipeline includes it, and confirmed
human Undo removes it from future output without erasing history. Producer
access, redo, live warping, and automatic separation remain deferred.

Two historical failed import jobs containing `name 'Path' is not defined` may
remain visible in Activity. They are honest immutable history, not evidence that
the current import path is still broken. Commit `b87cec3` fixed the missing
`pathlib.Path` import and added controlled output resolution, symlink and size
checks, resilient download options, safe sidecar parsing, error sanitization,
callback isolation, and pipe-drain hardening.

## Architectural invariants — do not relax

- Vanilla JavaScript native modules; no React/Vue/Svelte or runtime framework.
- `StateStore extends EventTarget` is the only component communication path.
  Reducers own mutations; snapshots crossing the boundary are deep-cloned.
- Dynamic/API/user text is created with DOM APIs and `textContent`. Never use
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` for data.
- Views receive state and dispatch actions. They do not scrape the DOM for
  application truth or perform implicit fetches from render functions.
- One global `AudioController` owns the only active `HTMLAudioElement`.
- EventSource connections close on every terminal job state and on teardown;
  controlled reconnect uses 1s/2s/5s/10s backoff, then polling.
- CSS components use semantic custom properties from `studio.css`; no literal
  component colors. Preserve reduced motion, visible focus, and 44px targets.
- SQLite is the project source of truth. Only harmless UI preferences belong in
  `localStorage`.
- Project saves are Last-Write-Wins. Do not add revisions or optimistic locking.
- Effective analysis is `override ?? detected`; API responses retain effective,
  detected, and override values separately.
- Stems must be named truthfully. Center/side output is never called vocals.
- Only one GPU/audio job may run at once. CUDA OOM fallback warnings remain
  visible in `progress_detail`.
- No absolute managed paths in ordinary API payloads. No transactions across
  decoding, separation, or other long work.
- Ghost asset IDs are strict opaque identifiers. Asset preparation happens
  before the short SQLite append transaction; registry, ledger, and projection
  commit together, and failed/racing appends discard unpublished bytes.
- Unpinned Ghost previews remain available until expiry. GC removes only
  expired-and-unpinned assets; accepted assets are verified and pinned.
- Web Audio scheduling keeps at least 250 ms lead and owns all buffers, nodes,
  requests, timers, and cancellation outside serializable StateStore state.
- Preserve V0.2 endpoints and existing media. Do not edit an applied migration.

## Historical Phase 5 execution order (completed; do not re-execute)

Hermes should implement the following in order, keeping the repository green
after each narrow commit. Phase 5 may make the small backend additions explicitly
listed in Task 1 because the frontend cannot otherwise satisfy the existing
truthfulness and restart requirements.

### Task 0 — Baseline and scope lock

1. Confirm `v0.3-workspace`, the expected HEAD, clean tracked files, and the
   current test baseline. Do not force-push `main`.
2. Read this file, `V0.3_IMPLEMENTATION_PLAN.md`, and the current implementations
   of `projects.py`, `studio.py`, `webapp.py`, `state.js`, `api.js`, `audio.js`,
   and `views/studio.js` before editing.
3. Mark Phase 4 complete in the authoritative plan with its final commits and
   test counts. Do not mark Phase 5 complete until its exit gate passes.
4. Preserve the two real imported tracks and existing jobs. Tests use temporary
   data roots; manual checks against the real root must be read-only except for
   normal project/UI operations.

### Task 1 — Close the two UI-blocking backend contracts first

Write failing service/HTTP tests before implementation.

1. Enrich `GET /api/tracks/{track_id}/stems` while preserving the existing
   top-level `stems: [name, ...]` compatibility alias. Add structured available
   variants containing at least `name`, `stem_set_id`, `method`, `model_name`,
   `device`, and a server-authored `audio_url`. Only advertise files that pass
   the existing managed-path and availability checks. A cached stem set must be
   playable after a server restart without relying on a remembered job result.
2. Extend `GET /api/stems/{stem_set_id}/audio?name=...` with an optional
   `download=true` disposition. Continue resolving by strict set/name lookup;
   never accept a path from the browser.
3. When saving `anchor_variant` or `lead_variant`, validate it against the track
   currently assigned to that role. `full` is always valid; every other value
   must exist in a completed, path-valid stem set for that exact track. Validate
   the prospective project as one atomic whole so a multi-field PATCH can assign
   a track and its variant together. Reject invalid combinations without a
   partial write.
4. Add a server-authored, read-only render-plan endpoint (choose one clear route
   and document it) accepting the same arrangement fields as `RenderOptions`.
   Refactor shared planning logic rather than duplicating it. Return the exact
   tempo ratio, BPM change percentage, semitone shift, effective BPM/keys,
   selected truthful variants, pitch mode, requested/available output duration,
   and actionable warnings. It must not queue a job, decode media, run Demucs,
   or create output. The Phase 5 UI must not independently reimplement key or
   tempo math that can drift from the renderer.
5. Preserve the common error envelope, status mapping, V0.2 render behavior, and
   no-absolute-path rule. No schema migration should be needed for this task.

Commit this backend support separately before building the controls.

### Task 2 — Persistent project lifecycle and serialized autosave

1. Add project helpers to `api.js`: list, create, get, patch, and delete.
2. At boot, load the most recently updated project. If none exists, create
   `Untitled mix`. Resolve both selected tracks by ID even when they are not on
   the first Library page. A missing or trashed selection gets an explicit
   recoverable deck state; never silently substitute another track.
3. Extend store reducers for the complete project, per-deck resolved tracks,
   save status (`idle`, `saving`, `saved`, `error`), and plan state. State remains
   serializable and contains no timers, DOM nodes, requests, audio objects, or
   EventSource instances.
4. Implement `New mix`, project rename, and a recent-project switcher. Deleting
   a project must never delete its tracks and requires confirmation.
5. Replace the current ephemeral slot assignment with LWW API persistence.
   Debounce ordinary writes about 400–600 ms, but serialize network saves so an
   older response can never overwrite a newer local edit. Coalesce pending
   fields, show `Saving…`, `Saved locally`, or a useful retryable error, and
   flush safely when leaving the Studio view where practical.
6. Implement Choose/Replace, Clear, and Swap. Swap the track IDs, selected
   variants, cue positions (`anchor_start`/`lead_start`), and role gains as one
   project save; role colors themselves remain Foundation pink and Lead cyan.
7. Project API responses are authoritative after successful writes. Failed
   writes keep the user's unsaved local edits visible and offer retry; they must
   not pretend to be saved.

### Task 3 — Decks, global playback, and waveform foundation

1. Replace the placeholder with `components/deck.js` and add `waveform.js` as in
   the planned module layout. Each ready deck shows artwork, safe display title,
   provenance, effective BPM/key/confidence, duration, selected source variant,
   transport, waveform, and Choose/Replace, Edit analysis, Separate, Open in
   Library, and Clear actions.
2. Extend playback state from a bare track ID to a serializable source descriptor
   (`track` or `stem`, owner track, variant, URL/key). Keep exactly one underlying
   audio element: starting a deck, Library, source-picker, or stem audition stops
   and resets the previous source. Do not create hidden per-card audio elements.
3. Fetch the versioned 1,200-bin waveform payload explicitly, abort obsolete
   requests on replacement/unmount, and cache successful immutable payloads by
   track ID outside render state or in a bounded serializable cache.
4. Draw min/max peaks on a device-pixel-ratio-aware canvas and redraw with
   `ResizeObserver`. Show loading, unavailable, and error states without making
   the rest of the deck unusable. Do not animate waveform data.
5. Canvas pointer input seeks the playhead only. It must never alter the saved cue
   merely because the user clicked or dragged on the waveform.
6. Supply an equivalent labeled native range/numeric control for keyboard and
   assistive technology. Arrow keys seek predictably, current time is announced
   sparingly, and every canvas action has a non-canvas equivalent.

### Task 4 — Cues, snapping, and analysis correction

1. Add explicit `Set cue here` per deck. With project `snap=true`, snap to the
   nearest non-negative beat computed from effective `first_beat + n * interval`,
   clamped to track duration. Provide an explicit unsnapped action/modifier and a
   `Use suggested downbeat` shortcut. Persist seconds, not pixel positions.
2. Add numeric cue inputs with 0.1-second precision and validation. Invalid input
   must not save or poison project state. Changing the playhead alone never saves.
3. Create an accessible analysis dialog showing effective, detected, and current
   overrides separately for BPM, tonic/mode, first beat, and suggested downbeat.
   Confidence is informational; low confidence says `Check this`, never `Wrong`.
4. Save one validated track PATCH atomically. `Reset to detected` must send JSON
   nulls for every override field rather than copying detected numbers into the
   override columns. Update the Library and either/both decks through store
   actions when the response returns.
5. Preserve focus trapping, Escape close, trigger-focus restoration, literal
   hostile text rendering, and debounced polite announcements.

### Task 5 — Separation and truthful stem tray

1. Add API helpers for submit separation, list variants, and stem audio/download.
   `Separate stems` offers understandable methods: Auto, Demucs four-stem when
   available, and Center/side. Never imply center/side is isolated vocals.
2. Queue the job, upsert it into global Activity state, monitor it through the
   existing shared SSE registry, and dispose the subscription on terminal state
   or unmount. Surface the exact CUDA OOM fallback warning from
   `progress_detail`. Do not invent numeric Demucs progress.
3. On completion, reload the track's server-authored variants. The stem tray shows
   truthful name/method/model/device, Play/Stop, Use in this deck, and Download.
   Stem auditions go through the global AudioController.
4. Selecting a stem updates that role's variant and autosaves the project. A
   stale/corrupt/missing stem becomes an explicit unavailable state; it must never
   silently fall back to `full`.
5. Cache hits should appear immediately as completed jobs/results and must not
   start a second Demucs run.

### Task 6 — Grouped arrangement controls and exact plan

1. Group controls by intent:
   - Timing: both cues, duration, snap, suggested-downbeat actions.
   - Harmony: Match Foundation key or Preserve Lead pitch.
   - Source: truthful per-deck full/stem choices.
   - Mix: Foundation and Lead gains with numeric values and reset defaults.
2. Keep project storage keys exactly aligned with the backend contract:
   `anchor_start`, `lead_start`, `duration`, `anchor_gain`, `lead_gain`, `snap`,
   and `pitch_mode`. Do not invent parallel local names.
3. Debounce/abort obsolete plan requests. Render the server-authored tempo ratio,
   BPM change, semitone shift, selected variants, expected duration, and warnings.
   Label the Lead waveform as source time and describe the computed stretch; do
   not imply the file has already been destructively transformed.
4. Phase 5 does not submit preview or full render jobs. It may show a clearly
   labeled arrangement-ready state, but working Preview/Render actions and result
   history belong to Phase 6.

### Task 7 — Responsive and accessibility hardening

1. Preserve the current token system and brand: Foundation pink, Lead cyan,
   success lime. Add any new colors only as root semantic tokens.
2. At desktop widths show balanced two-deck controls and stacked aligned
   waveforms; at 820px and 390px avoid clipped controls, horizontal page scroll,
   and inaccessible sticky layers.
3. Verify keyboard-only flow: open/switch project, choose both tracks, audition,
   seek, explicitly set both cues, edit/reset analysis, start/cancel separation,
   choose/audition/download a stem, and inspect the exact plan.
4. Preserve reduced-motion behavior, visible focus, semantic labels/fieldsets,
   focus return, 44px touch targets, and polite (not rapid) live announcements.

### Task 8 — Required tests and evidence

Backend tests must cover:

- structured stem rediscovery and playable URL after service restart;
- stem download disposition and strict set/name/path validation;
- atomic rejection of track/variant mismatches;
- render-plan parity with the renderer's shared planning logic, including
  effective overrides, preserve/match pitch, 1:2-style tempo ratios, variants,
  duration limits, and unavailable stems;
- common error envelopes and no absolute-path leakage.

Frontend tests must cover:

- latest-project load and first-project creation;
- serialized/coalesced autosave, stale response resistance, save error/retry,
  refresh restoration, swap/clear, and missing/trashed selections;
- waveform validation, DPR sizing, resize redraw, pointer seek without cue
  mutation, keyboard seeking, cue bounds, beat snapping, and unsnapped setting;
- effective/detected display, atomic override PATCH, exact null reset, and hostile
  names/errors rendered literally;
- one-audio singleton across track/deck/stem sources;
- separation SSE teardown, cache completion, OOM warning, unavailable stem, and
  truthful center/side labels;
- aborted stale fetch/plan requests and complete route/component teardown.

Run and report:

```bash
.venv/bin/pytest -q
npm test
git diff --check
```

Then run a system-Chromium smoke test with mocked destructive/expensive work for
the full keyboard flow, and a careful manual read/use test with Richard's two
existing tracks. Capture and inspect screenshots at 1440×1100, 1280×800,
820×1180, and 390×844, including loading, failure, and stem-progress states.
Report bundle size; from Phase 10 onward it must remain under 500 KB
uncompressed excluding media (Richard raised the allowance on 2026-08-29).

## Phase 5 exit gate

Phase 5 is complete only when all of the following are true:

- Refresh restores the most recent project, both decks, variants, cues, duration,
  gains, snap setting, and pitch mode from SQLite.
- The user can swap or clear decks without losing or corrupting role settings.
- Both waveforms are responsive and keyboard accessible; seeking never changes a
  cue until the explicit cue action is invoked.
- Analysis overrides and Reset to detected work without losing detected values.
- Separation progress is honest; cached stems survive restart and every shown
  stem can be auditioned, selected, and downloaded truthfully.
- The visible arrangement plan comes from the same backend logic the renderer
  will use in Phase 6.
- No untrusted DOM sink, mutable state leak, duplicate audio player, leaked SSE,
  absolute path, literal component color, console error, or regression appears.
- Full Python/frontend suites pass, screenshots are inspected, branch is clean,
  commits are narrow, pushed, and GitHub Actions is green.

## Explicit non-goals for Phase 5

- Do not wire Preview or Render result flows; those are Phase 6.
- Do not bump/version/tag/release; that is Phase 7.
- Do not add a frontend framework, cloud service, account, paid API, torrent
  downloader, analytics, or authentication system.
- Do not permanently purge media or rewrite Richard's existing track records.
- Do not alter the one-acquisition/two-worker plus serialized-audio executor
  policy unless a correctness bug is demonstrated and reported first.

## Suggested commit boundaries

1. `Add Phase 5 stem and render-plan contracts`
2. `Persist Studio project lifecycle`
3. `Build accessible Studio decks and waveforms`
4. `Add analysis correction and cue controls`
5. `Add truthful separation and stem tray UI`
6. `Complete responsive Studio plan and Phase 5 tests`

Hermes must flag any scope, persistence, security, or dependency deviation
before implementing it. At handoff, include commit IDs, exact test counts,
screenshots, bundle size, CI run URL/result, deviations, and any remaining known
limitations. A fresh Codex chat should audit the diff and real UI before
authorizing Phase 6.

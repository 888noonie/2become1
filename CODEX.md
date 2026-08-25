# Codex continuity handoff — 2BECOME1 V0.3

Updated: 2026-08-25

Owner: Richard (`richardn`)

Repository: `/home/richardn/2become1`

Authoritative plan: `V0.3_IMPLEMENTATION_PLAN.md`

This file is the durable context for a fresh Codex/Hermes conversation. Read it
before changing the repository. The next implementation unit is Phase 5 only:
Studio, projects, waveforms, analysis correction, and stems. Phase 6 owns
preview/render/results; Phase 7 owns release work.

## Verified checkpoint

- Branch: `v0.3-workspace`, tracking `origin/v0.3-workspace`.
- HEAD: `417abdc` (`Build accessible Studio decks, waveforms, stems, and arrangement plan`).
- Working tree is clean.
- Latest known full verification: 170 Python tests and all 53 frontend test
  declarations across 11 Node test files passed.
- Application version intentionally remains `0.2.0`; bump only in Phase 7.
- Current local URL: <http://127.0.0.1:8871/#/studio>.
- Persistent data root: `/home/richardn/.local/share/2become1`.
- The server is loopback-only. Preferred audio device is CUDA; Demucs 4.1.0,
  PyTorch 2.13.0, ffmpeg, and yt-dlp are available on this machine.

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
| 5 — Studio & Plan | `823113e`, `4779fd4`, `cd21d23`, `417abdc` | Stem & render-plan contracts, project lifecycle/autosave, dual decks, waveforms, cues, analysis editor, truthful stems tray, exact arrangement plan |

## Current product state

Richard successfully imported two YouTube tracks, assigned one Foundation and
one Lead, and confirmed their normalized artwork and detected analysis in the
Library. Their current display names are the controlled yt-dlp ID filenames
(`HkrZigV2Aq4.mp3` and `44uHNFwk_EU.mp3`). The sanitized YouTube title remains
in metadata. Do not silently rewrite an explicitly user-renamed track; title
presentation can be improved separately while retaining Rename as the source of
truth.

The Studio route is deliberately a Phase 4 placeholder with two in-memory slot
cards. Assignments are not yet persisted because Phase 5 owns project loading
and autosave. Activity and Engine now paint cached boot state immediately.

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
- Preserve V0.2 endpoints and existing media. Do not edit an applied migration.

## Phase 5 execution order for Hermes

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
Report bundle size; it must remain under 350 KB uncompressed excluding media.

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

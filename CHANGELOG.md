# Changelog

All notable changes to 2become1 are documented here. The project follows a
local-first, single-user model; versions track the workspace milestones.

## [Unreleased] — V1 Action and durable acoustic foundation

- Added the Ultimate Deck UI: persistent `◐ DJ` / `◎ FUN` views, seven
  project-backed performance pads, truthful single-player Foundation/Lead
  audition, beat-derived 1/2/4/8 render lengths, equal-power render blend, and
  overlay/A→B arrangement switching.
- Added the visible human Ghost workflow: bounded phrase selection, tether and
  lifecycle status, Release/Retry, durable Commit, project-owned render
  inclusion, and append-only Undo with reload provenance.

- Added strict cross-language V1 Action contracts, human/Producer permission
  policy, proposal lifecycle reducers, semantic idempotency, and deterministic
  DeckTransport phrase-boundary mathematics.
- Added migrations 8–9 for a project-scoped append-only Action ledger,
  versioned projection snapshots, and managed Ghost asset registry.
- Added silent, abortable projection hydration and bounded ledger/state HTTP
  endpoints without changing the visible V0.3 Studio.
- Added exact-Demucs-vocal preview preparation with server-resolved beat-grid
  origins/revisions, bounded tempo stretch, content hashing, atomic publish,
  strict opaque-ID serving, verify-and-pin commits, and expiry-aware GC.
- Added an injected, cancellation-safe Web Audio scheduler with a 250 ms
  minimum lead policy and immutable scheduling receipts.
- The independent audit moved ffmpeg work outside SQLite write transactions,
  added strict pre-lookup asset-ID validation, strengthened short-phrase lead
  handling, and made projection rebuild side-effect free.
- Current verification: 427 Python tests (1 skipped), all 30 frontend test
  files, inherited browser acceptance 30/30, focused Ultimate Deck desktop and
  mobile proofs, and green CI run 33282392237.

Producer access, live committed-layer playback, live warping, multi-source FUN
mixing, loops/stutter/reverse, and production claims of end-to-end sample
accuracy remain deferred.

## [0.3.0] — V0.3 local creative workspace

The V0.3 release turns the V0.2 vertical slice into a persistent, coherent
local music workspace. A user can acquire permitted media, understand its
analysis, reuse it from a library, place two sources precisely, audition
stems, render, follow every long-running operation, recover from failure, and
return later without reconstructing the session.

### User-visible journey

- **Asynchronous acquisition** — YouTube imports and local uploads return a job
  immediately; progress comes from real `yt-dlp` output (stage, percentage,
  speed, ETA) with cancellation, retry, and resume.
- **Media Library** — searchable, filterable, sortable, playable, reusable,
  editable, and safely removable (reversible trash) with source provenance,
  metadata, artwork, and waveforms.
- **Persisted projects** — the selected Foundation and Lead, their stem
  variants, cues, duration, gains, snap, and pitch mode auto-save and restore
  across refresh and restart (Last-Write-Wins).
- **Two-deck Studio** — interactive, keyboard-accessible waveforms with
  beat-snapped cue placement, analysis correction (detected vs. override vs.
  effective), and truthful stem separation/audition/selection/download.
- **Two-deck mixer** — explicit output BPM (Foundation/Lead/custom), overlay
  and A→B transition modes with crossfades, and per-deck gain/pan/3-band EQ,
  all sharing one exact plan/preview/render path.
- **Preview and full render** — queued jobs with live stage progress, result
  playback/download/rename, retry/resume, and "use these settings in a new
  mix".
- **Activity and Engine** — one chronological view of every job, and a
  read-only status view of capabilities, storage, and network binding.

### Compatibility and migration

- V0.2 databases migrate in place through numbered, transactional migrations;
  existing tracks, jobs, and media are preserved.
- V0.2 API endpoints remain available as compatibility aliases.
- The application version is now `0.3.0`.

### Security and boundaries

- The Studio binds to `127.0.0.1` by default. Binding a non-loopback host now
  requires an explicit `--allow-network` flag, and the Engine view reports
  network exposure truthfully.
- Media stays on the user's machine; no cloud processing, accounts, or public
  hosting.

### Known limitations

- Beat/downbeat positions are suggestions, not phrase or chorus detection.
- The ffmpeg fallback is a center/side transform, not vocal isolation.
- Demucs separation is serialized to protect laptop GPU memory; CUDA OOM falls
  back to CPU with a visible warning.
- Three-plus-track composition, clip timelines, plugins, and automation are
  deferred to a future version.

### Lawful-media reminder

Only import audio you own or have permission to download and remix. YouTube
importing requires `yt-dlp` and does not bypass access controls.

## [0.2.0] — vertical slice

The initial working vertical slice: analyze, separate, align, and recombine
two tracks through a CLI and a same-origin FastAPI Studio.

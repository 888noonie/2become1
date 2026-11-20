# AGENTS.md

Operating notes for an agent changing this repository. Product behavior is
described in `README.md`. Historical phase handoffs live in `CODEX.md` and the
`PHASE_*.md` files. When those older plans disagree with the code, trust the
code and this file.

## Run

```bash
uv sync --frozen --extra web --extra dev --extra demucs
.venv/bin/twobecomeone web
.venv/bin/pytest -q
npm test
```

The Studio listens on `127.0.0.1:8765` and stores media in
`~/.local/share/2become1`. Do not bind `0.0.0.0` without `--allow-network`.
A sync that omits `--extra demucs` uninstalls the local Demucs extra.

Verify UI against a second loopback port and a temporary `--data-dir`. Leave
the process already bound to port 8765 running. The frontend is vanilla JS in
`src/twobecomeone/studio_static` with no production bundler. Tests mount the
real view functions with `node --test tests/frontend/*.js`.

## Library, separation, and the sidebar

- A track that finishes a Studio upload or YouTube import keeps its original
  full mix. `_finish_import` then queues `submit_separation(method="auto")`
  and returns without waiting. A full queue or a missing capability must not
  fail the import.
- Do not start that hook from `ingest()` or the CLI `import` command. Doing so
  separates every test fixture. Do not backfill tracks that were stored before
  the hook existed.
- `auto` uses Demucs vocals, drums, bass, and other when `demucs.api` imports.
  Otherwise the components are ffmpeg center and sides. Never label center or
  sides as vocals. Explicit `method="demucs"` still fails closed when Demucs
  is not installed.
- Constructing `demucs.api.Separator` downloads HTDemucs weights. Import tests
  that reach `JobEngine.close()` must monkeypatch
  `twobecomeone.separator.demucs_available` to false unless the test is
  specifically about Demucs.
- The Library **+** pane calls `openSourcePicker(store, null)`. That dialog
  keeps its Library, Upload, and YouTube choices.
- The Stem Performance Desk uses the same dialog. Choose from Library picks a
  stored track into group A or B and does not assign a deck. Add / Process
  Track opens that dialog for a new upload or YouTube import, or requests
  `submit_separation(method="demucs")` when the selected track has no complete
  Demucs vocals/drums/bass/other set. It watches the existing job. A finished
  import is not a finished separation, and center/sides stay a channel split.
- `Import My Stems` attaches four owner-supplied WAVs to a library track. Roles
  are explicit (never inferred), the set is `method="imported"` with
  `model_name` = `sha256:<set hash>`, and no separation job or model call runs.
  Equal durations are not treated as alignment; the UI says the owner is
  responsible for providing aligned files. A complete imported quad is ready in
  the desk, and Add / Process must not request Demucs while one exists.
- A Stem Desk entry nudge is a per-group millisecond offset applied on the
  next Play. Negative is earlier, positive is later, and Reset is zero. It
  moves the whole group together and does not change playback rate, pitch,
  or tempo. It is not beat matching.
- `sources.from_youtube` downloads only after `canonicalize_youtube_url`.
  The child receives the canonical watch URL, `--ignore-config`, and
  `--max-filesize`. The only accepted file is `{video-id}.mp3` inside the
  work directory; a path printed by the child is not opened. `ingest_youtube`
  still stores the caller’s original string as `source_ref`.
- `source_adapter.validate` classifies one slot as a YouTube link, an
  already-staged upload, or a library track. It does not download. A public
  URL is not authorisation: `authorised` must be the caller's own True, or
  the result is `NOT_AUTHORISED`. The handoff names `submit_youtube_import`,
  `submit_upload_import`, or `assign_deck`. It does not start that call.
- A track label is `display_name`. Import may set it from the Track Name
  field, or from the video title when that field is blank. The upload file
  name and the YouTube address stay in `original_name` and `source_ref`.
  Renaming updates the label only: the track id, content hash, stem-set id,
  source URL, and media paths stay. A blank or whitespace-only name is
  rejected. A name longer than 200 characters is rejected rather than cut.
  Import writes the label only while `display_name` is still NULL, in one
  conditional update. A rename that lands while import completion is still
  running keeps the saved name. Separation finishing later does not replace it.
- The Stem Desk still defaults to 40 MiB fetched and 40 MiB decoded per stem,
  160 MiB per group, and 320 MiB for eight lanes. A 30, 60, or 90 second
  section is cut with ffmpeg before the browser decodes, at the file's own
  sample rate, channel count, and sample format. The cut seeks by sample
  index. 16-bit stays 16-bit, wider integer PCM stays wide enough to hold
  the samples, and float stays float. A start at or past the last sample is
  refused, including when the container duration rounds past that sample.
  An empty cut is a data chunk with no bytes. A 24-bit or float section is
  not treated as empty. The same start and length are sent for every stem in that group. A section
  that would still decode past 40 MiB is
  refused with the estimate. Full length is explicit: 128 MiB per stem,
  512 MiB per group, and 1024 MiB for the desk. Those three move together.
  Machine RAM is not that allowance. A stored stem may be as large as that
  full-length ceiling; the default load still cuts a section. The desk's
  playback context stays 48 kHz; the section file is not resampled to make it fit.
- The section route writes the cut to a seekable temp file, so ffmpeg emits a
  correct RIFF header: real RIFF/data sizes (not the `0xFFFFFFFF` pipe
  placeholder) and the word-alignment pad an odd data chunk needs. A 30 second
  cut must not read as a multi-gigabyte file or end before a chunk boundary.
- A reload whose every requested lane fails keeps the previous group and says
  `could not be reloaded; its existing N lanes are unchanged`, carrying the
  server's reason. It must not say `Loaded` for a group it did not refresh.
- A stem-desk proposal is `stem-desk-proposal/v1`.
  `suggestStemDeskProposal` only returns data: A keeps drums and bass, B keeps
  vocals and other, silent lanes stay muted, and both entry offsets stay 0.
  The desk buttons are Ask for a proposal, Preview, Hear it, one keep button,
  and Reject. Preview only displays the suggestion. `Hear it` validates the
  proposal exactly as Approve does, captures the current mix, and sets the
  proposal through the desk's own setters (`applyStemDeskMix`). The same
  button then reads `Hear mine` and flips between the two. Nothing calls
  `play`; no source starts and there is no second transport.
  The keep button is named for what pressing it does and keeps what is heard:
  `Keep it` while hearing the suggestion, `Keep mine` while hearing the
  musician's mix (the suggestion is set aside and was never applied to that
  mix), `Approve` after Preview without listening, and `Undo` after a
  suggestion was kept or approved. Undo returns the mix captured just before
  that suggestion. Reject, asking again, choosing another track or loading a
  group while hearing returns to that mix; a new suggestion, another track or
  a load also ends a pending Undo. There is one captured mix per idea, not a
  second snapshot system.
  A control the musician moves while an idea is being heard or can still be
  undone is theirs: flipping, Keep, Reject and Undo never move it. Outside an
  idea, a nudge, mute, solo, gain, level, or crossfader move drops the pending
  proposal. `approveStemDeskProposal` still applies a proposal only after it
  matches the loaded stem-set ids and lane measurements and names every
  loaded group; any soloed lane blocks it, and unknown fields, including
  playback rate and pitch, reject it whole. Entry offsets are heard on the
  next Play, as always.
  Flips, keeps from Preview, Reject and Undo run inside `StemDesk.glide`: the
  setters update the model and the gains are applied once at the end. On a
  playing desk each gain that actually changes ramps once over
  `STEM_DESK_GLIDE_SECONDS` (0.04 s of the audio clock) from wherever it is,
  including mid-glide; unchanged gains are not touched, and a stopped desk
  assigns directly. A manual move during a glide cancels that gain's pending
  ramp so it is never pulled back. Every other gain change still assigns
  directly. Whether the glide is click-free is a PM listening check, not
  something this note claims is proven.
- The Studio sidebar queue adds a track that is already in the library. It has
  no YouTube paste box. YouTube import stays in Choose Track. The queue is not
  persisted.
- `drop the bass on deck A` applies `{op: eq, deck: A, band: low, db: -12}`.
  On success the agent output is exactly `I have dropped the bass to come in
  on the next suitable cue`. A vocal-loop phrase returns
  `STEM_LOOP_UNAVAILABLE` and does not start separation.
- An EQ cut requested before a deck has a media element is stored and applied
  when the tone stage opens. A missing filter on an already loaded element
  stays `TONE_UNAVAILABLE`, and that failure does not show the bass sentence.

## Contracts that stay strict

- `import_next` still requires `itemId`, `url`, and `deck`. A library track
  enters the queue through `assign_deck`, not by omitting the URL.
- No model call separates stems. Cloud model calls read `OLLAMA_API_KEY` from
  the environment only. Do not write a key into the repo, and do not select
  `mistral-large-3:675b-cloud`.
- Unknown mix phrases with no model return `PR_PROVIDER_UNAVAILABLE` and apply
  nothing.

## Stem Performance Desk (two tracks, eight lanes)

Accepted 2026-11-18 at `4265ac1`; the owner confirmed it by ear. Milestone and
full evidence: `docs/milestone-2026-11-18-eight-stem-desk.md`. Procedures,
commands and the failure-mode table: `docs/stem-desk-engineering-guide.md`.
Earlier audio history: `docs/stem-desk-audio-diagnosis.md`.

- One `AudioContext` per mounted panel, owned by the panel, and one Play. Every
  stem inside a group shares that group's onset; a stored per-group entry nudge
  may delay that group's onset, which is still one clock and one transport, not
  a second one. Never add a second context, transport or master to add a track.
- Per-lane gain feeds a per-group gain; group gain is the equal-power crossfade
  **times** the track level, so a crossfade move cannot overwrite a level. The
  master feeds a soft-clip ceiling that is linear below 0.8.
- The mute/solo/gain law is unchanged (`anySolo ? solo : !muted`). Solo is global
  across all eight lanes; `effectiveGain` must include the group gain. Refuse an
  ambiguous bare lane name when two tracks share it.
- One loaded track keeps looping. Two tracks play once and end with the longer
  lane; a short stem must never wrap under a longer one.
- A successful load stops playback and returns to `ready`. Re-read the transport
  at commit time, merge overlapping loads against the current group set, and
  re-check track/lane/byte budgets there. `unload()` and `dispose()` retire the
  in-flight load. A decode that resolves afterwards does not commit, and
  aborting the signal during decode does not commit that lane.
- Lane labels carry method, model, device and stem-set id. Never label
  center/sides or user material as vocals or Demucs.
- Never claim beat matching. A shared start on one clock is not tempo or phrase
  alignment; the UI must say so before playback.
- Keep the default decoded-PCM limits (40 MiB/stem, 160 MiB/track, 320 MiB/desk,
  mono or stereo only). A section is cut before decode; full length raises all
  three byte ceilings together (128 / 512 / 1024 MiB) and only when the PM
  chooses it. Decoded size follows the context sample rate, not the file.
- Prove audio with real separated stems and a negative control that fails on the
  previous code, not with tone probes alone. Headless PCM never replaces the
  PM's listening acceptance.

## Studio arrangement editor (OPERATION FULL HOUSE)

The Studio has two surfaces: Performance (the accepted desk, still the landing
surface) and Arrangement (`#/studio/arrangement`, remembered once chosen).
Evidence and the demo procedure: `docs/full-house-daw.md`.

- One `EditEngine` (`js/arrangement/edit-api.js`) holds the ONE ProjectState.
  Every control, keyboard shortcut and Producer action goes through
  `DawSession.apply` → `EditEngine.run`: validated, atomic, undoable. Do not add
  a second project, snapshot or arrangement state, for the UI or for the AI.
- Assets carry a Studio media URL as `bufferReference` (a stem section such as
  `/api/stems/{set}/audio?name=vocals&start=30&duration=60`). Decoded PCM lives
  in `DawSession.buffers` and never enters project JSON. The server refuses any
  other reference shape. Decoding uses the desk's limits (40 MiB per stem and
  320 MiB in all for sections, 128 / 1024 MiB for Full length).
- No AudioContext exists until Play. Performance and Arrangement fire
  `twobecomeone:exclusive-play`; the other one stops. One context per session.
- The live engine takes edits with `RealtimeEngine.replacePlan`: mixer values
  ramp on the shared backbone (20 ms); a clip change re-anchors at the heard
  position through the Seek handover. Never rebuild the engine to apply an edit.
- Imported stems play at ratio 1 (no DSP) until the musician chooses Fit to
  project tempo (`beat_sync` from the track's measured BPM) or a manual speed.
  Stretch keeps pitch and the source span; pitch keeps time. An entered tempo
  is labelled entered, never measured. A rate or pitch outside the measured
  priming range plays and is reported as `STRETCH_UNQUALIFIED`.
- Save writes `/api/arrangements/{id}` (1 MiB JSON limit, atomic replace).
  Reopening restores the exact ProjectState; undo history starts fresh.
- Export saves first, renders that saved state through `renderOffline` (the
  accepted stretch-all bounce, limiter ceiling -0.3 dBFS, 0.5 s tail) and
  offers a 24-bit 48 kHz WAV download from the musician's own click. At most
  32 clips per bounce; more is refused with the reason.
- The arrangement Producer suggests ordinary edit commands, dry-runs them with
  `EditEngine.propose`, and applies Hear it / Hear mine / Keep / Undo as normal
  batches. A field the musician changes after the idea arrives is theirs.
- Browser runs use `--disable-audio-output --mute-audio`. Headless measurements
  never replace the PM's listening acceptance.

## Static assets

- There is no byte ceiling. Record the total uncompressed bytes under
  `src/twobecomeone/studio_static`, the file count, the largest files and the
  delta against the last recorded baseline for every frontend-bearing change.
  Explain meaningful growth; never minify, compress readability or delete a
  useful behaviour to satisfy a historical number.
- Keep desktop `1280x800` and mobile `390x844` journeys, the accessibility
  audits and the OfflineAudioContext audio capture passing where the change
  touches playback or UI. See `docs/static-asset-policy.md`.

## Commits

Stage the source, tests, and docs for the change. Leave personal documents,
`Mock Images/`, `.playwright-mcp/`, editor state, and session notes
untracked. Do not commit unless the user asks.

## Studio visual changes

The PM accepted Black Tie at `e53b266`. Use the [Black Tie frontend guide](docs/black-tie.md) for the mixer hierarchy, shared controls, fully loaded viewport checks and the visual acceptance gate. Keep the approved musical behaviour covered by the Stem Performance Desk contracts above.

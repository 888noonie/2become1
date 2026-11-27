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
- A stem label is `display_name` beside the unchanged role `name`, stored in
  `stem_sets.names_json` (migration 14) and read with `stem_set_info`. The
  identity is `(stem_set_id, role)`: the label follows the set into every
  project, but it never renames a file, changes `paths_json`, copies a WAV or
  alters provenance. `GET /api/stem-sets/{id}` is the identity card;
  `PATCH /api/stem-sets/{id}/names` sets a value or clears it with null.
  `stem_crate_items.label` is still a loop-region label, not the stem name.
- Library and Crate search (`/api/tracks?q=`, `/api/crate?q=`) also match
  validated stem labels, role tokens and the source recording's display name.
  A track item carries `match: {track, stems}` only when at least one validated
  stem matched; `total` and pagination still count distinct tracks, so a track
  with several matching stems is one result. Each stem match names
  `(stem_set_id, role)`, the original track, `display_name`, `available` and
  `audio_url`; it never carries paths, provenance or hashes, and missing media
  is never advertised. A query with no stem match keeps the old response shape.
- The stem audio surface for a focused preview is fixed and documented in
  `docs/stem-focus-audio-contract.md`. `/api/stems/{set}/audio?name={role}` is
  the only stem audio route: it serves the stored bytes with HTTP `Range`, and
  `start` plus a 30/60/90 second `duration` cuts a sample-aligned section at the
  file's own rate, channels and sample width. There is no stem duration field
  and no stem peaks route: duration comes from the decoded buffer, and stem
  peaks come from decoded PCM (`computePeaks`). `full` is not a stem. Identity
  is `(stem_set_id, role)` and survives a rename. No stem media outside
  `stems/` is reachable: a stored path that resolves outside it, a symlink out
  of it, or a file whose name does not match the role is refused. A
  pitch-preserving speed change is the Signalsmith path, never `playbackRate`.
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

### The Crate (record-crate)

Library search in the desk's right column. See `docs/record-crate.md` for the
contract, the evidence, and the `/api/crate` shape.

- Display name Crate, code identity `record-crate`. It is not the Stem Crate
  loop system (`stem-crate.js`, `/api/stem-crate`); do not merge the two.
- Producer and Crate are tabs in one rail, built by the one desk and hosted by
  the shell sidebar (see below). Expand is a non-modal 430 px overlay. At 1100
  px and narrower, the desk heading's Crate button opens the shell's modal
  sheet on the Crate tab; it exists only while open.
- Switching tabs never touches a pending idea, the mix or the transport. While
  an idea is heard, waiting or undoable, the Crate shows a strip that says so.
- The Crate reaches the desk only through its bridge. Choose sets the bank's
  own selector and fires its change handler: no AudioContext, no load, no
  stop. Load presses the bank's own Load button. Separate uses the same
  active-job lookup and Demucs request as Add / Process Track. Do not add a
  second load or separation path.
- Track ids are the Library's own. "On A/B" is set only when a load commits.
  Center/sides is never shown as stems or Demucs. No artist is invented.
- The Crate fetches nothing until it is first shown. Library facts and action
  permissions come from `/api/crate`. A failed projection read is surfaced to
  the user. Live progress comes from the existing job watch.

### Navigation keeps the Studio (OPERATION NEVER LOSE THE MIX)

Evidence, playback policy and limits: `docs/never-lose-the-mix.md`.

- The router keeps the Studio mounted (`keepAlive: ['studio']`). Leaving it
  hides its pane and calls `hide()`; returning calls `show({ hash })`. Only
  page unload disposes it. Do not dispose the desk, its AudioContext or the
  Arrangement's EditEngine on navigation, and do not paper over a lifecycle
  defect with saved state.
- Playback continues across sections. A Library/Activity preview takes part in
  `twobecomeone:exclusive-play`: starting it stops the desk or Arrangement,
  and their Play pauses it. Navigation saves no arrangement.
- In-app navigation is not a refresh: a reload still starts with empty banks
  and only a Saved arrangement. Never claim otherwise.
- Hidden Studio code must not act on the visible page: document-level key
  handlers check `root.closest('[hidden]')`, and nothing animates while the
  hidden Studio is stopped.
- The shell sidebar (`workspace-sidebar.js`) only moves the desk's one rail:
  a right-hand aside wider than 1100 px (Hide collapses it to a 44 px tab),
  under the desk at 1100 px and narrower while the desk is on screen, and a
  modal sheet from the top-bar Producer & Crate button on every section. Never
  build a second Producer or Crate. On the Arrangement surface the desk
  Producer's controls step aside for the page's own Producer; its idea stays.

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

### Direct clip control (OPERATION FIRST CUT)

Evidence and the demo: `docs/first-cut-direct-control.md`.

- Three positions, never mixed up. **Play cue** (ruler click, `Cue at clip
  start`) moves only where Play begins. **Move** changes `timelineStartBeat`.
  **Slip** (`slipClip`, absolute source seconds) changes only
  `sourceOffsetSec`; position, length, rate, pitch, fades and gain stay. Trim
  moves a boundary and advances the in-point at the clip's own rate. Source
  seconds, frames, output seconds and beats are converted only through
  `time-math.js` (`beatsToSourceSeconds`, `slipLimitsSec`).
- A clip that uses its whole stem has no slip room; the UI says to trim first.
  The Producer's clip idea shortens the clip's end when a later in-point needs
  it, and lists that change.
- An edit that changes nothing is not an undo step (`EditEngine.run` returns
  `noop`). A gain, fade or slip drag is one step; a pixel wobble is none.
- Clip gain is the clip's, separate from track level. The waveform draws gain
  times the linear fade envelope the engine and the bounce both apply.
- A new engine parks at frame 0 while preparing; that must not reset a cue
  chosen before the first Play (`DawSession` `onParked` ignores it).
- A Producer clip idea is typed (`suggestClipIdea`: position, in-point or
  phrase number, gain, fades), validated with `propose`, applied as one batch,
  and reversible. Phrase starts are a loudness heuristic on decoded peaks. It
  does not read free text.

### The conversational Producer (OPERATION THE LISTENING ROOM)

Evidence, model choice, limits and the demo: `docs/listening-room.md`.

- The model only reads and answers. `producer_brain.converse` sends a short
  session description plus the musician's words to an Ollama-compatible daemon
  on LOOPBACK (`TWOBECOMEONE_PRODUCER_MODEL`, default `qwen2.5:3b-instruct`;
  `TWOBECOMEONE_PRODUCER_URL`, loopback hosts only) with a JSON-schema
  `format` whose enums are the session's real section, clip and lane ids. The
  answer is ONE intent. It never edits anything.
- `producer-intent.js` turns intents into a spec that survives follow-ups and
  then into ordinary edit-API fields. Every edit is dry-run with `propose`,
  applied as one batch by Hear it, and kept, rejected or undone with the
  existing buttons (or by voice). A refinement while the idea is heard swaps
  it in as ONE undo step. A musician's own move on the idea is absorbed into
  the next version; Hear mine / Undo still return to the pre-idea arrangement.
- The edit description shown to the musician is built from what validated, not
  from the model's reply. `reconcile` drops fields the request did not ask for
  and turns effect requests (reverb, reverse, upload) into `unsupported`.
- A passage is cut from the stem file at a SAMPLE index of that file
  (`startFrame / sampleRate`), one source bar early, so the in-point inside the
  cut is nonzero and the first heard sample is the section start.
  `loadStemToTrack` takes `newClipId`, `sourceOffsetSec`, `durationBeats` and
  `reuseAsset` for this; it validates bounds like a slip and a trim.
- Source analysis (`listening.py`): bar self-similarity of the full mix,
  novelty boundaries, repetition clusters, vocal level from the separated
  vocal stem, optional words from a LOCAL faster-whisper folder
  (`TWOBECOMEONE_WHISPER_MODEL`; a bare model name is refused so nothing
  downloads). Labels are estimates with evidence and confidence. Cached by
  content hash; the musician's section names are stored per recording and
  replace the estimates.
- Heard words are never sent to an external (`*cloud`) model, and by default
  not to the local one either (they confuse a 3B model):
  `TWOBECOMEONE_PRODUCER_HEARD_WORDS=1` opts a local model in. A quoted lyric
  comes back as the intent's `lyric` and the Studio searches its own
  transcript; an uncertain match (score < 0.8) is asked about, not placed.
- No audio is ever sent to a model. Talking to the Producer never opens an
  AudioContext.

### Clip editing (OPERATION THE CUTTING ROOM)

Evidence, shortcuts and limits: `docs/cutting-room.md`.

- Cut, Copy, Paste, Delete and Split use the one `EditEngine`. `deleteRegion` splits at the range edges with `splitClipAtBeat` and deletes the inside pieces. Nothing slides to close the gap. `pasteClipboard` adds new clips; each is one undo step. Copy makes no edit.
- A clipboard (`arrangement-clipboard/v1`, from `clipboardFromClips` / `clipboardFromRegion`) is plain data: clip fields relative to an origin plus each piece's asset record. It never enters ProjectState or history. It lives in the panel, so it survives navigation but not a refresh.
- The edit range is the ruler range, which is also the loop. It applies to all eight lanes or to the selected lane. A selected clip wins over the range.
- Paste keeps in-point, length, rate mode, pitch, gain and fades. It reuses a matching asset record, never trims or removes a clip already there (overlaps sum), and decodes a source missing after Open before it lands. A project change during that decode drops the paste.
- Cut and Delete never remove an asset. Shortcuts act only while the Arrangement is shown. Ctrl+C/X need a clip or range selection and no selected page text.
- A pointer press on a clip focuses that clip before selecting it. Otherwise the re-render's focus restore hands the selection back to the clip that had focus.

### Library stems in the Arrangement (OPERATION OPEN THE RECORD SLEEVES)

Evidence and limits: `docs/record-sleeves.md`.

- `js/stem-sleeve.js` is the one frontend place that knows a stem: identity
  `(stem_set_id, role)`, and a URL accepted only when it is exactly
  `/api/stems/{set}/audio?name={role}`. Library and Crate share its list
  widget; renames go through `PATCH /api/stem-sets/{id}/names` and publish the
  identity card on its bus. Never copy a label into the Library store or into
  ProjectState, and never use a label as a path, lane id or audio query.
- Library **Stems** and an expanded Crate row read `GET /api/tracks/{id}/stems`;
  search matches (`match.stems`) sit under their one recording and never add to
  `total`. Each view keeps one list per recording and re-attaches it on
  re-render so focus and open rows survive.
- **Use in Arrangement** only offers the stem. `DawSession.placeStem` decodes
  it and places ONE `loadStemToTrack` (natural speed, reused asset) on the lane
  and bar the musician chose; an occupied span is refused (`PLACE_OCCUPIED`),
  nothing is moved or replaced, and nothing plays. `asset.source` keeps
  `stemSetId`, `role`, `trackId` and `title`; the owner's label is shown live.

### Directing a take (OPERATION THE MAESTRO)

Evidence, model runtime diagnosis and limits: `docs/the-maestro.md`.

- A Producer clip the musician kept (`conv.musicianClips` ∩ `idea-*`) owns its
  time on its lane. A later take never stacks a part over it
  (`clearOfKept`); the part starts where the kept clip ends. A lane holding a
  kept clip keeps its own gain curve; the new entrance is the clip's fade-in.
  Every later take names the kept clips in its reply and on the card. After a
  reload or Open, `idea-*` clips already on the lanes are kept: they have no
  pending idea behind them. Kept status is derived, not stored in ProjectState.
  A bed trim is recomputed from the lanes on every build, never replayed.
  The Producer never deletes a musician's clip. A bed piece that starts inside
  a new part and runs past it comes back where the part ends (move + slip, so
  Hear mine restores it). A piece wholly inside stays, and the reply names it.
- `.daw__producer-now[data-state]` is one of you-play, jam, idea, creating,
  waiting, playing, finished, yours. The direction row (Try another, More energy,
  Previous vocal, Take over) shows only while the Producer holds the decks and
  sends the same phrases as typing. Take over keeps the take; Restore previous
  arrangement is offered after it only while the lanes are exactly as the take
  left them; Take back keeps its meaning and never erases a hand edit.
- `creativeDirection` is a keyword map, not language understanding. Its reply
  says which word it read and that no model was used. A reply must state the
  fade, length or position actually applied, never the one requested.
- `producer_brain.status` reports `answered` from the last real call. A model
  listed by `/api/tags` that crashes on load is unavailable, with the daemon's
  error. As of 2026-11-22 the GPU daemon segfaults (NVIDIA 620.70 module vs
  620.73 user space); do not claim a working model without a successful call.

### Stem-Focus (OPERATION STUDIO SURGEON)

Evidence and limits: `docs/studio-surgeon.md`.

- `js/stem-focus.js` is ONE panel for Library, Crate (asset mode) and
  Arrangement clips (clip mode). Opening plays nothing, makes no
  AudioContext and loads no bank.
- Audition uses the one `audio.js` preview, registered by `app.js` through
  `useFocusAudio`; never import `audio.js` from a component.
  - It joins `twobecomeone:exclusive-play` and names what interrupted it.
  - Closing stops only its own preview.
- The waveform is real peaks: `GET /api/stems/{set}/waveform` (cached, reads
  only) or the Arrangement's decoded `peaksFor`. Never synthesise one.
- Clip mode edits only through `DawSession.apply` (one undo history).
  - A Focus selection is placed as one `loadStemToTrack`, cut from a 30/60/90 s
    section.
- Role tokens live in `js/stem-roles.js` and the `--color-role-*` tokens: a
  glyph and the written role always go with the colour. Bank A/B stays the
  clip colour.
- Arrangement document shortcuts ignore keys inside any `<dialog>`.

## Static assets

- There is no byte ceiling. Record the total uncompressed bytes under
  `src/twobecomeone/studio_static`, the file count, the largest files and the
  delta against the last recorded baseline for every frontend-bearing change.
  Explain meaningful growth; never minify, compress readability or delete a
  useful behaviour to satisfy a historical number.
- Keep desktop `1280x800` and mobile `390x844` journeys, the accessibility
  audits and the OfflineAudioContext audio capture passing where the change
  touches playback or UI. See `docs/static-asset-policy.md`.

## Arrangement skills

Reusable notes for the eight-lane DAW, Clockwork, chorus ranking, the Producer, stem audio and identity, audio checks, and release promotion live in `skills/`. Read the matching skill before changing that surface. When a skill and this file disagree, trust the code and this file.

## Commits

Stage the source, tests, and docs for the change. Leave personal documents,
`Mock Images/`, `.playwright-mcp/`, editor state, and session notes
untracked. Do not commit unless the user asks.

## Studio visual changes

The PM accepted Black Tie at `e53b266`. Use the [Black Tie frontend guide](docs/black-tie.md) for the mixer hierarchy, shared controls, fully loaded viewport checks and the visual acceptance gate. Keep the approved musical behaviour covered by the Stem Performance Desk contracts above.

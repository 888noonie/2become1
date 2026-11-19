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
- A stem-desk proposal is `stem-desk-proposal/v1`.
  `suggestStemDeskProposal` only returns data: A keeps drums and bass, B keeps
  vocals and other, silent lanes stay muted, and both entry offsets stay 0.
  The desk buttons are Ask for a proposal, Preview, Approve, and Reject.
  Preview only displays the suggestion. `approveStemDeskProposal` is the only
  function that may apply one, and only after it matches the loaded stem-set
  ids and lane measurements and names every loaded group. Any soloed lane
  blocks it, including a lane on a group the proposal does not name. It does
  not call `play`. Unknown fields, including playback rate and pitch, reject
  the whole proposal and leave the mix unchanged. A nudge, mute, solo, gain,
  level, or crossfader move drops the pending proposal.
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

# The Crate (record-crate), first slice

The Crate is a Library search inside the Performance desk's right column. It
shows each Library track's artwork, name, length, BPM and key where measured,
source kind, stem readiness, and whether the track is selected or loaded in
Bank A or B. From a result the musician can **Choose** it for a bank, **Load**
that bank and **Separate stems**.

Display name: Crate. Code identity: `record-crate` (`js/record-crate.js`,
`js/components/record-crate-panel.js`, `styles/record-crate.css`). It is
unrelated to the Stem Crate loop system (`js/stem-crate.js`, `/api/stem-crate`),
which is unchanged.

Not in this slice: saved references, external discovery or YouTube search,
drag and drop, a second catalogue, Arrangement integration.

## Layout

Since OPERATION NEVER LOSE THE MIX the rail described here is hosted by the
application shell: a sidebar beside every section wider than 1100 px, under the
desk at 1100 px and narrower, and a shared modal sheet from the top bar. See
`docs/never-lose-the-mix.md`. The behaviour below is otherwise unchanged.

- **Desktop, wider than 1100 px.** The column that held the Producer now holds
  two tabs, Producer and Crate. They share the column's existing width
  (`clamp(205px, 18vw, 268px)`, 230 px at 1280 wide), so the strips keep their
  width: 113.5 px with either tab and while the overlay is open, measured at
  1280×800.
- **Expand.** This turns the Crate into a 430 px panel fixed to the right edge.
  It is not modal: transport and banks stay operable. Escape or Collapse
  closes it and returns focus to Expand. Selecting the Producer tab also
  closes it.
- **1100 px and narrower.** The column sits under the desk, as before. A
  **Crate** button in the desk heading opens the same Crate in a modal
  `<dialog>`: 430 px wide on tablets, and full width and height on phones
  (390×844 measured). The dialog exists only while open. Done or Escape
  returns the Crate to its tab and focus to the Crate button.
- **Pending Producer ideas.** While the Producer has a suggestion being
  heard, waiting or ready to undo, the Crate tab shows a strip saying so with
  **Show Producer**, and the Producer tab carries a dot and "(idea pending)"
  for screen readers. Switching tabs only hides and shows panels. It never
  touches the idea, the mix or the transport.

## What each action does

| Action | Path | Audio |
| --- | --- | --- |
| Search | Reads `GET /api/crate` (debounced) | None |
| Choose for A/B | Fills the desk selectors (`ensureTracks`), sets the bank's own `<select>` and fires its `change` handler | No AudioContext, no load, no stop |
| Load A/B | Presses the bank's own Load button | Existing handler: stops playback, async guards, messages, focus |
| Separate stems | Same active-job lookup and `submitSeparation(id, 'demucs')` as Add / Process Track | None |

Choose goes through the selector's existing `change` handler. Under the Hear-it
contract, choosing a track while a suggestion is being heard returns the desk to
the musician's mix, but playback continues. Load requires the track to be currently selected in that bank, a catalogue
permission for that bank, validated roles, and an idle desk load slot.

Focus: Choose moves focus to that row's Load. A keyboard Load returns focus to
the Crate's Load once the desk settles, unless the musician has moved focus
elsewhere.

## Catalogue contract

`GET /api/crate?q=<query>&limit=20&offset=0&sort=name` returns
`{ items, total, limit, offset }` from the existing Library. The adapter
in `js/record-crate.js` maps the fields once.

| API field | Crate behavior |
| --- | --- |
| `track_id`, `name`, `duration`, `bpm`, `key`, `source.kind` | Reads existing Library identity and display facts. Artwork uses the local Library track route. A known YouTube ID is displayed as text. |
| `stems.status`, `stems.quad`, `stems.roles` | A quad requires the backend's quad classification and all four isolated roles. A partial set stays partial even if several sets collectively have four roles. Center/sides is a channel split. |
| `stems.method`, `stems.model_name` | Displays provenance for the primary set named by the backend. The available role list may span multiple sets. |
| `separation` | Queued, running and failed status comes from the catalogue. The existing job watcher can supply a percentage. A completed job prompts a new catalogue read and never creates readiness by itself. |
| `actions` | Choose and Load require `choose_A` or `choose_B` for the bank. Separate requires `separate` and an idle job. Other catalogue actions have no Stage 1 Crate controls. |
| `duplicates` | Shows exact-content matches, same-source matches and possible versions as separate facts. Possible versions are advisory. |
| Desk session | `Selected for A/B` comes from the selector. `On A/B` requires a committed bank load. Unload clears the badge and a new session starts without bank selections. |

A failed projection request shows a search error. The desk can still read its
usual selectors, stems and job endpoints for the actions it owns. Crate
search uses the single projection and adds no per-result stem or job-list
requests.

## Verification

`tests/frontend/record-crate.test.js` covers the adapter, provenance,
permissions, progress handling and retries. The focused quad and partial
assertions also run against the original adapter as negative controls.
`tests/browser/record_crate_ux.js` provides a controlled view of focus, target
sizes, layout and accessibility. Its catalogue responses are intercepted.

For the full-stack browser journey, copy an isolated Library containing
`lead-fixture.wav` and `paper-lanterns.wav` with the prepared Demucs sets.
Use a scratch path containing a `record-crate-stage1` directory. The fixture
adds a valid two-role partial set and a track without stems. The desktop
journey submits one real local Demucs job on the latter, so each replay
needs a fresh scratch copy and cached Demucs weights.

```sh
PYTHONPATH="$PWD/src" .venv/bin/python -m tests.browser.record_crate_live_fixture "$scratch_library"
env -u OLLAMA_API_KEY -u TWOBECOMEONE_WHISPER_MODEL PYTHONPATH="$PWD/src" \
  TWOBECOMEONE_PRODUCER_URL=http://127.0.0.1:9 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/twobecomeone web --host 127.0.0.1 --port 8767 --data-dir "$scratch_library"
```

From a second terminal, with the same checkout as the working directory:

```sh
node tests/browser/record_crate_live.js http://127.0.0.1:8767
```

Press Ctrl+C in the server terminal after the run. The journey uses loopback,
real HTTP responses, local audio and muted Chromium. Owner hearing and actual
screen-reader speech are separate acceptance checks.

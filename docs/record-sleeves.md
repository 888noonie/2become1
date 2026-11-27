# OPERATION OPEN THE RECORD SLEEVES: Stem Library and Cutting Room integration

Branch `integration/record-sleeves`, built by Claude Opus 5.5. It is not merged into main and not pushed.
The PM's acceptance is still open.

## Ancestry

- `686c560` (Cutting Room, PM-accepted) is the base.
- `d838c59` (OpenCode's Stem Finder) is merged with `--no-ff` in `ca31624`, so both histories are kept.
- `d838c59` → `6a93b13` (Senior Sol's reviewed naming) → `49340be` → `edc5083`, which is also the parent of `686c560`.
- The merge had no conflicts. `AGENTS.md` auto-merged.
- No source branch or main was changed.

**Migration:** backend migration **14** (`ALTER TABLE stem_sets ADD COLUMN names_json TEXT`) comes from `6a93b13`.
- It is additive and nullable, with no backfill.
- It runs on first start against a data directory.
- This branch adds no migration of its own.

## What the musician can do

| Where | What |
| --- | --- |
| Library card **Stems** | Opens the recording's separated stems from `GET /api/tracks/{id}/stems`. Each row shows its name, original role, method, a short set id, "stem audio available", and the recording it came from. |
| Stem row **Rename** | Opens a name field (Enter saves, Escape cancels), then sends `PATCH /api/stem-sets/{id}/names`. Focus stays on that stem's row, the list stays open, and other cards don't change. |
| Stem row **Original name** | Sends `null`, so the role becomes the label again. |
| Library search | Matches the name, the role or the recording name. Matching stems appear under their recording, with the reason they matched. The recording is still counted as one result. |
| Crate search | Same as the Library. Opening a row with no search reads the stem route instead of assuming `match.stems` is filled. |
| **Use in Arrangement** | Hands that stem to the Arrangement and opens it. Nothing decodes or plays at this point. |
| Arrangement **Place a Library stem** | The musician picks the lane, the bar, the length (30, 60 or 90 s, or full length) and the start inside the stem, then presses **Place on lane**. |

## How it is built

- **`js/stem-sleeve.js`** (new, 18 KB) is the one place that knows a stem.
  - **Identity.** A stem's identity is `(stem_set_id, role)`. `normalizeStem` accepts a stem only if it has a known role and a well-formed set id, and its `audio_url` is exactly `/api/stems/{set}/audio?name={role}`. Anything else is not playable, so a label can never become a path. Stems the backend reports `available: false` are never offered.
  - **List widget.** `createStemList` is the one list used by both the Library and the Crate. Each view keeps one list per recording and re-attaches it after a re-render, so a rename or a playback change doesn't collapse it or lose focus.
  - **Name bus and card cache.** Every rename publishes the backend's identity card (`GET /api/stem-sets/{id}` shape). Every visible list and the Arrangement update from it. Nothing is copied into the Library store or into ProjectState.
  - **Offer.** The one stem chosen for the Arrangement. It is a pointer to Library media; there is no second asset system.
- **Library** (`views/library.js`) gains a **Stems** toggle and a matching-stems block under each card. The search placeholder now reads "Search tracks and stem names…".
- **Crate** (`record-crate.js`, `record-crate-panel.js`):
  - `normalizeCrateItem` keeps a validated `match`.
  - `createCrateSource` gains `listStems` and `patchJson` (the desk passes `patch`).
  - The row shows matching stems under the toggle, and the expanded details hold the stem list.
- **Arrangement** (`daw-session.js` `placeStem`, `arrangement-panel.js`) places one `loadStemToTrack` with `naturalSpeed` and `reuseAsset`. That is the existing command, so the placement is one undoable step.
  - **Decoding.** The stem's own route (or a section cut of it) is decoded under the usual section and full limits.
  - **Overlaps.** A span that overlaps any clip on that lane is refused with `PLACE_OCCUPIED`. The placement never trims, moves or replaces anything.
  - **Stale project.** If the project changed during decoding, nothing lands (`PLACE_STALE`).
  - **Playback.** Placing never starts playback.
  - **Asset name and provenance.** The asset name is stable: `"<recording> — <Role>"`. `asset.source` carries `stemSetId`, `role`, `trackId`, `title`, `method`, `modelName`, `section` and `origin: 'library-stem'`.
  - **Tempo.** Source tempo comes from the identity card's `bpm` / `bpm_source`, and an entered tempo stays labelled entered.
  - **Live label.** The lane label and the clip inspector show the owner's name live (`Stem: Lantern Lead · Vocals of "Paper Lanterns"`). The project never stores it, so a rename never edits or breaks a saved arrangement.
- No new endpoint, table, catalogue, DSP or playback path.

## Evidence (2026-11-27)

- `node --test tests/frontend/record-sleeves.test.js`: 15/15. It covers:
  - identity and URL validation, foreign or missing media, deduplication, and two stems with the same name;
  - name rules;
  - **negative:** a rename sends only `{names: {role: label}}`, and the role, set, audio URL and track stay the same;
  - rename and Original name keep focus;
  - a blank name or a server refusal changes nothing;
  - Library: Stems open, and stay open and focused through a re-render; matches sit under one card;
  - Crate: match rows, and the stem route when there is no query;
  - Arrangement: no decode before lane and bar are chosen, one clip at the chosen place with provenance, refusal when occupied, cut/copy/paste/split, and a live label with no label in the project JSON.
- `npm test`: 1108 pass, 0 fail, 1 skipped. The 1093 from the Cutting Room plus 15 new.
  - `stem-desk-panel.test.js`'s Crate helper now counts only `/api/crate` searches. Opening a row also reads that recording's stems, which is not a search.
- Backend (targeted, not the full pytest): `test_stem_finder`, `test_stem_names`, `test_stem_import`, `test_crate`, `test_studio`, `test_phase3_http`, `test_contracts`, and the four tests the merge touched: 188 passed.
- `node tests/browser/record_sleeves.js http://127.0.0.1:PORT OUT DATA_DIR`: **37/37**. Real Chromium, on a scratch copy of the seeded Midnight Circuit / Paper Lanterns Studio with migration 14 applied. Steps 1–12 of the brief:
  - Rename Vocals to "Lantern Lead". The audio URL, its bytes and every stem file's sha256 on disk are unchanged.
  - The Library and the Crate each find it as one recording, with its recording and role shown.
  - A `vocals` search lists both recordings' vocals, told apart by set.
  - Use in Arrangement. An occupied lane is refused. It is placed on lane 5 at bar 3. The saved JSON holds `name=vocals` and no label.
  - Copy, Paste, S split and Cut all work on it.
  - It plays, with one AudioContext made by Play.
  - The export with lane 5 soloed is silent before bar 3, sounds where placed, is silent where it was cut, and sounds at the pasted copy.
  - Six Undo steps return the pre-placement arrangement, the source is untouched, and Redo replays.
  - Library → Activity → Engine → Studio keeps the same instance, clips and history, with no writes.
  - Original name: the old name finds nothing, the clip reads its role, and the arrangement saved under the old name reopens intact.
  - At 390 px there is no horizontal scroll and every stem button is at least 44 px.
- `tests/browser/cutting_room.js` on the same integrated Studio: 35/35.
- Static assets: 1,597,675 bytes in 103 files, +43,018 over `686c560`. The merge itself added no static bytes.
  - The new file is `js/stem-sleeve.js` (18,410).
  - `arrangement-panel.js` is now 107,556 bytes (+7,350: placement box, live label).
  - The largest file is still `vendor/signalsmith-stretch/SignalsmithStretch.mjs`.

## Limitations

- **One set per recording when opened.** `GET /api/tracks/{id}/stems` returns the backend's chosen set for a recording, plus center/sides. An older second set of the same recording appears only through search (`match.stems`), where each set is listed separately. Showing every set on expand needs a backend listing; I did not add one.
- **Rename doesn't re-search.** A rename updates the label in place. A row found by the old name stays visible until the next search; the backend decides membership then.
- **Recording availability isn't shown.** "Stem audio available" is the stem's own file. The Library and Crate items carry no media-availability field for the recording, so the UI makes no claim about the recording's file.
- **The offer is in-page.** It holds one stem and lives in the open Studio page, like the clipboard. A refresh forgets it.
- **Placement has whole-bar resolution** and refuses an occupied span. There is no overlay or replace mode, by design. Move the clip afterwards to adjust it.
- **The stem plays at its own speed** until Fit to project tempo, as with every Studio import. Nothing is stretched automatically.
- **Not re-run.** `never_lose_the_mix.js` needs a Demucs library that isn't available here. `full_house_daw.js` (53/54) and `black_tie_ux.js` (stale) are unchanged from the Cutting Room record.
- **Headless only.** Headless checks prove identity, timing and levels. They don't replace the owner listening.

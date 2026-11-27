# OPERATION STUDIO SURGEON, Act I: the Stem-Focus experience

Branch `claude/studio-surgeon`, built by Claude Opus 5.5 on `integration/record-sleeves @ 170b270`. The accepted
branch was not changed. Not merged, not pushed. The owner's listening acceptance is still open.

## What the musician gets

One **Stem-Focus** panel for one stem. It looks and works the same wherever it is opened.

| Opened from | How | Mode |
| --- | --- | --- |
| Library stem row | **Focus** button (also Enter/Space on it), or double-click the row | asset |
| Crate stem row | the same list widget: **Focus** button or double-click | asset |
| Arrangement clip | double-click the clip, **F** on the selected clip, or **Focus** in the clip inspector | clip |

Touch screens use the visible **Focus** button. Double-tap is never needed.

**What the panel shows first:**
- the role glyph and the name;
- the written role and whether it was renamed;
- the source recording, stem set and role token;
- the method and model (a `sha256:` content hash is shortened);
- whether the stem audio is available;
- in clip mode, the lane, bank, bar, length, speed, pitch and gain.

Below that are a real waveform, Play/Pause, Stop, a position slider, and the selection: In, Out, *In here*, *Out here*, *Whole stem* / *Clip span* and *Loop the selection*. Everything else is under **Details and tools**.

**Asset mode tools:**
- **Rename / Original name.** Names only, through `PATCH /api/stem-sets/{id}/names`.
- **Place selection in Arrangement.** The selection travels with the offer (`offerStem(stem, {startSec, endSec})`). The Arrangement's place box then offers *Focus selection (5.50 s from 0:04.0)*. Placing it is ONE `loadStemToTrack` with an exact length (`DawSession.placeStem` `lengthSec`), from the 30/60/90 s section that holds the selection.

**Clip mode tools.** Each is an ordinary `DawSession.apply` command, so it is one step in the one undo history:
- **Trim clip to selection:** a `batch` of trim end → slip → trim end, so the in-point and length both change.
- **Split at cursor:** `splitClipAtBeat`.
- **Clip gain, Fade in, Fade out:** sliders, coalesced as gestures, so one drag is one step.
- **Fit to project tempo:** `stretchClipKeepingSource`.
- **Hear it in place:** plays the Arrangement from the clip's start.
- **Cut, Copy, Duplicate, Delete, Undo and Redo.** These use the panel's existing clipboard and delete paths.

The stem file never changes, and no asset is added.

## Audio ownership

- **Opening the panel** plays nothing, creates no `AudioContext` and loads no bank. It fetches only the waveform: the stem route in asset mode, nothing in clip mode.
- **Audition** goes through `audio.js`'s single `<audio>` element. `app.js` registers it with `useFocusAudio`, so importing the module builds nothing. The element streams the stem route, so nothing is decoded and no buffer is copied.
- **Pause and resume** use a new `AudioController.resume()`, which continues the same source with no reload.
- **One sound at a time** uses the existing `twobecomeone:exclusive-play` handshake:
  - A Focus preview stops the desk and the Arrangement.
  - The desk, the Arrangement, a Library preview or another stem preview stops the Focus preview. The panel then says which one, for example *Paused: the Arrangement started playing. One sound plays at a time*.
  - Closing the panel stops only its own preview.
- **The window:** playback starts at In (or at the cursor, when the cursor is inside the window). At Out it stops and returns to In, or loops back to In.
- **Clip mode** previews the clip's own source section (its `bufferReference`) at its own speed and level, and says so. **Hear it in place** uses the Arrangement's transport, so gain, fades, stretch and pitch are heard there.

## Waveforms

- **Asset mode:** `GET /api/stems/{set}/waveform?name={role}` is new. It uses the same versioned 1,200-bin min/max payload as a track waveform, from `media.generate_waveform` over the stored stem file, plus `duration_sec`.
  - It reads the file and never writes it.
  - The payload is cached under `waveforms/stems/{set}.{role}.json` and recomputed when the file's size or mtime change.
  - The role must be one of the set's own `paths_json` keys, so a label or path never reaches the filesystem.
  - It takes about 0.2 s cold for a 2:51 stem here.
- **Clip mode** draws the peaks the Arrangement already computed from the PCM it decoded (`peaksFor`). Nothing new is fetched or decoded. The span the clip plays is bright; the rest of its section is dimmed.
- **Never decorative.** No waveform is ever synthesised. If peaks are unavailable, the panel says so and audition still works.

## Role identity (patchbay)

`js/stem-roles.js` holds one token per role. The colours are defined in `studio.css`:

| Role | Colour token | Glyph | Signature |
| --- | --- | --- | --- |
| Drums | `--color-role-drums` (`#e5984b`) | step-grid | step grid |
| Bass | `--color-role-bass` (`#5c7cfa`) | low-slab | low slab |
| Vocals | `--color-role-vocals` (`#eb5e7c`) | diamond | diamond |
| Other | `--color-role-other` (`#38b2a6`) | harmonic-rings | harmonic rings |

- **Neutral roles.** Center and sides share a neutral `split` token (with center/sides glyphs). An unknown role gets a dashed `unknown` glyph and its own name.
- **Never colour alone.** The written role always goes with the glyph.
- **Where it appears:**
  - Library and Crate rows: a chip and a 3 px left stripe.
  - Arrangement clips: a 4 px left stripe and a 12 px glyph.
  - The Focus panel: the header and the waveform.
- **Bank identity is unchanged.** A/B is still the clip's bank colour and the lane/bank labels, and the mixer layout is untouched.
- **CSS:** `styles/stem-focus.css` uses tokens only. It has `prefers-reduced-motion` and `forced-colors` blocks; under forced colours the canvas redraws in `CanvasText`.

## Keyboard, focus, touch

- **Inside the panel:** Space is Play/Pause, I and O set In and Out at the cursor, L toggles the loop, and Escape closes. Typing in a field is never a shortcut.
- **Keys don't leak.** The Arrangement's document-level shortcuts now ignore keys inside any `<dialog>`. Before this, Delete, S, L or Escape in a dialog reached the Arrangement.
- **Focus return on close:**
  - It goes back to the control that opened the panel.
  - If a rename rebuilt that row, it goes to the button with the same `data-key`.
  - For a clip, it goes to the clip element, which every render rebuilds.
- **Touch and layout.** Every panel control is at least 44 px. At 390 px there is no horizontal scroll and nothing is clipped.

## Also fixed

- **Library focus after a search ends.** When a search ends under a focused match row, focus now moves to the same stem's control in the card's own list instead of falling to the page.
  - This came in with `bd41255` (search again after a rename).
  - `tests/browser/record_sleeves.js` step 12 failed on `170b270` (36/37) and passes here.
  - A unit test is red with `170b270`'s `library.js`.

## Evidence (2026-11-27)

**Frontend tests:**
- `node --test tests/frontend/stem-focus.test.js`: 17/17. It covers:
  - role identity, the tokens and the forced-colours and reduced-motion blocks;
  - Focus button and double-click (a double-click on a button is not Focus);
  - asset identity, the waveform route, nothing played on open, and Escape with focus return;
  - the window, loop, stop at Out, and resume without reload;
  - yielding to the Arrangement, the desk and a Library preview, with the right words;
  - close stops only its own preview;
  - keyboard parity;
  - Rename;
  - Place selection, and over 90 s refused with the reason;
  - the Crate opening the same panel;
  - the Arrangement placing a selection as one exact clip;
  - clip mode from double-click, F and the inspector;
  - clip preview and Hear it in place;
  - Trim, gain (one gesture is one step), Split and Undo;
  - panel keys not editing the Arrangement, and Delete;
  - focus return after a rename re-render.
- **Negative controls:**
  - Without the dialog key guard in `arrangement-panel.js`, 1 test fails.
  - Without the `data-key` focus fallback, 1 test fails.
  - With `170b270`'s `library.js`, the new Library focus test fails.
- `npm test`: 1127 pass, 0 fail, 1 skipped. That is 1110 before, plus 17 Focus tests and 1 Library focus test.

**Backend:**
- `tests/test_stem_waveform.py`: 4/4. It checks that the peaks equal `generate_waveform` of the stem file, the file is unchanged, the cache is reused and recomputed after a change, unknown roles or sets are refused, and the HTTP route works.
- Targeted backend run, with `PYTHONPATH=src` (`test_stem_waveform`, `test_stem_names`, `test_stem_import`, `test_studio`, `test_phase3_http`, `test_contracts`): 79 passed.

**Browser journeys** (real Chromium, `--disable-audio-output --mute-audio`), on a scratch copy of the seeded Midnight Circuit / Paper Lanterns Studio served from this branch on 127.0.0.1:8798:
- `tests/browser/stem_focus.js URL OUT DATA_DIR`: **37/37**, at desktop 1440×900 and mobile 390×844 (touch). It checks:
  - role tokens on clips and rows;
  - the Library Focus button and double-click, identity, real peaks (1200 bins, ink on the canvas);
  - nothing played or fetched on open, and no AudioContext;
  - the shared preview on the stem route with a 2–3 s loop, then a stop at Out;
  - Rename, with the row updating behind the panel and files unchanged;
  - Escape returning focus;
  - Place selection: 5.5 s from 0:04 is one clip on lane 5 at bar 3, cut from `&start=4&duration=30`;
  - clip mode by double-click, with decoded peaks and no new audio request;
  - the clip preview;
  - Hear it in place stopping the preview (one AudioContext), and the Focus preview stopping the Arrangement;
  - Trim, keyboard gain and Split, then Undo back to the exact clips, with no new asset and stem files byte-identical;
  - Delete and S inside the panel not editing the Arrangement;
  - F opening the panel;
  - the Crate panel for Midnight Circuit drums, with focus back on the row;
  - the same Arrangement instance throughout, and no saves;
  - at 390 px: fit, no horizontal scroll, all controls ≥ 44 px;
  - forced colours;
  - no page errors.
- `tests/browser/record_sleeves.js`: 37/37 on this branch (36/37 on `170b270`, see "Also fixed").
- `tests/browser/cutting_room.js`: 35/35. The Cutting Room is intact.

**Static assets:** 1,667,542 bytes in 106 files, against 1,601,627 / 103 at `170b270`. That is **+65,915 (+4.1%)**, which crosses the 50,000-byte investigation trigger. Where it went:
- `js/stem-focus.js`: 36,746 bytes. The whole panel: asset and clip tools, the audition state machine, and comments.
- `styles/stem-focus.css`: 8,961 bytes.
- `js/stem-roles.js`: 4,869 bytes.
- `arrangement-panel.js`: +10,114 bytes, mostly the clip adapter. It is now the largest file, at 117,670 bytes, ahead of `SignalsmithStretch.mjs` (113,867).
- Nothing was minified or removed to offset it.

## Limitations and what is still required

- **The window is enforced on animation frames** (about 17 ms) through the media element's seek. It is not sample-accurate, and a loop has a small seek gap. This is an audition; the render path is unchanged.
- **The clip preview plays the source section at its own speed and level.** The clip's gain, fades, speed and pitch are heard only through *Hear it in place*, which plays every lane. A soloed, processed clip audition would need a per-clip render through the Arrangement engine.
- **Speed and pitch numbers stay in the clip inspector.** Focus offers *Fit to project tempo* only, and says so.
- **Slip has no control of its own in Focus.** *Trim clip to selection* sets the in-point and the length together; a selection of the same length is a slip.
- **Placing from Focus is limited to 90 s or less**, because the stem section route cuts 30, 60 or 90 s. A longer selection is refused with the reason. Full length stays an explicit choice in the Arrangement's place box.
- **A backend route was added:** `GET /api/stems/{set}/waveform`. Its cache files live under the data dir's `waveforms/stems/`.
- **Interruption by the Performance Desk** is proven by unit test only. The browser journey used the Arrangement and the Library preview.
- **Accessibility** was not checked with a screen reader. Forced colours and reduced motion were checked by emulation.
- **Not re-run:** `full_house_daw.js`, `black_tie_ux.js`, and `never_lose_the_mix.js` (needs Demucs).
- **Owner accepted.** The PM confirmed the final In/Out repair at `e705a12`. See the [release handoff](studio-surgeon-act-iii.md) for its focused evidence and remaining limits.

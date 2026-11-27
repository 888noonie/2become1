# OPERATION THE CUTTING ROOM — Act I: clip editing

Branch `claude/cutting-room`, from `feature/never-lose-the-mix` at `edc5083`.
Built by Claude Opus 5.5. Not merged, not pushed. The owner's listening acceptance is still open.

## What the musician can do

| Action | Keyboard | Also from |
| --- | --- | --- |
| Copy the selected clip, or the ruler range | Ctrl/⌘+C | Clip inspector **Copy**, track inspector **Copy range**, right-click |
| Cut the selected clip, or the ruler range | Ctrl/⌘+X | **Cut**, **Cut range**, right-click |
| Paste at the playhead | Ctrl/⌘+V | **Paste at playhead**, right-click **Paste here** (that lane and bar) |
| Delete the selected clip, or the ruler range | Delete / Backspace | **Delete**, **Delete range**, right-click |
| Split the selected clip at the playhead | S | **Split at playhead**, right-click **Split here** (the clicked bar) |
| Split every clip on the selected lane at the playhead | S (no clip selected) | **Split lane at playhead**, right-click on a lane |
| Undo / Redo | Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl/⌘+Y | Undo / Redo buttons |
| Open the edit menu on a focused clip | Menu key, Shift+F10 | Right-click |

The **range** is the span dragged on the ruler, the same one that sets the loop. Under **Range on**, the track inspector applies it to all eight lanes (the default) or to the selected lane only.
Range Cut/Copy/Delete need a range; with a clip selected, the clip wins.

## How it is built (no parallel system)

- `edit-api.js` has two new commands on the one `EditEngine.run` path:
  - `deleteRegion` splits every clip on the range's lanes at the range edges with `splitClipAtBeat` and deletes the inside pieces. Nothing slides to close the gap.
  - `pasteClipboard` adds one new clip per clipboard piece.
  Each is one validated, atomic, undoable step.
- A clipboard is plain data, `arrangement-clipboard/v1`. It holds the clip fields relative to an origin beat, plus the asset record each piece plays. It is never ProjectState and never enters history. `clipboardFromClips` and `clipboardFromRegion` are pure (tested). Copying a range cuts at the edges exactly as `deleteRegion` would.
- **Cut** = clipboard + `deleteClip` / `deleteRegion`. **Copy** makes no edit. **Paste** = `DawSession.pasteClipboard`. If a piece's source is no longer decoded (copied before Open), it is decoded first under the usual section/full limits. If the project changed during that decode, nothing lands (`PASTE_STALE`).
- Paste keeps every piece's in-point, length, rate mode, pitch, formants, clip gain and fades. It reuses the project's own asset record when the reference, length and tempo match. Otherwise it adds that record (for example, pasting into a New project). A one-lane clipboard lands on the target lane; a multi-lane one keeps each piece's lane.
- Source audio is never removed: assets stay after Cut and Delete, as with `deleteClip` before.
- Pasted clips get new `clip-N` ids from the existing id rule. The asset reference is the stable reference.
- Pasting never trims or removes a clip already there. Overlaps are summed (the existing `OVERLAP_POLICY`), and the announcement says so.
- Keyboard shortcuts only act while the Arrangement is shown (the existing `[hidden]` guard). Ctrl+C/X act only when there is a clip or range selection and no page text is selected. Ctrl+V acts only when the clipboard holds something. Otherwise the browser's own copy/paste is untouched.

### A focus fix found by the browser journey

`renderLanes` puts focus back on whichever clip had it, and `focusin` selects the focused clip. Before this change, a mouse press on another clip (`pointerdown` calls `preventDefault`, so focus did not move) selected the new clip. The re-render then handed focus, and the selection, back to the old one. Keyboard users could already hit this; the menu returning focus to its clip made it routine. A press now focuses the pressed clip first. The jsdom test for this fails without the fix.

## Evidence (2026-11-27)

- `node --test tests/frontend/arrangement/cutting-room.test.js`: 10/10 (engine: range edges, in-point arithmetic, purity, paste mapping beat-for-beat, cut/paste/undo identity, new-project paste, tempo refusal, malformed clipboard).
- `node --test tests/frontend/cutting-room-panel.test.js`: 11/11 (keyboard, inspector, both menus, range scope, S on a lane, paste after Open, stale paste, hidden-surface guard, page-text guard, focus fix).
- `npm test`: 1093 pass, 0 fail, 1 skipped.
- `node tests/browser/cutting_room.js http://127.0.0.1:PORT OUT`: 35/35. It runs on the seeded Midnight Circuit / Paper Lanterns Studio (`docs/full-house-daw.md` recipe) with real Chromium and real mouse and keyboard.
  - Copy/paste, cut, Undo/Redo, ruler-range Delete on all lanes, right-click Split here, S split.
  - Play after editing, and Undo/Redo while playing (still playing, one AudioContext).
  - Library → Activity → Engine → Studio: the same instance, clips, history and clipboard, and no shortcut edits while hidden.
  - Export WAV: the deleted range is digital silence, the music on both sides is present, and the pasted drums sound at bar 29.
  - 6 Undo steps return exactly the imported clips; Redo replays them.
  - The 390 px menu fits the screen with 44 px items.
- `tests/browser/full_house_daw.js`: 53/54. The failing check, "4. trimming the end lands on the bar grid", fails identically on unmodified `edc5083` against the same Studio (an end-trim drag that does not land), so it is not from this change. The 390 px accessibility audit is clean after the range-scope select was given 44 px.
- `tests/browser/black_tie_ux.js` stops at the desk's **Ask for a proposal**. It does the same on unmodified `edc5083`, because that commit moved the desk Producer into the shell sidebar; the script is stale.
- `tests/browser/never_lose_the_mix.js` was not re-run. Its prepared `lead-fixture.wav` / `paper-lanterns.wav` Demucs library was not available. This change does not touch the router, desk or sidebar. The Arrangement half of that gate (same instance, clips, history, no writes) is re-checked by `cutting_room.js` section 6.
- Static assets: 1,554,657 bytes in 102 files, +26,379 over `edc5083`. The largest file is still `vendor/signalsmith-stretch/SignalsmithStretch.mjs`. `arrangement-panel.js` is now 100,206 bytes (menu, edit fieldset, clipboard actions).

## Limitations

- One clip or one ruler range at a time. There is no multi-clip (shift-click or lasso) selection; the clipboard format and `pasteClipboard` already take up to 64 pieces.
- The edit range is the loop range: there is no separate time selection, so choosing a range also sets the loop. The journey turns Loop off before playing straight through.
- No ripple delete (closing the gap) and no paste-insert (pushing later clips right). Both would move clips the musician did not touch, so they are left for a product decision.
- The clipboard lives in the open Studio page (it survives navigation, not a refresh) and is not the system clipboard.
- Paste overlays. It does not replace what is under it.
- Pasting at a different project tempo is refused if a manual-rate piece would run past its source (`BEYOND_ASSET_END`). Nothing is stretched to fit.
- Headless checks prove timing, identity and levels. They do not replace the owner listening to a real arrangement.

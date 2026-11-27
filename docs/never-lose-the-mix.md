# Never lose the mix: the Studio outlives navigation

Branch `feature/never-lose-the-mix`, from the accepted Stage 1 Crate candidate
`0c1bda7`.

## The defect and its root cause

The owner reported that going from Studio to Library (or Activity, Engine) and
back reset the Performance desk and the Arrangement.

The cause was in the view lifecycle, not in any audio or project code:

1. `Router._render` (`js/router.js`) disposed the current view on every route
   change, then mounted the next view into the same `#main` element.
2. `mountStudio`'s disposer called every child disposer:
   - `mountStemDeskPanel`'s dispose ran `desk.dispose()`, which closed the
     desk's AudioContext and dropped both banks, every lane setting, the
     crossfader, the transport and any Producer idea.
   - `arrangementApi.dispose()` ran `session.dispose()`, which threw away the
     one `EditEngine` (clips, selection, Undo/Redo history) and deleted
     `window.__arrangement`.
3. Returning to `#/studio` mounted a brand-new Studio: empty banks, a fresh
   Arrangement and an empty history. Nothing had been saved, because nothing
   is meant to save on navigation.

The negative control shows this on the unmodified candidate. Running
`tests/browser/never_lose_the_mix.js --base` against `0c1bda7` fails checks
A1 to A8 and then the journey:

- `AudioContext` made 1, closed 1.
- Groups `[]`, and the transport back at `0.0 s`.
- `window.__arrangement` is gone, and the history depth is `[2, 1] → [0, 0]`.

## The repair

It is a lifecycle fix, not persistence.

- **`Router` `keepAlive`.**
  - A route named in `keepAlive` is mounted once, into its own
    `.view-pane[data-pane=studio]`, when the router starts. That happens even
    when the first route is Library.
  - Leaving that route hides the pane and calls the view's `hide()`.
    Returning shows the same pane and calls `show({ hash })`.
  - Only `stop()` (page unload) disposes a kept view.
  - Library, Activity and Engine are still mounted on entry and disposed on
    exit, in their own transient pane.
  - `app.js` passes `keepAlive: ['studio']`.
- **`mountStudio`.**
  - It returns its disposer with `show` and `hide` attached.
  - `show` applies a `#/studio/arrangement` or `#/studio/performance`
    sub-hash and re-renders a visible Arrangement.
  - `hide` only flushes the legacy project autosave, which the old disposer
    also did on every navigation. It does not save or commit an arrangement.
- **Nothing else changed.** There is no new state store, no snapshot and no
  localStorage copy of the mix. The desk, its one AudioContext and the
  Arrangement's one `EditEngine` simply stay alive.

### Playback across navigation (deliberate)

- **Playback keeps going.** A playing desk or Arrangement keeps playing while
  you browse Library, Activity or Engine, and the transport position keeps
  advancing. Coming back shows the same transport, and Stop works at once.
  The music is never paused or reset by navigation.
- **One audible source at a time.** A Library or Activity preview
  (`audioController`) now joins the existing `twobecomeone:exclusive-play`
  handshake:
  - starting a preview stops the desk or the Arrangement, through their
    existing listeners;
  - pressing Play on the desk or the Arrangement pauses a playing preview.
- **Keyboard.** The Arrangement's document shortcuts were already ignored
  while its root is inside `[hidden]`, so Space, Delete and Ctrl+Z on the
  Library page do not reach a hidden timeline.
- **Stopped means idle.** With the Studio hidden and stopped, nothing
  animates: 0 animation-frame requests in 1 s, measured. The Arrangement's
  playhead loop only runs while it plays.

### Navigation is not a restart

- **What survives:** moving between sections inside one page load.
- **What does not:** a browser refresh, closing the tab or restarting the
  Studio still starts from empty banks and an unsaved Arrangement.
  - An Arrangement survives a restart only through its explicit Save
    (`/api/arrangements/{id}`).
  - The desk has no saved session.
  - This change does not claim otherwise.
- **Unchanged:** New mix, Projects and Delete project change the legacy
  project as before. The Arrangement's own New/Open/Save are unchanged.

## The universal sidebar (Phase B)

- **One rail.** The Producer/Crate rail is still built by the one Performance
  desk: one Producer, one Crate and one bridge. `mountStemDeskPanel({ railHost })`
  hands that DOM node to `mountWorkspaceSidebar` (`js/components/workspace-sidebar.js`).
  The sidebar only moves the node. Because the Studio is kept alive, the rail
  exists on all four sections.
- **Wider than 1100 px.**
  - A right-hand `<aside>` sits beside every section at the old column width,
    `clamp(205px, 18vw, 268px)`: 230 px at 1280.
  - Desk strips are 113.5 px wide headless at 1280×800, as before.
  - **Hide** collapses the sidebar to a 44 px reopen tab, and the strips
    widen. The tab shows a dot and "(idea pending)" while the Producer holds
    an idea.
  - Hidden or shown is remembered per viewer, in localStorage, as a
    convenience only.
  - Hiding keeps the rail in the DOM: search text, the selected tab, open
    rows and the Producer's idea are untouched.
- **1100 px and narrower.**
  - On the Performance desk the rail sits under the desk, exactly where the
    accepted mobile desk had the Producer.
  - On every section a **Producer & Crate** button in the top bar opens the
    same rail in a modal, full-height `<dialog>`: 390×844 at phone width.
    Tab stays inside it, and Done or Escape puts the rail back and returns
    focus.
  - The desk heading's **Crate** button opens the same sheet on the Crate tab.
- **Context.**
  - **Away from the desk:** on Library, Activity and Engine, and on the
    Arrangement surface, a line says the Producer and Crate act on the
    Performance desk. The Crate then repeats the desk's own messages, so Load
    and Separate are never silent.
  - **Arrangement surface:** the Arrangement has its own Producer on the page,
    so the desk Producer's controls step aside behind a note. Its idea and
    Undo are kept and return on Performance or on any other section. One
    page never shows two Producers' Hear it buttons.
  - **Library changes:** the Crate re-reads `/api/crate` (debounced, once
    opened) when the Library slice changes, for example after a rename,
    import or delete made in Library.

## Evidence

`tests/browser/never_lose_the_mix.js`: a real Studio, real Chromium and two
complete Demucs tracks. Its desktop journey runs at 1280×800, followed by a
390×844 phone journey. Result: 25/25.

| Check | Result |
| --- | --- |
| Setup | A and B loaded (8 lanes). Then: A·Vocals −9 dB, B·Bass −4 dB, Group A −3 dB, crossfader 72, Mute A·Drums, Solo B·Vocals, Play. An Arrangement clip is brought in, moved one step and moved again; one move is undone, so Redo is available. |
| A1 | Library, Activity, Engine: the same desk DOM node (tagged), hidden |
| A2–A4 | Banks, lanes, track ids, every range value, mute and solo identical after Studio → Library → Activity → Engine → Studio |
| A5 | Transport kept advancing; Stop enabled |
| A6 | `AudioContext` made 1, closed 0 |
| A7–A9 | Same Arrangement instance (tagged); clips, edit and selection identical; Undo/Redo depths identical and still walkable |
| A10 | No arrangement write during navigation |
| A11 | 0 animation frames in 1 s on Engine with the Studio stopped |
| B1 | Sidebar 230 px; strips ≥ 113 px |
| B2–B3 | Hear it in Studio, Keep it from Library, Undo offered on Activity, Undo in Studio returns the pre-idea mix |
| B4 | The desk Producer steps aside on the Arrangement surface |
| B5–B6 | Hide → 44 px, wider strips, still hidden after navigation; reopen keeps the Crate tab, the search "paper" and the open row |
| B7 | Still one AudioContext |
| B8–B9 | 390×844 on all four sections: top-bar entry, 390×844 modal sheet, Tab trapped, focus returned, rail back home, no AudioContext, no horizontal scroll |

Unit tests:

- `router.test.js`: keep-alive mount, hide and show order, sub-hash and
  stop.
- `stem-desk-panel.test.js`, tests named `Shell: …`:
  - one rail in the shell, and Hide/reopen keeping the search and open row;
  - an idea kept from another section, with the pending dot;
  - the Arrangement step-aside;
  - the sheet move and focus return;
  - narrow inline placement.

## Static size

Measured against `0c1bda7`: 1,504,870 bytes in 100 files before, 1,528,278
bytes in 102 files after. That is +23,408 bytes and +2 files.

| File | Bytes |
| --- | --- |
| New: `js/components/workspace-sidebar.js` | about 10 KB |
| New: `styles/workspace.css` | about 5 KB |
| `js/router.js` (keep-alive) | +3,545 |
| `stem-desk-panel.js` (rail host, inline slot, Producer step-aside) | +2,030 |
| `js/app.js`, `views/studio.js`, `index.html` | +2,603 |

Nothing was minified and no dependency was added.

## Limitations and risks

- **Refresh, restart or a closed tab still lose the desk and an unsaved
  Arrangement.** This is a navigation fix only.
- **Memory.** The Studio stays mounted, so its decoded PCM stays in memory
  while you browse. This is the same memory the open Studio already held,
  within the desk's existing 320 MiB and the Arrangement's limits. Unload or
  New frees it as before.
- **The Studio mounts at boot even when the first page is Library.** That
  means its usual read requests: track list and jobs. No AudioContext is
  made until a load (desk) or Play (Arrangement).
- **Off-Studio Load.** Load and Separate from the Crate on another section
  act on the hidden desk. A load still stops playback, by the desk's own
  rule. The Crate says what happened, but the strips are not on screen.
- **Playback continuity is not a listening acceptance.** Audio continuing
  under navigation is measured by the transport clock. The PM should
  confirm it by ear.

## Product requirements recorded for the next phase (Phase C)

These are recorded, not built. What exists today and what each one needs:

| # | Requirement | Today | Depends on |
| --- | --- | --- | --- |
| 1 | Arrangement Cut, Copy, Paste, Delete, Split, Stretch | Delete (Del), Split at playhead (S), Duplicate (Ctrl+D), Fit to project tempo / manual speed exist as `EditEngine` commands. There is no clipboard: no Cut, Copy or Paste. | A clipboard of clip descriptors (asset ref, offsets, length, stretch) pasted through `EditEngine.run` as one undoable batch; a paste position rule (playhead, selected lane) |
| 2 | Individual stem BPM, pitch-preserving | The Arrangement already stretches per clip with Signalsmith (pitch kept). The Performance desk plays at ratio 1 and never claims beat matching. | For the desk: a per-lane or per-bank stretch node on the one desk context, and new decode/latency budgets. A new acceptance by ear. Must not imply beat matching. |
| 3 | Expandable Library tracks listing separated stems | The Library view lists tracks only; stems are in `/api/tracks/{id}/stems` and the Crate's `stems` summary | A Library row expander reading the existing stems route; no schema change |
| 4 | User-assigned stem names, keeping source attribution | Stem sets have fixed roles (vocals, drums, bass, other), plus `method` and `model_name`; there is no per-stem label | A stem label column (migration) with rename semantics matching track `display_name` (200 characters, no blank). Role, method, model and source stay immutable and shown beside the label. |
| 5 | Reuse stems in other projects | Stems are Library-wide: any Arrangement can reference `/api/stems/{set}/audio`, and the desk loads any Library track | An explicit "use in project" path from Library or the Crate into the Arrangement import; needs #3 |
| 6 | Search tracks and stems by their own and original source names (Library, Arrangement, Crate) | `/api/crate` delegates `q` to the track listing: `COALESCE(display_name, original_name)` and `metadata_json`. Stems are not searchable. | Needs #4. A stem search index (label, role, parent track names, source title) exposed through `/api/crate` and reused by the Library and Arrangement pickers |
| 7 | Accurate stem readiness in every surface | `/api/crate` `stems.status` is authoritative (quad, center_sides, partial, none). The desk and the Arrangement import compute readiness from per-track stem listings. | Make the Library view and the Arrangement import read the same projection or the same `completeQuad` rule, with one shared readiness label |
| 8 | Explicit source start/end for a Demucs request (e.g. `00:00:34`–`00:02:04`) | `submit_separation(track_id, method)` separates the whole file. The desk's 30/60/90 s sections are cut at load, not at separation. | A request `{start, end}` validated against the file (sample-index cut as the section route does). A stem set recording its source span. Readiness and desk loading that understand a partial-span set. Lane labels naming the span. |

Coordination: no OpenCode investigation artifact for these was found in the
repository's worktrees on 2026-11-26. This table is written to be handed to
that investigation, which should confirm the dependencies against its own
findings before any of them is built. Items 4 and 8 change the schema; the
others need none.

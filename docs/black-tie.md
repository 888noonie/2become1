# Black Tie control room

The two reference branches share e81edfa. Black Tie starts from 24b5390 and carries over the Silk Tie dialog focus, labelled controls, proposal details and responsive Library work. The musical runtime and API come from the accepted listening branch.

In the rendered Silk Tie Studio the queue occupied a full column, preparation repeated three equal-weight actions per source and Producer appeared between transport and the channel rows. The two rendered studies compared a light editorial desk with a deep-green control room. The control room leaves the brightest areas for signals and actions. Copper and aqua identify the two sources. The fine concentric grooves are a static engraving, independent of audio.

Load a source from each track selector. Sources & section opens library acquisition, processing, external stems and section controls. Each bank exposes four channel strips when four stems are available. Transport and Producer share the desk. Arrangement & rendering opens the two-deck editor. Queue & advanced mixing opens the queue, commands, EQ and looping.

The isolated owner demo uses the prepared Midnight Circuit and Paper Lanterns fixture. To replay the capture suite, run the Studio against the isolated data directory and pass its URL and an output directory to tests/browser/black_tie_ux.js.

The first render exposed a collapsed desktop desk caused by flex cross-axis sizing. The refinement stretched the desk across the workspace, added engraved empty banks and replaced round desktop gain thumbs with calibrated fader caps. Mobile keeps horizontal gain travel.

Static payload totals 783,688 bytes in 72 files, up 21,938 bytes from the musical base. The added files are the shared stem desk and console styles. The largest files are stem-desk-panel.js, ghost-controller.js, live-mixer.js, stem-desk.js and styles/studio.css. No runtime dependencies or external font requests were added.

## Maintaining the accepted interface

The PM visually inspected, operated and accepted the interface at `e53b266`. Keep performance first. A visitor should be able to select two sources, see both loaded channel banks and reach transport on a desktop without paging through acquisition, queue or render settings. Preserve the bank identity in labels as well as colour. Use the shared copper A, aqua B, action and focus tokens in `studio.css`. Keep console layout in `styles/console.css` and reuse the labelled controls in `styles/components.css`.

Keep native selects and ranges operable by keyboard. Maintain focus during lane updates and return it to the opener on dialog dismissal. Verify the visible Mute and Solo state against the accessible pressed state. Measure each switch at its rendered size, including intermediate tablet widths. Stack the two switches inside a narrow strip so each retains a 44 × 44 CSS pixel target. On phones, preserve horizontal fader travel.

Presentation consumes the existing desk state. The shared clock, lane and group gains, decoded-memory limits and source provenance belong to the audio implementation. Preview shows proposed changes. Reject leaves the mix intact. Only explicit approval may apply a validated proposal, and playback requires its own user action. See [audio and proposal contracts](../AGENTS.md#stem-performance-desk-two-tracks-eight-lanes).

From the checkout root, run the browser capture against a second loopback Studio with two prepared four-stem tracks and isolated storage:

```sh
node tests/browser/black_tie_ux.js "$capture_dir" "$demo_url"
```

Inspect the actual empty and loaded desk, proposal preview, acquisition dialog and focus captures. Compare the central instrument at 1440×900 and 1280×800, inspect tablet switch sizes and follow both banks at 390×844. Exercise a refused reload with eight lanes already present. Pair the visual review with the [prepared musical journey](for-your-ears-only.md). Record the candidate revision, findings and fixes. Automated accessibility results, independent engineering review and the PM's visual acceptance are separate evidence.

## Draw levels (Black Tie Encore)

Draw levels (the toolbar chip or G) lifts each lane's gain curve above its clips and holds the clips still, so a levels gesture can never move, trim, slip or fade a clip. Escape or G returns to clip editing; Escape leaves the mode without stopping playback. G does nothing while a text field, select or another panel has focus.

A new point lands on the Snap grid and a pointer-placed level is stored in tenths of a dB, with a detent on the fader; Alt places either freely. A press that does not travel only selects a point. A drag snaps the beat only once the pointer moves sideways, and one drag is one undo step. On touch, an empty-lane tap adds a point when the finger lifts without travelling, and a point drag the browser cancels for a pan is taken back. Keyboard: arrows move the focused point by the Snap step and 1 dB, Shift gives 1/16 beat and 0.1 dB, and Delete moves focus to the nearest remaining point. Phones and coarse pointers get 44 px point targets around the same small dot.

Positions in the inspector, point labels and announcements read as bars and beats ("bar 4, beat 2½"); off-grid positions keep three decimals. Levels are said against the fader ("-9.0 dB, 3.0 dB under the fader"). The transport counter keeps its bar · beat · tick display.

The Producer's four-bar entrance is dashed and labelled "Idea · not playing" before Hear it, and "Idea · playing, not kept" while it sounds. A hand edit, Keep or Reject removes the mark. A hand edit retires the pending curve, so the Producer can't write it back. Draw levels changes presentation and edit gestures only. The automation scheduler, live and offline gain, ProjectState and the stored point format are unchanged. Real-browser coverage: `node tests/browser/black_tie_encore.js <studio-url> <out-dir>`.

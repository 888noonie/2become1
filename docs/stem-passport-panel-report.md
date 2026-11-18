# Stem Passport Panel Report

Branch: `q/stem-passport-panel-001`
Base: `00d81bceb81fe0fa5ed85488ce1bc367831f5718`
Scope: the Stem Desk panel's readiness, Add / Process Track, and provenance
behaviour for imported (bring-your-own) separated stems.

## What changed

`src/twobecomeone/studio_static/js/components/stem-desk-panel.js`

1. Added `completeQuad(variants)`: it returns the four lanes named `vocals`,
   `drums`, `bass`, `other` when each has method `demucs` or `imported`, and
   `null` otherwise. `demucsQuad` is kept unchanged for cases that genuinely
   mean Demucs, and is still used for Demucs-specific wording.
2. Readiness now uses `completeQuad`:
   - `reportReadiness` reports a complete imported quad as
     "Four imported stems are ready for <track>. Load <group> to play them."
     A complete Demucs quad keeps the existing "Four Demucs stems..." message.
   - A partial imported set (for example three lanes) is not ready and says
     "has 3 of 4 imported stems. The imported set is incomplete; ...".
   - The separation-complete and post-import paths also accept/describe a
     complete quad by its actual method.
3. Add / Process Track (`onAdd`) and the add-picker handoff
   (`receivePickedTrack`) use `completeQuad`. A complete imported quad opens
   the add picker and never calls `submitSeparation`; a track without a
   complete quad keeps the old Demucs request path.
4. Provenance for method `imported` is exactly
   `imported · set <first 8 chars of model_name>`. It does not append a
   device or a stem set id, and it never says or implies Demucs. The `demucs`
   and `ffmpeg` provenance strings are unchanged.
5. Nothing else was touched: mute/solo/gain, group levels, crossfader, entry
   nudge, the single load-slot reservation, disposal, status messages for
   non-imported paths, and the read-only API boundary are unchanged.

`tests/frontend/stem-desk-panel.test.js`

Added three tests (plus a shared `IMPORTED_QUAD` fixture):

- (a) a complete imported quad is reported ready and never requests a
  separation, including when Add / Process Track is pressed;
- (b) imported provenance renders `imported · set a1b2c3d4` for every lane,
  shows no full hash, and makes no `demucs` claim;
- (c) three imported lanes without the fourth are not ready and the status
  says the imported set is incomplete.

Existing panel tests were left in place and still pass.

## Commands and results

Run from the worktree root on Node v26.13.1:

```
$ node --test tests/frontend/stem-desk-panel.test.js
...
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 111.612889
```

```
$ git diff --check
(no output, exit 0)
```

After staging (see the commit step): `git diff --cached --check` produced no
output. After the commit: `git diff --check <base>..HEAD` produced no output.

## Actual sample measurement

Fixture: four imported variants, hash `a1b2c3d4e5f60718`.

- The panel rendered each lane's provenance as `imported · set a1b2c3d4`
  (23 characters: 8 for `imported`, 3 for ` · `, 4 for `set `, 8 for the hash
  prefix). The full 16-character hash did not appear.
- Case-insensitive `demucs` occurrences in the loaded lane region: 0.
- `submitSeparationImpl` calls after Add / Process Track on that quad: 0.
- Partial fixture with three imported lanes: readiness message contained
  `3 of 4 imported stems`, contained `incomplete`, and did not contain
  `are ready` or `demucs`.
- Test counts: 38 tests total, 38 passed, 0 failed (35 pre-existing tests plus
  3 new ones).

## Limitations

- `jsdom` is not installed in this worktree and the permitted command set does
  not include `npm install`. To execute the required `node --test` command, a
  minimal DOM shim was placed at `node_modules/jsdom` (gitignored, not
  committed). It implements only the DOM surface these tests use; the
  committed source and tests are unchanged by it. A normal checkout with
  `npm install` will run the same suite against real jsdom.
- The panel still only reads stems. It does not import, write, or re-separate
  files; it trusts the `GET /api/tracks/{id}/stems` contract for `method` and
  `model_name`.
- Imported identity is displayed with the first 8 characters of the set hash,
  so two different sets can share a visible prefix; the full hash remains in
  the API payload.
- `completeQuad` accepts a quad whose lanes are a mix of `demucs` and
  `imported`, per the contract wording. Such a mixed quad is reported as
  "Four isolated stems" rather than claiming either provenance.
- No worker/subagent sessions were used; there are no worker session ids to
  report.

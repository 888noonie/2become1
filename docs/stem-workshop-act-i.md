# The Stem Workshop, Act I — identity, sections and tempo

Starting point: `feature/never-lose-the-mix @ edc5083`. This act implements one
bounded backend capability — **owner-chosen stem display names** — and records
the exact contract for the two larger capabilities (precise Demucs sections and
independent stem tempo) without implementing them.

Backend only. No frontend, Arrangement editor, merge, push, live-data change or
new dependency.

## 1. Implemented: a stem display name on its existing identity

### What a stem already is

A separated stem has one identity: `(stem_set_id, role)`.

- `stem_sets` is the audio set (one row per content hash + method + model).
- `paths_json` maps each role (`vocals`, `drums`, `bass`, `other`, `center`,
  `sides`) to its file under `stems/<set>/`.
- `provenance_json` keeps an imported set's original per-lane filename and hash.
- The audio route is `/api/stems/{stem_set_id}/audio?name=<role>`, and the
  Arrangement stores that URL as `bufferReference`.

There was no place for a human label. The role token cannot be replaced: it is
the path key, the audio query key and the mixer lane identity.

### The smallest safe addition

Migration **14** adds one nullable column:

```sql
ALTER TABLE stem_sets ADD COLUMN names_json TEXT;
```

`names_json` is `{"vocals": "Lead Vocal", ...}` or `NULL`. There is no new
table, no new catalogue, no backfill, and no unique index. Keeping the label on
the set is what makes it reusable: every project, Crate result and future search
that references the same set + role sees the same name.

`stem_crate_items` is deliberately untouched. It remains the loop-region
catalogue (`label`, region, gain), not the stem's identity.

### Contracts

**`GET /api/stem-sets/{stem_set_id}`** — the identity card:

```json
{
  "stem_set_id": "<set-id>",
  "track_id": "<original-track-id>",
  "track_name": "Paper Lanterns",
  "source_kind": "local",
  "bpm": 95.1,
  "bpm_source": "measured",
  "method": "imported",
  "model_name": "sha256:<set-hash>",
  "device": "user",
  "status": "complete",
  "created_at": 1760000000.0,
  "stems": [
    {
      "name": "vocals",
      "display_name": "Lead Vocal",
      "custom_name": true,
      "audio_url": "/api/stems/<set-id>/audio?name=vocals"
    }
  ]
}
```

- `track_id` and `track_name` are the **original** track that owns the set;
  they do not change when a name changes.
- `bpm` is the track's effective tempo and `bpm_source` is `measured` or
  `entered` (`bpm_override` present). It is read-only source tempo for an
  Arrangement asset's `nativeBpm`; a stem does not get a second tempo.
- `name` is always the role. `display_name` is the label to show.
- `custom_name` is true only when the owner set that label.
- Roles whose file no longer validates are omitted, exactly as `list_stems`
  omits them. No absolute path, media byte or raw metadata is returned.

**`PATCH /api/stem-sets/{stem_set_id}/names`**

```json
{ "names": { "vocals": "Lead Vocal", "drums": null } }
```

- Keys must be roles the set actually contains; an absent role is a 400.
- `null` clears that label; the role becomes the display name again.
- Values use the track-label rules: NFC, control characters removed,
  whitespace collapsed, blank rejected, more than 200 characters rejected
  rather than cut.
- Every key and value is validated before the one `names_json` write, so a
  request naming an unknown role makes no partial change.
- Unknown set: 400 `bad_request`, matching the existing stem routes. Extra
  body fields: 422.
- The response is the same identity card.

**`GET /api/tracks/{track_id}/stems`** — every variant now also carries
`display_name` and `custom_name`. The existing `name`, `stem_set_id`, `method`,
`model_name`, `device`, `audio_url` and imported `provenance` fields are
unchanged. The `full` mix variant reports `display_name: "full"` and
`custom_name: false`.

### What a name does not do

- It never changes `paths_json`, a filename, a set id, the track id, the source
  ref, the method/model, `provenance_json` or a media byte.
- It never copies a WAV and never starts a separation job.
- It is not written into ProjectState. A project that references the set looks
  the name up, so a later rename is visible everywhere instead of freezing the
  old label in one saved arrangement.
- It is asset-level, not a per-project alias. Two projects using the same set
  share the name; two different sets (for example Demucs and imported stems of
  the same song) can name their vocals differently.

### Frontend follow-up (Claude's surface, not edited here)

1. To show a stem name in Arrangement, parse the set id from the asset
   `bufferReference` and call `GET /api/stem-sets/{id}`; do not persist the
   name into `ProjectState`.
2. Keep using `name` for audio URLs, DSP lane identity and mixer addressing.
   Show `display_name` only as text.
3. Rename with the PATCH route; send `null` for "use the role again".
4. Treat `bpm_source: "entered"` as an entered tempo, never as measured.
5. If a set has no valid files, the role is absent; do not invent it.

## 2. Recommended next: precise Demucs sections

### Today

`POST /api/tracks/{id}/separations` accepts only `method`. `_run_separation`
passes the whole track file to `separator.separate`, and the cache key is
`(track_sha256, method, model_name)`. `stem_audio_window` already cuts
sample-accurately for playback, but that happens after separation.

### Recommended contract

1. Extend the separation body with optional absolute source timecodes:

   ```json
   { "method": "demucs", "start_sec": 34.0, "end_sec": 124.0 }
   ```

   - Require `start_sec < end_sec`, both finite, `end_sec <=` the probed source
     duration, and a minimum useful length (1 s is a reasonable floor).
   - Do not also accept `duration_sec`; derive it from the two values, so the
     request cannot disagree with itself.
   - `start_sec` is the source sample index `round(start_sec * sample_rate)`,
     using `_probe_audio_layout`; this matches the existing section route.

2. Cut before Demucs, server-side, with ffmpeg:

   ```text
   atrim=start_sample=<first>:end_sample=<last>,asetpts=PTS-STARTPTS
   ```

   Preserve the source sample rate and channel count; choose a PCM width that
   holds the source samples (the existing `_window_pcm_codec` logic). Write a
   seekable temp WAV and pass that file to `separator.separate`. Never send the
   timestamps to Demucs as if it understood them.

3. Migration **15**:

   - `stem_sets.segment_key TEXT NOT NULL DEFAULT ''`
   - `stem_sets.segment_json TEXT`
   - drop and recreate `idx_stem_sets_cache` as
     `(track_sha256, method, model_name, segment_key)`.

   `segment_key` is canonical, for example `1701000-5468400` (sample indices),
   and `''` means the whole recording. Without this, a full-track set would be
   returned for a section request, or a section would poison the full cache.

4. `segment_json` holds:

   ```json
   {
     "start_sec": 34.0,
     "end_sec": 124.0,
     "start_sample": 1499400,
     "end_sample": 5468400,
     "source_sample_rate": 44100,
     "source_sha256": "<track content hash>",
     "reused_from_full_set_id": null
   }
   ```

   `NULL` means the whole recording. This is the explicit distinction between
   "these stems are the whole song" and "these stems are a segment"; a file
   length alone is not that distinction.

5. Reuse instead of rerunning Demucs, in order:

   - Exact `(hash, method, model_name, segment_key)` cache hit: reuse.
   - Otherwise, if a whole-recording set for the same `(hash, method, model)`
     exists and every lane validates, cut the requested span from each stem
     with the same ffmpeg rule, publish a new set (`method` and `model_name`
     unchanged) and record `reused_from_full_set_id`. No model call.
   - Only otherwise run Demucs on the cut input.

6. Source-relative timing: a segment's local 0 is its own first sample. The
   client must map it to the source with `segment.start_sec`. In Arrangement,
   that means an asset field such as `sourceStartSec` (or storing the segment
   start on the asset), while `clip.sourceOffsetSec` stays local to the asset.
   Do not silently rewrite offsets; a section placed at the wrong absolute time
   is a musical error, not a rounding detail.

7. Tests worth writing: the fake separator receives only the cut length; exact
   segment cache hit makes no model call; a full set serves a section by cutting
   its stems; `segment_json` survives reopen; the cache key does not collide
   with the whole recording; `start >= end` and `end > duration` are refused;
   `GET /api/stem-sets/{id}` reports `segment` and `is_full_recording`.

Padding silence before `start_sec` was rejected: it preserves absolute timing
without client changes, but it forces Demucs to process silence, inflates the
files and still needs a marker to say the leading audio is padding. Explicit
segment metadata is smaller and honest.

## 3. Recommended next: independent stem tempo

### The engine already exists

- `src/twobecomeone/studio_static/vendor/signalsmith-stretch` is a vendored
  pitch-preserving time-stretch WASM.
- `StretchFactory` is used by the accepted offline bounce
  (`js/arrangement/offline-render.js`) and by the real-time engine. There is one
  routing predicate, `clipNeedsDsp` in `js/arrangement/time-math.js`.
- No new dependency and no server-side DSP is needed.

### The accurate representation

| Concept | Field | Rule |
| --- | --- | --- |
| Source tempo | `asset.nativeBpm` | Track effective BPM; `bpm_source` says measured vs entered. Unknown stays `null`. |
| Target tempo | `transport.masterBpm` | Project tempo. |
| Fitted rate | `stretchMode: "beat_sync"` | `sourceAdvanceRate = masterBpm / nativeBpm`. |
| Manual rate | `stretchMode: "manual"`, `customStretchRatio` | Same convention. |
| Rate meaning | `sourceAdvanceRate` | **Source seconds consumed per output second.** Output duration multiplier is `1 / rate`. This is not `playbackRate`. |
| Pitch | `pitchSemitones` | Factor `2 ** (semitones / 12)`, independent of rate; `preserveFormants` available. |
| Bypass | `clipNeedsDsp(rate, pitch)` | Only rate exactly 1 and 0 semitones bypass the DSP. |

`stretchMode: "beat_sync"` already refuses to operate when `nativeBpm` is null
(`BEAT_SYNC_UNAVAILABLE`). The measured priming range is 0.857–1.2; a rate
outside it still plays and is reported as `STRETCH_UNQUALIFIED`, not refused.

### What not to do

- Do not use `AudioBufferSourceNode.playbackRate` or `preservesPitch` for
  musical time-stretch: it is not the accepted engine, and rate changes pitch
  when pitch preservation is off.
- Do not resample or pre-stretch WAVs on the server; that copies media and
  freezes one target tempo into the library.
- Do not add a per-stem BPM column. A stem inherits its recording's tempo; the
  target tempo and the resulting rate are properties of the clip in a project.
  A per-stem BPM would duplicate ProjectState and invite two truths.
- Do not call a changed speed "pitch-preserving" unless the Signalsmith path is
  active.

### Missing piece

`ProjectState` has no `sourceStartSec` for a stem segment. Add it with the
section work (#2) in Claude's editor: an asset made from a segment reports its
absolute source start, and `clip.sourceOffsetSec` remains relative to that
asset. Everything else needed for independent tempo is already in the accepted
Arrangement.

## 4. Evidence

```bash
PYTHONPATH=$PWD/src .venv/bin/pytest \
  tests/test_stem_names.py -q
# 16 passed

PYTHONPATH=$PWD/src .venv/bin/pytest \
  tests/test_stem_names.py tests/test_stem_import.py tests/test_contracts.py \
  tests/test_track_names_and_sections.py tests/test_phase14b1_stem_crate.py \
  tests/test_phase10a_lifecycle.py tests/test_phase14c_stem_stack.py \
  tests/test_phase9a_actions.py -q
# 153 passed
```

The stem-name tests cover: the label attaches to `(set, role)`; the role, paths,
filenames, hashes and audio bytes stay identical; a later write does not replace
an earlier name; `null` clears; names survive reopening; an unknown role or bad
value makes no partial write; an absent media file is not advertised; a corrupt
`names_json` falls back to the role; migration 14 upgrades an existing database
without touching its sets; the HTTP PATCH/GET/list/audio paths; 400/422 refusals.

A disposable negative control made `set_stem_names` write `NULL` instead of
the submitted labels (never committed). It failed 6 of the 16 tests, including
the role/label mapping, persistence across reopen, the migration upgrade and the
HTTP round trip. The file was restored with `cmp` confirming an exact match, and
the suite returned to 16 passed. This proves the tests depend on the write, not
only on the response shape.

No live data was touched, no full-suite run was needed, and nothing was merged
or pushed.

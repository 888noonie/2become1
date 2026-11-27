# The Stem Finder, Act I — renamed stems in the Library catalogue

Starting point: `review/stem-names-senior @ 6a93b13` (parent `49340be`).
Feature branch: `feat/stem-finder`. Backend only.

The owner can now search a stem's own label, its role token, or its source
recording and find the stem through the existing Library and Crate search. The
result is still one row per track; the matching stems travel with their source
track. No second catalogue, no new endpoint, no new table, no audio copy and no
Arrangement or playback change.

## Contract

`GET /api/tracks` and `GET /api/crate` keep their existing query parameters:
`q`, `limit`, `offset`, `status`, `sort`, `source`. Both still return
`{items, total, limit, offset}`.

When `q` matches at least one **validated** stem in that response, every item
also carries:

```json
"match": {
  "track": false,
  "stems": [
    {
      "stem_set_id": "<set-id>",
      "role": "vocals",
      "display_name": "Lead Vox",
      "custom_name": true,
      "available": true,
      "method": "imported",
      "audio_url": "/api/stems/<set-id>/audio?name=vocals",
      "matched": ["label"],
      "track_id": "<original-track-id>",
      "track_name": "Paper Lanterns"
    }
  ]
}
```

- `match.track` is the existing track-name/metadata match.
- `match.stems` lists validated `(stem_set_id, role)` assets that matched.
- `matched` is one or more of `"label"`, `"role"`, `"track"` (the source
  recording's display name).
- `display_name` is the owner's label when set, otherwise the role token.
- `available` is true only after the file resolves beneath `stems/`.
- `track_id` / `track_name` identify the original Library track.
- `audio_url` is the existing stem audio route; no absolute path is returned.

If no validated stem matches, the response is exactly the old shape: no
`match` key. A track-name search for a recording with no stems, or a search for
nothing, is unchanged.

### Not returned

`paths_json`, `names_json`, `provenance_json`, `content_sha256`, raw metadata,
absolute media paths, and the underlying file names. The stem-match object has
a fixed ten-key shape (see `tests/test_stem_finder.py: STEM_MATCH_KEYS`).

## Matching rules

A stem match requires all of:

1. The set row is `status = 'complete'`.
2. The role is one of `vocals`, `drums`, `bass`, `other`, `center`, `sides`.
3. The role has a path in `paths_json`.
4. That path resolves to a real file beneath the managed `stems/` root.
5. At least one of these contains the query, case-insensitively:
   - the owner's custom label for that role,
   - the role token,
   - the source recording's display name.

`paths_json` that cannot be parsed as an object yields no stems, so a corrupt
row cannot manufacture a match. A label whose file was deleted is not
advertised; the source track can still be found by its own name.

Each validated set is scanned, not only the set the desk currently selects.
That is deliberate: renaming a stem on an older Demucs or imported set must
still make it discoverable.

## Pagination and counts

The page is a union of:

- tracks whose own name/metadata match (the existing predicate), and
- tracks that own at least one validated matching stem.

The union is ordered by the requested `sort` once, then sliced by track. `total`
is the number of **distinct tracks**, so a track with four matching stems is one
result and one count. `match.stems` may hold several entries for that one row.

`status` and `source` filters apply to both sides of the union: a trashed
track's stems appear only under `status=trash` or `all`, and a `source=youtube`
search does not return a local stem match.

There is no separate stem pagination. A frontend may flatten `match.stems`
across the current page for a "Stems" strip, but must not add those entries to
`total`: the Library's pagination remains track-authoritative.

## Crate

`GET /api/crate` passes the same `match` object through on its item. The existing
track-level readiness summary (`stems.status`, `stems.roles`, `actions`, …) is
unchanged and is not the search match. A Crate row for a track with two matching
stems is still one row.

## Frontend handoff (Claude's surface, not edited here)

1. When `item.match` exists, render its `stems` beneath the track result;
   `match.track` says whether the recording itself matched.
2. Use `(stem_set_id, role)` as the asset identity, `display_name` as text and
   `audio_url` for audition or loading. Never use `display_name` as a file path
   or a mixer lane id.
3. Show `track_id` / `track_name` as provenance; a stem-only match is still a
   result about its source recording.
4. Do not count `match.stems` toward `total`, and do not persist the label in
   project state — the name is looked up live.
5. For Arrangement, build an asset from `audio_url`; fetch
   `GET /api/stem-sets/{id}` for the source `bpm` / `bpm_source` (the identity
   card from the previous act). No Arrangement editor file was changed.
6. A missing file never appears in `match.stems`; no extra availability check
   is needed in the UI.

## Evidence

```bash
PYTHONPATH=$PWD/src .venv/bin/pytest \
  tests/test_stem_finder.py -q
# 17 passed

PYTHONPATH=$PWD/src .venv/bin/pytest \
  tests/test_stem_finder.py tests/test_stem_names.py tests/test_stem_import.py \
  tests/test_crate.py tests/test_studio.py tests/test_phase3_http.py \
  tests/test_media_imports.py tests/test_track_names_and_sections.py \
  tests/test_phase40.py tests/test_contracts.py -q
# 134 passed
```

`tests/test_stem_finder.py` covers: a renamed stem is found by its new name;
the original track id/name/source/size survive; a source-name search reaches
stems; clearing the label restores the role; two similar labels and two sets
with the same role stay distinct; a track with several matching stems counts
once; limit/offset pages never repeat a track; status/source filters and sorting
still apply; a deleted file and malformed `paths_json` produce no stem match;
the ordinary Library listing and track search keep their shape; Crate readiness
and `match` coexist; the HTTP routes expose the same object; the stem match is a
fixed shape with no paths or hashes.

A disposable negative control disabled custom-label matching in
`_stem_search_matches` (never committed). It failed **13 of the 17** tests,
including every label, pagination, Crate and HTTP case. The file was restored
with `cmp` confirming an exact match, and the suite returned to 17 passed.

## Limits stated at delivery

- Matching is case-insensitive substring matching, consistent with the Library
  search; no fuzzy matching or typo correction.
- A query with no stem match keeps the old response shape exactly; `match`
  appears only when at least one validated stem matched somewhere in that
  response.
- The search validates the complete stem sets of the filtered Library to prove
  availability. That is correct for a local owner library; it is not a
  full-text index and does not add a table or a background job.
- No frontend, no Demucs ranges, no DSP or playback change, no new migration.
- No production data was touched, and nothing was merged or pushed.

# Operation For Your Ears Only — real-music acceptance (2026-11-19)

Owner workstream: demonstrate the current AI Producer DAW with actual music,
through the full current workflow (Library, naming, sections, eight lanes, entry
nudge, AI Producer approval), rather than silence or a stationary tone.

Branch `feature/for-your-ears-only`, base `feature/the-name-is-bond @ 7e38df5`
(which contains the Stem Passport import, the approved-proposal desk, naming,
and the section work). Isolated worktree `/tmp/opencode/for-your-ears`.

## Source material

Two original arrangements are synthesised by
`tests/browser/for_your_ears_fixture.py`. They are not licensed recordings; they
are original so there is no rights question. Each is built as four aligned parts
with one common gain, and the mix is their sum. The identity is exact before
export; after 16-bit quantisation the stored mix and the four stored stems can
differ by a few least-significant bits.

| Track | Key / tempo | Length | Full stem decoded at 48 kHz | Over the 40 MiB ceiling |
| --- | --- | --- | --- | --- |
| Midnight Circuit | A minor, 96 BPM | 180.0 s | 65.9 MiB | yes |
| Paper Lanterns | E minor, 84 BPM | 171.4 s | 62.8 MiB | yes |

That is the point of the length: a full-length eight-lane load would be refused
by the ordinary per-stem ceiling, so the demonstration exercises the default
section path rather than switching on the opt-in 1024 MiB full-length mode.

Measured content, not a stationary tone: beat autocorrelation recovers 96.8 BPM
and 83.3 BPM; each stem carries independent musical content (drums, bass, pad and
arp, formant-shaped lead) and the mix peak is 0.700 with every stem between
−24 dB and −29 dB RMS.

## What the owner can do

1. **Library** shows *Midnight Circuit* and *Paper Lanterns*. Import the whole
   mix as the library track, then attach the four already-separated parts
   through **Import My Stems**. The import path itself starts no separation job
   and no model call. The demo seed also suppresses the *upload route's*
   automatic separation hook, because the four parts already exist; a normal
   Studio upload still queues that hook.
2. **Rename** a track from the Library. The label is stored in
   `tracks.display_name`; the original filename and media path do not move.
   The rename survives a page reload and a server restart.
3. **Stem Desk** loads group A and group B as 60 s sections (start 60 s). The
   default selection is *90 seconds*, and *Full length* is an explicit opt-in.
4. Eight lanes load on one 48 kHz clock with honest `imported · set …`
   provenance. Mute, solo and per-lane gain are independent; the entry nudge
   moves a whole group in signed 10 ms steps and is announced on Play.
5. **AI Producer**: Ask for a proposal → Preview (changes nothing) → Reject
   (changes nothing) or Approve (applies only the permitted controls).

The current AI Producer is the deterministic `suggestStemDeskProposal`: A keeps
drums and bass, B keeps vocals and other, silent lanes stay muted, entry offsets
stay 0. It is not a model call.

## Evidence

| Gate | Result |
| --- | --- |
| Python suite | **630 passed, 1 skipped** |
| Frontend suite | **569/569** |
| Mission audio/memory gate | **20/20** |
| Mission owner journey | **20/20** |
| Two-track desk UI / PCM | **24/24** / **8/8** |
| Single-desk UX | pass |
| Stem Passport audio / journey | **9/9** / **15/15** |
| Desktop / mobile journeys | 39/0 · 39/5 (the five known moderate a11y findings, 0 serious) |
| Static assets | 761,750 bytes / 70 files, +110,845 (+17.03%) |

### Audio and memory (60 s sections, 48 kHz)

- Eight lanes load on one clock; every lane carries a real signal (no lane at or
  below −50 dB).
- Decoded accounting: **184,320,000 bytes (175.8 MiB)** for eight 60 s stereo
  lanes, i.e. 8 × 60 × 48,000 × 2 × 4, under the ordinary **320 MiB** desk
  budget. The 1024 MiB allowance is only the explicit full-length constant.
- Eight-lane render: RMS **0.1006**, peak **0.784**, inside full scale.
- Approved arrangement rendered to 48 kHz stereo: 61 s, peak 0.565, RMS
  −23.2 dB, energy across the low/mid/high bands.
- Unload one group frees exactly its half (184.3 → 92.2 MB, 8 → 4 lanes);
  reloading restores eight lanes.

### Source/window alignment

A 60 s section at start 60 s is **byte-exact** against the full stem at the same
sample offset (44.1 kHz, 2 ch, 16-bit, 10,584,000 payload bytes). It keeps the
source rate, channels and sample width. The cut is written to a
seekable temp file, so ffmpeg emits a normal header: `RIFF size = len − 8`, a
real `data` size, and the word-alignment pad an odd data chunk needs. Before
this mission the piped output carried `0xFFFFFFFF` sizes (a 30 s cut read as
24,347 s), and an odd-length 24-bit mono cut ended one byte before the chunk
boundary.

### Proposal reject/approve

- Preview: *“Nothing is applied until Approve.”*
- Reject: crossfader stayed at 80, offsets stayed −20/+20 ms, gains and mutes
  unchanged.
- Approve: crossfader **50**, both group levels **0 dB**, both entry offsets
  **0 ms**, every lane gain **0 dB**, and exactly
  `A vocals/other muted, A drums/bass open; B vocals/other open, B drums/bass
  muted`. Approval did not start playback.

### Negative controls

| Case | Result |
| --- | --- |
| declared full-length stem (70 MiB) | refused `S_STEM_TOO_LARGE` before download |
| section length 45 s | refused `must be 30, 60, or 90 seconds` |
| start past the end | refused; the loaded eight lanes stay intact |
| proposal with a soloed lane | refused `clear solo on B:vocals` |
| malformed / out-of-range proposal | covered by the proposal runtime suite |

## Fixes made during the mission

1. **Section WAV header.** `stem_audio_window` wrote ffmpeg's piped output
   unchanged, so the RIFF/data sizes were `0xFFFFFFFF`, and an odd-length data
   chunk lacked the word-alignment pad. Chrome tolerated both, but the declared
   duration was nonsense to `wave` and other tools, and an odd 24-bit mono cut
   ended one byte before the chunk boundary. The cut is now written to a unique
   seekable temp file, so ffmpeg emits the real sizes and the pad; the payload is
   untouched. Regression tests in `tests/test_track_names_and_sections.py`
   cover both the size declaration and the odd-length pad.
2. **Failed reload wording.** A reload whose every lane failed kept the previous
   group but said “Loaded N stems”, and the desk flattened the server's reason
   into “could not be fetched”. The desk now carries the server message, and the
   panel says `Group A could not be reloaded; its existing N lanes are unchanged`.
   Regression test in `tests/frontend/stem-desk-panel.test.js`; the owner
   journey proves the eight loaded lanes survive a refused section.

## Independent review

Codex GPT-6.2 Sol reviewed the branch read-only at three successive heads:

| Head | Verdict | Finding |
| --- | --- | --- |
| `adbbb09` | FAIL | A refused reload that combined a lane failure with a group-level budget refusal had fewer failures than lanes, so the panel still said “Loaded 4 stems”. |
| `0077eea` | FAIL | The header repair left an odd-length 24-bit mono data chunk without the word-alignment pad. |
| `a54c063` | **PASS** | The unlink guard preserves the structured error; no remaining blocking defect. |

Both blocking findings are fixed: the desk records a per-track `committed`
outcome in `state().lastLoad` and the panel uses it, and the section cut is
written to a seekable temp file so ffmpeg emits the real sizes and the pad.
Regression tests were shown to fail on the preceding head and pass here.

## Limits stated

- The two recordings are original synthesised arrangements, not studio
  recordings. They are musical and beat-regular, but they are not a substitute
  for a licensed commercial master.
- The AI Producer is deterministic; it is not a language model and does not
  choose tempo, key, fades or transitions.
- Equal sample rate, channels and duration are checked; musical alignment is the
  owner's responsibility (the import dialog says so).
- The 1024 MiB full-length mode remains opt-in and is not used here.
- No audible acceptance is claimed until the PM listens to the demonstration.

## Reproduce

```bash
cd /tmp/opencode/for-your-ears
PYTHONPATH=$PWD/src .venv/bin/python tests/browser/for_your_ears_fixture.py \
  --out /var/tmp/for-your-ears/fixture
PYTHONPATH=$PWD/src .venv/bin/python tests/browser/for_your_ears_seed.py \
  --data-dir /var/tmp/for-your-ears/demo --fixture /var/tmp/for-your-ears/fixture
PYTHONPATH=$PWD/src node tests/browser/for_your_ears_audio.js \
  --data-dir /var/tmp/for-your-ears/demo --out /tmp/opencode/for-your-ears-evidence/audio
PYTHONPATH=$PWD/src node tests/browser/for_your_ears_ux.js \
  --data-dir /var/tmp/for-your-ears/demo --out /tmp/opencode/for-your-ears-evidence/ux
```

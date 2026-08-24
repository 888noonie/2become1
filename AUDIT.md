# 2become1 — Audit Report & V0.1 Implementation Plan

**Auditor:** GLM (model switch from deepseek-v4-flash)
**Date:** 2026-08-24
**Commit audited:** 5030613

---

## Part 1: Code Audit

### What works (verified)

| Component | Status | Evidence |
|-----------|--------|----------|
| Package scaffold | OK | `uv pip install -e .` succeeds, `twobecomeone` CLI runs |
| BPM detection (basic) | Partial | 100 BPM synth → 100.6, 140 BPM synth → 141.3 (after fix) |
| Key detection (basic) | Partial | C major synth → C major, A minor synth → A minor (after rotation fix) |
| Mash pipeline (E2E) | OK | Synthetic 100/140 BPM tracks → valid WAV output, correct tempo ratio + key shift |
| yt-dlp install | OK | Installed via `uv tool install yt-dlp`, v2026.08.19 |
| git repo | OK | Initial commit 5030613 |

### Bugs found (15 total)

#### Crash bugs (would fail on real use)

**B1. `_build_magnet()` called without `trackers` argument (sources.py:132)**
```python
# Definition (line 81) requires 3 args:
def _build_magnet(info_hash: str, name: str, trackers: list[str]) -> str:

# Call site (line 132) passes only 2:
magnet = _build_magnet(ih, it["name"])  # TypeError at runtime
```
The torrent search command would crash on any TPB hit. DFlash defined `_TRACKERS` but never passed it.

**B2. Archive.org API response shape not handled (sources.py:125)**
`search_torrents` only processes `isinstance(data, list)` responses. Archive.org returns `{"response": {"docs": [...]}}` — a dict — so index=1 silently returns `[]`. Half the torrent backends are dead code.

**B3. `from_youtube` picks the wrong file (sources.py:49)**
`sorted(out_dir.glob("*.mp3"))` returns the alphabetically first MP3, not the most recently downloaded. If `out_dir` contains any pre-existing MP3s, the function returns the wrong file. Should use `max(candidates, key=os.path.getmtime)` or parse yt-dlp's stdout for the actual output path.

#### Correctness bugs (wrong output, no crash)

**B4. BPM halving preference is broken (analyzer.py:89-96)**
The doubling/halving logic iterates `(bpm/2, bpm, bpm*2)` but the loop logic doesn't properly prefer the stronger autocorrelation peak — it uses a 0.9 threshold that's too permissive. The 140 BPM synth track (tb.wav) was detected as 69.7 BPM. Real tracks with strong half-time feels (common in pop, hip-hop) will routinely halve or double.

**B5. `semitones_to_match` ignores musical mode (assembler.py:25-29)**
Only compares tonic pitch classes (`split()[0]`). A minor → C major gets +3 semitones, but these are relative keys sharing the same notes — the shift is musically unnecessary and will sound wrong. Should use the Camelot wheel or at minimum account for relative major/minor relationships.

**B6. `_chromagram` frequency axis is slightly wrong (analyzer.py:116)**
```python
freqs = np.fft.rfftfreq(2 * n_bins, 1.0 / sr)  # uses 2*508=1016
# Should be:
freqs = np.fft.rfftfreq(win, 1.0 / sr)  # uses 1014 (the actual window size)
```
The mismatch (1016 vs 1014) causes a small frequency error (~0.24 semitones at A4). Not catastrophic — the chroma binning rounds to the nearest pitch class — but it's incorrect and will cause occasional mis-binning of frequencies near pitch-class boundaries.

#### Code quality / dead code

**B7.** `field` imported but unused in sources.py:13
**B8.** `_TIMEOUT` defined but unused in sources.py:71
**B9.** `bins_per_oct` parameter in `_chromagram` is never used (analyzer.py:113)
**B10.** `lead_trim_to_anchor` parameter in `build_mash` is never used (assembler.py:83)
**B11.** `from_local` takes an `out_dir` parameter it never uses (sources.py:20)
**B12.** `dataclass` imported but unused in analyzer.py:14 (TrackAnalysis uses it, but `dataclass` is imported at module level and only used once — minor)

#### Documentation bugs

**B13.** README says `.venv/bin/2become1` — the actual entrypoint is `twobecomeone`
**B14.** README uses `2become1` as the CLI name throughout — should be `twobecomeone`
**B15.** argparse `prog="2become1"` in cli.py:57 — displays as `2become1` in help but the binary is `twobecomeone`

### Architecture assessment

The four-layer architecture (source → analyze → align → recombine) is sound. The decision to keep analysis numpy-only (no librosa/torch) for V0.1 is defensible — it keeps the install light and the code transparent. However:

1. **No stem separation** — the most critical gap. Without isolating vocals from instrumentals, a "mashup" is just two full mixes played on top of each other. This is the #1 feature gap for V0.1.
2. **No test suite** — DFlash tested with ad-hoc synthetic scripts in /tmp. There are no committed tests. Any refactor risks silent regressions.
3. **No error handling** — every subprocess call will raise an unhelpful RuntimeError on failure. No try/except, no user-friendly messages.
4. **No logging** — no way to debug what the pipeline is doing on real tracks.
5. **No configuration** — hardcoded sample rates, gains, filter parameters. No way to tune without editing source.

---

## Part 2: V0.1 Implementation Plan

### V0.1 Definition of Done

A user can:
1. Install with one command
2. Point at two real audio files (any common format)
3. Get a mashup with aligned tempo + key, with the vocal isolated from one track
4. Search for source material via torrent
5. Get JSON output for scripting/automation
6. Have confidence the output is correct (tests pass)

### Phase 1: Fix the bugs (estimate: ~1 hour)

**1.1 Fix crash bugs**
- B1: Pass `_TRACKERS` to `_build_magnet` in `search_torrents`
- B2: Handle Archive.org dict-shaped responses
- B3: Fix `from_youtube` file selection (use mtime, or parse yt-dlp `--print-file-name`)

**1.2 Fix correctness bugs**
- B4: Rewrite BPM doubling/halving to compare actual autocorrelation strengths at each candidate lag and pick the true maximum (not a 0.9 threshold)
- B5: Implement Camelot wheel key compatibility for `semitones_to_match` — relative major/minor should shift 0 semitones
- B6: Fix `rfftfreq` to use `win` not `2 * n_bins`

**1.3 Clean up dead code**
- Remove B7-B11: unused imports, params, constants

**1.4 Fix documentation**
- B13-B15: Standardize CLI name to `twobecomeone` in all docs + argparse

### Phase 2: Stem separation (estimate: ~2-3 hours)

**2.1 ffmpeg center-channel extraction (quick win)**
- Add `separate_stems()` to a new `separator.py` module
- Use ffmpeg's `pan=stereo|c0=c0|c1=-c1` (phase cancellation) for a rough vocal isolation
- This is the "karaoke trick" — works on stereo tracks with center-panned vocals
- Output: `vocals.wav`, `instrumental.wav`

**2.2 Demucs integration (proper separation)**
- Add `demucs` as an optional dependency (extras group: `[demucs]`)
- `pip install twobecomeone[demucs]` pulls torch + demucs
- `separator.py` auto-detects: if demucs is importable, use it; else fall back to ffmpeg
- Demucs htdemucs model: 4 stems (vocals/drums/bass/other), fits in 6GB VRAM
- GPU via CUDA if available, CPU fallback

**2.3 CLI integration**
- New `separate` subcommand: `twobecomeone separate track.mp3 -o stems/`
- `mash` command gains `--stems` flag to auto-separate before mixing

### Phase 3: Test suite (estimate: ~1 hour)

**3.1 Test fixtures**
- Commit small synthetic test audio files (the ones in /tmp are ephemeral)
- Generate a "golden" mashup output for regression comparison

**3.2 Tests**
- `test_analyzer.py`: BPM detection on known-BPM signals, key detection on known-key chords, edge cases (silence, noise)
- `test_assembler.py`: tempo ratio calculation, semitone shift calculation, atempo chain bounds
- `test_sources.py`: magnet building, torrent API response parsing (mocked)
- `test_cli.py`: CLI smoke tests via `main(argv=[...])`
- All tests run with `pytest`, no network, no GPU required

### Phase 4: Robustness (estimate: ~1 hour)

**4.1 Error handling**
- Wrap subprocess calls with informative error messages
- Check ffmpeg/yt-dlp availability at startup with helpful install instructions
- Validate input file formats before processing

**4.2 Logging**
- Python `logging` module, `--verbose` / `-v` flag
- Log each pipeline stage (decode, analyze, align, mix) with timing

**4.3 Configuration**
- `twobecomeone.toml` config file for defaults (sample rate, gains, separation method)
- Override via CLI flags

### Phase 5: Polish for V0.1 release (estimate: ~30 min)

- Update README with correct CLI name, full usage examples, install instructions
- Add `--json` output to all subcommands (not just `analyze`)
- Add `--dry-run` to `mash` (show what would happen without rendering)
- Tag git: `v0.1.0`
- Update memory with project state

### Phase summary

| Phase | What | Est. | Priority |
|-------|------|------|----------|
| 1 | Fix 15 bugs | ~1h | P0 (blocking) |
| 2 | Stem separation | ~2-3h | P0 (core feature) |
| 3 | Test suite | ~1h | P0 (confidence) |
| 4 | Robustness | ~1h | P1 |
| 5 | Polish | ~30m | P1 |

Total estimate: ~5-6 hours of focused work.

### Key risks

1. **Demucs on 6GB VRAM** — the RTX 4050 Laptop has 6GB, htdemucs should fit but may need `--segment` splitting for long tracks. CPU fallback is slow (~real-time).
2. **Python 3.14 compatibility** — torch may not have wheels for 3.14 yet. The venv already uses 3.12 (uv fetched its own), so this should be fine.
3. **Torrent API reliability** — public torrent indexers are flaky. Need graceful degradation and maybe a second/fallback indexer.
4. **BPM detection on real music** — synthetic tests prove the algorithm is sound, but real tracks (with syncopation, tempo changes, sparse sections) will stress it. May need a refinement pass.
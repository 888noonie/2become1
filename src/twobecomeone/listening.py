"""OPERATION THE LISTENING ROOM: find useful passages in a source recording.

The smallest pipeline that gives the Producer real musical evidence:

  1. The track's own beat grid (stored analysis or the musician's override)
     cut into bars.
  2. Bar-level harmony (chroma) and timbre from the full mix, and vocal level
     from the separated vocal stem.
  3. A self-similarity matrix: where the music changes (novelty) gives the
     section boundaries, and which sections repeat each other gives letters
     (A, B, C ...).
  4. Labels (intro, verse, chorus, bridge, instrumental, outro) estimated from
     repetition, loudness and vocal presence. A label is an ESTIMATE and says
     so, with the evidence that produced it.
  5. Optional: words heard in the vocal stem by a LOCAL faster-whisper model
     the owner configured (``TWOBECOMEONE_WHISPER_MODEL`` = a model folder on
     disk). Nothing is downloaded and no audio leaves the machine. Repeated
     words strengthen a repetition label; they do not prove it.

A musician's corrections are stored per recording (content hash) and replace
the estimated sections everywhere that recording is used.

Words heard in a recording are musical content. They are returned as data,
fenced and labelled as heard lyrics, and never treated as instructions.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import math
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from .analyzer import decode_mono
from .common import UserError

ANALYSIS_VERSION = 2
SR = 22050
N_FFT = 4096
HOP = 1024
BEATS_PER_BAR = 4
MIN_SECTION_BARS = 4
LABELS = ("intro", "verse", "pre-chorus", "chorus", "bridge", "instrumental", "breakdown", "outro", "section")
MAX_ANALYSIS_SECONDS = 12 * 60
WHISPER_ENV = "TWOBECOMEONE_WHISPER_MODEL"
_LOCK = threading.Lock()


# ---------------------------------------------------------------- features

def _frames(x: np.ndarray) -> np.ndarray:
    if len(x) < N_FFT:
        x = np.pad(x, (0, N_FFT - len(x)))
    count = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(count)[:, None]
    return x[idx] * np.hanning(N_FFT)[None, :]


def _spectral_features(x: np.ndarray) -> dict[str, np.ndarray]:
    """Per-frame chroma (12), timbre (12 cepstral bands) and RMS dB."""
    frames = _frames(x)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    mag = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SR)

    band = (freqs >= 55) & (freqs <= 4200)
    midi = 69 + 12 * np.log2(freqs[band] / 440.0)
    pc = np.mod(np.round(midi), 12).astype(int)
    chroma = np.zeros((mag.shape[0], 12))
    power = mag[:, band] ** 2
    for k in range(12):
        chroma[:, k] = power[:, pc == k].sum(axis=1)
    chroma = np.log1p(chroma / (np.median(chroma) + 1e-9))

    edges = np.geomspace(60, 9000, 25)
    bands = np.zeros((mag.shape[0], 24))
    for i in range(24):
        sel = (freqs >= edges[i]) & (freqs < edges[i + 1])
        bands[:, i] = np.log(np.mean(mag[:, sel] ** 2, axis=1) + 1e-10)
    n = np.arange(24)
    dct = np.cos(np.pi / 24 * (n[None, :] + 0.5) * np.arange(1, 13)[:, None])
    timbre = bands @ dct.T
    return {"chroma": chroma, "timbre": timbre, "rms_db": 20 * np.log10(rms)}


def _bar_grid(track: dict, duration: float) -> tuple[float, float, list[float]]:
    bpm = float(track.get("bpm") or 0)
    if not math.isfinite(bpm) or bpm <= 0:
        raise UserError("this recording has no tempo analysis yet, so it cannot be cut into bars")
    grid = track.get("beat_grid") or {}
    beat = 60.0 / bpm
    bar = beat * BEATS_PER_BAR
    anchor = grid.get("suggested_downbeat")
    if anchor is None:
        anchor = grid.get("first_beat") or 0.0
    anchor = float(anchor)
    first = anchor - math.floor(anchor / bar + 1e-9) * bar
    starts = []
    t = first
    while t + bar <= duration + 1e-6:
        starts.append(round(t, 6))
        t += bar
    if len(starts) < 2 * MIN_SECTION_BARS:
        raise UserError("the recording is too short to find sections in")
    return bpm, bar, starts


def _per_bar(values: np.ndarray, starts: list[float], bar: float) -> np.ndarray:
    hop_s = HOP / SR
    out = []
    for s in starts:
        a = int(s / hop_s)
        b = max(a + 1, int((s + bar) / hop_s))
        chunk = values[a:b]
        out.append(chunk.mean(axis=0) if len(chunk) else np.zeros(values.shape[1:]))
    return np.asarray(out)


def _section_mean_chroma(chroma: np.ndarray, a: int, b: int) -> list[float] | None:
    """Mean of the per-bar chroma rows for bars ``a:b``.

    A non-finite mean is missing evidence: callers store null, never NaN.
    """
    rows = chroma[a:b]
    if getattr(rows, "ndim", 0) != 2 or rows.shape[1] != 12 or rows.shape[0] == 0:
        return None
    mean = rows.mean(axis=0)
    if not np.all(np.isfinite(mean)):
        return None
    return [float(f"{float(value):.6f}") for value in mean]


def _cos(m: np.ndarray) -> np.ndarray:
    n = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-12)
    return n @ n.T


def _similarity(chroma: np.ndarray, timbre: np.ndarray) -> np.ndarray:
    c = chroma - chroma.mean(axis=0)
    lag = np.vstack([c[1:], c[-1:]])
    sc = _cos(np.hstack([c, lag]))
    t = (timbre - timbre.mean(axis=0)) / (timbre.std(axis=0) + 1e-9)
    d = np.sqrt(((t[:, None, :] - t[None, :, :]) ** 2).sum(-1))
    sigma = np.median(d[d > 0]) if np.any(d > 0) else 1.0
    st = np.exp(-(d ** 2) / (2 * sigma ** 2))
    return 0.6 * (sc + 1) / 2 + 0.4 * st


def _novelty(s: np.ndarray, half: int = 4) -> np.ndarray:
    n = len(s)
    g = np.exp(-0.5 * (np.linspace(-1, 1, 2 * half) / 0.6) ** 2)
    kernel = np.outer(g, g) * np.outer(np.r_[-np.ones(half), np.ones(half)], np.r_[-np.ones(half), np.ones(half)])
    padded = np.pad(s, half, mode="edge")
    out = np.zeros(n + 1)
    for i in range(1, n):
        block = padded[i:i + 2 * half, i:i + 2 * half]
        out[i] = -(block * kernel).sum()
    out[out < 0] = 0
    return out / (out.max() + 1e-12)


def _boundaries(score: np.ndarray, n_bars: int) -> list[int]:
    cand = [i for i in range(MIN_SECTION_BARS, n_bars - MIN_SECTION_BARS + 1)
            if score[i] >= score[i - 1] and score[i] >= score[min(i + 1, n_bars)]]
    floor = float(np.mean(score[1:n_bars]) + 0.35 * np.std(score[1:n_bars]))
    ranked = sorted((i for i in cand if score[i] > floor), key=lambda i: -score[i] * (1.2 if i % 4 == 0 else 1.0))
    chosen: list[int] = []
    for i in ranked:
        if all(abs(i - j) >= MIN_SECTION_BARS for j in chosen):
            chosen.append(i)
    bounds = [0] + sorted(chosen) + [n_bars]
    # Song sections are rarely longer than 12 bars: split a long one at its
    # strongest inner change, preferring a 4-bar phrase line.
    changed = True
    while changed:
        changed = False
        for k in range(len(bounds) - 1):
            a, b = bounds[k], bounds[k + 1]
            if b - a <= 16:
                continue
            inner = range(a + MIN_SECTION_BARS, b - MIN_SECTION_BARS + 1)
            best = max(inner, key=lambda i: score[i] * (1.5 if (i - a) % 4 == 0 else 1.0))
            bounds.insert(k + 1, best)
            changed = True
            break
    return bounds


def _segment_similarity(s: np.ndarray, a: tuple[int, int], b: tuple[int, int]) -> float:
    """The shorter section against its best-aligned place inside the longer one."""
    if a[1] - a[0] > b[1] - b[0]:
        a, b = b, a
    n = a[1] - a[0]
    best = 0.0
    for off in range(0, (b[1] - b[0]) - n + 1):
        best = max(best, float(np.mean([s[a[0] + k, b[0] + off + k] for k in range(n)])))
    if n / (b[1] - b[0]) < 0.4:
        best *= 0.92
    return best


def _bar_repetition(s: np.ndarray, min_lag: int = 8, span: int = 4) -> np.ndarray:
    """How strongly each bar's next few bars come back elsewhere in the song."""
    n = len(s)
    out = np.zeros(n)
    for i in range(n):
        best = 0.0
        for j in range(n):
            if abs(i - j) < min_lag:
                continue
            k = min(span, n - i, n - j)
            if k < 2:
                continue
            best = max(best, float(np.mean([s[i + q, j + q] for q in range(k)])))
        out[i] = best
    return out


def _cluster(sim: np.ndarray, threshold: float) -> list[int]:
    """Average-linkage agglomeration; returns a cluster id per segment."""
    groups = [[i] for i in range(len(sim))]
    while len(groups) > 1:
        best, pair = -1.0, None
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                v = float(np.mean([sim[p, q] for p in groups[i] for q in groups[j]]))
                if v > best:
                    best, pair = v, (i, j)
        if best < threshold or pair is None:
            break
        i, j = pair
        groups[i] += groups.pop(j)
    out = [0] * len(sim)
    order = sorted(groups, key=min)
    for gid, members in enumerate(order):
        for m in members:
            out[m] = gid
    return out


# ---------------------------------------------------------------- words

def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def whisper_model_path(env: dict | None = None) -> Path | None:
    raw = (env if env is not None else os.environ).get(WHISPER_ENV, "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    # A folder on disk only: a bare model name would make faster-whisper
    # download weights, which this Studio never does on its own.
    if not (path.is_dir() and (path / "model.bin").is_file()):
        return None
    return path


_MODELS: dict[str, Any] = {}


def _transcriber(path: Path):
    key = str(path)
    if key not in _MODELS:
        from faster_whisper import WhisperModel  # optional, local only
        _MODELS[key] = WhisperModel(key, device="cpu", compute_type="int8", cpu_threads=4)
    return _MODELS[key]


def transcribe_spans(vocals_16k: np.ndarray, spans: list[tuple[float, float]], model_path: Path) -> list[dict]:
    """Words heard in each span (absolute seconds), each with a probability."""
    model = _transcriber(model_path)
    words: list[dict] = []
    for start, end in spans:
        t = start
        while t < end - 0.5:
            stop = min(end, t + 28.0)
            chunk = vocals_16k[int(t * 16000):int(stop * 16000)].astype(np.float32)
            segments, _info = model.transcribe(
                chunk, language="en", word_timestamps=True, vad_filter=False,
                condition_on_previous_text=False, beam_size=1,
            )
            for seg in segments:
                if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
                    continue
                seg_words = [w for w in (seg.words or []) if _tokens(w.word)]
                # Whisper invents text over wordless melody: very unsure words,
                # or one token repeated over and over, are not lyrics.
                if not seg_words or np.mean([w.probability for w in seg_words]) < 0.45:
                    continue
                toks = [_tokens(w.word)[0] for w in seg_words]
                if len(toks) >= 4 and len(set(toks)) <= len(toks) / 4:
                    continue
                for w in seg_words:
                    if w.probability < 0.25:
                        continue
                    text = w.word.strip()
                    words.append({
                        "w": text[:40],
                        "start": round(t + float(w.start), 3),
                        "end": round(t + float(w.end), 3),
                        "p": round(float(w.probability), 3),
                    })
            t = stop
    return words


def _words_between(words: list[dict], start: float, end: float) -> list[dict]:
    return [w for w in words if start - 0.05 <= (w["start"] + w["end"]) / 2 < end]


def _lyric_summary(words: list[dict]) -> dict | None:
    if not words:
        return None
    probs = [w["p"] for w in words]
    return {
        "text": " ".join(w["w"] for w in words)[:400],
        "wordCount": len(words),
        "meanProbability": round(float(np.mean(probs)), 3),
    }


def _jaccard(a: list[str], b: list[str]) -> float:
    sa, sb = set(a), set(b)
    return len(sa & sb) / len(sa | sb) if sa and sb else 0.0


CERTAIN_LYRIC = 0.8


def find_lyric(analysis: dict, phrase: str, *, min_score: float = 0.6) -> list[dict]:
    """Where `phrase` was heard, in time order. Below 0.8 a match is uncertain."""
    want = _tokens(phrase)
    words = analysis.get("words") or []
    if not want or not words:
        return []
    target = " ".join(want)
    toks = [(_tokens(w["w"]) or [""])[0] for w in words]

    def fits(tok: str) -> bool:
        return any(difflib.SequenceMatcher(None, tok, t).ratio() >= 0.6 for t in want)

    hits = []
    for size in {max(1, len(want) - 1), len(want), len(want) + 1}:
        if size > len(words):
            continue
        for i in range(0, len(words) - size + 1):
            a, b = i, i + size
            # A window starts and ends on words that belong to the phrase.
            while a < b - 1 and not fits(toks[a]):
                a += 1
            while b - 1 > a and not fits(toks[b - 1]):
                b -= 1
            heard = " ".join(toks[a:b])
            score = difflib.SequenceMatcher(None, target, heard).ratio()
            if score >= min_score:
                hits.append((score, a, b - a))
    hits.sort(key=lambda h: (-h[0], h[1]))
    out: list[dict] = []
    for score, i, size in hits:
        start, end = words[i]["start"], words[i + size - 1]["end"]
        if any(o["startSec"] - 1.0 < end and start < o["endSec"] + 1.0 for o in out):
            continue
        section = next((s for s in analysis["sections"] if s["startSec"] <= start < s["endSec"]), None)
        out.append({
            "startSec": start, "endSec": end, "score": round(score, 3),
            "certain": score >= CERTAIN_LYRIC,
            "heard": " ".join(w["w"] for w in words[i:i + size]),
            "sectionId": section["id"] if section else None,
        })
    return sorted(out, key=lambda o: o["startSec"])


# ---------------------------------------------------------------- labels

def _label_sections(segs: list[dict], words_on: bool) -> None:
    """Estimated labels from repetition, loudness, vocals and repeated words."""
    letters = sorted({s["letter"] for s in segs})
    # Words that come back elsewhere in the song: the share of a section's
    # word pairs heard again in another section.
    for s in segs:
        pairs = set(zip(s["_tokens"], s["_tokens"][1:]))
        if not pairs:
            s["_recur"] = 0.0
            continue
        elsewhere = set()
        for o in segs:
            if o is not s:
                elsewhere |= set(zip(o["_tokens"], o["_tokens"][1:]))
        s["_recur"] = len(pairs & elsewhere) / len(pairs)
    stats = {}
    for L in letters:
        members = [s for s in segs if s["letter"] == L]
        lyric_rep = 0.0
        if words_on and len(members) > 1:
            pairs = [(a, b) for i, a in enumerate(members) for b in members[i + 1:]]
            lyric_rep = float(np.mean([_jaccard(a["_tokens"], b["_tokens"]) for a, b in pairs]))
        stats[L] = {
            "count": len(members),
            "energy": float(np.mean([s["energyDb"] for s in members])),
            "vocal": float(np.mean([s["vocalPresence"] for s in members])),
            "lyricRepeat": max(lyric_rep, float(np.mean([s["_recur"] for s in members])) if words_on else 0.0),
            "repetition": float(np.mean([s["_rep"] for s in members])),
        }
    energies = [v["energy"] for v in stats.values()]
    e_mean, e_std = float(np.mean(energies)), float(np.std(energies) + 1e-6)
    reps = [v["repetition"] for v in stats.values()]
    r_mean, r_std = float(np.mean(reps)), float(np.std(reps) + 1e-6)
    repeated = [L for L in letters if stats[L]["count"] >= 2 and stats[L]["vocal"] >= 0.35]
    chorus = None
    if repeated:
        def score(L):
            st = stats[L]
            return ((st["energy"] - e_mean) / e_std + 1.2 * (st["repetition"] - r_mean) / r_std
                    + 0.4 * min(st["count"], 4) + 3.0 * st["lyricRepeat"] + st["vocal"])
        chorus = max(repeated, key=score)
    verse = None
    others = [L for L in repeated if L != chorus]
    if chorus and others:
        first_chorus = min(s["index"] for s in segs if s["letter"] == chorus)
        before = [L for L in others if min(s["index"] for s in segs if s["letter"] == L) < first_chorus]
        verse = max(before or others, key=lambda L: stats[L]["count"])
    last_chorus = max((s["index"] for s in segs if s["letter"] == chorus), default=-1)
    for s in segs:
        st = stats[s["letter"]]
        evidence = []
        if st["count"] > 1:
            evidence.append(f"music repeats {st['count']}× (part {s['letter']})")
        if s["vocalPresence"] < 0.2:
            evidence.append("little or no voice")
        if s["letter"] == chorus and s["vocalPresence"] < 0.2:
            label, conf = "instrumental", 0.45
            evidence.append("chorus music without the voice")
        elif s["letter"] == chorus:
            label = "chorus"
            evidence.append("loudest repeated vocal part" if st["energy"] >= e_mean else "most repeated vocal part")
            if st["lyricRepeat"] >= 0.3:
                evidence.append("the same words come back")
            conf = 0.45 + 0.15 * min(st["count"] - 1, 2) + (0.15 if st["lyricRepeat"] >= 0.3 else 0.0)
        elif s["letter"] == verse:
            label = "verse"
            evidence.append("repeated vocal part before the chorus")
            conf = 0.45 + (0.1 if st["lyricRepeat"] < 0.3 else 0.0)
        elif s["index"] == 0 and s["vocalPresence"] < 0.35:
            label, conf = "intro", 0.6
        elif s["index"] == len(segs) - 1 and st["count"] == 1:
            label, conf = "outro", 0.5
        elif s["vocalPresence"] < 0.2:
            label, conf = "instrumental", 0.45
        elif chorus and s["index"] > last_chorus - 1 and st["count"] == 1 and s["index"] < len(segs) - 1:
            label, conf = "bridge", 0.35
        else:
            label, conf = "section", 0.3
        s["label"] = label
        s["confidence"] = round(min(conf, 0.9), 2)
        s["evidence"] = evidence
        s["basis"] = "estimated"


def _number(sections: list[dict]) -> None:
    seen: dict[str, int] = {}
    for s in sections:
        seen[s["label"]] = seen.get(s["label"], 0) + 1
        s["occurrence"] = seen[s["label"]]
    totals = dict(seen)
    for s in sections:
        s["name"] = f"{s['label']} {s['occurrence']}" if totals[s["label"]] > 1 else s["label"]


# ---------------------------------------------------------------- pipeline

def analyse(
    track: dict,
    mix_path: Path,
    vocals_path: Path | None,
    *,
    whisper: Path | None = None,
) -> dict:
    started = time.monotonic()
    mix = decode_mono(mix_path, sr=SR)
    if len(mix) > MAX_ANALYSIS_SECONDS * SR:
        raise UserError("recordings longer than 12 minutes are not analysed here")
    duration = len(mix) / SR
    bpm, bar, starts = _bar_grid(track, duration)
    feats = _spectral_features(mix)
    chroma = _per_bar(feats["chroma"], starts, bar)
    timbre = _per_bar(feats["timbre"], starts, bar)
    energy = _per_bar(feats["rms_db"][:, None], starts, bar)[:, 0]

    vocal_db = None
    vocals_16k = None
    if vocals_path is not None:
        vocals = decode_mono(vocals_path, sr=SR)
        vfeats = _frames(vocals)
        vrms = 20 * np.log10(np.sqrt(np.mean(vfeats ** 2, axis=1) + 1e-12))
        vocal_db = _per_bar(vrms[:, None], starts, bar)[:, 0]
        del vocals, vfeats
    n = len(starts)
    s = _similarity(chroma, timbre)
    nov = _novelty(s)
    score = nov.copy()
    if vocal_db is not None:
        top = float(np.percentile(vocal_db, 95))
        active = (vocal_db > top - 18) & (vocal_db > -50)
        for i in range(1, n):
            if active[i] != active[i - 1]:
                score[i] += 0.35
        presence = np.clip((vocal_db - (top - 30)) / 18, 0, 1)
    else:
        presence = np.zeros(n)
    jumps = np.r_[0, np.abs(np.diff(energy))]
    score[:n] += 0.25 * np.clip(jumps / 6.0, 0, 1)
    bounds = _boundaries(score, n)

    spans = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
    m = len(spans)
    seg_sim = np.ones((m, m))
    for i in range(m):
        for j in range(i + 1, m):
            seg_sim[i, j] = seg_sim[j, i] = _segment_similarity(s, spans[i], spans[j])
    off = seg_sim[np.triu_indices(m, 1)] if m > 1 else np.array([1.0])
    # Real mixes sound alike almost everywhere: only a similarity well above
    # this song's own typical value counts as "the same part again".
    threshold = max(0.72, float(np.mean(off) + 0.8 * np.std(off)))
    ids = _cluster(seg_sim, threshold)
    rep = _bar_repetition(s)

    words: list[dict] = []
    lyric_note = "no vocal stem"
    if vocals_path is not None and whisper is None:
        lyric_note = f"no local transcription model configured ({WHISPER_ENV})"
    segs = []
    for k, (a, b) in enumerate(spans):
        seg_start = starts[a]
        seg_end = starts[b - 1] + bar
        segs.append({
            "id": f"s{k + 1}", "index": k, "letter": chr(65 + ids[k]) if ids[k] < 26 else f"Z{ids[k]}",
            "startBar": a + 1, "bars": b - a,
            "startSec": round(seg_start, 4), "endSec": round(seg_end, 4),
            "energyDb": round(float(np.mean(energy[a:b])), 2),
            "vocalPresence": round(float(np.mean(presence[a:b])), 2),
            "meanChroma": _section_mean_chroma(chroma, a, b),
            "_rep": float(np.mean(rep[a:b])),
        })
    from .chorus_fit import section_swings
    for seg, swing in zip(segs, section_swings(mix, SR, bpm, [(s["startSec"], s["endSec"]) for s in segs])):
        if swing is not None:
            seg["swingRatio"] = round(float(swing), 4)
    if vocals_path is not None and whisper is not None:
        try:
            vocals_16k = decode_mono(vocals_path, sr=16000).astype(np.float32)
            voiced = [(g["startSec"], g["endSec"]) for g in segs if g["vocalPresence"] >= 0.2]
            words = transcribe_spans(vocals_16k, voiced, whisper)
            lyric_note = (f"heard by local {whisper.name} (rough; words can be wrong)" if len(words) >= 6
                          else f"no clear words heard by local {whisper.name}: instrumental or unclear voice")
        except Exception as exc:  # noqa: BLE001 - lyrics are optional evidence
            words = []
            lyric_note = f"transcription unavailable: {type(exc).__name__}"
        finally:
            vocals_16k = None
    for g in segs:
        mine = _words_between(words, g["startSec"], g["endSec"])
        g["_tokens"] = [t for w in mine for t in _tokens(w["w"])]
        g["lyrics"] = _lyric_summary(mine)
    _label_sections(segs, len(words) >= 6)
    for g in segs:
        del g["_tokens"], g["_recur"], g["_rep"]
    _number(segs)
    has_voice = vocal_db is not None and float(np.mean(presence)) >= 0.1
    return {
        "version": ANALYSIS_VERSION,
        "trackId": track["id"],
        "title": track.get("name"),
        "bpm": bpm,
        "beatsPerBar": BEATS_PER_BAR,
        "barSec": round(bar, 6),
        "firstBarSec": starts[0],
        "durationSec": round(duration, 4),
        "bars": n,
        "sections": segs,
        "descriptors": {
            "chromaBins": 12,
            "field": "meanChroma",
            "swingField": "swingRatio",
            "kind": "section-mean pitch-class energy",
        },
        "words": words,
        "lyrics": {
            "available": len(words) >= 6,
            "note": lyric_note,
            "instrumental": not has_voice,
        },
        "method": {
            "structure": "bar self-similarity (harmony + timbre of the full mix), novelty boundaries, repetition clusters",
            "vocals": "level of the separated vocal stem per bar" if vocal_db is not None else "no vocal stem",
            "labels": "estimated from repetition, loudness, voice and repeated words",
        },
        "elapsedSec": round(time.monotonic() - started, 2),
    }


# ---------------------------------------------------------------- corrections

def _usable_mean_chroma(value: object) -> list[float] | None:
    """Twelve finite pitch-class weights, or nothing when the evidence is absent."""
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)) or len(value) != 12:
        return None
    numbers: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return None
        number = float(item)
        if not math.isfinite(number):
            return None
        numbers.append(number)
    return numbers


def _corrected_mean_chroma(analysis: dict, start: float, bars: int) -> list[float] | None:
    """Chroma from the nearest estimate that still matches this span.

    A document older than version 2, or a section with no finite 12-bin mean,
    is missing evidence. Nothing is invented, and a distant section is not copied.
    """
    version = analysis.get("version")
    if isinstance(version, bool) or not isinstance(version, (int, float)) or version < 2:
        return None
    half = float(analysis["barSec"]) / 2
    candidates = []
    for section in analysis["sections"]:
        if abs(float(section["startSec"]) - start) > half:
            continue
        try:
            estimated_bars = int(section["bars"])
        except (KeyError, TypeError, ValueError):
            continue
        if abs(estimated_bars - bars) > 1:
            continue
        candidates.append(section)
    if not candidates:
        return None
    nearest = min(candidates, key=lambda section: abs(float(section["startSec"]) - start))
    return _usable_mean_chroma(nearest.get("meanChroma"))


def apply_corrections(analysis: dict, corrections: list[dict] | None) -> dict:
    """The musician's sections replace the estimates; words are re-sliced."""
    if not corrections:
        return analysis
    out = dict(analysis)
    estimated = {s["id"]: s for s in analysis["sections"]}
    words = analysis.get("words") or []
    bar = analysis["barSec"]
    first = analysis["firstBarSec"]
    sections = []
    for k, c in enumerate(corrections):
        start, end = float(c["startSec"]), float(c["endSec"])
        near = min(analysis["sections"], key=lambda s: abs(s["startSec"] - start))
        mine = _words_between(words, start, end)
        bars = max(1, int(round((end - start) / bar)))
        row = {
            "id": f"s{k + 1}", "index": k, "letter": near["letter"] if abs(near["startSec"] - start) < bar / 2 else "?",
            "startBar": int(round((start - first) / bar)) + 1, "bars": bars,
            "startSec": round(start, 4), "endSec": round(end, 4),
            "energyDb": near["energyDb"], "vocalPresence": near["vocalPresence"],
            "lyrics": _lyric_summary(mine),
            "label": c["label"], "confidence": 1.0,
            "evidence": ["named by you"], "basis": "musician",
        }
        chroma = _corrected_mean_chroma(analysis, start, bars)
        if chroma is not None:
            row["meanChroma"] = chroma
            matched = [
                s for s in analysis["sections"]
                if _usable_mean_chroma(s.get("meanChroma")) == chroma
            ]
            nearest = min(matched, key=lambda s: abs(float(s["startSec"]) - start), default=None)
            swing = nearest.get("swingRatio") if isinstance(nearest, dict) else None
            if isinstance(swing, (int, float)) and not isinstance(swing, bool) and math.isfinite(float(swing)):
                row["swingRatio"] = round(float(swing), 4)
        sections.append(row)
    _number(sections)
    out["sections"] = sections
    out["estimatedSections"] = list(estimated.values())
    out["corrected"] = True
    return out


def validate_corrections(analysis: dict, sections: list[dict]) -> list[dict]:
    if not isinstance(sections, list) or not sections or len(sections) > 64:
        raise UserError("send between 1 and 64 sections")
    clean = []
    last_end = -1.0
    for s in sections:
        try:
            start, end = float(s["startSec"]), float(s["endSec"])
            label = str(s["label"]).strip().lower()
        except (KeyError, TypeError, ValueError) as exc:
            raise UserError("each section needs startSec, endSec and label") from exc
        if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or end <= start:
            raise UserError("a section must end after it starts")
        if end > analysis["durationSec"] + 0.01:
            raise UserError("a section runs past the end of the recording")
        if start < last_end - 1e-6:
            raise UserError("sections must be in order and must not overlap")
        if not re.fullmatch(r"[a-z][a-z -]{0,23}", label):
            raise UserError("a section name is 1 to 24 letters")
        clean.append({"startSec": round(start, 4), "endSec": round(end, 4), "label": label})
        last_end = end
    return clean


# ---------------------------------------------------------------- store

class ListeningStore:
    """Cached analyses by recording identity, and the musician's corrections."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.corrections_dir = self.root / "corrections"

    def _key(self, sha: str, stem_set_id: str | None, track: dict, whisper: Path | None) -> str:
        grid = track.get("beat_grid") or {}
        params = json.dumps([ANALYSIS_VERSION, stem_set_id, track.get("bpm"), grid.get("suggested_downbeat"),
                             grid.get("first_beat"), whisper.name if whisper else None])
        return f"{sha[:16]}-{hashlib.sha256(params.encode()).hexdigest()[:12]}"

    def cached(self, sha: str, stem_set_id: str | None, track: dict, whisper: Path | None) -> dict | None:
        path = self.root / f"{self._key(sha, stem_set_id, track, whisper)}.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def store(self, sha: str, stem_set_id: str | None, track: dict, whisper: Path | None, analysis: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.root / f"{self._key(sha, stem_set_id, track, whisper)}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(analysis), "utf-8")
        tmp.replace(path)

    def corrections(self, sha: str) -> list[dict] | None:
        path = self.corrections_dir / f"{sha}.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text("utf-8")).get("sections")
        except (OSError, json.JSONDecodeError):
            return None

    def save_corrections(self, sha: str, sections: list[dict] | None) -> None:
        path = self.corrections_dir / f"{sha}.json"
        if sections is None:
            path.unlink(missing_ok=True)
            return
        self.corrections_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"sections": sections, "savedAt": time.time()}), "utf-8")


# ---------------------------------------------------------------- service

def _inputs(service, track_id: str) -> tuple[dict, str, Path, Path | None, str | None, dict | None]:
    track = service.get_track(track_id)
    sha = service._track_content_hash(track_id)
    stems = service.list_stems(track_id)
    vocals = next((v for v in stems.get("variants", []) if v.get("name") == "vocals"), None)
    vocal_path = service.stem_audio_path(vocals["stem_set_id"], "vocals") if vocals else None
    return track, sha, service.track_path(track_id), vocal_path, vocals["stem_set_id"] if vocals else None, vocals


def _stem_rate(service, stem_set_id: str | None) -> int | None:
    if not stem_set_id:
        return None
    try:
        return int(service._probe_audio_layout(service.stem_audio_path(stem_set_id, "vocals"))["sample_rate"])
    except Exception:  # noqa: BLE001 - informative only
        return None


def for_track(service, track_id: str, *, compute: bool, env: dict | None = None) -> dict | None:
    """The cached analysis (with the musician's corrections), computing it if asked."""
    store = ListeningStore(Path(service.data_dir) / "listening")
    track, sha, mix_path, vocal_path, stem_set_id, vocals = _inputs(service, track_id)
    whisper = whisper_model_path(env)
    analysis = store.cached(sha, stem_set_id, track, whisper)
    if analysis is None:
        if not compute:
            return None
        with _LOCK:
            analysis = store.cached(sha, stem_set_id, track, whisper)
            if analysis is None:
                analysis = analyse(track, mix_path, vocal_path, whisper=whisper)
                analysis["stemSetId"] = stem_set_id
                analysis["stemMethod"] = vocals.get("method") if vocals else None
                analysis["stemSampleRate"] = _stem_rate(service, stem_set_id)
                analysis["contentSha256"] = sha
                store.store(sha, stem_set_id, track, whisper, analysis)
    analysis = dict(analysis)
    analysis["trackId"] = track_id
    analysis["title"] = track.get("name")
    corrected = apply_corrections(analysis, store.corrections(sha))
    # The effective key is already on the track. Attach it when the document
    # is read so a cached analysis can be compared without being recomputed.
    key = effective_key_name(track)
    if key:
        corrected = dict(corrected)
        corrected["key"] = key
    return corrected


def effective_key_name(track: dict) -> str | None:
    """``C major`` from the track's effective key, or None when it has no key."""
    key = track.get("key") if isinstance(track, dict) else None
    if not isinstance(key, dict):
        return None
    tonic = key.get("tonic")
    mode = key.get("mode")
    if not isinstance(tonic, str) or not isinstance(mode, str):
        return None
    text = f"{tonic.strip()} {mode.strip()}".strip()
    return text or None


def save_corrections(service, track_id: str, sections: list[dict] | None, env: dict | None = None) -> dict:
    analysis = for_track(service, track_id, compute=True, env=env)
    base = {**analysis, "sections": analysis.get("estimatedSections", analysis["sections"])}
    store = ListeningStore(Path(service.data_dir) / "listening")
    sha = analysis["contentSha256"]
    store.save_corrections(sha, None if sections is None else validate_corrections(base, sections))
    return for_track(service, track_id, compute=False, env=env)


def lock() -> threading.Lock:
    """One analysis at a time: it is CPU and memory heavy."""
    return _LOCK

// mashup/deck-loop.js — pure bar-loop window. One bar is four beats. No DOM.

const LOOP_BARS = Object.freeze([1, 2, 4, 8]);
const MIN_WINDOW_SECONDS = 0.05;

export function loopWindow({ time, duration, bpm, bars, firstBeat = 0 }) {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) return null;
  if (!LOOP_BARS.includes(bars)) return null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(time) || !Number.isFinite(firstBeat)) return null;
  const barSeconds = bars * 4 * (60 / bpm);
  if (!Number.isFinite(barSeconds) || barSeconds <= 0) return null;
  const start = firstBeat + Math.floor((time - firstBeat) / barSeconds) * barSeconds;
  const end = start + barSeconds;
  const clampedStart = Math.min(duration, Math.max(0, start));
  const clampedEnd = Math.min(duration, Math.max(0, end));
  if (clampedEnd - clampedStart < MIN_WINDOW_SECONDS) return null;
  return { start: clampedStart, end: clampedEnd };
}

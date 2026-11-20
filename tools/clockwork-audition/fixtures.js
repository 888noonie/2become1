// tools/clockwork-audition/fixtures.js — small, original audition material.
//
// OPERATION THE GOLDEN EAR II. Every sound here is synthesised by this file from
// fixed formulas and a fixed-seed PRNG: no recorded, downloaded or licensed
// media, nothing read from the Studio library, nothing written to disk. The same
// generators feed the bounded Chromium checks and the owner audition page.
//
// Levels are deliberately low (pad peak ~0.12, drums ~0.25) so the material
// sits well under the limiter ceiling and the page's conservative monitor level
// keeps the result quiet.

export const SR = 48000;
export const BPM = 120;
export const BEAT = SR / 2; // frames per beat at 120 BPM

/** Deterministic PRNG (mulberry32). */
export function prng(seed = 0x2b1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stereo(frames, fn) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let n = 0; n < frames; n += 1) { const v = fn(n); l[n] = v; r[n] = v; }
  return { channels: [l, r] };
}

/** Sustained pad: integer-Hz partials (220/275/330), so any whole-second loop is
 *  phase-continuous — a seam test can compare against the ideal signal exactly. */
export function pad(seconds, level = 0.04) {
  const w = (f) => (2 * Math.PI * f) / SR;
  return stereo(Math.round(seconds * SR), (n) => level * (Math.sin(w(220) * n) + Math.sin(w(275) * n) + Math.sin(w(330) * n)));
}

/** Drum-like transients: a decaying noise burst + click on every beat. Periodic
 *  per beat, so a loop on beat boundaries is sample-continuous. */
export function drums(seconds, level = 0.25) {
  const frames = Math.round(seconds * SR);
  const rnd = prng(7);
  const burst = new Float32Array(2400);
  for (let i = 0; i < burst.length; i += 1) burst[i] = (rnd() * 2 - 1) * Math.exp(-i / 360);
  burst[0] = 1;
  return stereo(frames, (n) => { const k = n % BEAT; return k < burst.length ? level * burst[k] : 0; });
}

/** Bass: 110 Hz with a per-beat envelope. */
export function bass(seconds, level = 0.1) {
  const w = (2 * Math.PI * 110) / SR;
  return stereo(Math.round(seconds * SR), (n) => level * Math.sin(w * n) * Math.exp(-(n % BEAT) / (SR * 0.25)));
}

/** Arpeggio (for the Signalsmith path): a note per half beat. */
export function arp(seconds, level = 0.06) {
  const notes = [440, 550, 660, 550];
  const half = BEAT / 2;
  return stereo(Math.round(seconds * SR), (n) => {
    const k = Math.floor(n / half) % notes.length;
    const env = Math.min(1, (n % half) / 96) * Math.exp(-(n % half) / (SR * 0.2));
    return level * env * Math.sin((2 * Math.PI * notes[k] * n) / SR);
  });
}

/** Position-coded tone: `fA` Hz before `splitSec`, `fB` Hz after (seek oracle). */
export function twoTone(seconds, splitSec, fA = 300, fB = 900, level = 0.2) {
  const split = Math.round(splitSec * SR);
  return stereo(Math.round(seconds * SR), (n) => level * Math.sin((2 * Math.PI * (n < split ? fA : fB) * n) / SR));
}

/**
 * The owner audition arrangement as a REAL ProjectState (EditEngine) — the same
 * path a Studio arrangement takes — plus its decoded buffers. 8 s at 120 BPM:
 *   track 1 pad (bypass), track 2 drums (bypass), track 3 bass (bypass),
 *   track 4 arpeggio stretched x1.2 through Signalsmith (inside the measured
 *   priming range 0.857-1.2).
 */
export function auditionProject(EditEngine) {
  const engine = new EditEngine();
  const seconds = 8;
  const add = (track, name, ref, dur) => engine.loadStemToTrack(track, { name, durationSec: dur, bufferReference: ref }, null);
  add(0, 'pad (synthesised)', 'fx:pad', seconds);
  add(1, 'drums (synthesised)', 'fx:drums', seconds);
  add(2, 'bass (synthesised)', 'fx:bass', seconds);
  const a = add(3, 'arpeggio (synthesised)', 'fx:arp', seconds * 1.2);
  engine.trimClip(a.clipId, 'end', -((seconds * 1.2 - seconds) * (BPM / 60)));
  engine.setClipStretch(a.clipId, 1.2);
  const buffers = {
    'fx:pad': pad(seconds),
    'fx:drums': drums(seconds),
    'fx:bass': bass(seconds),
    'fx:arp': arp(seconds * 1.2),
  };
  return { engine, buffers, seconds };
}

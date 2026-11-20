// tests/browser/daw/synth.js — deterministic synthesis shared by the bounce
// harness (browser) and the click-guard / artifact tests (node). Pure typed
// arrays, no host APIs: the identical signals in every environment.
//
// All material is original and synthesised here (no licensing question).

export const SR = 48000;
export const BPM = 120;
export const beat = 60 / BPM;

export function makeBuffer(seconds, channels = 2) {
  const n = Math.round(seconds * SR);
  return Array.from({ length: channels }, () => new Float32Array(n));
}

export function addTone(ch, startSec, seconds, freq, amp, { vibrato = 0, formants = null, f0ForFormants = null } = {}) {
  const n = Math.round(seconds * SR);
  const at = Math.round(startSec * SR);
  const fade = Math.round(0.01 * SR);
  for (let i = 0; i < n; i += 1) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    let s;
    if (formants) {
      s = 0;
      const f0 = f0ForFormants ?? freq;
      for (let k = 1; k * f0 < 3400; k += 1) {
        const f = k * f0;
        let e = 0.02;
        for (const [fc, bw, gain] of formants) {
          const d = (f - fc) / bw;
          e += gain * Math.exp(-0.5 * d * d);
        }
        s += (e / k) * Math.sin((2 * Math.PI * f * i) / SR);
      }
    } else {
      const wobble = vibrato ? 1 + vibrato * Math.sin((2 * Math.PI * 5 * i) / SR) : 1;
      s = Math.sin((2 * Math.PI * freq * wobble * i) / SR);
    }
    for (const c of ch) {
      c[at + i] += amp * s * Math.max(0, env);
    }
  }
}

export function addKick(ch, startSec, amp = 0.9) {
  const at = Math.round(startSec * SR);
  const n = Math.round(0.25 * SR);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    const f = 120 * Math.exp(-t * 18) + 45;
    const env = Math.exp(-t * 14);
    const s = Math.sin(2 * Math.PI * f * t) * env * amp;
    for (const c of ch) c[at + i] += s;
  }
}

export function addSnare(ch, startSec, amp = 0.5) {
  const at = Math.round(startSec * SR);
  const n = Math.round(0.18 * SR);
  let seed = 12345;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x3fffffff - 1);
    const env = Math.exp(-(i / SR) * 22);
    const s = (noise * 0.7 + Math.sin((2 * Math.PI * 190 * i) / SR) * 0.3) * env * amp;
    for (const c of ch) c[at + i] += s;
  }
}

export function addHat(ch, startSec, amp = 0.2) {
  const at = Math.round(startSec * SR);
  const n = Math.round(0.06 * SR);
  let seed = 777;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x3fffffff - 1);
    const env = Math.exp(-(i / SR) * 60);
    for (const c of ch) c[at + i] += noise * env * amp;
  }
}

export const VOWEL = [[730, 80, 1], [1090, 90, 0.7], [2440, 120, 0.25]];

export function buildStems() {
  // 0 drums: 8 s = 16 beats, 120 BPM pattern (kick/snare/hats).
  const drums = makeBuffer(8);
  for (let b = 0; b < 16; b += 1) {
    if (b % 4 === 0 || b % 4 === 2) addKick(drums, b * beat);
    if (b % 4 === 2) addSnare(drums, b * beat);
    addHat(drums, b * beat + beat / 2, 0.16);
    addHat(drums, b * beat, 0.1);
  }
  // 1 bass: A minor line (A1/C2/D2/E2).
  const bass = makeBuffer(8);
  const bassNotes = [55, 55, 65.4, 55, 73.4, 55, 82.4, 55, 55, 55, 65.4, 55, 82.4, 73.4, 65.4, 55];
  for (let b = 0; b < 16; b += 1) {
    addTone(bass, b * beat, beat * 0.9, bassNotes[b], 0.35);
  }
  // 3 lead: vowel (vocal-like) melody on long notes; note 4 is a pure 330 Hz
  // sine whose positive peak sits exactly at source 5.000757 s — the point the
  // arrangement trims through, so boundary-click probes are phase-proof.
  const lead = makeBuffer(6, 2);
  const melody = [220, 261.6, 293.7];
  for (let i = 0; i < 3; i += 1) {
    addTone(lead, i * 1.5, 1.4, melody[i], 0.4, { formants: VOWEL, f0ForFormants: melody[i] });
  }
  addTone(lead, 4.5, 1.4, 330, 0.5);
  // 4 pad: soft triad chords (Am/F/G/Am).
  const pad = makeBuffer(8);
  const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [220, 261.6, 329.6]];
  for (let i = 0; i < 4; i += 1) {
    for (const f of chords[i]) addTone(pad, i * 2, 1.95, f, 0.12, { vibrato: 0.002 });
  }
  // 5 arp: sixteenth-note A-minor arpeggio.
  const arp = makeBuffer(8);
  const arpNotes = [440, 523.3, 659.3, 523.3];
  for (let s = 0; s < 64; s += 1) {
    addTone(arp, s * (beat / 4), beat / 4 * 0.8, arpNotes[s % 4], 0.18);
  }
  return { drums, bass, lead, pad, arp };
}

/** Exact source sample of the lead's sine-peak cut (note 4 peaks here). */
export const LEAD_PEAK_SOURCE_SEC = 5.000757;

// js/arrangement/wav.js — deterministic WAV encoding for master export.
//
// THE LIVING DAYLIGHTS GATE 3. File encoding must never become a second mixing
// engine: this turns already-rendered PCM into a container, nothing more.
// 24-bit PCM stereo/mono, canonical RIFF header. Pure and node-testable.

/**
 * Encode Float32 channel data (−1..1 nominal) as a 24-bit PCM WAV buffer.
 * @param {Float32Array[]} channels one array per channel (1 or 2)
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav24(channels, sampleRate) {
  if (!channels.length || channels.length > 2) {
    throw new RangeError('encodeWav24 supports mono or stereo');
  }
  const frames = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new RangeError('all channels must have equal length');
  }
  const bytesPerSample = 3;
  const blockAlign = channels.length * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);           // fmt chunk size
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  let at = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels.length; c += 1) {
      // Clamp to the 24-bit two's-complement range; the limiter owns levels.
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      let v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608)));
      if (v < 0) v += 16777216;
      view.setUint8(at, v & 0xff);
      view.setUint8(at + 1, (v >> 8) & 0xff);
      view.setUint8(at + 2, (v >> 16) & 0xff);
      at += 3;
    }
  }
  return buffer;
}

/** Decode the canonical header fields back out, for validity checks. */
export function readWavHeader(buffer) {
  const view = new DataView(buffer);
  const ascii = (offset, len) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    riffSize: view.getUint32(4, true),
  };
}

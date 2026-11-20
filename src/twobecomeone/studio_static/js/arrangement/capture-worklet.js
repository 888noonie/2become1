// js/arrangement/capture-worklet.js — PCM capture tap for the real-time proof.
//
// THE LIVING DAYLIGHTS GATE 5. Passes audio through untouched and forwards
// copies of the blocks to the main thread so the real-time path's output can
// be compared with the offline bounce of the same render plan.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inL = input && input[0] ? input[0] : new Float32Array(output[0].length);
    const inR = input && input[1] ? input[1] : inL;
    output[0].set(inL);
    if (output[1]) output[1].set(inR);
    this.frames += inL.length;
    this.port.postMessage({ type: 'chunk', l: inL.slice(), r: inR.slice() });
    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('pcm-capture', CaptureProcessor);
}

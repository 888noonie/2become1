// tests/browser/daw/arrangement-script.js — the bounce harness's edit
// sequence, shared verbatim between the browser harness and the node
// regression tests. Pure: takes a real EditEngine and clip durations, applies
// the documented arrangement edits through the atomic API, returns the ids.
//
// Keeping ONE copy means the artifact regression test and the bounce cannot
// drift apart on what the arrangement actually is.

/**
 * @param {import('../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js').EditEngine} engine
 * @param {{drumsSec: number, bassSec: number, chordsSec: number, leadSec: number,
 *          padSec: number, arpSec: number, percSec: number, sideSec: number}} sizes
 */
export function applyHarnessArrangement(engine, sizes) {
  const load = (trackIndex, name, durationSec, nativeBpm, key = null) => engine.loadStemToTrack(
    trackIndex,
    { name, durationSec, bufferReference: `synth:${name}`, detectedKey: key },
    nativeBpm,
  );

  const drums = load(0, 'drums', sizes.drumsSec, 120, 'Am');
  const bass = load(1, 'bass', sizes.bassSec, 120, 'Am');
  const chords = load(2, 'chords-100bpm', sizes.chordsSec, 100, 'C');
  const lead = load(3, 'lead-vowel', sizes.leadSec, 120, 'Am');
  const pad = load(4, 'pad', sizes.padSec, 120, 'Am');
  const arp = load(5, 'arp', sizes.arpSec, 120, 'Am');
  const perc = load(6, 'perc-140bpm', sizes.percSec, 140, 'Am');
  const side = load(7, 'side-texture', sizes.sideSec, null); // tempo unmeasured: stays unknown

  // Non-destructive edits through the atomic API:
  engine.splitClipAtBeat(drums.clipId, 8);              // split a drum region
  engine.trimClip(drums.clipId, 'end', -1);             // trim the left half
  engine.trimClip(bass.clipId, 'start', 1);             // trim the bass start
  engine.moveClip(lead.clipId, 3, 8);                   // move the vocal clip to bar 3
  engine.trimClip(lead.clipId, 'end', -1.998485);       // cut at the sine peak (beat ~18.0015)
  engine.setClipPitch(lead.clipId, 7, true);            // transpose +7, formants kept
  engine.setClipFades(pad.clipId, 2, 2);                // musical 2-beat fades
  engine.setClipStretch(arp.clipId, 0.85);              // manual stretch ratio
  engine.setClipGain(side.clipId, -12);
  engine.setTrackEq(1, { lowGainDb: 3 });
  engine.setTrackEq(3, { midGainDb: 2, highGainDb: 2 });
  engine.setTrackEq(4, { lowGainDb: -2, highGainDb: 1 });
  engine.setTrackPan(0, -0.2);
  engine.setTrackPan(5, 0.3);
  engine.setTrackPan(7, 0.7);
  engine.setTrackVolume(2, -3);
  engine.setLoopRange(0, 32);
  return { ids: { drums, bass, chords, lead, pad, arp, perc, side } };
}

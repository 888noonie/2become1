// Pure Chorus Fit decisions. The rank math stays in chorus_fit.py.

import test from 'node:test';
import assert from 'node:assert/strict';

import { arrangementBeatForSource, arrangementPlans, chorusUtterance, deckChoice, measurePlan, pickPlan, pitchFor, playbackSpeed, scoredRows, stylePlan } from '../../src/twobecomeone/studio_static/js/arrangement/chorus-fit.js';

test('the musician’s phrases stay deterministic', () => {
  assert.deepEqual(chorusUtterance('Which part of B fits this chorus?'), { kind: 'fit', targetSong: 'A', sourceSong: 'B', label: 'chorus' });
  assert.equal(chorusUtterance('Find another section that would work with A').another, true);
  assert.deepEqual(chorusUtterance('Try the strongest match'), { kind: 'choose', index: 0 });
  assert.equal(chorusUtterance('Use the second-best option.').index, 'next');
  assert.equal(chorusUtterance('Try the next best match instead').index, 'next');
  assert.equal(chorusUtterance('Keep the chorus but choose a different vocal phrase').stem, 'vocals');
  assert.deepEqual(chorusUtterance('Put it at bar 17'), { kind: 'place', bar: 17 });
  assert.deepEqual(chorusUtterance('Move the idea half a beat earlier'), { kind: 'nudge', beats: -0.5 });
  assert.deepEqual(chorusUtterance('Half a beat earlier'), { kind: 'nudge', beats: -0.5 });
  assert.deepEqual(chorusUtterance('Play the idea at its own speed'), { kind: 'speed', speed: 'natural' });
  assert.equal(chorusUtterance('Make the fade gentler').kind, 'gentler');
  assert.equal(chorusUtterance('Make something beautiful from these two songs').kind, 'decks');
  assert.equal(chorusUtterance('Make a mashup from these two songs').kind, 'decks');
  assert.equal(chorusUtterance('Take the decks and surprise me').style, 'surprise');
  assert.equal(chorusUtterance('Try another arrangement').kind, 'another-plan');
  assert.equal(chorusUtterance('Let the second chorus of B take over').style, 'second');
  assert.equal(chorusUtterance("Keep A's drums but use B's vocals").style, 'lock');
  assert.equal(chorusUtterance('Find a more interesting transition').style, 'transition');
  assert.equal(chorusUtterance('Give the build more energy').style, 'energy');
  assert.equal(chorusUtterance('Make the vocals come in more gently').kind, 'gentler');
  assert.equal(chorusUtterance("Stop. I'll take it from here.").kind, 'take-back');
  assert.equal(chorusUtterance('Take back').kind, 'take-back');
  assert.equal(chorusUtterance('You play').kind, 'you-play');
  assert.equal(chorusUtterance('bring the vocals in gradually across four bars'), null);
  assert.equal(chorusUtterance('Find the second chorus in the other song'), null);
});

test('Take the Decks can prefer a playable neighbour of a closer but unplayable match', () => {
  const rank = {
    ask: true,
    ambiguityGap: 0.05,
    candidates: [
      { id: 'closest', evidence: 'estimate', harmonic: { cosine: 0.99 }, tempo: { qualified: false }, pitch: { suggested: 5 }, vocal: { status: 'present' } },
      { id: 'playable', evidence: 'estimate', harmonic: { cosine: 0.95 }, tempo: { qualified: true }, pitch: { suggested: 0 }, vocal: { status: 'present' } },
      { id: 'blank', evidence: 'missing', harmonic: { cosine: null } },
    ],
  };
  const choice = deckChoice(rank);
  assert.equal(choice.id, 'playable');
  assert.equal(choice.adventurous, true);
  assert.equal(choice.uncertain, true);
  assert.deepEqual(scoredRows(rank).map((row) => row.id), ['closest', 'playable']);
});

test('a large agreed pitch is shown in a jam and left alone when the decks are playing', () => {
  const row = { pitch: { autoApply: true, suggested: 5, note: 'A shift of +5 semitones is outside the qualified range.' } };
  assert.equal(pitchFor(row, { auto: false }).semitones, 5);
  const held = pitchFor(row, { auto: true });
  assert.equal(held.semitones, 0);
  assert.equal(held.applied, false);
  assert.match(held.note, /leaving the pitch alone/);
  const small = pitchFor({ pitch: { autoApply: true, suggested: -1, note: 'one down' } }, { auto: true });
  assert.equal(small.semitones, -1);
  assert.equal(small.unqualified, true);
});

test('beat-sync is used only when the project tempo is the qualified ratio', () => {
  assert.equal(playbackSpeed(0.909, 100 / 110), 'fit');
  assert.equal(playbackSpeed(0.909, 220 / 110), 'natural');
  assert.equal(playbackSpeed(1.2, 1.21), 'natural');
  assert.equal(playbackSpeed(0.857, 0.85), 'natural');
  assert.equal(playbackSpeed(2, 2), 'natural');
  assert.equal(playbackSpeed(null, 1), 'natural');
});

test('a chorus is placed where that source time is heard, not at its source bar', () => {
  const state = {
    transport: { masterBpm: 220 },
    assets: { a: { nativeBpm: 100, source: { section: { startSec: 0 } } } },
    clips: [{ id: 'a-vocal', trackIndex: 0, assetId: 'a', timelineStartBeat: 0, sourceOffsetSec: 0, durationBeats: 80, stretchMode: 'manual', customStretchRatio: 1 }],
  };
  const beat = arrangementBeatForSource(state, 'A', 9.6);
  assert.ok(Math.abs(beat - 35.2) < 1e-9, `heard at ${beat}`);
  state.transport.masterBpm = 100;
  assert.ok(Math.abs(arrangementBeatForSource(state, 'A', 9.6) - 16) < 1e-9);
});

test('an arrangement is two different sketches, and a pitch reading is not applied', () => {
  const rank = {
    ask: false,
    ambiguityGap: 0.05,
    candidates: [
      { id: 'chorus', evidence: 'estimate', harmonic: { cosine: 0.91 }, tempo: { qualified: true }, pitch: { suggested: 0 }, vocal: { status: 'present' } },
      { id: 'verse', evidence: 'estimate', harmonic: { cosine: 0.72 }, tempo: { qualified: false, applyStretch: 1.4 }, pitch: { suggested: 3 }, vocal: { status: 'present' } },
    ],
  };
  const sections = [
    { id: 'chorus', bars: 8 },
    { id: 'verse', bars: 4 },
  ];
  const { plans } = arrangementPlans({ rank, sections, chorusBeat: 16, bpb: 4 });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].id, 'lock');
  assert.equal(plans[0].vocal.stem, 'vocals');
  assert.equal(plans[0].vocal.pitch, 0);
  assert.equal(plans[0].vocal.speed, 'fit');
  assert.equal(plans[0].parts[0].stem, 'drums');
  assert.equal(plans[0].parts[0].speed, 'natural');
  assert.equal(plans[0].parts[0].pitch, 0);
  assert.equal(plans[0].parts[0].startBeat, 16 + 8 * 4);
  assert.equal(plans[0].trims[0].stem, 'vocals');
  assert.equal(plans[1].vocal.stem, 'drums');
  assert.notEqual(plans[0].vocal.stem, plans[1].vocal.stem);
  const measured = measurePlan(plans[0]);
  assert.equal(measured.flags.bothSongs, true);
  assert.equal(measured.flags.pitchLeftAlone, true);
  assert.equal(pickPlan(plans, { surprise: true }).id, 'swap');
  const energetic = stylePlan(plans[0], 'energy');
  assert.equal(energetic.entranceBars, 1);
  assert.match(energetic.issues.at(-1), /not a measurement of energy/);
});

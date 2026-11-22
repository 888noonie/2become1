// Chorus Fit on the real Producer card.
//
// Listening documents are fixtures. POST /api/chorus-fit is the worktree's
// rank_fit, not a scripted winner. The language model is not called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { setupDom, teardownDom } from './helpers/dom.js';
import { mountArrangementPanel } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { mountArrangementProducer } from '../../src/twobecomeone/studio_static/js/components/arrangement-producer.js';
import { gainLinearAtBeat } from '../../src/twobecomeone/studio_static/js/arrangement/automation.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAJOR = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
const CLUSTER = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const SR = 48000;
const SHARED = new Float32Array(30 * SR).map((_, i) => 0.2 * Math.sin(i / 18));

function section(id, name, label, startBar, chroma, vocal) {
  const bar = 2.4;
  const start = (startBar - 1) * bar;
  return {
    id, name, label, startBar, bars: 4, startSec: start, endSec: start + 4 * bar,
    basis: 'estimated', confidence: 0.8, evidence: ['synthetic chroma'], vocalPresence: vocal,
    meanChroma: chroma, swingRatio: 0.5, lyrics: null,
  };
}

function analysis(trackId, title, bpm, sections) {
  return {
    trackId, title, bpm, barSec: 2.4, firstBarSec: 0, stemSetId: `set${trackId}`, stemSampleRate: 44100,
    key: 'C major', lyrics: { available: false, note: 'synthetic' }, sections,
  };
}

const ANALYSIS = {
  A: analysis('tA', 'Song A', 100, [
    section('a-verse', 'verse 1', 'verse', 1, CLUSTER, 0.1),
    section('a-chorus', 'chorus 1', 'chorus', 5, MAJOR, 0.9),
  ]),
  B: analysis('tB', 'Song B', 110, [
    section('b-match', 'chorus 1', 'chorus', 1, MAJOR, 0.8),
    section('b-decoy', 'verse 1', 'verse', 5, CLUSTER, 0.9),
    section('b-blank', 'bridge 1', 'bridge', 9, null, 0.2),
  ]),
};

function rankFit(body) {
  const run = spawnSync('.venv/bin/python', ['-c', `
import json, sys
from twobecomeone.chorus_fit import rank_fit
body = json.loads(sys.stdin.read())
json.dump(rank_fit(body["target"], body["candidates"]), sys.stdout)
`], {
    input: JSON.stringify(body),
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: `${ROOT}/src` },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(run.stderr || 'rank_fit failed');
  return JSON.parse(run.stdout);
}

function cut(song, sectionId) {
  const doc = ANALYSIS[song];
  const section = doc.sections.find((item) => item.id === sectionId);
  const lead = Math.min(doc.barSec, section.startSec);
  const startFrame = Math.round((section.startSec - lead) * doc.stemSampleRate);
  return { startFrame, inPoint: section.startSec - startFrame / doc.stemSampleRate, startSec: section.startSec };
}

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => { globalThis.creativeGate = null; globalThis.creativeReply = null; teardownDom(dom); });

async function mounted(extra = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? 'GET', body });
    if (url === '/api/producer/model') return reply(200, { provider: 'ollama', model: 'unavailable', local: true, available: false, note: 'not used by this path' });
    if (url === '/api/chorus-fit') return reply(200, rankFit(body));
    if (url === '/api/tracks/tA/listening') return reply(200, ANALYSIS.A);
    if (url === '/api/tracks/tB/listening') return reply(200, ANALYSIS.B);
    if (url === '/api/producer/converse') return reply(503, { error: { code: 'PRODUCER_MODEL_UNAVAILABLE', message: 'model not running' } });
    if (url === '/api/producer/creative') {
      if (globalThis.creativeGate) await globalThis.creativeGate;
      return reply(200, globalThis.creativeReply ?? { move: 'none', model: 'fixture', local: true });
    }
    return reply(200, {});
  };
  const s = new DawSession({
    fetchImpl, decodeAudio: async () => ({ sampleRate: SR, numberOfChannels: 1, length: SHARED.length, getChannelData: () => SHARED }),
    createContext: extra.createContext ?? (() => { throw new Error('no audio in this test'); }),
    RealtimeEngine: extra.RealtimeEngine ?? class {}, renderOffline: async () => { throw new Error('not used'); }, StretchFactory: () => null, modules: {},
  });
  const container = document.getElementById('main');
  const api = mountArrangementPanel({
    container, session: s, listTracks: async () => ({ items: [] }), listStems: async () => ({ variants: [] }),
    producer: mountArrangementProducer,
  });
  for (const song of ['A', 'B']) {
    const doc = ANALYSIS[song];
    await s.importGroup(song, {
      trackId: doc.trackId, title: doc.title, bpm: doc.bpm, section: { startSec: 0, seconds: 30 },
      stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/set${doc.trackId}/audio?name=${role}&start=0&duration=30`, stemSetId: `set${doc.trackId}` })),
    });
  }
  api.render();
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const tell = async (text) => {
    const input = prod.querySelector('.daw__talk-input');
    input.value = text;
    prod.querySelector('.daw__talk').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 80 && (input.disabled || prod.querySelectorAll('.daw__talk-log li').length % 2); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return [...prod.querySelectorAll('.daw__talk-log li')].at(-1)?.textContent ?? '';
  };
  return { api, s, calls, container, prod, btn, tell };
}

const ideaClip = (s) => s.state.clips.find((c) => c.id.startsWith('idea-'));
const assetOf = (s, clip) => s.state.assets[clip.assetId];

test('a chorus fit uses the real ranker, keeps the target, and stays reversible', async () => {
  const { s, calls, container, btn, tell } = await mounted();
  const before = s.state.clips.map((c) => c.id);
  const said = await tell('Which part of B fits this chorus?');
  assert.match(said, /chorus 1/);
  assert.match(said, /verse 1/);
  assert.match(said, /not a chord-by-chord proof/);
  assert.match(said, /fitted from 110 to 100 BPM|Stretch 0\.909/);
  assert.equal(calls.filter((c) => c.url === '/api/producer/converse').length, 0);
  const fit = calls.find((c) => c.url === '/api/chorus-fit');
  assert.equal(fit.body.target.id, 'a-chorus');
  assert.equal(fit.body.target.startSec, ANALYSIS.A.sections[1].startSec);
  assert.ok(fit.body.candidates.some((c) => c.meanChroma == null));
  assert.deepEqual(s.state.clips.map((c) => c.id), before, 'the idea is not written before Hear it');
  assert.ok(container.querySelector('.daw__lane[data-track="4"] .daw__ghost'));

  btn('Hear it').click();
  let clip = ideaClip(s);
  assert.equal(clip.timelineStartBeat, 16);
  assert.equal(clip.pitchSemitones, 0);
  assert.equal(clip.stretchMode, 'beat_sync');
  const match = cut('B', 'b-match');
  assert.equal(clip.sourceOffsetSec, match.inPoint);
  assert.equal(match.startFrame, 0);
  assert.match(assetOf(s, clip).bufferReference, /start=0/);

  const next = await tell('Try the next best match instead');
  assert.match(next, /verse 1/);
  assert.match(next, /chorus 1 of song A/);
  clip = ideaClip(s);
  const decoy = cut('B', 'b-decoy');
  assert.equal(assetOf(s, clip).source.section.startFrame, decoy.startFrame);
  assert.equal(assetOf(s, clip).source.passage.startSec, decoy.startSec);
  assert.ok(Math.abs(clip.sourceOffsetSec - decoy.inPoint) < 1e-6);
  assert.equal(clip.timelineStartBeat, 16, 'the chorus target stays put');
  assert.notEqual(decoy.startFrame, match.startFrame);

  await tell('Put it at bar 17');
  assert.equal(ideaClip(s).timelineStartBeat, 64);
  await tell('Make the fade gentler');
  assert.equal(ideaClip(s).fadeInBeats, 4);
  await tell('Move the idea half a beat earlier');
  clip = ideaClip(s);
  assert.equal(clip.timelineStartBeat, 63.5);
  assert.equal(clip.fadeInBeats, 4);
  assert.equal(clip.pitchSemitones, 0);

  s.apply({ name: 'moveClip', args: { clipId: clip.id, newTrackIndex: 4, newStartBeat: 70 } });
  await tell('Try the strongest match');
  clip = ideaClip(s);
  assert.equal(clip.timelineStartBeat, 70, 'the hand move wins');
  assert.match(assetOf(s, clip).bufferReference, /name=vocals&start=0/);
  assert.ok(Math.abs(clip.sourceOffsetSec - match.inPoint) < 1e-6);

  assert.match(await tell('Hear mine'), /your version/);
  assert.equal(ideaClip(s), undefined);
  btn('Hear it').click();
  assert.equal(ideaClip(s).timelineStartBeat, 70);
  assert.match(await tell('Keep this version'), /Kept/);
  assert.ok(ideaClip(s));
  assert.match(await tell('undo it'), /Undone|Back to your version/);
  assert.equal(ideaClip(s), undefined);
  assert.equal(calls.filter((c) => c.url === '/api/producer/converse').length, 0);
});

test('You play explains a fit and writes nothing', async () => {
  const { s, calls, container, btn, tell } = await mounted();
  const before = s.edit.serialize();
  btn('You play').click();
  const said = await tell('Which part of song B fits this chorus');
  assert.match(said, /You play is on/);
  assert.match(said, /cosine/);
  assert.equal(container.querySelector('.daw__ghost'), null);
  assert.equal(s.edit.serialize(), before);
  assert.equal(calls.filter((c) => c.url === '/api/producer/converse').length, 0);
});

test('a rejected preview does not change the arrangement', async () => {
  const { s, btn, tell } = await mounted();
  const before = s.edit.serialize();
  await tell('Which part of B fits this chorus?');
  btn('Reject').click();
  assert.equal(s.edit.serialize(), before);
});

test('Take the decks writes both songs, and another sketch keeps a hand edit', async () => {
  const { s, tell } = await mounted();
  const vocal = s.state.clips.find((clip) => clip.trackIndex === 0);
  const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
  const vocalBefore = vocal.durationBeats;
  const drumsBefore = drums.durationBeats;
  const said = await tell('Take the decks');
  assert.match(said, /did not audition the audio/);
  const ideas = s.state.clips.filter((clip) => String(clip.id).startsWith('idea-'));
  assert.ok(ideas.length >= 2, `expected a vocal and a handoff, saw ${ideas.map((clip) => clip.id).join(', ')}`);
  assert.ok(ideas.some((clip) => clip.trackIndex === 4), 'B vocals are in the arrangement');
  assert.ok(ideas.some((clip) => clip.trackIndex === 5), 'B drums take over later');
  const vocalIdea = ideas.find((clip) => clip.trackIndex === 4);
  const drumIdea = ideas.find((clip) => clip.trackIndex === 5);
  assert.ok(Math.abs(drumIdea.timelineStartBeat - (vocalIdea.timelineStartBeat + vocalIdea.durationBeats)) < 0.05, 'the drums follow the vocal that was placed');
  const bedNow = s.state.clips.find((clip) => clip.id === drums.id);
  assert.ok(Math.abs((bedNow.timelineStartBeat + bedNow.durationBeats) - drumIdea.timelineStartBeat) < 0.05, 'the old drums meet the new drums');
  assert.ok(s.state.clips.find((clip) => clip.id === vocal.id).durationBeats < vocalBefore - 1);
  assert.ok(s.state.clips.find((clip) => clip.id === drums.id).durationBeats < drumsBefore - 1);
  s.apply({ name: 'setTrackVolume', args: { trackIndex: 1, volumeDb: -9 } });
  const again = await tell('Try another arrangement');
  assert.match(again, /Instruments lead/);
  assert.equal(s.state.tracks[1].volumeDb, -9);
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(s.state.tracks[1].volumeDb, -9);
  assert.ok(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')), 'the hand edit keeps the earlier sketch');
});

test('You play does not nudge a take', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const starts = s.state.clips.filter((clip) => String(clip.id).startsWith('idea-')).map((clip) => [clip.id, clip.timelineStartBeat]);
  await tell('You play');
  assert.match(await tell('Half a beat earlier'), /You play is on/);
  for (const [id, beat] of starts) assert.equal(s.state.clips.find((clip) => clip.id === id).timelineStartBeat, beat);
});

test('returning to the first sketch trims the bed to the same handoff', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const bed = () => s.state.clips.find((clip) => clip.trackIndex === 1 && !String(clip.id).startsWith('idea-'));
  const first = bed().durationBeats;
  await tell('Try another arrangement');
  const second = bed().durationBeats;
  await tell('Try another arrangement');
  const third = bed().durationBeats;
  assert.ok(Math.abs(second - first) > 1, `second ${second} first ${first}`);
  assert.ok(Math.abs(third - second) > 1, `third ${third} second ${second}`);
});

test('a one-and-a-half-beat remainder still accepts the sketch', async () => {
  const { s, tell } = await mounted();
  const vocal = s.state.clips.find((clip) => clip.trackIndex === 0);
  s.apply({ name: 'moveClip', args: { clipId: vocal.id, newTrackIndex: 0, newStartBeat: 14.5 } });
  assert.match(await tell('Take the decks'), /on the lanes|playing/);
  assert.ok(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')));
});

test('an in-flight take does not write a stem set that has been replaced', async () => {
  const { s, tell } = await mounted();
  const original = s.loadSource.bind(s);
  let release;
  let paused = false;
  s.loadSource = (spec) => {
    if (paused) return original(spec);
    paused = true;
    return new Promise((resolve, reject) => { release = () => original(spec).then(resolve, reject); });
  };
  const pending = tell('Take the decks');
  for (let i = 0; i < 150 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
  const clip = s.state.clips.find((item) => item.trackIndex >= 4);
  s.state.assets[clip.assetId].source.stemSetId = 'replaced-set';
  release();
  assert.match(await pending, /lanes changed|have not placed/);
  assert.equal(s.state.clips.filter((item) => String(item.id).startsWith('idea-')).length, 0);
});

test('a fast project keeps the handoff at the passage’s own speed', async () => {
  const { s, tell } = await mounted();
  s.state.transport.masterBpm = 220;
  await tell('Take the decks');
  const ideas = s.state.clips.filter((clip) => String(clip.id).startsWith('idea-'));
  assert.ok(ideas.length >= 2);
  for (const clip of ideas) {
    assert.equal(clip.stretchMode, 'manual');
    assert.equal(clip.customStretchRatio, 1);
  }
});

test('energy, a different structure, and the previous vocal stay editable', async () => {
  const { s, prod, tell } = await mounted();
  const pressed = () => prod.querySelector('button[aria-pressed="true"]').textContent;
  await tell('Take the decks');
  const vocal = () => s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  const passage = (clip) => s.state.assets[clip.assetId]?.source?.passage?.name;
  const firstStart = vocal().timelineStartBeat;
  const firstName = passage(vocal());
  const secondReply = await tell('Try something completely different');
  const thirdReply = await tell('Try something completely different');
  assert.notEqual(vocal().timelineStartBeat, firstStart, `${secondReply} || ${thirdReply} || start ${vocal()?.timelineStartBeat} was ${firstStart}`);
  assert.notEqual(passage(vocal()), firstName, `${passage(vocal())} vs ${firstName}`);
  const keptStart = vocal().timelineStartBeat;
  await tell('I preferred the previous vocal');
  assert.equal(passage(vocal()), firstName);
  assert.equal(vocal().timelineStartBeat, keptStart);
  await tell("That works. I'll take over.");
  assert.equal(pressed(), 'Jam together');
  assert.match(await tell('Try something completely different'), /Take the decks when/);
});

test('more energy brings the vocal in sooner', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const vocal = () => s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  const start = vocal().timelineStartBeat;
  await tell('Give it more energy');
  assert.ok(vocal().timelineStartBeat < start, `${vocal().timelineStartBeat} vs ${start}`);
});

test('Take back during the fetch does not place the take', async () => {
  const { s, prod, tell } = await mounted();
  const original = s.loadSource.bind(s);
  let release;
  s.loadSource = (spec) => new Promise((resolve, reject) => { release = () => original(spec).then(resolve, reject); });
  const pending = tell('Take the decks');
  for (let i = 0; i < 150 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
  const stopped = tell('Take back');
  release();
  await pending;
  await stopped;
  assert.equal(s.state.clips.filter((clip) => String(clip.id).startsWith('idea-')).length, 0);
  assert.equal(prod.querySelector('button[aria-pressed="true"]').textContent, 'Jam together');
});

test('Take the decks writes one arrangement and Take back restores it', async () => {
  const { s, prod, btn, tell } = await mounted();
  const strip = (text) => {
    const copy = JSON.parse(text);
    delete copy.transport.playheadBeat;
    delete copy.transport.isPlaying;
    return JSON.stringify(copy);
  };
  const before = strip(s.edit.serialize());
  const said = await tell('Make something beautiful from these two songs');
  assert.match(said, /on the lanes|playing/);
  assert.ok(ideaClip(s), 'the decks write without a separate Hear it');
  assert.equal(prod.querySelector('button[aria-pressed="true"]').textContent, 'Take the decks');
  const entrance = s.state.tracks[4].gainPoints;
  assert.ok(entrance.length >= 2 && entrance[0].db < entrance[entrance.length - 1].db, 'the vocal entrance rises');
  s.apply({ name: 'moveClip', args: { clipId: ideaClip(s).id, newTrackIndex: 4, newStartBeat: 80 } });
  assert.match(await tell('Take back'), /will not take that away/);
  assert.equal(ideaClip(s).timelineStartBeat, 80);
  const fresh = await mounted();
  const origin = strip(fresh.s.edit.serialize());
  await fresh.tell('Take the decks');
  assert.notEqual(strip(fresh.s.edit.serialize()), origin);
  assert.match(await fresh.tell('Take back'), /decks are yours/);
  assert.equal(strip(fresh.s.edit.serialize()), origin);
  assert.equal(fresh.prod.querySelector('button[aria-pressed="true"]').textContent, 'Jam together');
});

test('Take back undoes the latest take and leaves a hand edit made before it', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
  s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -9 } });
  await tell('Take the decks');
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, -9);
});

test('a project tempo outside the qualified ratio does not beat-sync the passage', async () => {
  const { s, btn, tell } = await mounted();
  s.state.transport.masterBpm = 220;
  const said = await tell('Try the strongest match');
  assert.match(said, /keeps its own speed/);
  btn('Hear it').click();
  const clip = ideaClip(s);
  assert.equal(clip.stretchMode, 'manual');
  assert.equal(clip.customStretchRatio, 1);
});

test('the next passage can put the pitch back to zero', async () => {
  const originalKey = ANALYSIS.B.key;
  const originalChroma = ANALYSIS.B.sections[0].meanChroma;
  ANALYSIS.B.key = 'D major';
  ANALYSIS.B.sections[0].meanChroma = originalChroma.slice(10).concat(originalChroma.slice(0, 10));
  try {
    const { s, btn, tell } = await mounted();
    await tell('Try the strongest match');
    btn('Hear it').click();
    assert.equal(ideaClip(s).pitchSemitones, -2);
    await tell('Try the next best match instead');
    assert.equal(ideaClip(s).pitchSemitones, 0);
  } finally {
    ANALYSIS.B.key = originalKey;
    ANALYSIS.B.sections[0].meanChroma = originalChroma;
  }
});

test('Hear it rechecks the project tempo instead of replaying a stale fit', async () => {
  const { s, btn, tell } = await mounted();
  await tell('Try the strongest match');
  s.state.transport.masterBpm = 220;
  btn('Hear it').click();
  for (let i = 0; i < 40 && ideaClip(s)?.stretchMode !== 'manual'; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const clip = ideaClip(s);
  assert.equal(clip.stretchMode, 'manual');
  assert.equal(clip.customStretchRatio, 1);
});

test('a natural-speed chorus is matched where it is heard', async () => {
  const { s, btn, tell } = await mounted();
  const vocal = s.state.clips.find((clip) => clip.trackIndex === 0);
  s.apply({ name: 'setClipStretch', args: { clipId: vocal.id, ratioOrAuto: 1 } });
  s.state.transport.masterBpm = 220;
  await tell('Try the strongest match');
  btn('Hear it').click();
  const clip = ideaClip(s);
  assert.ok(Math.abs(clip.timelineStartBeat - 35.2) < 1e-6, `placed at ${clip.timelineStartBeat}`);
});

test('a hand edit during Play is not inside the Take back checkpoint', async () => {
  const { s, tell } = await mounted();
  const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
  s.play = async () => {
    s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -9 } });
    return false;
  };
  await tell('Take the decks');
  assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, -9);
  assert.match(await tell('Take back'), /will not take that away/);
  assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, -9);
});

test('Take back includes a Producer move made while the decks are still held', async () => {
  const { s, tell } = await mounted();
  const strip = (text) => {
    const copy = JSON.parse(text);
    delete copy.transport.playheadBeat;
    delete copy.transport.isPlaying;
    return JSON.stringify(copy);
  };
  const origin = strip(s.edit.serialize());
  await tell('Take the decks');
  await tell('Put it at bar 17');
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(strip(s.edit.serialize()), origin);
});

test('a failed passage load does not commit the previous preview', async () => {
  const { s, tell } = await mounted();
  await tell('Try the strongest match');
  const before = s.edit.serialize();
  const match = ANALYSIS.B.sections[0].meanChroma;
  const decoy = ANALYSIS.B.sections[1].meanChroma;
  ANALYSIS.B.sections[0].meanChroma = decoy.slice();
  ANALYSIS.B.sections[1].meanChroma = match.slice();
  s.loadSource = async () => { throw new Error('uncached'); };
  try {
    const said = await tell('Take the decks');
    assert.match(said, /couldn.t load|could not load/i);
    assert.equal(s.edit.serialize(), before);
  } finally {
    ANALYSIS.B.sections[0].meanChroma = match;
    ANALYSIS.B.sections[1].meanChroma = decoy;
  }
});

test('You play during a take stops the clip from landing', async () => {
  const match = ANALYSIS.B.sections[0].meanChroma.slice();
  const decoy = ANALYSIS.B.sections[1].meanChroma.slice();
  ANALYSIS.B.sections[0].meanChroma = decoy.slice();
  ANALYSIS.B.sections[1].meanChroma = match.slice();
  try {
    const { s, prod, tell } = await mounted();
    const count = s.state.clips.length;
    let release;
    s.loadSource = () => new Promise((resolve) => { release = resolve; });
    const pending = tell('Take the decks');
    for (let i = 0; i < 150 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(release, 'the take waited on the passage');
    [...prod.querySelectorAll('button')].find((b) => b.textContent === 'You play').click();
    release();
    const said = await pending;
    assert.match(said, /You play is on/);
    assert.equal(s.state.clips.length, count);
  } finally {
    ANALYSIS.B.sections[0].meanChroma = match;
    ANALYSIS.B.sections[1].meanChroma = decoy;
  }
});

test('Hear it after a tempo change follows the chorus that is now heard', async () => {
  const { s, btn, tell } = await mounted();
  const vocal = s.state.clips.find((clip) => clip.trackIndex === 0);
  s.apply({ name: 'setClipStretch', args: { clipId: vocal.id, ratioOrAuto: 1 } });
  await tell('Try the strongest match');
  s.state.transport.masterBpm = 220;
  btn('Hear it').click();
  for (let i = 0; i < 40 && Math.abs((ideaClip(s)?.timelineStartBeat ?? 0) - 35.2) > 1e-6; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const clip = ideaClip(s);
  assert.ok(Math.abs(clip.timelineStartBeat - 35.2) < 1e-6, `placed at ${clip.timelineStartBeat}`);
  assert.equal(clip.stretchMode, 'manual');
});

test('typing Hear it uses the tempo at commit time', async () => {
  const { s, tell } = await mounted();
  await tell('Try the strongest match');
  s.state.transport.masterBpm = 220;
  const said = await tell('Hear it');
  assert.match(said, /Hearing the idea/);
  assert.equal(ideaClip(s).stretchMode, 'manual');
  assert.equal(ideaClip(s).customStretchRatio, 1);
});

test('a hand edit during the load survives Take back', async () => {
  const match = ANALYSIS.B.sections[0].meanChroma.slice();
  const decoy = ANALYSIS.B.sections[1].meanChroma.slice();
  ANALYSIS.B.sections[0].meanChroma = decoy.slice();
  ANALYSIS.B.sections[1].meanChroma = match.slice();
  try {
    const { s, tell } = await mounted();
    const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
    const original = s.loadSource.bind(s);
    let release;
    s.loadSource = (spec) => new Promise((resolve, reject) => {
      release = () => original(spec).then(resolve, reject);
    });
    const pending = tell('Take the decks');
    for (let i = 0; i < 150 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
    s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -9 } });
    release();
    await pending;
    assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, -9);
    assert.match(await tell('Take back'), /decks are yours/);
    assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, -9);
  } finally {
    ANALYSIS.B.sections[0].meanChroma = match;
    ANALYSIS.B.sections[1].meanChroma = decoy;
  }
});

test('a hand edit between a take and a later move is not undone', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
  s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -9 } });
  await tell('Put it at bar 17');
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, -9);
  assert.notEqual(ideaClip(s).timelineStartBeat, 64);
});

test('moving the passage moves its entrance with it', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Put it at bar 17');
  const points = s.state.tracks[4].gainPoints;
  assert.ok(points.length >= 2 && points[0].beat >= 64, `entrance starts at ${points[0]?.beat}`);
});

test('several Producer moves still Take back as one experiment', async () => {
  const { s, tell } = await mounted();
  const strip = (text) => {
    const copy = JSON.parse(text);
    delete copy.transport.playheadBeat;
    delete copy.transport.isPlaying;
    return JSON.stringify(copy);
  };
  const origin = strip(s.edit.serialize());
  await tell('Take the decks');
  for (const bar of [17, 18, 19, 20, 21, 22]) await tell(`Put it at bar ${bar}`);
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(strip(s.edit.serialize()), origin);
});

test('a new arrangement during a take does not receive the old passage', async () => {
  const match = ANALYSIS.B.sections[0].meanChroma.slice();
  const decoy = ANALYSIS.B.sections[1].meanChroma.slice();
  ANALYSIS.B.sections[0].meanChroma = decoy.slice();
  ANALYSIS.B.sections[1].meanChroma = match.slice();
  try {
    const { s, tell } = await mounted();
    let release;
    s.loadSource = () => new Promise((resolve) => { release = resolve; });
    const pending = tell('Take the decks');
    for (let i = 0; i < 150 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
    await s.newProject();
    release();
    const said = await pending;
    assert.match(said, /new arrangement/);
    assert.equal(s.state.clips.length, 0);
  } finally {
    ANALYSIS.B.sections[0].meanChroma = match;
    ANALYSIS.B.sections[1].meanChroma = decoy;
  }
});

test('Half a beat earlier keeps the take and moves it', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Put it at bar 17');
  const said = await tell('Half a beat earlier');
  assert.doesNotMatch(said, /press Hear it/i);
  const clip = ideaClip(s);
  assert.ok(Math.abs(clip.timelineStartBeat - 63.5) < 1e-6, `placed at ${clip.timelineStartBeat}`);
  assert.ok(s.state.tracks[4].gainPoints[0].beat >= 63);
});

test('You play does not write when Hear it is typed', async () => {
  const { s, prod, tell } = await mounted();
  await tell('Try the strongest match');
  const count = s.state.clips.length;
  [...prod.querySelectorAll('button')].find((b) => b.textContent === 'You play').click();
  const said = await tell('Hear it');
  assert.match(said, /You play is on/);
  assert.equal(s.state.clips.length, count);
});

test('setting a gain and putting it back does not let Take back unwind those edits', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
  s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -9 } });
  s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: 0 } });
  assert.match(await tell('Take back'), /will not take that away/);
  assert.ok(ideaClip(s));
  assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, 0);
});

test('an explicit natural speed is not fitted again', async () => {
  const { s, btn, tell } = await mounted();
  await tell('Try the strongest match');
  btn('Hear it').click();
  const said = await tell('Play the idea at its own speed');
  assert.match(said, /own speed/);
  assert.equal(ideaClip(s).stretchMode, 'manual');
  assert.equal(ideaClip(s).customStretchRatio, 1);
});

test('replacing a song during a take does not bring the old passage back', async () => {
  const match = ANALYSIS.B.sections[0].meanChroma.slice();
  const decoy = ANALYSIS.B.sections[1].meanChroma.slice();
  ANALYSIS.B.sections[0].meanChroma = decoy.slice();
  ANALYSIS.B.sections[1].meanChroma = match.slice();
  try {
    const { s, tell } = await mounted();
    const original = s.loadSource.bind(s);
    let release;
    s.loadSource = (spec) => new Promise((resolve, reject) => {
      release = () => original(spec).then(resolve, reject);
    });
    const pending = tell('Take the decks');
    for (let i = 0; i < 150 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
    const doc = ANALYSIS.B;
    await s.importGroup('B', {
      trackId: 'tC', title: 'Song C', bpm: 100, section: { startSec: 0, seconds: 30 },
      stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/setC/audio?name=${role}&start=0&duration=30`, stemSetId: 'setC' })),
    });
    release();
    const said = await pending;
    assert.match(said, /lanes changed/);
    assert.equal(s.state.clips.filter((clip) => clip.trackIndex >= 4).length, 4);
    assert.equal(ideaClip(s), undefined);
    void doc;
  } finally {
    ANALYSIS.B.sections[0].meanChroma = match;
    ANALYSIS.B.sections[1].meanChroma = decoy;
  }
});

test('Hear it does not place a preview after the song on that bank has changed', async () => {
  const { s, btn, tell } = await mounted();
  await tell('Try the strongest match');
  await s.importGroup('B', {
    trackId: 'tC', title: 'Song C', bpm: 100, section: { startSec: 0, seconds: 30 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/setC/audio?name=${role}&start=0&duration=30`, stemSetId: 'setC' })),
  });
  btn('Hear it').click();
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(ideaClip(s), undefined);
  assert.equal(s.state.clips.filter((clip) => clip.trackIndex >= 4).length, 4);
});

test('a bar move does not apply the previous song after the bank is replaced', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await s.importGroup('B', {
    trackId: 'tC', title: 'Song C', bpm: 100, section: { startSec: 0, seconds: 30 },
    stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/setC/audio?name=${role}&start=0&duration=30`, stemSetId: 'setC' })),
  });
  const said = await tell('Put it at bar 17');
  assert.match(said, /lanes changed/);
  assert.equal(s.state.clips.filter((clip) => clip.trackIndex >= 4).length, 4);
  assert.equal(ideaClip(s), undefined);
});

test('a later move does not let Take back cross a fader that was put back', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const drums = s.state.clips.find((clip) => clip.trackIndex === 1);
  s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -9 } });
  s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: 0 } });
  await tell('Put it at bar 17');
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(s.state.clips.find((clip) => clip.id === drums.id).clipGainDb, 0);
  assert.ok(ideaClip(s));
  assert.notEqual(ideaClip(s).timelineStartBeat, 64);
});

test('Take back during preparation does not start playback', async () => {
  let release;
  class Engine {
    constructor() { this.phaseName = 'ready'; }
    prepare() { return new Promise((done) => { release = () => { this.phaseName = 'ready'; done(); }; }); }
    play() { this.phaseName = 'playing'; }
    stop() { this.phaseName = 'stopped'; }
    state() { return { phase: this.phaseName, loop: null }; }
    setLoop() {}
    dispose() {}
  }
  const gain = { connect() {}, gain: { value: 1 } };
  const { s, tell, btn } = await mounted({
    createContext: () => ({ state: 'running', currentTime: 0, destination: {}, createGain: () => gain, resume: async () => {} }),
    RealtimeEngine: Engine,
  });
  const pending = tell('Take the decks');
  for (let i = 0; i < 40 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(release, 'preparation started');
  btn('Take back').click();
  release();
  await pending;
  assert.equal(s.isPlaying(), false);
});

test('typing You play stops a take that is already playing', async () => {
  class Engine {
    constructor() { this.phaseName = 'ready'; }
    prepare() { return Promise.resolve(); }
    play() { this.phaseName = 'playing'; }
    stop() { this.phaseName = 'stopped'; }
    state() { return { phase: this.phaseName, loop: null }; }
    setLoop() {}
    dispose() {}
  }
  const gain = { connect() {}, gain: { value: 1 } };
  const { s, tell, prod } = await mounted({
    createContext: () => ({ state: 'running', currentTime: 0, destination: {}, createGain: () => gain, resume: async () => {} }),
    RealtimeEngine: Engine,
  });
  await tell('Take the decks');
  assert.equal(s.isPlaying(), true);
  await tell('You play');
  assert.equal(s.isPlaying(), false);
  assert.equal(prod.querySelector('button[aria-pressed="true"]').textContent, 'You play');
});

test('a late creative reply does not retake the decks', async () => {
  let release;
  globalThis.creativeGate = new Promise((done) => { release = done; });
  globalThis.creativeReply = { move: 'surprise', model: 'fixture', local: true };
  const { s, tell, btn, prod, calls } = await mounted();
  await tell('Take the decks');
  const vocal = () => s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  const start = vocal().timelineStartBeat;
  const pending = tell('Give it some sparkle');
  for (let i = 0; i < 40 && !calls.some((call) => call.url === '/api/producer/creative'); i += 1) await new Promise((r) => setTimeout(r, 20));
  btn('Take back').click();
  release();
  await pending;
  const input = prod.querySelector('.daw__talk-input');
  for (let i = 0; i < 40 && input.disabled; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(vocal().timelineStartBeat, start);
  assert.equal(prod.querySelector('button[aria-pressed="true"]').textContent, 'Jam together');
});

test('a kept vocal and its move survive the next take', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const vocal = s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  btn('Keep it').click();
  s.apply({ name: 'moveClip', args: { clipId: vocal.id, newTrackIndex: 4, newStartBeat: 36 } });
  await tell('Take the decks and surprise me');
  const kept = s.state.clips.find((clip) => clip.id === vocal.id);
  assert.ok(kept, 'the kept vocal is still on the lanes');
  assert.equal(kept.timelineStartBeat, 36);
});

test('the previous vocal stops at four revisions', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Try something completely different');
  await tell('Try something completely different');
  await tell('Give it more energy');
  const revision = s.edit.revision;
  assert.match(await tell('I preferred the previous vocal'), /four times/);
  assert.equal(s.edit.revision, revision);
});

test('taking over does not block the next jam', async () => {
  const { tell, btn, prod } = await mounted();
  await tell('Take the decks');
  await tell("That works. I'll take over.");
  btn('Jam together').click();
  const said = await tell('Which part of B fits this chorus');
  assert.doesNotMatch(said, /You play is on/);
  assert.equal(prod.querySelector('button[aria-pressed="true"]').textContent, 'Jam together');
});

// OPERATION THE MAESTRO ------------------------------------------------------

function laneOverlaps(s, lane) {
  const clips = s.state.clips.filter((clip) => clip.trackIndex === lane);
  const out = [];
  for (let i = 0; i < clips.length; i += 1) {
    for (let j = i + 1; j < clips.length; j += 1) {
      const a = clips[i];
      const b = clips[j];
      const lo = Math.max(a.timelineStartBeat, b.timelineStartBeat);
      const hi = Math.min(a.timelineStartBeat + a.durationBeats, b.timelineStartBeat + b.durationBeats);
      if (hi - lo > 1e-6) out.push(`${a.id}&${b.id}`);
    }
  }
  return out;
}

test('a kept vocal is not doubled by the next take, and the reply says it stays', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const kept = s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  btn('Keep it').click();
  const said = await tell('Take the decks');
  // Before the repair the same vocal and drums were stacked for 17.6 beats.
  assert.deepEqual(laneOverlaps(s, 4), []);
  assert.deepEqual(laneOverlaps(s, 5), []);
  assert.match(said, /Your kept B Vocals at bar 5 .*stay in this arrangement, untouched/);
  const still = s.state.clips.find((clip) => clip.id === kept.id);
  assert.equal(still.timelineStartBeat, kept.timelineStartBeat);
  assert.equal(still.durationBeats, kept.durationBeats);
});

test('a later entrance does not silence the vocal the musician kept', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const kept = s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  btn('Keep it').click();
  const middle = kept.timelineStartBeat + kept.durationBeats / 2;
  const heardBefore = gainLinearAtBeat(s.state.tracks[4], middle);
  assert.match(await tell('Try another arrangement'), /Instruments lead/);
  const newVocal = s.state.clips.find((clip) => clip.trackIndex === 4 && clip.id !== kept.id && String(clip.id).startsWith('idea-'));
  assert.ok(newVocal.timelineStartBeat >= kept.timelineStartBeat + kept.durationBeats - 1e-6);
  // Before the repair the new lane curve held -60 dB over the kept clip (0.001).
  assert.ok(gainLinearAtBeat(s.state.tracks[4], middle) > 0.1, `kept vocal gain ${gainLinearAtBeat(s.state.tracks[4], middle)}`);
  assert.equal(gainLinearAtBeat(s.state.tracks[4], middle), heardBefore);
  assert.ok(newVocal.fadeInBeats > 1 || s.state.assets[newVocal.assetId], 'the entrance moved onto the new clip');
});

test('the Producer says what it is doing, and one tap directs it', async () => {
  const { s, prod, btn, tell } = await mounted();
  const now = () => prod.querySelector('.daw__producer-now');
  const direct = () => prod.querySelector('.daw__direct');
  assert.equal(now().dataset.state, 'jam');
  assert.equal(direct().hidden, true);
  await tell('Take the decks');
  assert.equal(now().dataset.state, 'finished');
  assert.match(now().textContent, /Finished: A keeps the drums and bass, B sings/);
  assert.equal(direct().hidden, false);
  assert.equal(btn('Previous vocal').disabled, true, 'only one vocal so far');
  btn('Try another').click();
  for (let i = 0; i < 80 && !/Instruments lead/.test(now().textContent); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.match(now().textContent, /Instruments lead/);
  btn('More energy').click();
  for (let i = 0; i < 80 && prod.querySelectorAll('.daw__talk-log li').length < 6; i += 1) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
  btn('Take over').click();
  for (let i = 0; i < 80 && now().dataset.state !== 'yours'; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(now().dataset.state, 'yours');
  assert.equal(direct().hidden, true);
  const restore = btn('Restore previous arrangement');
  for (let i = 0; i < 80 && restore.disabled; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(restore.hidden, false, 'Take over keeps the take and still offers to restore');
  assert.ok(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')), 'Take over kept the arrangement');
  restore.click();
  for (let i = 0; i < 80 && s.state.clips.some((clip) => String(clip.id).startsWith('idea-')); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')), false, [...prod.querySelectorAll('.daw__talk-log li')].map((li) => li.textContent).join(' | '));
  for (let i = 0; i < 80 && now().dataset.state !== 'jam'; i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(now().dataset.state, 'jam');
});

test('a hand edit after Take over hides Restore instead of erasing the edit', async () => {
  const { s, btn, tell } = await mounted();
  await tell('Take the decks');
  btn('Take over').click();
  for (let i = 0; i < 80 && btn('Restore previous arrangement').hidden; i += 1) await new Promise((r) => setTimeout(r, 25));
  s.apply({ name: 'setTrackVolume', args: { trackIndex: 2, volumeDb: -5 } });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(btn('Restore previous arrangement').hidden, true);
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(s.state.tracks[2].volumeDb, -5);
});

test('loose words direct the take without the model, and say so', async () => {
  const { s, calls, tell } = await mounted();
  await tell('Take the decks');
  const vocal = () => s.state.clips.find((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'));
  const start = vocal().timelineStartBeat;
  const said = await tell('make it punchier');
  assert.match(said, /I took “punch” as more energy, from the words alone; no model was used/);
  assert.ok(vocal().timelineStartBeat < start);
  assert.equal(calls.filter((c) => c.url === '/api/producer/creative').length, 0);
  assert.match(await tell('my turn'), /decks are yours/);
});

test('a more interesting transition really lengthens the drum fade it describes', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const drums = () => s.state.clips.filter((clip) => clip.trackIndex === 5 && String(clip.id).startsWith('idea-')).at(-1);
  const before = drums().fadeInBeats;
  const said = await tell('Find a more interesting transition');
  // Before the repair the reply said eight bars while the fade stayed at one bar.
  assert.ok(drums().fadeInBeats > before, `${before} -> ${drums().fadeInBeats}`);
  assert.match(said, new RegExp(`fade in over ${drums().fadeInBeats / 4} bars`));
  assert.doesNotMatch(said, /eight bars/);
});

// Independent Codex review of 32fdceb ----------------------------------------

function holdLoads(s) {
  const original = s.loadSource.bind(s);
  const gate = { release: null };
  s.loadSource = (spec) => new Promise((resolve, reject) => {
    gate.release = () => original(spec).then(resolve, reject);
  });
  gate.restore = () => { s.loadSource = original; };
  return gate;
}
const latestVocal = (s) => s.state.clips.filter((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-'))
  .sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5))).at(-1);

test('Keep pressed while the next take loads keeps that vocal on the lanes', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  await tell('Try another arrangement');
  const gate = holdLoads(s);
  const pending = tell('Try another arrangement');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release, 'the third take fetches a passage');
  const kept = latestVocal(s);
  btn('Keep it').click();
  gate.release();
  await pending;
  gate.restore();
  const still = s.state.clips.find((clip) => clip.id === kept.id);
  assert.ok(still, 'the vocal kept during the fetch is still on the lanes');
  assert.equal(still.timelineStartBeat, kept.timelineStartBeat);
  assert.deepEqual(laneOverlaps(s, 4), []);
});

test('a clip moved while the next take loads stays where the musician put it', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Try another arrangement');
  const gate = holdLoads(s);
  const pending = tell('Try another arrangement');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release);
  const vocal = latestVocal(s);
  s.apply({ name: 'moveClip', args: { clipId: vocal.id, newTrackIndex: 4, newStartBeat: vocal.timelineStartBeat + 4 } });
  gate.release();
  await pending;
  gate.restore();
  assert.equal(s.state.clips.find((clip) => clip.id === vocal.id)?.timelineStartBeat, vocal.timelineStartBeat + 4);
});

test('a chorus-fit choice while holding the decks does not double or silence a kept vocal', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const kept = latestVocal(s);
  btn('Keep it').click();
  const middle = kept.timelineStartBeat + kept.durationBeats / 2;
  const heard = gainLinearAtBeat(s.state.tracks[4], middle);
  await tell('Try the strongest match');
  assert.deepEqual(laneOverlaps(s, 4), []);
  assert.ok(s.state.clips.some((clip) => clip.id === kept.id));
  assert.equal(gainLinearAtBeat(s.state.tracks[4], middle), heard);
});

test('Restore and Take back stop at what the musician kept', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const kept = latestVocal(s);
  btn('Keep it').click();
  await tell('Try another arrangement');
  await tell('I’ll take over');
  await tell('Restore the arrangement');
  assert.ok(s.state.clips.some((clip) => clip.id === kept.id), 'Restore did not cross the Keep');
  assert.equal(s.state.clips.filter((clip) => clip.trackIndex === 4 && String(clip.id).startsWith('idea-')).length, 1);
});

test('the revision cap holds on typed choices, and a new Take the decks starts a new count', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Try another arrangement');
  await tell('Try another arrangement');
  await tell('More energy');
  const revision = s.edit.revision;
  assert.match(await tell('Try the strongest match'), /revised this 4 times/);
  assert.equal(s.edit.revision, revision);
  await tell('I’ll take over');
  assert.doesNotMatch(await tell('Take the decks'), /revised this/);
});

// Second independent Codex review (355d945) ----------------------------------

test('Keep pressed while a typed revision loads is not overwritten', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const gate = holdLoads(s);
  const pending = tell('Try the next best match instead');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release, 'the next match fetches a passage');
  const kept = latestVocal(s);
  const before = JSON.stringify(kept);
  btn('Keep it').click();
  gate.release();
  const said = await pending;
  gate.restore();
  assert.equal(JSON.stringify(s.state.clips.find((clip) => clip.id === kept.id)), before, said);
  assert.deepEqual(laneOverlaps(s, 4), []);
});

test('a hand move in Jam while the next match loads is not put back', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Try the strongest match');
  btn('Hear it').click();
  await new Promise((r) => setTimeout(r, 50));
  const vocal = latestVocal(s);
  assert.ok(vocal, 'the match is heard');
  const gate = holdLoads(s);
  const pending = tell('Try the next best match instead');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release);
  s.apply({ name: 'moveClip', args: { clipId: vocal.id, newTrackIndex: 4, newStartBeat: vocal.timelineStartBeat + 4 } });
  gate.release();
  const said = await pending;
  gate.restore();
  assert.equal(s.state.clips.find((clip) => clip.id === vocal.id)?.timelineStartBeat, vocal.timelineStartBeat + 4, said);
  assert.match(said, /while I was loading that passage/);
});

test('Restore right after a Keep changes nothing and says so', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  btn('Keep it').click();
  await tell('I’ll take over');
  const before = s.edit.revision;
  assert.match(await tell('Restore the arrangement'), /nothing of mine to put back/);
  assert.equal(s.edit.revision, before);
  assert.equal(btn('Undo').disabled, false, 'the Producer’s Undo is still there');
});

test('Undo of a kept take forgets it was kept', async () => {
  const { prod, tell, btn } = await mounted();
  await tell('Take the decks');
  btn('Keep it').click();
  btn('Undo').click();
  await tell('Try another arrangement');
  assert.equal(prod.querySelector('.daw__now-kept').hidden, true, prod.querySelector('.daw__now-kept').textContent);
});

test('the revision cap also holds on Find another section', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Try another arrangement');
  await tell('Try another arrangement');
  await tell('More energy');
  const revision = s.edit.revision;
  assert.match(await tell('Find another section that would work with A'), /revised this 4 times/);
  assert.equal(s.edit.revision, revision);
});

// Third independent Codex review (6ddcdbb) -----------------------------------

test('a bed trimmed by hand while a Jam revision loads keeps the hand trim', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  btn('Jam together').click();
  const bed = s.state.clips.find((clip) => clip.trackIndex === 1);
  const gate = holdLoads(s);
  const pending = tell('Try the next best match instead');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release, 'the next match fetches a passage');
  const trimmed = Math.round((s.state.clips.find((clip) => clip.id === bed.id).durationBeats - 6) * 1e6) / 1e6;
  s.apply({ name: 'trimClip', args: { clipId: bed.id, edge: 'end', deltaBeats: -6 } });
  gate.release();
  const said = await pending;
  gate.restore();
  const hear = btn('Hear it');
  if (hear && !hear.disabled) hear.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(Math.round(s.state.clips.find((clip) => clip.id === bed.id).durationBeats * 1e6) / 1e6, trimmed, said);
});

test('Ask for a clip idea and Ask for an idea leave a kept clip alone', async () => {
  const { s, tell, btn, prod } = await mounted();
  const bed = s.state.clips.find((clip) => clip.trackIndex === 4);
  s.apply({ name: 'deleteClip', args: { clipId: bed.id } });
  await tell('Take the decks');
  const kept = latestVocal(s);
  btn('Keep it').click();
  await tell('I’ll take over');
  const before = JSON.stringify(s.state.clips.find((clip) => clip.id === kept.id));
  btn('Ask for a clip idea').click();
  if (!btn('Hear it').disabled) btn('Hear it').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.stringify(s.state.clips.find((clip) => clip.id === kept.id)), before, prod.querySelector('.daw__producer-status').textContent);
  const keptLanes = s.state.clips.filter((clip) => String(clip.id).startsWith('idea-')).map((clip) => clip.trackIndex);
  const levels = keptLanes.map((lane) => s.state.tracks[lane].volumeDb);
  btn('Ask for an idea').click();
  if (!btn('Hear it').disabled) btn('Hear it').click();
  await new Promise((r) => setTimeout(r, 50));
  for (const [i, lane] of keptLanes.entries()) {
    assert.equal(s.state.tracks[lane].mute, false, `lane ${lane} muted`);
    assert.ok(s.state.tracks[lane].volumeDb >= levels[i], `lane ${lane} cut`);
  }
  const soloed = s.state.tracks.map((track, lane) => (track.solo ? lane : null)).filter((lane) => lane != null);
  assert.ok(!soloed.length || keptLanes.every((lane) => soloed.includes(lane)), `solo ${soloed} silences a kept lane`);
  assert.equal(JSON.stringify(s.state.clips.find((clip) => clip.id === kept.id)), before);
});

test('a curve drawn while the first take loads stands, and the take still lands', async () => {
  const { s, tell } = await mounted();
  const gate = holdLoads(s);
  const pending = tell('Take the decks');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release);
  const flat = [{ beat: 0, db: -5 }, { beat: 40, db: -5 }];
  s.apply({ name: 'setTrackGainEnvelope', args: { trackIndex: 4, points: flat } });
  gate.release();
  const said = await pending;
  gate.restore();
  assert.ok(latestVocal(s), `the take landed: ${said}`);
  assert.deepEqual(s.state.tracks[4].gainPoints.map((p) => ({ beat: p.beat, db: p.db })), flat);
});

test('Hear mine during a Jam load is not mistaken for a hand edit', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Try the strongest match');
  btn('Hear it').click();
  await new Promise((r) => setTimeout(r, 50));
  const gate = holdLoads(s);
  const pending = tell('Try the next best match instead');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release);
  btn('Hear mine').click();
  gate.release();
  const said = await pending;
  gate.restore();
  assert.doesNotMatch(said, /while I was loading/);
  assert.equal(btn('Hear it').disabled, false, `a new preview is offered: ${said}`);
});

test('a refused take does not leave the card claiming a finished take', async () => {
  const { s, tell, prod } = await mounted();
  s.loadSource = () => Promise.reject(new Error('network gone'));
  const said = await tell('Take the decks');
  assert.match(said, /network gone/);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')), false);
  assert.doesNotMatch(prod.querySelector('.daw__producer-now').textContent, /Finished|Playing my take/);
});

// Fourth independent Codex review (6c33051) ----------------------------------

test('Hear mine during a Jam load does not hide a hand trim made in the same load', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  btn('Jam together').click();
  const bed = s.state.clips.find((clip) => clip.trackIndex === 1);
  const gate = holdLoads(s);
  const pending = tell('Try the next best match instead');
  for (let i = 0; i < 150 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(gate.release);
  const trimmed = Math.round((s.state.clips.find((clip) => clip.id === bed.id).durationBeats - 6) * 1e6) / 1e6;
  s.apply({ name: 'trimClip', args: { clipId: bed.id, edge: 'end', deltaBeats: -6 } });
  const mine = btn('Hear mine');
  if (mine && !mine.disabled) mine.click();
  gate.release();
  const said = await pending;
  gate.restore();
  const hear = btn('Hear it');
  if (hear && !hear.disabled) hear.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(Math.round(s.state.clips.find((clip) => clip.id === bed.id).durationBeats * 1e6) / 1e6, trimmed, said);
});

test('Ask for a clip idea refuses a clip the musician kept', async () => {
  const { s, tell, btn, prod } = await mounted();
  const bed = s.state.clips.find((clip) => clip.trackIndex === 4);
  s.apply({ name: 'deleteClip', args: { clipId: bed.id } });
  await tell('Take the decks');
  const kept = latestVocal(s);
  btn('Keep it').click();
  await tell('I’ll take over');
  const before = JSON.stringify(s.state.clips.find((clip) => clip.id === kept.id));
  btn('Ask for a clip idea').click();
  assert.match(prod.querySelector('.daw__producer-status').textContent, /You kept that B Vocals clip/);
  assert.equal(JSON.stringify(s.state.clips.find((clip) => clip.id === kept.id)), before);
});

test('Hear it rebuilds a waiting preview that would play over a kept clip', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const kept = latestVocal(s);
  btn('Keep it').click();
  btn('Jam together').click();
  await tell('Try the strongest match');
  const outline = s.state.clips.length;
  const preview = s.state.clips.filter((clip) => clip.trackIndex === 4).length;
  assert.ok(outline && preview >= 1);
  // Move the kept vocal onto where the preview will sound.
  s.apply({ name: 'moveClip', args: { clipId: kept.id, newTrackIndex: 4, newStartBeat: kept.timelineStartBeat + kept.durationBeats } });
  await new Promise((r) => setTimeout(r, 600));
  btn('Hear it').click();
  for (let i = 0; i < 60 && btn('Hear it'); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(laneOverlaps(s, 4), []);
});

test('a take that leaves another clip sounding on its lane says so', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const said = await tell('More energy');
  if (laneOverlaps(s, 4).length) assert.match(said, /Another B Vocals clip also plays from bar \d/);
});

// Fifth independent Codex review (9dd8765) -----------------------------------

test('a later request does not stretch a bed the musician shortened by hand', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  const bed = s.state.clips.find((clip) => clip.trackIndex === 1);
  s.apply({ name: 'trimClip', args: { clipId: bed.id, edge: 'end', deltaBeats: -6 } });
  const trimmed = s.state.clips.find((clip) => clip.id === bed.id).durationBeats;
  await new Promise((r) => setTimeout(r, 600));
  const said = await tell('Make the fade gentler');
  assert.equal(s.state.clips.find((clip) => clip.id === bed.id).durationBeats, trimmed, said);
});

test('a reopened arrangement keeps its Producer clips as the musician’s', async () => {
  const { s, tell, btn } = await mounted();
  const saved = {};
  const inner = s.deps.fetchImpl;
  s.deps.fetchImpl = async (url, init = {}) => {
    const m = /^\/api\/arrangements\/([^/?]+)$/.exec(url);
    if (m && init.method === 'PUT') { saved[m[1]] = { id: m[1], ...JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => saved[m[1]] }; }
    if (m && saved[decodeURIComponent(m[1])]) return { ok: true, status: 200, json: async () => saved[decodeURIComponent(m[1])] };
    return inner(url, init);
  };
  await tell('Take the decks');
  const kept = latestVocal(s);
  btn('Keep it').click();
  const { id } = await s.save('Kept take');
  await s.open(id);
  // A reload mounts a fresh card with no memory of the Keep.
  const fresh = document.createElement('div');
  document.body.append(fresh);
  const card = mountArrangementProducer({ container: fresh, session: s, rerender: () => {} });
  await card.converse('Take the decks');
  const said = [...fresh.querySelectorAll('.daw__talk-log li')].at(-1)?.textContent ?? '';
  card.dispose();
  assert.deepEqual(laneOverlaps(s, 4), [], said);
  assert.ok(s.state.clips.some((clip) => clip.id === kept.id));
  assert.match(said, /Your kept B Vocals/);
});

test('More energy leaves the other song’s vocal a bar and does not sing over it', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('More energy');
  const vocal = latestVocal(s);
  const aVocal = s.state.clips.find((clip) => clip.trackIndex === 0 && !String(clip.id).startsWith('idea-'));
  assert.ok(aVocal.timelineStartBeat + aVocal.durationBeats <= vocal.timelineStartBeat + 1e-6,
    `A vocal ${aVocal.timelineStartBeat}+${aVocal.durationBeats} vs B vocal at ${vocal.timelineStartBeat}`);
  assert.ok(vocal.timelineStartBeat >= aVocal.timelineStartBeat + 4 - 1e-6);
});

test('Previous vocal returns to the vocal before a typed match', async () => {
  const { s, tell, btn } = await mounted();
  await tell('Take the decks');
  const passage = (clip) => s.state.assets[clip.assetId]?.source?.passage?.name;
  const first = passage(latestVocal(s));
  await tell('Try the next best match instead');
  assert.notEqual(passage(latestVocal(s)), first);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(btn('Previous vocal').disabled, false);
  const said = await tell('Previous vocal');
  assert.equal(passage(latestVocal(s)), first, said);
});

test('a decks attempt that placed nothing says so', async () => {
  const { s, tell, prod } = await mounted();
  s.loadSource = () => Promise.reject(new Error('network gone'));
  await tell('Take the decks');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(prod.querySelector('.daw__producer-now').dataset.state, 'waiting');
});

// Sixth independent Codex review (1243d87) -----------------------------------

test('Hear it right after Open does not write the old idea into the new arrangement', async () => {
  const { s, tell, btn, prod } = await mounted();
  const saved = {};
  const inner = s.deps.fetchImpl;
  s.deps.fetchImpl = async (url, init = {}) => {
    const m = /^\/api\/arrangements\/([^/?]+)$/.exec(url);
    if (m && init.method === 'PUT') { saved[m[1]] = { id: m[1], ...JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => saved[m[1]] }; }
    if (m && saved[decodeURIComponent(m[1])]) return { ok: true, status: 200, json: async () => saved[decodeURIComponent(m[1])] };
    return inner(url, init);
  };
  const { id } = await s.save('Before the idea');
  await tell('Try the strongest match');
  await s.open(id);
  btn('Hear it').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')), false);
  assert.match(prod.querySelector('.daw__producer-status').textContent, /Another arrangement is open/);
});

test('More energy trims every piece of a split vocal bed', async () => {
  const { s, tell } = await mounted();
  const aVocal = s.state.clips.find((clip) => clip.trackIndex === 0);
  assert.ok(s.apply({ name: 'splitClipAtBeat', args: { clipId: aVocal.id, splitBeat: 2 } }).ok, 'the A vocal is split');
  assert.equal(s.state.clips.filter((clip) => clip.trackIndex === 0).length, 2);
  await tell('Take the decks');
  await tell('More energy');
  const vocal = latestVocal(s);
  const singing = s.state.clips.filter((clip) => clip.trackIndex === 0
    && clip.timelineStartBeat < vocal.timelineStartBeat + vocal.durationBeats - 1e-6
    && clip.timelineStartBeat + clip.durationBeats > vocal.timelineStartBeat + 1e-6);
  assert.deepEqual(singing.map((clip) => clip.id), [], JSON.stringify(s.state.clips.filter((clip) => clip.trackIndex === 0)));
});

test('the first take is not moved by the More energy floor, and More energy never enters later', async () => {
  const original = ANALYSIS.A.sections;
  // A's chorus opens the song, so its vocal bed starts on the chorus.
  ANALYSIS.A.sections = [
    section('a-chorus', 'chorus 1', 'chorus', 1, MAJOR, 0.9),
    section('a-verse', 'verse 1', 'verse', 5, CLUSTER, 0.1),
  ];
  try {
    const { tell, s } = await mounted();
    await tell('Take the decks');
    const first = latestVocal(s).timelineStartBeat;
    assert.equal(first, 0, 'the first take enters on the chorus at bar 1');
    const said = await tell('More energy');
    assert.ok(latestVocal(s).timelineStartBeat <= first, said);
    assert.doesNotMatch(said, /comes in sooner/);
  } finally {
    ANALYSIS.A.sections = original;
  }
});

test('Previous vocal keeps the bar the musician named', async () => {
  const { s, tell } = await mounted();
  await tell('Take the decks');
  await tell('Try the next best match instead');
  await tell('Put it at bar 7');
  const placed = latestVocal(s).timelineStartBeat;
  assert.equal(placed, 24);
  const said = await tell('Previous vocal');
  assert.equal(latestVocal(s).timelineStartBeat, placed, said);
});

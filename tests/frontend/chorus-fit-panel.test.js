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
test.afterEach(() => teardownDom(dom));

async function mounted() {
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
    return reply(200, {});
  };
  const s = new DawSession({
    fetchImpl, decodeAudio: async () => ({ sampleRate: SR, numberOfChannels: 1, length: SHARED.length, getChannelData: () => SHARED }),
    createContext: () => { throw new Error('no audio in this test'); },
    RealtimeEngine: class {}, renderOffline: async () => { throw new Error('not used'); }, StretchFactory: () => null, modules: {},
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
  assert.match(again, /drums take the bed/);
  assert.equal(s.state.tracks[1].volumeDb, -9);
  assert.equal(s.state.clips.filter((clip) => String(clip.id).startsWith('idea-')).length, 1);
  assert.match(await tell('Take back'), /decks are yours/);
  assert.equal(s.state.tracks[1].volumeDb, -9);
  assert.ok(s.state.clips.some((clip) => String(clip.id).startsWith('idea-')), 'the first sketch stays after the hand edit');
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
  assert.ok(bed().durationBeats < first - 1);
  await tell('Try another arrangement');
  assert.ok(Math.abs(bed().durationBeats - first) < 0.05, `bed ${bed().durationBeats} first ${first}`);
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

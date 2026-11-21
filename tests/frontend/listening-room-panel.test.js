// tests/frontend/listening-room-panel.test.js — OPERATION THE LISTENING ROOM.
//
// The real arrangement panel and Producer card over jsdom, with the language
// model's answers SCRIPTED (the live model is exercised by the Python and
// browser tests). Proves the conversation reaches the ONE ProjectState
// through DawSession, that Hear it / Hear mine / Keep / Undo / Reject keep
// their contracts, that a refinement while listening is one undo step, and
// that the musician's own moves survive the next refinement.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, teardownDom } from './helpers/dom.js';
import { mountArrangementPanel } from '../../src/twobecomeone/studio_static/js/components/arrangement-panel.js';
import { mountArrangementProducer } from '../../src/twobecomeone/studio_static/js/components/arrangement-producer.js';
import { DawSession } from '../../src/twobecomeone/studio_static/js/arrangement/daw-session.js';

let dom;
test.beforeEach(() => { dom = setupDom(); });
test.afterEach(() => teardownDom(dom));

const SR = 48000;
const SHARED = new Float32Array(30 * SR).map((_, i) => 0.3 * Math.sin(i / 20));
const decodeAudio = async () => ({ sampleRate: SR, numberOfChannels: 2, length: SHARED.length, getChannelData: () => SHARED });
const BAR_B = (4 * 60) / 63.8;
const sec = (bar) => Math.round((0.41 + (bar - 1) * BAR_B) * 1e4) / 1e4;
const ANALYSIS_B = {
  trackId: 'tB', title: 'Need To Feel Loved', bpm: 63.8, barSec: Math.round(BAR_B * 1e6) / 1e6, firstBarSec: 0.41,
  stemSetId: 'setB', stemSampleRate: 44100, lyrics: { available: true, note: 'heard by local faster-whisper-tiny' },
  sections: [
    { id: 's1', name: 'intro', label: 'intro', startBar: 1, bars: 8, startSec: sec(1), endSec: sec(9), basis: 'estimated', confidence: 0.6, evidence: [], vocalPresence: 0, lyrics: null },
    { id: 's2', name: 'chorus 1', label: 'chorus', startBar: 9, bars: 4, startSec: sec(9), endSec: sec(13), basis: 'estimated', confidence: 0.75, evidence: ['music repeats 2×'], vocalPresence: 1, lyrics: { text: 'come on' } },
    { id: 's3', name: 'chorus 2', label: 'chorus', startBar: 13, bars: 4, startSec: sec(13), endSec: sec(17), basis: 'estimated', confidence: 0.75, evidence: ['music repeats 2×'], vocalPresence: 1, lyrics: { text: 'be with me' } },
  ],
};

async function mounted(script) {
  const made = { contexts: 0 };
  const calls = [];
  const answers = [...script];
  let analysisB = structuredClone(ANALYSIS_B);
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url === '/api/producer/model') return reply(200, { provider: 'ollama', model: 'qwen2.5:3b-instruct', local: true, available: true, note: 'runs on this machine' });
    if (url === '/api/producer/converse') {
      const next = answers.shift();
      if (next?.status) return reply(next.status, { error: { code: 'PRODUCER_MODEL_UNAVAILABLE', message: next.message } });
      return reply(200, { intent: next, resolved: next.resolved ?? {}, model: { name: 'qwen2.5:3b-instruct', local: true, elapsedMs: 5 } });
    }
    if (url === '/api/tracks/tB/listening/sections') {
      const { sections } = JSON.parse(init.body);
      analysisB = { ...analysisB, sections: analysisB.sections.map((s, i) => ({ ...s, label: sections[i].label, name: sections[i].label, basis: s.label === sections[i].label ? s.basis : 'musician' })) };
      return reply(200, analysisB);
    }
    if (url === '/api/tracks/tB/listening') return reply(200, analysisB);
    if (url === '/api/tracks/tA/listening') return reply(404, { error: { code: 'NOT_ANALYSED', message: 'not yet' } });
    return reply(200, {});
  };
  const s = new DawSession({
    fetchImpl, decodeAudio,
    createContext: () => { made.contexts += 1; throw new Error('no audio in this test'); },
    RealtimeEngine: class {}, renderOffline: async () => { throw new Error('not used'); }, StretchFactory: () => null, modules: {},
  });
  const container = document.getElementById('main');
  const api = mountArrangementPanel({
    container, session: s, listTracks: async () => ({ items: [] }), listStems: async () => ({ variants: [] }),
    producer: mountArrangementProducer,
  });
  for (const [g, trackId, title, bpm] of [['A', 'tA', 'Looking For Love', 63], ['B', 'tB', 'Need To Feel Loved', 63.8]]) {
    await s.importGroup(g, {
      trackId, title, bpm, section: { startSec: 30, seconds: 30 },
      stems: ['vocals', 'drums', 'bass', 'other'].map((role) => ({ role, url: `/api/stems/set${g}/audio?name=${role}&start=30&duration=30`, stemSetId: `set${g}` })),
    });
  }
  api.render();
  const prod = container.querySelector('.daw__producer');
  const btn = (text) => [...prod.querySelectorAll('button')].find((b) => b.textContent === text);
  const tell = async (text) => {
    const input = prod.querySelector('.daw__talk-input');
    input.value = text;
    prod.querySelector('.daw__talk').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && (prod.querySelector('.daw__talk-input').disabled || prod.querySelectorAll('.daw__talk-log li').length % 2); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 5));
    return [...prod.querySelectorAll('.daw__talk-log li')].at(-1)?.textContent ?? '';
  };
  return { api, s, made, calls, container, prod, btn, tell };
}

const HEADLINE = { action: 'propose', reply: 'Here it is.', song: 'B', stem: 'vocals', section: 'B:s3', bar: 17, beat: 1, asks: ['choose_part', 'place_or_move'] };
const ideaClip = (s) => s.state.clips.find((c) => c.id.startsWith('idea-'));

test('say it, see it on the timeline, Hear it, refine it while listening (one undo step each), Keep, Undo', async () => {
  const { s, made, calls, container, btn, tell } = await mounted([
    HEADLINE,
    { action: 'adjust', reply: 'Up two, fading in.', pitch_change: 2, fade_in_change: 2, asks: ['pitch', 'fade'] },
    { action: 'adjust', reply: 'Earlier.', shift_beats: -0.5, asks: ['place_or_move'] },
    { action: 'adjust', reply: 'One more.', pitch_change: 1, asks: ['pitch'] },
  ]);
  const before = structuredClone(s.state.clips);
  const depth0 = s.edit.historyDepth.past;
  const said = await tell('Find the second chorus in the other song and put its vocals over my drums at bar 17');
  assert.match(said, /chorus 2 of “Need To Feel Loved”.*at bar 17.*fitted from 63\.8 to 63 BPM/);
  assert.deepEqual(s.state.clips, before, 'an idea changes nothing until Hear it');
  const ghost = container.querySelector('.daw__lane[data-track="4"] .daw__ghost');
  assert.ok(ghost, 'the idea is drawn on the B Vocals lane');
  assert.match(ghost.textContent, /Idea · B Vocals · chorus 2/);
  assert.ok(ghost.classList.contains('daw__ghost--B'), 'in B’s aqua, not A’s copper');
  const sent = calls.find((c) => c.url === '/api/producer/converse').body;
  assert.equal(sent.project.groups.B.trackId, 'tB');
  assert.equal(sent.project.mine, 'A');
  assert.ok(!JSON.stringify(sent).includes('getChannelData') && JSON.stringify(sent).length < 20000, 'only a short description, no audio');

  btn('Hear it').click();
  assert.equal(ideaClip(s).timelineStartBeat, 64);
  assert.equal(s.edit.historyDepth.past, depth0 + 1);
  assert.equal(container.querySelector('.daw__ghost'), null, 'once heard it is a real clip, not an outline');

  await tell('Pitch it up two semitones and fade it in over two beats');
  assert.equal(ideaClip(s).pitchSemitones, 2);
  assert.equal(ideaClip(s).fadeInBeats, 2);
  assert.equal(s.edit.historyDepth.past, depth0 + 2, 'the refinement replaced what was heard as ONE step');
  await tell('Half a beat earlier');
  let c = ideaClip(s);
  assert.deepEqual([c.timelineStartBeat, c.pitchSemitones, c.fadeInBeats], [63.5, 2, 2], 'nothing else was lost');

  // The musician drags the idea clip themself; the next refinement keeps their move.
  s.apply({ name: 'moveClip', args: { clipId: c.id, newTrackIndex: 4, newStartBeat: 66 } });
  await tell('one more semitone up');
  c = ideaClip(s);
  assert.equal(c.timelineStartBeat, 66, 'the musician’s own position wins');
  assert.equal(c.pitchSemitones, 3);

  btn('Keep it').click();
  assert.ok(ideaClip(s), 'kept');
  btn('Undo').click();
  assert.equal(ideaClip(s), undefined, 'Undo returns to the arrangement from before the idea');
  assert.deepEqual(s.state.clips.map((x) => x.id), before.map((x) => x.id));
  assert.equal(made.contexts, 0, 'talking to the Producer never opens audio');
});

test('Hear mine and Reject leave the arrangement exactly as it was', async () => {
  const { s, btn, tell } = await mounted([HEADLINE]);
  const before = s.edit.serialize();
  await tell('put the second chorus vocals of song B at bar 17');
  btn('Hear it').click();
  assert.ok(ideaClip(s));
  btn('Hear mine').click();
  assert.equal(ideaClip(s), undefined);
  btn('Hear it').click();
  btn('Reject').click();
  assert.equal(ideaClip(s), undefined);
  const strip = (j) => { const o = JSON.parse(j); return JSON.stringify(o.state ? o.state.clips : o.clips); };
  assert.equal(strip(s.edit.serialize()), strip(before));
});

test('“undo that idea” and “keep it” work by voice too', async () => {
  const { s, prod, tell } = await mounted([
    HEADLINE, { action: 'hear_idea', reply: 'Here.' }, { action: 'undo_idea', reply: 'Back.' },
    HEADLINE, { action: 'keep', reply: 'Kept.' },
  ]);
  await tell('second chorus of B at bar 17');
  await tell('let me hear it');
  assert.ok(ideaClip(s));
  assert.match(await tell('undo that idea'), /Undone/);
  assert.equal(ideaClip(s), undefined);
  await tell('second chorus of B at bar 17 again');
  await tell('keep it');
  assert.ok(ideaClip(s), 'keep by voice hears and keeps the idea');
  assert.equal([...prod.querySelectorAll('button')].find((b) => b.textContent === 'Undo')?.disabled, false);
});

test('a question, an unsupported request and a model outage are said plainly; hand editing still works', async () => {
  const { s, tell } = await mounted([
    { action: 'clarify', reply: '', question: 'Which song is yours, A or B?' },
    { action: 'unsupported', reply: 'I can’t add reverb yet; I can move, pitch, fade or level it.' },
    { status: 503, message: 'no model daemon answered at http://127.0.0.1:11434' },
  ]);
  const before = s.edit.serialize();
  assert.match(await tell('put my vocals over the other drums'), /Which song is yours/);
  assert.match(await tell('add some reverb'), /can’t add reverb/);
  assert.match(await tell('anything'), /isn't answering.*Every edit still works by hand/);
  assert.equal(s.edit.serialize(), before, 'nothing was edited');
  const drums = s.state.clips.find((c) => c.trackIndex === 1);
  assert.equal(s.apply({ name: 'setClipGain', args: { clipId: drums.id, gainDb: -3 } }).ok, true);
});

test('what the Producer heard is shown, can be renamed, and the rename is what it uses next', async () => {
  const { prod, calls } = await mounted([]);
  await new Promise((r) => setTimeout(r, 600)); // the card polls the lanes and fetches the analyses
  const heard = prod.querySelector('.daw__heard');
  assert.match(heard.textContent, /B · Need To Feel Loved · 63\.8 BPM/);
  assert.match(heard.textContent, /chorus 2 · song bars 13–16/);
  assert.match(heard.textContent, /heard \(rough\): “be with me”/);
  assert.ok([...heard.querySelectorAll('button')].some((b) => b.textContent === 'Listen to A'), 'A has not been listened to yet');
  const select = heard.querySelector('select[aria-label^="B chorus 2"]');
  select.value = 'bridge';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/tracks/tB/listening/sections');
  assert.equal(put.body.sections[2].label, 'bridge');
  assert.match(prod.querySelector('.daw__heard').textContent, /bridge · song bars 13–16 · .*named by you/);
});

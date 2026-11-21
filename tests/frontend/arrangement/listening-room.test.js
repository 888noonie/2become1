// tests/frontend/arrangement/listening-room.test.js — OPERATION THE LISTENING ROOM.
//
// The conversational Producer's deterministic half: a model intent becomes a
// spec that survives follow-ups, and a spec becomes ordinary edit-API commands
// whose source frames are exact. The fixture is deliberately awkward: a 44.1
// kHz stem, a section that does not start on a sample, a one-bar lead (so the
// in-point inside the cut is NONZERO) and a 63.8 -> 63 BPM fit (rate != 1).

import test from 'node:test';
import assert from 'node:assert/strict';

import { EditEngine } from '../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { compileRenderPlan } from '../../../src/twobecomeone/studio_static/js/arrangement/render-plan.js';
import { beatsToSourceSeconds, sourceAdvanceRate } from '../../../src/twobecomeone/studio_static/js/arrangement/time-math.js';
import {
  applyIntent, buildIdea, clipObject, clipSourceRange, passageSource, projectSummary, refusalText,
} from '../../../src/twobecomeone/studio_static/js/arrangement/producer-intent.js';

const SR = 48000;
const FILE_RATE = 44100;
const B_BPM = 63.8;
const BAR_B = (4 * 60) / B_BPM;

function analysisB({ lyrics = true } = {}) {
  const sec = (bar) => Math.round((0.41 + (bar - 1) * BAR_B) * 1e4) / 1e4;
  const s = (id, name, label, startBar, bars, text) => ({
    id, name, label, startBar, bars, startSec: sec(startBar), endSec: sec(startBar + bars), basis: 'estimated',
    confidence: 0.75, evidence: ['music repeats 3×', 'loudest repeated vocal part'], vocalPresence: 1,
    lyrics: text ? { text, wordCount: 4, meanProbability: 0.8 } : null,
  });
  return {
    trackId: 'tB', title: 'Need To Feel Loved', bpm: B_BPM, barSec: Math.round(BAR_B * 1e6) / 1e6, firstBarSec: 0.41,
    stemSetId: 'setB', stemSampleRate: FILE_RATE,
    lyrics: lyrics ? { available: true, note: 'heard by local faster-whisper-tiny' } : { available: false, note: 'no local transcription model configured' },
    sections: [
      s('s1', 'intro', 'intro', 1, 8, null),
      s('s3', 'chorus 1', 'chorus', 20, 5, 'come on lets go'),
      s('s4', 'chorus 2', 'chorus', 25, 8, 'be with me baby'),
      s('s9', 'chorus 3', 'chorus', 63, 12, 'i need to feel'),
    ],
  };
}

/** A and B on the lanes as the Studio imports them (60 s cuts from 30 s). */
function session() {
  const e = new EditEngine();
  e.setMasterBpm(63);
  const load = (trackIndex, group, role, bpm, trackId, title) => e.run({
    name: 'loadStemToTrack',
    args: {
      trackIndex, naturalSpeed: true,
      audioFile: {
        name: `${title} — ${role}`, durationSec: 60, nativeBpm: bpm,
        bufferReference: `/api/stems/set${group}/audio?name=${role}&start=30&duration=60`,
        source: { trackId, title, role, group, stemSetId: `set${group}`, section: { startSec: 30, seconds: 60 } },
      },
    },
  });
  ['vocals', 'drums', 'bass', 'other'].forEach((r, i) => load(i, 'A', r, 63, 'tA', 'Looking For Love'));
  ['vocals', 'drums', 'bass', 'other'].forEach((r, i) => load(4 + i, 'B', r, B_BPM, 'tB', 'Need To Feel Loved'));
  ['Vocals', 'Drums', 'Bass', 'Other'].forEach((r, i) => { e.setTrackName(i, `A ${r}`); e.setTrackName(4 + i, `B ${r}`); });
  const groups = { A: { trackId: 'tA', title: 'Looking For Love', stemSetId: 'setA', bpm: 63 }, B: { trackId: 'tB', title: 'Need To Feel Loved', stemSetId: 'setB', bpm: B_BPM } };
  return { e, groups, analyses: { B: analysisB() } };
}

const records = (url) => ({ [url]: { durationSec: 60 } });

/** Build the idea, giving it its decoded cut, and return fields + the source. */
function realise(e, spec, ctx) {
  const first = buildIdea(e.state, spec, ctx);
  if (!first.needsSource) return { built: first, url: null };
  const built = buildIdea(e.state, spec, { ...ctx, records: records(first.needsSource) });
  return { built, url: first.needsSource };
}
const commandsOf = (state, built) => built.fields.flatMap((f) => [].concat(f.command(state, f.value)));
const ideaClip = (e) => e.state.clips.find((c) => c.id.startsWith('idea-'));

// ------------------------------------------------------------------ the headline conversation

test('“second chorus of the other song at bar 17”, then pitch + fade, then half a beat earlier: one idea, nothing lost', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  let out = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17, beat: 1 }, ctx);
  assert.ok(out.spec, JSON.stringify(out));
  out = applyIntent(out.spec, { action: 'adjust', pitch_change: 2, fade_in_change: 2 }, ctx);
  out = applyIntent(out.spec, { action: 'adjust', shift_beats: -0.5 }, ctx);
  const m = out.spec.main;
  assert.equal(m.passage.name, 'chorus 2');
  assert.equal(m.startBeat, 63.5, 'bar 17 is beat 64; half a beat earlier is 63.5');
  assert.equal(m.pitch, 2);
  assert.equal(m.fadeIn, 2);
  assert.equal(m.speed, 'fit');

  const { built, url } = realise(e, out.spec, { analyses, groups });
  assert.match(url, /^\/api\/stems\/setB\/audio\?name=vocals&start=[0-9.]+&duration=60$/);
  const before = e.serialize();
  const dry = e.propose({ name: 'batch', args: { commands: commandsOf(e.state, built) } });
  assert.equal(dry.status, 'pending', 'the idea validates');
  assert.equal(e.serialize(), before, 'proposing changes nothing');
  e.run({ name: 'batch', args: { commands: commandsOf(e.state, built) } });
  const c = ideaClip(e);
  assert.equal(c.trackIndex, 4, 'B vocals go on the B Vocals lane');
  assert.equal(c.timelineStartBeat, 63.5);
  assert.equal(c.pitchSemitones, 2);
  assert.equal(c.fadeInBeats, 2);
  assert.equal(c.stretchMode, 'beat_sync');
  assert.equal(c.durationBeats, 32, 'eight bars of the song, fitted, are 32 project beats');
});

test('the passage lands on exact source frames at a non-unity rate with a nonzero in-point', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  const { spec } = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17 }, ctx);
  const { built } = realise(e, spec, { analyses, groups });
  e.run({ name: 'batch', args: { commands: commandsOf(e.state, built) } });
  const c = ideaClip(e);
  const asset = e.state.assets[c.assetId];
  const passage = analyses.B.sections.find((s) => s.id === 's4');
  const src = passageSource(analyses.B, groups.B, 'vocals', passage);
  // The cut starts on a real sample of the 44.1 kHz stem file, one source bar early.
  assert.equal(asset.source.section.startFrame, Math.round((passage.startSec - analyses.B.barSec) * FILE_RATE));
  assert.equal(asset.source.section.startSec, asset.source.section.startFrame / FILE_RATE);
  assert.ok(c.sourceOffsetSec > 3.7 && c.sourceOffsetSec < 3.8, `nonzero in-point inside the cut: ${c.sourceOffsetSec}`);
  // First heard sample, in the ORIGINAL recording, is the passage start.
  assert.ok(Math.abs(asset.source.section.startSec + c.sourceOffsetSec - passage.startSec) < 1e-9);
  assert.ok(Math.abs(clipSourceRange(e.state, c).start - passage.startSec) < 1e-9);
  const rate = sourceAdvanceRate(c, asset, 63);
  assert.ok(Math.abs(rate - 63 / B_BPM) < 1e-12 && rate !== 1, 'tempo-fitted: rate 63/63.8');
  const plan = compileRenderPlan(e.state).clips.find((p) => p.clipId === c.id);
  assert.equal(plan.sourceStartFrame, Math.round(src.inPoint * SR), 'the decoded cut is read from the in-point frame');
  assert.equal(plan.sourceEndFrame, Math.round((c.sourceOffsetSec + beatsToSourceSeconds(c.durationBeats, c, asset, 63)) * SR));
  assert.ok(plan.sourceEndFrame <= 60 * SR, 'never past the end of the cut');
});

test('trim, split, slip, save and reopen keep the passage’s source exact', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  const { spec } = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17 }, ctx);
  const { built } = realise(e, spec, { analyses, groups });
  e.run({ name: 'batch', args: { commands: commandsOf(e.state, built) } });
  const id = ideaClip(e).id;
  const at = () => clipSourceRange(e.state, e.state.clips.find((c) => c.id === id)).start;
  const start0 = at();
  e.trimClip(id, 'start', 1); // one project beat in: the in-point advances by one beat of source at the clip's rate
  const c1 = e.state.clips.find((c) => c.id === id);
  assert.ok(Math.abs(at() - (start0 + beatsToSourceSeconds(1, c1, e.state.assets[c1.assetId], 63))) < 1e-9);
  const { rightId } = e.splitClipAtBeat(id, 64 + 8);
  const left = e.state.clips.find((c) => c.id === id);
  const right = e.state.clips.find((c) => c.id === rightId);
  const leftEnd = clipSourceRange(e.state, left).end;
  assert.ok(Math.abs(clipSourceRange(e.state, right).start - leftEnd) < 1e-9, 'the split halves continue the source');
  e.slipClip(rightId, right.sourceOffsetSec - 0.5);
  e.setClipPitch(id, 2, true);
  const reopened = EditEngine.deserialize(e.serialize());
  assert.deepEqual(compileRenderPlan(reopened.state), compileRenderPlan(e.state), 'reopen compiles the identical plan');
});

test('NEGATIVE CONTROL: an in-point that forgets the lead (or the cut start) is a bar away from the passage', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  const { spec } = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17 }, ctx);
  const { built } = realise(e, spec, { analyses, groups });
  const naive = commandsOf(e.state, built).map((cmd) => (cmd.name === 'loadStemToTrack' ? { ...cmd, args: { ...cmd.args, sourceOffsetSec: 0 } } : cmd));
  e.run({ name: 'batch', args: { commands: naive } });
  const c = ideaClip(e);
  const passage = analyses.B.sections.find((s) => s.id === 's4');
  const missBy = passage.startSec - clipSourceRange(e.state, c).start;
  assert.ok(Math.abs(missBy - analyses.B.barSec) < 1e-3, `the naive clip starts one source bar early (${missBy.toFixed(3)} s)`);
  // ...which the exactness check above would have caught.
  assert.ok(Math.abs(clipSourceRange(e.state, c).start - passage.startSec) > 1e-3);
});

test('a different passage on a heard idea swaps the clip’s source under the same id', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  let { spec } = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17, pitch: 2 }, ctx);
  let { built } = realise(e, spec, { analyses, groups });
  e.run({ name: 'batch', args: { commands: commandsOf(e.state, built) } });
  const id = ideaClip(e).id;
  ({ spec } = applyIntent(spec, { action: 'adjust', section: 'B:s3' }, { ...ctx, state: e.state }));
  ({ built } = realise(e, spec, { analyses, groups }));
  const cmds = commandsOf(e.state, built);
  assert.deepEqual(cmds.slice(0, 2).map((c) => c.name), ['deleteClip', 'loadStemToTrack']);
  e.run({ name: 'batch', args: { commands: cmds } });
  const c = e.state.clips.find((x) => x.id === id);
  assert.equal(c.pitchSemitones, 2, 'the pitch the musician asked for survives the new passage');
  assert.match(e.state.assets[c.assetId].name, /chorus 1/);
});

// ------------------------------------------------------------------ asking, refusing, honesty

test('ambiguity becomes a short question, never a guess', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  assert.match(applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4' }, ctx).ask, /Where should chorus 2 come in/);
  assert.match(applyIntent(null, { action: 'propose', song: 'B', section: 'B:s4', bar: 9 }, ctx).ask, /vocals, drums, bass or other/);
  assert.match(applyIntent(null, { action: 'clarify', question: 'Which song is yours?' }, ctx).ask, /Which song is yours/);
  assert.match(applyIntent(null, { action: 'adjust', pitch_change: 2 }, ctx).ask, /Which clip do you mean/);
  assert.match(applyIntent(null, { action: 'propose', song: 'A', stem: 'vocals', section: 'B:s4', bar: 9 }, ctx).ask, /belongs to song B/);
});

test('lyrics: a certain match places its section; an uncertain one asks; missing words say why', () => {
  const { e, groups, analyses } = session();
  const base = { state: e.state, analyses, groups };
  const sure = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', lyric: 'need to feel', bar: 9 },
    { ...base, resolved: { lyricsAvailable: true, lyricMatches: [{ startSec: 240.2, endSec: 241.4, score: 0.95, certain: true, heard: 'I need to feel', sectionId: 'B:s9' }] } });
  assert.equal(sure.spec.main.passage.name, 'chorus 3');
  assert.match(sure.spec.main.heardNote, /I need to feel/);
  const unsure = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', lyric: 'golden river', bar: 9 },
    { ...base, resolved: { lyricsAvailable: true, lyricMatches: [{ startSec: 95.1, endSec: 96, score: 0.64, certain: false, heard: 'go with me', sectionId: 'B:s4' }] } });
  assert.ok(!unsure.spec, 'an uncertain lyric match is not placed');
  assert.match(unsure.ask, /closest I heard is “go with me”.*not sure/);
  const none = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', lyric: 'golden river', bar: 9 }, { ...base, resolved: { lyricsAvailable: true, lyricMatches: [] } });
  assert.match(none.ask, /didn't hear “golden river”/);
  const noWords = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', lyric: 'anything', bar: 9 },
    { ...base, analyses: { B: analysisB({ lyrics: false }) }, resolved: { lyricsAvailable: false, lyricMatches: [] } });
  assert.match(noWords.ask, /don't have the words for song B \(no local transcription model configured\)/);
});

test('model slips are caught: a shift beside an absolute bar, a position-only propose, a bar after “where?”', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {}, selectedClipId: e.state.clips[4].id };
  const one = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17, beat: 1, shift_beats: 1 }, ctx);
  assert.equal(one.spec.main.startBeat, 64, 'bar 17 wins over a contradictory shift');
  const drums = applyIntent(null, { action: 'propose', bar: 41, beat: 1 }, ctx);
  assert.ok(!drums.spec, 'a propose naming no part never edits the selected clip');
  assert.match(drums.ask, /Which song, and which part/);
  const named = applyIntent(null, { action: 'propose', song: 'B', stem: 'drums', bar: 41 }, ctx);
  assert.match(named.ask, /Which part of song B: intro, chorus 1, chorus 2, chorus 3/);
  const pending = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4' }, ctx);
  assert.match(pending.ask, /Where should chorus 2 come in/);
  const part = applyIntent(null, { action: 'propose', section: 'B:s9' }, { ...ctx, pending: named.pending });
  assert.equal(part.spec.main.stem, 'drums', '“chorus 3” completes “the drums … at bar 41”');
  assert.equal(part.spec.main.startBeat, 160);
  assert.equal(part.spec.main.passage.name, 'chorus 3');
  const answered = applyIntent(pending.spec, { action: 'propose', bar: 9 }, ctx);
  assert.equal(answered.spec.main.startBeat, 32, '“at bar 9” answers the question');
});

test('unsupported requests and empty intents are said plainly; no edit is invented', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  assert.match(applyIntent(null, { action: 'unsupported', reply: 'I can’t add reverb yet.' }, ctx).say, /reverb/);
  const empty = applyIntent(null, { action: 'propose', reply: 'I added reverb!' }, ctx);
  assert.ok(!empty.spec && /Which song, and which part/.test(empty.ask), 'an empty propose invents nothing and asks');
  assert.match(applyIntent(null, { action: 'adjust', reply: 'Done!' }, ctx).say, /couldn't turn that into a change/);
  assert.equal(applyIntent(null, { action: 'keep' }, ctx).control, 'keep');
  assert.equal(applyIntent(null, { action: 'undo_idea' }, ctx).control, 'undo_idea');
});

test('a stale clip reference is reported, and an idea whose clip vanished refuses', () => {
  const { e, groups, analyses } = session();
  const drums = e.state.clips.find((c) => c.trackIndex === 1).id;
  let out = applyIntent(null, { action: 'adjust', clip: drums, gain_change_db: -3 }, { state: e.state, analyses, groups, resolved: {} });
  assert.equal(out.spec.clips[drums].gainDb, -3);
  e.deleteClip(drums);
  assert.match(applyIntent(null, { action: 'adjust', clip: drums, gain_change_db: -3 }, { state: e.state, analyses, groups, resolved: {} }).say, /not on the lanes any more/);
  out = buildIdea(e.state, out.spec, { analyses, groups });
  assert.match(out.refusal, /not on the lanes any more/);
});

test('a pitch past the edit API’s range is refused by the dry run, in plain words, and nothing changes', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  let { spec } = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17 }, ctx);
  ({ spec } = applyIntent(spec, { action: 'adjust', pitch_change: 20 }, ctx));
  const { built } = realise(e, spec, { analyses, groups });
  const before = e.serialize();
  const depth = e.historyDepth.past;
  const dry = e.propose({ name: 'batch', args: { commands: commandsOf(e.state, built) } });
  assert.notEqual(dry.status, 'pending');
  assert.match(refusalText(dry.errors?.[0] ?? dry.error), /12 semitones/);
  assert.equal(e.serialize(), before);
  assert.equal(e.historyDepth.past, depth, 'a refused proposal leaves no undo step');
});

test('the mixer: “mute my other lane” is an ordinary track field; an existing clip edit keeps its source', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  const { spec } = applyIntent(null, { action: 'propose', lane: 'A Other', mute: true }, ctx);
  const built = buildIdea(e.state, spec, { analyses, groups });
  assert.deepEqual(commandsOf(e.state, built), [{ name: 'setTrackMute', args: { trackIndex: 3, mute: true } }]);
  const drums = e.state.clips.find((c) => c.trackIndex === 1);
  const { spec: s2 } = applyIntent(null, { action: 'adjust', clip: drums.id, shift_beats: 4, fade_in: 1 }, ctx);
  const b2 = buildIdea(e.state, s2, { analyses, groups });
  e.run({ name: 'batch', args: { commands: commandsOf(e.state, b2) } });
  const after = clipObject(e.state, drums.id);
  assert.equal(after.startBeat, 4);
  assert.equal(after.fadeIn, 1);
  assert.equal(after.sourceOffsetSec, drums.sourceOffsetSec);
});

test('the model is told the session briefly and accurately (ids, bars, sources, the idea)', () => {
  const { e, groups, analyses } = session();
  const ctx = { state: e.state, analyses, groups, resolved: {} };
  const { spec } = applyIntent(null, { action: 'propose', song: 'B', stem: 'vocals', section: 'B:s4', bar: 17, pitch: 2 }, ctx);
  const sum = projectSummary(e.state, { groups, spec, mine: 'A' });
  assert.equal(sum.bpm, 63);
  assert.equal(sum.mine, 'A');
  assert.equal(sum.lanes.length, 8);
  assert.equal(sum.lanes[4].name, 'B Vocals', 'lane names are the project’s own');
  assert.match(sum.lanes[1].clips[0].source, /Looking For Love drums 0:30\.0-1:30\.0/);
  assert.match(sum.idea, /B Vocals from B:chorus-2 \(chorus 2 of song B\), placed at bar 17, pitch \+2/);
  assert.match(sum.idea, /not heard yet/);
});

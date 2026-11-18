// components/stem-desk-panel.js — Stem Performance Desk.
//
// Two separated tracks (groups A and B), up to four stem lanes each, one
// transport and one equal-power crossfader. Lanes are decoded by stem-desk.js
// and started together on a single AudioContext, so mute/solo/gain are exact
// gain-node values rather than UI-only state.
//
// Bounded by design: the panel loads each group on demand, aborts a stale
// request for that group, and disposes its desk (and its own AudioContext) on
// unmount. Library intake reuses Choose Track. Separation reuses the existing
// job. The panel does not write stem files, projects, or renders itself.

import { createElement, replaceChildren } from '../dom.js';
import {
  discardStagedStems, importStemSet, listJobs, listStems, listTracks,
  stageStemFile, submitSeparation, watchJob,
} from '../api.js';
import { StemDesk, STEM_DESK_FULL_LIMITS, STEM_DESK_LIMITS } from '../runtime/stem-desk.js';
import {
  approveStemDeskProposal,
  suggestStemDeskProposal,
  validateStemDeskProposal,
} from '../runtime/stem-desk-proposal.js';

const STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'center', 'sides'];
const QUAD_NAMES = ['vocals', 'drums', 'bass', 'other'];
const GROUP_IDS = ['A', 'B'];
const FALLBACK_NOTE = 'Fallback split: center and sides are channel separations, not isolated vocals or instruments.';
const SECTION_SECONDS = new Set(['30', '60', '90']);

function withSection(url, start, seconds) {
  const [path, query = ''] = String(url).split('?');
  const params = new URLSearchParams(query);
  params.set('start', String(start));
  params.set('duration', String(seconds));
  return `${path}?${params.toString()}`;
}

function sortLanes(variants) {
  return [...variants].sort((a, b) => {
    const left = STEM_ORDER.indexOf(a.name);
    const right = STEM_ORDER.indexOf(b.name);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
}

/**
 * A track can legitimately have both a Demucs set and an ffmpeg fallback set.
 * Prefer the four isolated Demucs stems; only fall back to other variants when
 * no Demucs lane exists, and never exceed the per-track lane limit.
 */
function selectLanes(variants) {
  const usable = variants.filter((variant) => variant && variant.name && variant.name !== 'full');
  const byName = new Map(usable.map((variant) => [variant.name, variant]));
  const demucs = ['vocals', 'drums', 'bass', 'other']
    .filter((name) => byName.has(name))
    .map((name) => byName.get(name));
  const chosen = demucs.length ? demucs : usable.slice(0, STEM_DESK_LIMITS.maxLanesPerTrack);
  return sortLanes(chosen);
}

function stemLabel(name) {
  switch (name) {
    case 'vocals': return 'Vocals';
    case 'drums': return 'Drums';
    case 'bass': return 'Bass';
    case 'other': return 'Other';
    case 'center': return 'Center (mid)';
    case 'sides': return 'Sides';
    default: return name;
  }
}

function provenanceLabel(variant) {
  // An imported set is the user's own separated stems, identified by its set
  // hash; there is no separation model to name and no device that ran one.
  if (variant.method === 'imported') {
    // The schema's model identity is `sha256:<set hash>`; show the hash only.
    const setHash = variant.modelName
      ? String(variant.modelName).replace(/^sha256:/, '').slice(0, 8)
      : '';
    return setHash ? `imported · set ${setHash}` : 'imported';
  }
  const method = variant.method === 'demucs'
    ? `demucs${variant.modelName ? ` · ${variant.modelName}` : ''}`
    : variant.method === 'ffmpeg'
      ? 'ffmpeg · center/side fallback'
      : (variant.method || 'unknown method');
  const withDevice = variant.device ? `${method} · ${variant.device}` : method;
  // The stem set id is what proves which separation produced this lane; two
  // tracks both have a "vocals", so the set is part of the identity.
  return variant.stemSetId
    ? `${withDevice} · set ${String(variant.stemSetId).slice(0, 8)}`
    : withDevice;
}

/** Group level is a second gain layer, independent of the crossfader. */
function groupLevelRow(groupId, onChange) {
  const input = createElement('input', {
    type: 'range',
    min: String(STEM_DESK_LIMITS.minLevelDb),
    max: String(STEM_DESK_LIMITS.maxLevelDb),
    step: '1',
    value: '0',
    class: 'stem-desk__level',
    'aria-label': `Group ${groupId} level`,
  });
  const text = createElement('span', { class: 'stem-desk__meta', text: '0 dB' });
  const row = createElement('div', { class: 'stem-desk__level-row' }, [
    createElement('span', { class: 'stem-desk__group-label', text: 'level' }),
    input,
    text,
  ]);
  input.addEventListener('input', (event) => {
    text.textContent = `${event.target.value} dB`;
    onChange?.(event.target.value);
  });
  return { row, input, text };
}

const ENTRY_STEP_MS = 10;

/** Signed milliseconds, so 0, earlier and later cannot be confused. */
function formatEntryOffset(ms) {
  const rounded = Math.round(Number(ms) || 0);
  if (rounded > 0) return `+${rounded} ms`;
  if (rounded < 0) return `−${Math.abs(rounded)} ms`;
  return '0 ms';
}

/**
 * Manual entry nudge for one whole group. It stores a value; Play applies it.
 * Earlier is negative (the group is already underway). Later is positive.
 */
function groupTimingRow(groupId, onNudge) {
  const readout = createElement('span', {
    class: 'stem-desk__meta stem-desk__offset',
    text: '0 ms',
  });
  const earlier = createElement('button', {
    class: 'button button--sm',
    type: 'button',
    text: 'Earlier',
    'aria-label': `Group ${groupId} earlier`,
  });
  const later = createElement('button', {
    class: 'button button--sm',
    type: 'button',
    text: 'Later',
    'aria-label': `Group ${groupId} later`,
  });
  const reset = createElement('button', {
    class: 'button button--sm',
    type: 'button',
    text: 'Reset',
    'aria-label': `Group ${groupId} reset entry`,
  });
  earlier.addEventListener('click', () => onNudge(-ENTRY_STEP_MS));
  later.addEventListener('click', () => onNudge(ENTRY_STEP_MS));
  reset.addEventListener('click', () => onNudge(null));
  const row = createElement('div', { class: 'stem-desk__timing' }, [
    earlier,
    readout,
    later,
    reset,
    createElement('span', { class: 'stem-desk__meta', text: 'Takes effect on the next Play.' }),
  ]);
  return { row, readout };
}

function groupLabel(trackId) {
  return String(trackId);
}

export function mountStemDeskPanel({
  container,
  store = null,
  openPicker = null,
  listTracksImpl = listTracks,
  listStemsImpl = listStems,
  listJobsImpl = listJobs,
  submitSeparationImpl = submitSeparation,
  stageStemFileImpl = stageStemFile,
  importStemSetImpl = importStemSet,
  discardStagedStemsImpl = discardStagedStems,
  watchJobImpl = watchJob,
  createDesk = (options) => new StemDesk(options),
  // A fixed context rate makes decoded size predictable, so the import path's
  // 48 kHz budget matches what the desk actually decodes. There is deliberately
  // no silent fallback: an unpredictable rate could refuse a set the importer
  // accepted, so the panel reports that audio is unavailable instead.
  audioContextFactory = () => new AudioContext({ sampleRate: 48000 }),
  onAnnounce = null,
} = {}) {
  if (!container) throw new Error('mountStemDeskPanel requires a container');

  const root = createElement('section', {
    class: 'stem-desk',
    'aria-label': 'Stem Performance Desk',
  });
  const title = createElement('h2', { class: 'stem-desk__title', text: 'Stem Performance Desk' });
  const status = createElement('p', { class: 'stem-desk__status', role: 'status', text: 'Choose separated tracks for group A and group B.' });
  const memoryNote = createElement('p', {
    class: 'stem-desk__meta',
    text: 'A section is cut before the browser decodes it, at the recording’s own sample rate and channel count. Full length allows 128 MiB per stem, 512 MiB for one group, and 1024 MiB for eight stems. Available machine memory is not memory the browser can allocate.',
  });
  const groupControls = createElement('div', { class: 'stem-desk__groups' });
  const groupSelects = {};
  const groupButtons = {};
  const groupChoose = {};
  const groupImport = {};
  const groupProcess = {};
  const groupSection = {};
  const groupStart = {};
  for (const groupId of GROUP_IDS) {
    const select = createElement('select', {
      class: 'stem-desk__select',
      'aria-label': `Track for group ${groupId}`,
    }, [createElement('option', { value: '', text: 'Choose a track…' })]);
    const chooseLibrary = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Choose from Library',
      'aria-label': `Choose from Library for group ${groupId}`,
    });
    const addOrProcess = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Add / Process Track',
      'aria-label': `Add / Process Track for group ${groupId}`,
    });
    const loadButton = createElement('button', {
      class: 'button button--sm stem-desk__load',
      type: 'button',
      text: `Load ${groupId}`,
      'aria-label': `Load stems ${groupId}`,
      dataset: { group: groupId },
    });
    const importStemsButton = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Import My Stems',
      'aria-label': `Import My Stems for group ${groupId}`,
    });
    const section = createElement('select', {
      class: 'stem-desk__select',
      'aria-label': `Section for group ${groupId}`,
    }, [
      createElement('option', { value: '90', text: '90 seconds' }),
      createElement('option', { value: '60', text: '60 seconds' }),
      createElement('option', { value: '30', text: '30 seconds' }),
      createElement('option', { value: 'full', text: 'Full length (higher memory)' }),
    ]);
    const start = createElement('input', {
      class: 'input',
      type: 'number',
      min: '0',
      max: '3600',
      step: '1',
      value: '0',
      'aria-label': `Section start in seconds for group ${groupId}`,
    });
    const row = createElement('div', { class: 'stem-desk__group-controls', dataset: { group: groupId } }, [
      createElement('span', { class: 'stem-desk__group-label', text: `Group ${groupId}` }),
      select,
      chooseLibrary,
      addOrProcess,
      importStemsButton,
      section,
      start,
      loadButton,
    ]);
    groupSelects[groupId] = select;
    groupButtons[groupId] = loadButton;
    groupChoose[groupId] = chooseLibrary;
    groupProcess[groupId] = addOrProcess;
    groupImport[groupId] = importStemsButton;
    groupSection[groupId] = section;
    groupStart[groupId] = start;
    groupControls.appendChild(row);
  }
  const playButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Play', disabled: 'true' });
  const stopButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Stop', disabled: 'true' });
  const positionLabel = createElement('span', { class: 'stem-desk__meta', text: '0.0 s' });
  const transport = createElement('div', { class: 'stem-desk__actions stem-desk__transport' }, [playButton, stopButton, positionLabel]);
  const askButton = createElement('button', {
    class: 'button button--sm', type: 'button', text: 'Ask for a proposal', disabled: 'true',
  });
  const previewButton = createElement('button', {
    class: 'button button--sm', type: 'button', text: 'Preview', disabled: 'true',
  });
  const approveButton = createElement('button', {
    class: 'button button--sm', type: 'button', text: 'Approve', disabled: 'true',
  });
  const rejectButton = createElement('button', {
    class: 'button button--danger button--sm', type: 'button', text: 'Reject', disabled: 'true',
  });
  const proposalRow = createElement('div', {
    class: 'stem-desk__proposal', role: 'group', 'aria-label': 'Stem proposal',
  }, [askButton, previewButton, approveButton, rejectButton]);
  const proposalStatus = createElement('p', { class: 'stem-desk__proposal-status', role: 'status' });
  const PROPOSAL_UNAPPROVED = 'Proposal not approved. Groups A and B stay on the stem desk. Entry offsets take effect on the next Play.';
  const PROPOSAL_APPROVED = 'Proposal approved. Groups A and B stay loaded on one transport. Entry offsets take effect on the next Play.';
  const PROPOSAL_INCOMPLETE = 'Proposal incomplete. Only one group is included. The other group stays as it is, and any entry offset takes effect on the next Play.';
  const crossfaderInput = createElement('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: '50',
    class: 'stem-desk__crossfader',
    'aria-label': 'Crossfader A to B',
  });
  const crossfaderGains = createElement('span', { class: 'stem-desk__meta stem-desk__crossfader-gains', text: 'gainA 1.00 · gainB 0.00' });
  const crossfader = createElement('div', { class: 'stem-desk__crossfader-row' }, [
    createElement('span', { class: 'stem-desk__group-label', text: 'A / B' }),
    crossfaderInput,
    crossfaderGains,
  ]);
  const lanesMount = createElement('div', { class: 'stem-desk__lanes' });
  const note = createElement('p', { class: 'stem-desk__note', hidden: 'true' });
  const policy = createElement('p', {
    class: 'stem-desk__meta stem-desk__policy',
    text: 'Solo applies across both tracks. The crossfader and each group level still apply on top, so a soloed lane on a closed track is silent.',
  });
  const TWO_TRACK_POLICY = ' Two tracks start on one clock at their own tempo; this desk does not beat-match them.';
  const ONE_TRACK_POLICY = ' One track keeps looping, as the four-stem desk always has.';

  container.replaceChildren(root);
  replaceChildren(root, [
    title,
    groupControls,
    status,
    memoryNote,
    proposalRow,
    proposalStatus,
    transport,
    crossfader,
    policy,
    lanesMount,
    note,
  ]);

  let desk = null;
  const aborts = new Map();
  const separationWatches = new Map();
  const readinessTokens = { A: 0, B: 0 };
  let positionTimer = null;
  let disposed = false;
  let tracksLoaded = false;
  let tracksPending = null;
  let loadingCount = 0;
  let pendingProposal = null;
  let proposalPreviewed = false;
  const rowViews = new Map();
  const groupViews = new Map();

  function syncProposalButtons() {
    const groups = desk?.state()?.groups?.length || 0;
    askButton.disabled = loadingCount > 0 || groups < 1 ? 'true' : undefined;
    previewButton.disabled = pendingProposal ? undefined : 'true';
    approveButton.disabled = pendingProposal && proposalPreviewed ? undefined : 'true';
    rejectButton.disabled = pendingProposal ? undefined : 'true';
  }

  function syncLoadButtons() {
    for (const id of GROUP_IDS) {
      const button = groupButtons[id];
      if (!button) continue;
      button.disabled = loadingCount > 0 ? 'true' : undefined;
    }
    syncProposalButtons();
  }

  function sayProposal(message) {
    proposalStatus.textContent = message;
    try {
      onAnnounce?.(message);
    } catch {
      // An announcement listener is a viewer, not the approval path.
    }
  }

  function dropPendingProposal() {
    const had = pendingProposal !== null || proposalPreviewed;
    pendingProposal = null;
    proposalPreviewed = false;
    if (had) sayProposal(PROPOSAL_UNAPPROVED);
    syncProposalButtons();
  }

  function say(message) {
    status.textContent = message;
    try {
      onAnnounce?.(message);
    } catch {
      // An announcement listener is a viewer, not the load path; its failure
      // must not escape a transport or load handler.
    }
  }

  function ensureDesk() {
    if (desk) return desk;
    // The panel owns this context; LiveMixer's context is never reused or
    // closed here, and this one is closed when the panel is disposed.
    desk = createDesk({ audioContext: audioContextFactory(), ownsContext: true });
    return desk;
  }

  function stopSeparationWatch(groupId) {
    const watch = separationWatches.get(groupId);
    if (!watch) return;
    try { watch.unsub?.(); } catch { /* a watcher must not block the next track */ }
    separationWatches.delete(groupId);
  }

  function rememberTrack(track, groupId) {
    const label = track.title || track.name || track.originalName || track.id;
    for (const id of GROUP_IDS) {
      const select = groupSelects[id];
      const existing = [...select.options].find((entry) => entry.value === track.id);
      if (!existing) {
        select.appendChild(createElement('option', { value: track.id, text: label }));
      }
      select.disabled = undefined;
    }
    groupSelects[groupId].value = track.id;
    tracksLoaded = true;
  }

  function demucsQuad(variants) {
    const byName = new Map();
    for (const variant of variants) {
      if (!variant || variant.method !== 'demucs' || !variant.name || variant.name === 'full') continue;
      byName.set(variant.name, variant);
    }
    const lanes = QUAD_NAMES.map((name) => byName.get(name));
    return lanes.every(Boolean) ? lanes : null;
  }

  /**
   * Readiness is having the four isolated lanes, whether a Demucs run or the
   * user's own imported set produced them. Keep this separate from demucsQuad:
   * only wording and provenance that genuinely mean Demucs may use that one.
   */
  function completeQuad(variants) {
    const byName = new Map();
    for (const variant of variants) {
      if (!variant || !variant.name || variant.name === 'full') continue;
      if (variant.method !== 'demucs' && variant.method !== 'imported') continue;
      if (!QUAD_NAMES.includes(variant.name)) continue;
      byName.set(variant.name, variant);
    }
    const lanes = QUAD_NAMES.map((name) => byName.get(name));
    return lanes.every(Boolean) ? lanes : null;
  }

  function importedQuad(quad) {
    return Boolean(quad) && quad.every((variant) => variant.method === 'imported');
  }

  function quadReadyMessage(quad, name, groupId) {
    if (demucsQuad(quad)) {
      return `Four Demucs stems are ready for ${name}. Load ${groupId} to play them.`;
    }
    if (importedQuad(quad)) {
      return `Four imported stems are ready for ${name}. Load ${groupId} to play them.`;
    }
    return `Four isolated stems are ready for ${name}. Load ${groupId} to play them.`;
  }

  async function readVariants(trackId) {
    const stems = await listStemsImpl(trackId);
    return Array.isArray(stems?.variants) ? stems.variants : [];
  }

  async function reportReadiness(groupId, trackId = groupSelects[groupId].value) {
    const token = ++readinessTokens[groupId];
    if (!trackId) {
      say(`Choose a track for group ${groupId} first.`);
      return;
    }
    let variants = [];
    try {
      variants = await readVariants(trackId);
    } catch (err) {
      if (readinessTokens[groupId] !== token || groupSelects[groupId].value !== trackId) return;
      say(`Could not read stems for group ${groupId}: ${err?.message || 'request failed'}`);
      return;
    }
    if (disposed || readinessTokens[groupId] !== token || groupSelects[groupId].value !== trackId) return;
    const name = trackTitle(trackId);
    const quad = completeQuad(variants);
    if (quad) {
      say(quadReadyMessage(quad, name, groupId));
      return;
    }
    const countFor = (method) => QUAD_NAMES.filter((stemName) => (
      variants.some((variant) => variant && variant.name === stemName && variant.method === method)
    )).length;
    const importedCount = countFor('imported');
    const demucsCount = countFor('demucs');
    if (importedCount > 0 && importedCount >= demucsCount) {
      say(`${name} has ${importedCount} of 4 imported stems. The imported set is incomplete; Load ${groupId} plays only the lanes that exist.`);
      return;
    }
    if (demucsCount > 0) {
      say(`${name} has ${demucsCount} of 4 Demucs stems. The set is not ready. Load ${groupId} plays only the lanes that exist.`);
      return;
    }
    const channelSplit = variants.some((variant) => variant && (variant.name === 'center' || variant.name === 'sides'));
    if (channelSplit) {
      say(`${name} has a center/sides split, not four Demucs stems. Load ${groupId} plays that channel split. Add / Process Track requests Demucs.`);
      return;
    }
    say(`${name} has no separated stems yet. Use Add / Process Track to separate it.`);
  }

  async function separationJobsFor(trackId) {
    const page = await listJobsImpl({ kind: 'separate', limit: 50 });
    const items = Array.isArray(page?.items) ? page.items : (Array.isArray(page) ? page : []);
    return items.filter((job) => (
      job
      && (job.kind == null || job.kind === 'separate')
      && job.request
      && job.request.track_id === trackId
    ));
  }

  async function findActiveSeparation(trackId) {
    const jobs = await separationJobsFor(trackId);
    return jobs.find((job) => job.status === 'queued' || job.status === 'running') || null;
  }

  function jobDetail(job) {
    const detail = job.progress_detail;
    const percent = detail && typeof detail === 'object' && detail.percent != null
      ? ` ${Math.round(Number(detail.percent))}%`
      : '';
    const message = job.message || job.error || '';
    return `${job.status}${percent}${message ? ` — ${message}` : ''}`;
  }

  async function onSeparationUpdate(groupId, trackId, job) {
    if (disposed || !job) return;
    const watch = separationWatches.get(groupId);
    if (!watch || watch.trackId !== trackId || watch.jobId !== job.id) return;
    if (groupSelects[groupId].value !== trackId) return;
    const name = trackTitle(trackId);
    if (job.status === 'queued' || job.status === 'running') {
      say(`Separating ${name}: ${jobDetail(job)}.`);
      return;
    }
    if (job.status === 'complete') {
      let variants = [];
      try {
        variants = await readVariants(trackId);
      } catch {
        variants = [];
      }
      if (disposed || groupSelects[groupId].value !== trackId) return;
      const still = separationWatches.get(groupId);
      if (!still || still.jobId !== job.id) return;
      const quad = completeQuad(variants);
      if (quad) {
        const ready = demucsQuad(quad)
          ? 'Four Demucs stems are ready.'
          : importedQuad(quad)
            ? 'Four imported stems are ready.'
            : 'Four isolated stems are ready.';
        say(`Separation complete for ${name}. ${ready} Load ${groupId} to play them.`);
      } else if (variants.some((variant) => variant && (variant.name === 'center' || variant.name === 'sides'))) {
        say(`Separation finished for ${name}, but the result is a center/sides split, not four Demucs stems.`);
      } else {
        say(`Separation finished for ${name}, but four Demucs stems are not available.`);
      }
      stopSeparationWatch(groupId);
      return;
    }
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted') {
      const reason = job.error || job.message || job.status;
      say(`Separation ${job.status} for ${name}: ${reason}. Use Add / Process Track to retry.`);
      stopSeparationWatch(groupId);
    }
  }

  function watchSeparation(groupId, trackId, job) {
    stopSeparationWatch(groupId);
    if (!job?.id) return;
    const unsub = watchJobImpl(job.id, (updated) => {
      void onSeparationUpdate(groupId, trackId, updated);
    });
    separationWatches.set(groupId, { trackId, jobId: job.id, unsub });
    void onSeparationUpdate(groupId, trackId, job);
  }

  async function startSeparation(groupId, trackId) {
    let active = null;
    try {
      active = await findActiveSeparation(trackId);
    } catch (err) {
      if (groupSelects[groupId].value !== trackId) return;
      say(`Could not read separation jobs for group ${groupId}: ${err?.message || 'request failed'}`);
      return;
    }
    if (disposed || groupSelects[groupId].value !== trackId) return;
    if (active) {
      watchSeparation(groupId, trackId, active);
      return;
    }
    let job = null;
    try {
      job = await submitSeparationImpl(trackId, 'demucs');
    } catch (err) {
      if (disposed || groupSelects[groupId].value !== trackId) return;
      say(`Group ${groupId}: Demucs separation is unavailable. ${err?.message || 'request failed'}. Use Add / Process Track to retry when Demucs is available.`);
      return;
    }
    if (disposed || groupSelects[groupId].value !== trackId || !job) return;
    if (store) {
      try { store.dispatch({ type: 'jobs/upsert', job }); } catch { /* the status line still follows the job */ }
    }
    watchSeparation(groupId, trackId, job);
  }

  async function openChooseTrack(groupId, mode) {
    let picker = openPicker;
    if (!picker) {
      if (!store) {
        say('Choose Track needs the Studio library, which is not connected here.');
        return;
      }
      const mod = await import('./source-picker.js');
      picker = mod.openSourcePicker;
    }
    try {
      await picker(store, null, {
        initialTab: mode === 'add' ? 'upload' : 'library',
        onPick: (track) => { void receivePickedTrack(groupId, track, mode); },
        onImported: (track) => receiveImportedTrack(groupId, track),
      });
    } catch (err) {
      if (!disposed) say(`Choose Track failed: ${err?.message || 'request failed'}`);
    }
  }

  async function receivePickedTrack(groupId, track, mode) {
    if (disposed || !track?.id) return;
    rememberTrack(track, groupId);
    stopSeparationWatch(groupId);
    if (mode === 'add') {
      let variants = [];
      try {
        variants = await readVariants(track.id);
      } catch (err) {
        say(`Could not read stems for group ${groupId}: ${err?.message || 'request failed'}`);
        return;
      }
      if (disposed || groupSelects[groupId].value !== track.id) return;
      if (!completeQuad(variants)) {
        await startSeparation(groupId, track.id);
        return;
      }
    }
    await reportReadiness(groupId, track.id);
  }

  async function receiveImportedTrack(groupId, track) {
    if (disposed || !track?.id) return;
    rememberTrack(track, groupId);
    stopSeparationWatch(groupId);
    const name = track.title || track.name || track.id;
    const imported = `Imported ${name}. The full mix is in the library.`;
    let jobs = [];
    try {
      jobs = await separationJobsFor(track.id);
    } catch {
      jobs = [];
    }
    if (disposed || groupSelects[groupId].value !== track.id) return;
    const active = jobs.find((job) => job.status === 'queued' || job.status === 'running');
    if (active) {
      say(`${imported} Separation is a separate step and is not finished yet.`);
      watchSeparation(groupId, track.id, active);
      return;
    }
    let variants = [];
    try {
      variants = await readVariants(track.id);
    } catch {
      variants = [];
    }
    if (disposed || groupSelects[groupId].value !== track.id) return;
    const quad = completeQuad(variants);
    if (quad) {
      const ready = demucsQuad(quad)
        ? 'Separation has since finished: Four Demucs stems are ready.'
        : importedQuad(quad)
          ? 'Four imported stems are ready.'
          : 'Four isolated stems are ready.';
      say(`${imported} ${ready} Load ${groupId} to play them.`);
      return;
    }
    const terminal = jobs.find((job) => (
      job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted'
    ));
    if (terminal) {
      const reason = terminal.error || terminal.message || terminal.status;
      const split = variants.some((variant) => variant && (variant.name === 'center' || variant.name === 'sides'));
      const extra = split ? ' A center/sides split is not four Demucs stems.' : '';
      say(`Separation ${terminal.status} for ${name}: ${reason}.${extra} Use Add / Process Track to retry.`);
      return;
    }
    if (variants.some((variant) => variant && (variant.name === 'center' || variant.name === 'sides'))) {
      say(`${imported} Separation finished as a center/sides split, not four Demucs stems.`);
      return;
    }
    say(`${imported} Separation is a separate step and is not finished yet.`);
  }

  function trackTitle(trackId) {
    for (const groupId of GROUP_IDS) {
      const select = groupSelects[groupId];
      if (select.value !== trackId) continue;
      const option = [...select.options].find((entry) => entry.value === trackId);
      if (option) return option.textContent;
    }
    const option = [...groupSelects.A.options].find((entry) => entry.value === trackId);
    return option ? option.textContent : trackId;
  }

  function refreshDisplayedNames() {
    const items = store?.getState?.().library?.items || [];
    const names = new Map(items.filter((track) => track && track.id).map((track) => [track.id, track.name]));
    for (const groupId of GROUP_IDS) {
      const select = groupSelects[groupId];
      for (const option of select.options) {
        if (names.has(option.value)) option.textContent = names.get(option.value);
      }
      const view = groupViews.get(groupId);
      const selected = [...select.options].find((option) => option.value === select.value);
      if (view && selected && selected.value) {
        view.heading.textContent = `Group ${groupId} · ${selected.textContent}`;
      }
    }
  }

  let unsubscribeNames = () => {};
  if (store && typeof store.subscribeSlice === 'function') {
    unsubscribeNames = store.subscribeSlice('library', () => {
      if (!disposed) refreshDisplayedNames();
    });
  }

  function createRowView(key) {
    const nameEl = createElement('div', { class: 'stem-desk__name' });
    const metaEl = createElement('div', { class: 'stem-desk__meta' });
    const silentEl = createElement('div', { class: 'stem-desk__meta stem-desk__silent' });
    const mute = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'M',
    });
    const solo = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'S',
    });
    const gain = createElement('input', {
      type: 'range',
      min: String(STEM_DESK_LIMITS.minGainDb),
      max: String(STEM_DESK_LIMITS.maxGainDb),
      step: '1',
      value: '0',
    });
    const gainText = createElement('span', { class: 'stem-desk__meta', text: '0 dB' });
    const row = createElement('div', { class: 'stem-desk__row', dataset: { key } }, [
      createElement('div', {}, [nameEl, metaEl, silentEl]),
      createElement('div', { class: 'stem-desk__actions' }, [mute, solo, gain, gainText]),
    ]);
    const view = { key, row, nameEl, metaEl, silentEl, mute, solo, gain, gainText, lane: null };

    mute.addEventListener('click', () => {
      if (!view.lane) return;
      dropPendingProposal();
      const label = `${groupLabel(view.lane.trackId)} · ${stemLabel(view.lane.name)}`;
      const next = !view.lane.muted;
      const nextState = desk.setMuted(view.lane.key, next);
      say(`${label} ${next ? 'muted' : 'unmuted'}.`);
      renderLanes(nextState);
    });
    solo.addEventListener('click', () => {
      if (!view.lane) return;
      dropPendingProposal();
      const label = `${groupLabel(view.lane.trackId)} · ${stemLabel(view.lane.name)}`;
      const next = !view.lane.solo;
      const nextState = desk.setSolo(view.lane.key, next);
      const stateLane = nextState.lanes.find((entry) => entry.key === view.lane.key);
      const silentNote = next && stateLane?.silent
        ? ' This stem is effectively silent in this set.'
        : '';
      say(`${next ? 'Solo' : 'Solo released for'} ${label}.${silentNote}`);
      renderLanes(nextState);
    });
    gain.addEventListener('input', (event) => {
      if (!view.lane) return;
      dropPendingProposal();
      const nextState = desk.setGain(view.lane.key, event.target.value);
      const stateLane = nextState.lanes.find((entry) => entry.key === view.key);
      if (stateLane) view.lane = stateLane;
      // The row itself is deliberately not rebuilt: only its own readout and
      // live gain-node state change while the user drags.
      gainText.textContent = `${event.target.value} dB`;
    });

    rowViews.set(key, view);
    return view;
  }

  function updateRowView(view, lane) {
    view.lane = lane;
    const label = `${groupLabel(lane.trackId)} · ${stemLabel(lane.name)}`;
    view.nameEl.textContent = stemLabel(lane.name);
    view.metaEl.textContent = provenanceLabel(lane);
    view.silentEl.textContent = lane.silent ? 'effectively silent in this set' : '';
    view.silentEl.hidden = !lane.silent;
    view.mute.setAttribute('aria-label', `Mute ${label}`);
    view.mute.setAttribute('aria-pressed', lane.muted ? 'true' : 'false');
    view.solo.setAttribute('aria-label', `Solo ${label}`);
    view.solo.setAttribute('aria-pressed', lane.solo ? 'true' : 'false');
    view.gain.setAttribute('aria-label', `${label} gain`);
    view.gain.value = String(lane.gainDb);
    view.gainText.textContent = `${lane.gainDb} dB`;
  }

  function renderLanes(state) {
    const lanes = state?.lanes || [];
    const groups = state?.groups || [];
    const anyFallback = lanes.some((lane) => lane.name === 'center' || lane.name === 'sides');
    note.hidden = !anyFallback;
    note.textContent = anyFallback ? FALLBACK_NOTE : '';

    policy.textContent = groups.length >= 2
      ? 'Solo applies across both tracks. The crossfader and each group level still apply on top, so a soloed lane on a closed track is silent.' + TWO_TRACK_POLICY
      : 'Solo applies across both tracks. The crossfader and each group level still apply on top, so a soloed lane on a closed track is silent.' + ONE_TRACK_POLICY;

    const liveGroupIds = new Set(groups.map((group) => group.trackId));
    for (const [groupId, view] of groupViews) {
      if (!liveGroupIds.has(groupId)) {
        view.section.remove();
        groupViews.delete(groupId);
      }
    }

    for (const group of groups) {
      let view = groupViews.get(group.trackId);
      if (!view) {
        const heading = createElement('h3', { class: 'stem-desk__group-title' });
        const rows = createElement('div', { class: 'stem-desk__group-rows' });
        const level = groupLevelRow(group.trackId, (value) => {
          if (!desk) return;
          dropPendingProposal();
          const next = desk.setTrackLevel(group.trackId, value);
          refreshTransport(next);
          say(`Group ${group.trackId} level ${value} dB.`);
        });
        const timing = groupTimingRow(group.trackId, (delta) => {
          if (!desk) return;
          dropPendingProposal();
          const current = desk.state().groups
            .find((entry) => entry.trackId === group.trackId)?.entryOffsetMs ?? 0;
          const nextMs = delta == null ? 0 : current + delta;
          const next = desk.setGroupEntryOffset(group.trackId, nextMs);
          const stored = next.groups
            .find((entry) => entry.trackId === group.trackId)?.entryOffsetMs ?? 0;
          const live = groupViews.get(group.trackId);
          if (live?.timing) live.timing.readout.textContent = formatEntryOffset(stored);
          say(`Group ${group.trackId} entry ${formatEntryOffset(stored)}. Takes effect on the next Play.`);
        });
        const section = createElement('section', {
          class: 'stem-desk__group',
          dataset: { group: group.trackId },
        }, [heading, level.row, timing.row, rows]);
        view = { section, heading, rows, level, timing };
        groupViews.set(group.trackId, view);
        lanesMount.appendChild(section);
      }
      view.heading.textContent = `Group ${group.trackId} · ${group.title}`;
      view.level.input.value = String(group.levelDb ?? 0);
      view.level.text.textContent = `${group.levelDb ?? 0} dB`;
      if (view.timing) view.timing.readout.textContent = formatEntryOffset(group.entryOffsetMs);
      const groupLanes = lanes.filter((lane) => lane.trackId === group.trackId);
      const rows = groupLanes.map((lane) => {
        const rowView = rowViews.get(lane.key) || createRowView(lane.key);
        updateRowView(rowView, lane);
        return rowView.row;
      });
      // replaceChildren moves the existing row nodes instead of recreating
      // them, so a gain drag keeps the same element and focus.
      replaceChildren(view.rows, rows);
    }

    const liveKeys = new Set(lanes.map((lane) => lane.key));
    for (const [key, view] of rowViews) {
      if (!liveKeys.has(key)) {
        view.row.remove();
        rowViews.delete(key);
      }
    }
    syncProposalButtons();
  }

  function updateCrossfader(state) {
    const value = state?.crossfader || { position: 50, gainA: 0, gainB: 0, disabled: true };
    crossfaderInput.value = String(value.position);
    crossfaderInput.disabled = Boolean(value.disabled);
    crossfaderGains.textContent = `gainA ${value.gainA.toFixed(2)} · gainB ${value.gainB.toFixed(2)}`;
    crossfaderInput.setAttribute(
      'aria-valuetext',
      `gainA ${value.gainA.toFixed(2)}, gainB ${value.gainB.toFixed(2)}`,
    );
  }

  function refreshTransport(state = desk?.state()) {
    const playing = state?.status === 'playing';
    const hasLanes = Boolean(state?.lanes?.length);
    playButton.disabled = !hasLanes || (!playing && state.status !== 'ready') ? 'true' : undefined;
    stopButton.disabled = playing ? undefined : 'true';
    playButton.textContent = playing ? 'Restart' : 'Play';
    if (!playing) positionLabel.textContent = '0.0 s';
    if (state) updateCrossfader(state);
  }

  function startPositionTimer() {
    window.clearInterval(positionTimer);
    positionTimer = window.setInterval(() => {
      if (!desk) return;
      const state = desk.state();
      if (state.status !== 'playing') {
        window.clearInterval(positionTimer);
        positionTimer = null;
        positionLabel.textContent = '0.0 s';
        refreshTransport(state);
        renderLanes(state);
        // A load in flight stops the transport by design; that is not the
        // programme reaching its end and must not be announced as such.
        if (state.status === 'ready' && loadingCount === 0) say('The stem desk reached the end.');
        return;
      }
      positionLabel.textContent = `${state.positionSeconds.toFixed(1)} s`;
    }, 200);
  }

  playButton.addEventListener('click', async () => {
    try {
      const before = await desk.resume();
      // The accepted single-track desk loops, so preserve that exactly.
      // Two tracks are a performance mix: play once, stop at the longest lane,
      // because looping unequal-length tracks would wrap them out of phase.
      const groups = desk.state().groups || [];
      const loop = groups.length <= 1;
      const state = desk.play({ loop });
      renderLanes(state);
      refreshTransport(state);
      startPositionTimer();
      if (before.contextState && before.contextState !== 'running' && before.contextState !== 'unknown') {
        say('The browser is still blocking audio. Press Play again to allow sound.');
      } else if (loop) {
        say(`Looping ${state.lanes.length} lanes started on one clock.`);
      } else {
        const nudged = (state.groups || [])
          .filter((group) => group.entryOffsetMs)
          .map((group) => `Group ${group.trackId} ${formatEntryOffset(group.entryOffsetMs)}`);
        const entryNote = nudged.length ? ` Entry ${nudged.join(', ')}.` : '';
        say(
          `Started ${state.lanes.length} lanes on one clock.${entryNote} Playback ends with the longest lane; ` +
          'this is a shared start, not tempo or beat matching.',
        );
      }
    } catch (err) {
      say(err?.message || 'The stem desk could not start.');
    }
  });

  stopButton.addEventListener('click', () => {
    if (!desk) return;
    window.clearInterval(positionTimer);
    positionTimer = null;
    const state = desk.stop();
    renderLanes(state);
    positionLabel.textContent = '0.0 s';
    refreshTransport(state);
    say('Stem desk stopped.');
  });

  askButton.addEventListener('click', () => {
    if (!desk || loadingCount > 0) return;
    const groups = desk.state().groups || [];
    if (groups.length < 2) {
      dropPendingProposal();
      sayProposal(PROPOSAL_INCOMPLETE);
      return;
    }
    const suggestion = suggestStemDeskProposal(desk.state());
    if (!suggestion.ok) {
      dropPendingProposal();
      sayProposal(suggestion.message);
      return;
    }
    pendingProposal = suggestion.proposal;
    proposalPreviewed = false;
    sayProposal(PROPOSAL_UNAPPROVED);
    syncProposalButtons();
  });

  previewButton.addEventListener('click', () => {
    if (!desk || !pendingProposal) return;
    const checked = validateStemDeskProposal(pendingProposal, desk.state());
    if (!checked.ok) {
      pendingProposal = null;
      proposalPreviewed = false;
      sayProposal(checked.message);
      syncProposalButtons();
      return;
    }
    proposalPreviewed = true;
    sayProposal(`Preview only. ${pendingProposal.rationale} Nothing is applied until Approve.`);
    syncProposalButtons();
  });

  approveButton.addEventListener('click', () => {
    if (!desk || !pendingProposal || !proposalPreviewed) return;
    const result = approveStemDeskProposal(pendingProposal, desk);
    pendingProposal = null;
    proposalPreviewed = false;
    syncProposalButtons();
    if (!result.ok) {
      sayProposal(result.message);
      return;
    }
    renderLanes(result.state);
    refreshTransport(result.state);
    sayProposal(PROPOSAL_APPROVED);
  });

  rejectButton.addEventListener('click', () => {
    if (!pendingProposal) return;
    dropPendingProposal();
  });

  crossfaderInput.addEventListener('input', (event) => {
    if (!desk) return;
    dropPendingProposal();
    const state = desk.setCrossfader(event.target.value);
    updateCrossfader(state);
    say(`Crossfader A ${state.crossfader.gainA.toFixed(2)} / B ${state.crossfader.gainB.toFixed(2)}.`);
  });

  // Fetched on demand, never on mount: mounting the Studio must not add a
  // request to every page load or to unrelated component tests.
  function ensureTracks() {
    if (tracksLoaded) return Promise.resolve(true);
    if (tracksPending) return tracksPending;
    tracksPending = (async () => {
      try {
        const page = await listTracksImpl({ limit: 50 });
        const tracks = Array.isArray(page?.items)
          ? page.items
          : Array.isArray(page?.tracks)
            ? page.tracks
            : (Array.isArray(page) ? page : []);
        const options = tracks.map((track) => createElement('option', {
          value: track.id,
          text: track.title || track.name || track.originalName || track.id,
        }));
        for (const groupId of GROUP_IDS) {
          const select = groupSelects[groupId];
          const previous = select.value;
          replaceChildren(select, options.length
            ? options.map((option) => option.cloneNode(true))
            : [createElement('option', { value: '', text: 'No tracks in the library' })]);
          select.disabled = options.length === 0 ? 'true' : undefined;
          if (previous && options.some((option) => option.value === previous)) select.value = previous;
          else if (options.length) select.value = options[0].value;
        }
        tracksLoaded = options.length > 0;
        say(options.length
          ? 'Choose separated tracks for A and B, then load each group.'
          : 'No tracks are available.');
        return options.length > 0;
      } catch (err) {
        say(`Could not list tracks: ${err?.message || 'request failed'}`);
        return false;
      } finally {
        tracksPending = null;
      }
    })();
    return tracksPending;
  }

  async function onChoose(groupId) {
    await ensureTracks();
    if (disposed) return;
    await openChooseTrack(groupId, 'choose');
  }

  async function onAdd(groupId) {
    await ensureTracks();
    if (disposed) return;
    const trackId = groupSelects[groupId].value;
    if (!trackId) {
      await openChooseTrack(groupId, 'add');
      return;
    }
    let variants = [];
    try {
      variants = await readVariants(trackId);
    } catch (err) {
      say(`Could not read stems for group ${groupId}: ${err?.message || 'request failed'}`);
      return;
    }
    if (disposed || groupSelects[groupId].value !== trackId) return;
    if (completeQuad(variants)) {
      await openChooseTrack(groupId, 'add');
      return;
    }
    await startSeparation(groupId, trackId);
  }

  /**
   * Import four already-separated files into the group's selected track.
   * The owner names each role; a filename never decides one. The dialog stays
   * open on failure so the same files can be retried.
   */
  function openImportDialog(groupId) {
    const trackId = groupSelects[groupId].value;
    if (!trackId) {
      say(`Choose the target track for group ${groupId} first.`);
      return;
    }
    const layer = document.getElementById('dialog-layer');
    if (!layer) {
      say('The import dialog is unavailable in this page.');
      return;
    }
    const title = trackTitle(trackId);
    const dialog = createElement('dialog', { class: 'dialog' });
    const inputs = {};
    const status = createElement('p', { class: 'stem-desk__meta', role: 'status', text: '' });

    const body = createElement('div', { class: 'dialog__body' }, [
      createElement('h2', { class: 'dialog__title', text: `Import my stems · ${title}` }),
      createElement('p', {
        class: 'dialog__description',
        text:
          'Choose the four files you separated yourself and name each role. They must come '
          + 'from one timeline: the same start point, sample rate and length. Equal length is '
          + 'not proof of alignment — you are responsible for supplying aligned stems. Nothing '
          + 'is resampled, time-stretched or separated.',
      }),
      ...QUAD_NAMES.map((role) => {
        const input = createElement('input', {
          type: 'file',
          accept: '.wav,audio/wav,audio/x-wav',
          'aria-label': `${stemLabel(role)} file`,
        });
        inputs[role] = input;
        return createElement('div', { class: 'stem-desk__import-row' }, [
          createElement('span', { class: 'stem-desk__group-label', text: stemLabel(role) }),
          input,
        ]);
      }),
      status,
    ]);

    const cancel = createElement('button', { type: 'button', class: 'button', text: 'Cancel' });
    const commit = createElement('button', {
      type: 'button', class: 'button button--primary', text: 'Import four stems',
    });
    cancel.addEventListener('click', () => dialog.close());
    commit.addEventListener('click', async () => {
      const chosen = QUAD_NAMES.map((role) => [role, inputs[role].files?.[0] || null]);
      const missing = chosen.filter(([, file]) => !file).map(([role]) => stemLabel(role));
      if (missing.length) {
        status.textContent = `Choose a file for: ${missing.join(', ')}.`;
        return;
      }
      commit.disabled = true;
      cancel.disabled = true;
      const stagedKeys = [];
      try {
        const entries = [];
        for (const [role, file] of chosen) {
          status.textContent = `Staging ${stemLabel(role)}…`;
          const staged = await stageStemFileImpl(file);
          stagedKeys.push(staged.staging_key);
          entries.push({
            role,
            staging_key: staged.staging_key,
            original_name: staged.original_name || file.name,
          });
        }
        status.textContent = 'Validating and publishing the four stems…';
        const result = await importStemSetImpl(trackId, entries);
        dialog.close();
        say(
          `Imported four ${result?.method === 'imported' ? 'owner-supplied' : ''} stems into `
          + `${title}. Load ${groupId} to play them.`,
        );
        await reportReadiness(groupId, trackId);
      } catch (err) {
        status.textContent = `Could not import: ${err?.message || 'request failed'}.`;
        // A failed commit is cleaned up by the server; a failure while staging
        // is not, so drop whatever this attempt already staged.
        if (stagedKeys.length) {
          try {
            await discardStagedStemsImpl(stagedKeys);
          } catch {
            // Housekeeping only; the error above is what the owner needs.
          }
        }
      } finally {
        commit.disabled = undefined;
        cancel.disabled = undefined;
      }
    });

    body.appendChild(createElement('div', { class: 'dialog__actions' }, [cancel, commit]));
    dialog.appendChild(body);
    layer.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
  }

  for (const groupId of GROUP_IDS) {
    const select = groupSelects[groupId];
    select.addEventListener('focus', () => { void ensureTracks(); });
    select.addEventListener('pointerdown', () => { void ensureTracks(); });
    select.addEventListener('change', () => {
      stopSeparationWatch(groupId);
      dropPendingProposal();
      void reportReadiness(groupId);
    });
    groupChoose[groupId].addEventListener('click', () => { void onChoose(groupId); });
    groupImport[groupId].addEventListener('click', () => { openImportDialog(groupId); });
    groupProcess[groupId].addEventListener('click', () => { void onAdd(groupId); });

    groupButtons[groupId].addEventListener('click', async () => {
      // Reserve the single load slot BEFORE any await: two clicks while the
      // library is still being fetched used to start two concurrent loads.
      if (loadingCount > 0) return;
      dropPendingProposal();
      loadingCount += 1;
      syncLoadButtons();
      // Everything after the reservation lives inside this try/finally, so no
      // early return (no track chosen, empty library, a throwing listener) can
      // leave both buttons disabled for the life of the panel.
      let controller = null;
      try {
        if (!tracksLoaded) await ensureTracks();
        if (disposed) return;
        const trackId = select.value;
        if (!trackId) {
          say(`Choose a track for group ${groupId} first.`);
          return;
        }
        aborts.get(groupId)?.abort();
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (controller) aborts.set(groupId, controller);

        const sectionChoice = groupSection[groupId].value;
        const fullLength = sectionChoice === 'full';
        const startSeconds = Number(groupStart[groupId].value);
        if (!fullLength && (!SECTION_SECONDS.has(sectionChoice)
          || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 3600)) {
          say(`Group ${groupId}: choose 30, 60, or 90 seconds, starting between 0 and 3600.`);
          return;
        }
        say(`Loading separated stems for group ${groupId}...`);
        const stems = await listStemsImpl(trackId, controller?.signal);
        if (disposed) return;

        const variants = Array.isArray(stems?.variants) ? stems.variants : [];
        const lanes = selectLanes(variants);
        if (!lanes.length) {
          refreshTransport();
          say(`Group ${groupId}: this track has no separated stems yet. Use Add / Process Track to separate it.`);
          return;
        }
        const sectionNote = fullLength
          ? 'Full length, original sample rate and channels. Higher memory limit.'
          : `Section ${startSeconds}–${startSeconds + Number(sectionChoice)} s of the source, or the remainder if the recording is shorter. Original sample rate and channels.`;
        const state = await ensureDesk().loadGroups([{
          trackId: groupId,
          title: trackTitle(trackId),
          lanes: lanes.map((variant) => ({
            name: variant.name,
            label: stemLabel(variant.name),
            audioUrl: fullLength
              ? variant.audio_url
              : withSection(variant.audio_url, startSeconds, sectionChoice),
            method: variant.method,
            modelName: variant.model_name,
            device: variant.device,
            stemSetId: variant.stem_set_id,
          })),
        }], {
          signal: controller?.signal,
          limits: fullLength ? STEM_DESK_FULL_LIMITS : STEM_DESK_LIMITS,
        });
        if (disposed) return;
        renderLanes(state);
        refreshTransport(state);
        const groupLanes = state.lanes.filter((entry) => entry.trackId === groupId);
        const failures = Array.isArray(state.error?.failures) ? state.error.failures : [];
        const detail = failures[0] || null;
        if (!groupLanes.length) {
          // Show the real reason (byte counts, codes), not just "unavailable".
          const reason = detail
            ? `${detail.code || 'unavailable'} — ${detail.message || detail.name}`
            : (state.error?.message || 'no playable media');
          say(`Group ${groupId} was refused: ${reason}`);
        } else if (state.error?.code === 'S_DESK_FULL') {
          say(`Group ${groupId} was refused by the memory budget: ${state.error.message || detail?.message || 'over budget'}. The other group is unchanged.`);
        } else if (detail) {
          say(
            `Loaded ${groupLanes.length} stems into group ${groupId}. ` +
            `${detail.code || 'Unavailable'} — ${detail.message || detail.name}. ${sectionNote}`,
          );
        } else {
          const silent = groupLanes
            .filter((entry) => entry.silent)
            .map((entry) => stemLabel(entry.name));
          say(
            silent.length
              ? `Loaded ${groupLanes.length} stems into group ${groupId}. ${silent.join(', ')} ` +
                `${silent.length === 1 ? 'is' : 'are'} effectively silent in this set. ${sectionNote}`
              : `Loaded ${groupLanes.length} stems into group ${groupId} on one transport. ${sectionNote}`,
          );
        }
      } catch (err) {
        say(`Could not load group ${groupId}: ${err?.message || 'request failed'}`);
      } finally {
        if (!controller || aborts.get(groupId) === controller) aborts.delete(groupId);
        loadingCount = Math.max(0, loadingCount - 1);
        syncLoadButtons();
      }
    });
  }

  return function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribeNames();
    for (const groupId of GROUP_IDS) stopSeparationWatch(groupId);
    for (const controller of aborts.values()) controller.abort();
    aborts.clear();
    window.clearInterval(positionTimer);
    positionTimer = null;
    desk?.dispose();
    desk = null;
    container.replaceChildren();
  };
}

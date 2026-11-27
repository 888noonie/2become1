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
  discardStagedStems, get, importStemSet, listJobs, listStems, listTracks, patch,
  stageStemFile, submitSeparation, watchJob,
} from '../api.js';
import { createCrateSource } from '../record-crate.js';
import { mountRecordCrate } from './record-crate-panel.js';
import { StemDesk, STEM_DESK_FULL_LIMITS, STEM_DESK_LIMITS } from '../runtime/stem-desk.js';
import {
  applyStemDeskMix,
  approveStemDeskProposal,
  captureStemDeskMix,
  mixControl,
  suggestStemDeskProposal,
  validateStemDeskProposal,
} from '../runtime/stem-desk-proposal.js';

/** Fired by whichever Studio instrument starts playing; the others stop. */
export const EXCLUSIVE_PLAY_EVENT = 'twobecomeone:exclusive-play';
let deskInstance = 0;
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
    createElement('span', { class: 'stem-desk__group-label', text: 'Track level' }),
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
  // The Crate shares the Producer's column and reads Library facts from /api/crate.
  crateSource = null,
  mountCrate = mountRecordCrate,
  // OPERATION NEVER LOSE THE MIX: the application shell may host the
  // Producer/Crate rail in its own sidebar ({ attach(rail, api), openSheet }).
  // Without one the rail stays in the desk's right column, as before.
  railHost = null,
} = {}) {
  if (!container) throw new Error('mountStemDeskPanel requires a container');

  const root = createElement('section', {
    class: 'stem-desk',
    'aria-label': 'Stem Performance Desk',
  });
  const title = createElement('h2', { class: 'stem-desk__title', text: 'Performance desk' });
  const status = createElement('p', { class: 'stem-desk__status', role: 'status', text: 'Choose tracks with stems, or prepare a stem set for each track.' });
  const memoryNote = createElement('p', {
    class: 'stem-desk__meta',
    text: 'A section is cut before the browser decodes it, at the recording’s own sample rate and channel count. Full length allows 128 MiB per stem, 512 MiB for one group, and 1024 MiB for eight stems. Available machine memory is not memory the browser can allocate.',
  });
  const groupControls = createElement('div', { class: 'stem-desk__groups' });
  const groupSelects = {};
  const groupButtons = {};
  const groupUnloadButtons = {};
  const groupChoose = {};
  const groupImport = {};
  const groupProcess = {};
  const groupSection = {};
  const groupStart = {};
  for (const groupId of GROUP_IDS) {
    const select = createElement('select', {
      class: 'select stem-desk__select',
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
      class: 'button button--primary',
      type: 'button',
      text: `Load ${groupId}`,
      'aria-label': `Load stems ${groupId}`,
      dataset: { group: groupId },
    });
    const unloadButton = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Unload stems',
      'aria-label': `Unload stems from group ${groupId}`,
      'aria-describedby': 'stem-desk-unload-hint',
      disabled: 'true',
    });
    const importStemsButton = createElement('button', {
      class: 'button button--sm',
      type: 'button',
      text: 'Import My Stems',
      'aria-label': `Import My Stems for group ${groupId}`,
    });
    const section = createElement('select', {
      class: 'select stem-desk__select',
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
    const row = createElement('section', {
      class: 'stem-desk__group-controls',
      dataset: { group: groupId },
      'aria-label': `Track ${groupId} source and section`,
    }, [
      createElement('h3', { class: 'stem-desk__source-title', text: `Group ${groupId}` }),
      select,
      createElement('div', { class: 'stem-desk__actions stem-desk__source-actions' }, [loadButton, unloadButton]),
      createElement('details', { class: 'source-options' }, [
        createElement('summary', { text: 'Sources & section' }),
        createElement('div', { class: 'stem-desk__actions' }, [chooseLibrary, addOrProcess, importStemsButton]),
        createElement('div', { class: 'stem-desk__section-fields' }, [
          createElement('label', { class: 'field' }, ['Duration', section]),
          createElement('label', { class: 'field' }, ['Start (s)', start]),
        ]),
      ]),
    ]);
    groupSelects[groupId] = select;
    groupButtons[groupId] = loadButton;
    groupUnloadButtons[groupId] = unloadButton;
    groupChoose[groupId] = chooseLibrary;
    groupProcess[groupId] = addOrProcess;
    groupImport[groupId] = importStemsButton;
    groupSection[groupId] = section;
    groupStart[groupId] = start;
    groupControls.appendChild(row);
  }
  const playButton = createElement('button', { class: 'button button--primary', type: 'button', text: 'Play', disabled: 'true' });
  const stopButton = createElement('button', { class: 'button button--sm', type: 'button', text: 'Stop', disabled: 'true' });
  const positionLabel = createElement('span', { class: 'stem-desk__meta', text: '0.0 s' });
  const transport = createElement('div', { class: 'stem-desk__actions stem-desk__transport' }, [playButton, stopButton, positionLabel]);
  const askButton = createElement('button', {
    class: 'button button--sm', type: 'button', text: 'Ask for a proposal', disabled: 'true',
  });
  const previewButton = createElement('button', {
    class: 'button button--sm', type: 'button', text: 'Preview', disabled: 'true',
  });
  // Hear it applies the suggestion to the live desk so it can be heard, and
  // flips to Hear mine to compare. Approve keeps it; Reject returns to the
  // mix as it was. Preview stays display-only.
  const hearButton = createElement('button', {
    class: 'button button--sm', type: 'button', text: 'Hear it', disabled: 'true',
  });
  const approveButton = createElement('button', {
    class: 'button button--primary', type: 'button', text: 'Approve', disabled: 'true',
  });
  const rejectButton = createElement('button', {
    class: 'button button--danger button--sm', type: 'button', text: 'Reject', disabled: 'true',
  });
  const proposalRow = createElement('div', {
    class: 'stem-desk__proposal', role: 'group', 'aria-label': 'Stem proposal',
  }, [askButton, previewButton, hearButton, approveButton, rejectButton]);
  const proposalStatus = createElement('p', { class: 'stem-desk__proposal-status', role: 'status' });
  const proposalDetails = createElement('div', { class: 'stem-desk__proposal-details', hidden: 'true' });
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
    'aria-label': 'Crossfader A to B', disabled: 'true',
  });
  const crossfaderGains = createElement('span', { class: 'stem-desk__meta stem-desk__crossfader-gains', text: 'A — / B —' });
  const crossfader = createElement('div', { class: 'stem-desk__crossfader-row' }, [
    createElement('span', { class: 'stem-desk__group-label', text: 'Crossfader' }),
    createElement('div', { class: 'stem-desk__fade-track' }, [
      createElement('span', { text: 'A', 'aria-hidden': 'true' }),
      crossfaderInput,
      createElement('span', { text: 'B', 'aria-hidden': 'true' }),
    ]),
    crossfaderGains,
  ]);
  const lanesMount = createElement('div', { class: 'stem-desk__lanes' });
  const note = createElement('p', { class: 'stem-desk__note', hidden: 'true' });
  const policy = createElement('p', {
    class: 'stem-desk__meta stem-desk__policy',
    text: 'Solo applies across both tracks. The crossfader and track levels can still silence a soloed lane.',
  });
  const TWO_TRACK_POLICY = ' Two tracks start on one clock at their own tempo; this desk does not beat-match them.';
  const ONE_TRACK_POLICY = ' A single loaded track loops.';

  const memory = createElement('details', { class: 'stem-desk__memory' }, [
    createElement('summary', { text: 'Section quality and memory limits' }),
    memoryNote,
  ]);
  const producer = createElement('section', {
    class: 'stem-desk__producer',
    'aria-label': 'AI Producer',
  }, [
    createElement('h3', { text: 'AI Producer' }),
    createElement('p', { class: 'producer-guide', text: 'Build an arrangement from your loaded stems. Hear the suggested mix, compare it with yours, then keep it or go back.' }),
    proposalRow,
    proposalStatus,
    proposalDetails,
  ]);
  // Shown instead of the desk Producer's controls while another Producer is
  // in charge of the page (the Arrangement surface has its own).
  const producerAway = createElement('p', { class: 'stem-desk__producer-away', hidden: 'true' });
  producer.appendChild(producerAway);

  // The right column holds two tabs: Producer and Crate. They take turns in
  // the same width, so the eight strips never get narrower. While the
  // Producer has an idea pending, a strip above the Crate says so.
  deskInstance += 1;
  const railId = `stem-desk-${deskInstance}`;
  const producerTab = createElement('button', {
    type: 'button', role: 'tab', id: `${railId}-tab-producer`, class: 'desk-rail__tab',
    'aria-selected': 'true', 'aria-controls': `${railId}-producer`, dataset: { tab: 'producer' },
  }, [
    createElement('span', { text: 'Producer' }),
    createElement('span', { class: 'desk-rail__pending-dot', 'aria-hidden': 'true' }),
    createElement('span', { class: 'sr-only desk-rail__pending-text' }),
  ]);
  const crateTab = createElement('button', {
    type: 'button', role: 'tab', id: `${railId}-tab-crate`, class: 'desk-rail__tab',
    'aria-selected': 'false', 'aria-controls': `${railId}-crate`, tabindex: '-1', dataset: { tab: 'crate' },
  }, [createElement('span', { text: 'Crate' })]);
  const railTabs = createElement('div', {
    class: 'desk-rail__tabs', role: 'tablist', 'aria-label': 'Producer and Crate',
  }, [producerTab, crateTab]);
  producer.id = `${railId}-producer`;
  producer.setAttribute('role', 'tabpanel');
  producer.setAttribute('aria-labelledby', producerTab.id);
  const ideaStripText = createElement('span', { class: 'desk-rail__idea-text' });
  const ideaStripButton = createElement('button', {
    type: 'button', class: 'button button--sm desk-rail__idea-show', text: 'Show Producer',
  });
  const ideaStrip = createElement('div', {
    class: 'desk-rail__idea', hidden: 'true',
  }, [ideaStripText, ideaStripButton]);
  const crateExpand = createElement('button', {
    type: 'button', class: 'button button--sm record-crate__expand', text: 'Expand',
    'aria-expanded': 'false', 'aria-controls': `${railId}-crate`,
  });
  const crateHost = createElement('div', { class: 'record-crate-host' });
  const cratePanel = createElement('section', {
    id: `${railId}-crate`, class: 'desk-rail__crate', role: 'tabpanel',
    'aria-labelledby': crateTab.id, hidden: 'true',
  }, [ideaStrip, crateHost]);
  const rail = createElement('div', { class: 'desk-rail', dataset: { tab: 'producer' } }, [railTabs, producer, cratePanel]);
  // With a shell host the rail lives in the sidebar; narrow screens put it
  // back here, under the desk, while the desk is on screen.
  const railSlot = createElement('div', { class: 'desk-rail-slot' });
  // Below 1100 px the column sits under the desk, so the desk heading gets
  // a Crate button that opens the Crate as a sheet.
  const crateOpen = createElement('button', {
    type: 'button', class: 'button button--sm stem-desk__crate-open', text: 'Crate',
    'aria-haspopup': 'dialog',
  });

  container.replaceChildren(root);
  replaceChildren(root, [
    createElement('header', { class: 'console-heading' }, [title, crateOpen]),
    createElement('div', { class: 'console-body' }, [
      createElement('div', { class: 'console-banks' }, [
        groupControls,
        createElement('p', {
          id: 'stem-desk-unload-hint',
          class: 'stem-desk__meta',
          text: 'Unloading during playback stops both banks. The other bank stays loaded.',
        }),
        createElement('div', { class: 'stem-desk__master' }, [transport, crossfader]),
        lanesMount,
        createElement('div', { class: 'standby-banks' }, GROUP_IDS.map(id =>
          createElement('div', { class: 'standby-bank', dataset: { group: id } }, [
            createElement('span', { class: 'standby-disc', 'aria-hidden': 'true', text: id }),
            createElement('span', { text: `Track ${id} · Awaiting stems` }),
          ])
        )),
        status, note, policy, memory,
      ]),
      railHost ? railSlot : rail,
    ]),
  ]);
  if (railHost) root.querySelector('.console-body')?.classList.add('console-body--solo');

  let desk = null;
  let activeLoad = null;
  const separationWatches = new Map();
  const readinessTokens = { A: 0, B: 0 };
  let positionTimer = null;
  let disposed = false;
  let tracksLoaded = false;
  let tracksPending = null;
  let playRequest = 0;
  let pendingProposal = null;
  let proposalPreviewed = false;
  // One idea at a time, from Hear it (or Approve) until it is set aside or
  // undone: the suggestion, the mix from just before it, the controls the
  // musician has moved since (nothing ever moves those back), and what is on
  // the desk now: 'idea', 'mine', or 'kept' (the idea was kept; Undo is ready).
  let idea = null;
  const auditioning = () => idea !== null && idea.hearing !== 'kept';
  const rowViews = new Map();
  const groupViews = new Map();
  // Which Library track each bank actually holds. Set only when a load
  // commits; a refused reload keeps the previous track, and unload clears it.
  const loadedTrackIds = { A: null, B: null };
  let lastMessage = '';
  const sessionListeners = new Set();
  let sessionQueued = false;

  function producerPendingText() {
    if (idea?.hearing === 'idea') return 'Hearing the Producer’s suggestion.';
    if (idea?.hearing === 'mine') return 'Hearing your mix. The suggestion is still waiting.';
    if (idea?.hearing === 'kept') return 'Suggestion kept. Undo is in the Producer tab.';
    if (pendingProposal) return 'A Producer proposal is waiting.';
    return '';
  }

  /** What the Crate may read: selection, loaded tracks, loading and transport. */
  function deskSession() {
    const state = desk?.state();
    const live = new Set((state?.groups || []).map((group) => group.trackId));
    const loading = activeLoad && !activeLoad.controller.signal.aborted ? activeLoad.groupId : null;
    const banks = {};
    for (const id of GROUP_IDS) {
      banks[id] = {
        selectedTrackId: groupSelects[id].value || null,
        loadedTrackId: live.has(id) ? loadedTrackIds[id] : null,
        loading: loading === id,
      };
    }
    return {
      banks,
      loading,
      playing: Boolean(state?.playing),
      message: lastMessage,
      producer: producerPendingText() || null,
    };
  }

  function emitSession() {
    if (sessionQueued || disposed) return;
    sessionQueued = true;
    queueMicrotask(() => {
      sessionQueued = false;
      if (disposed) return;
      const snapshot = deskSession();
      for (const listener of sessionListeners) {
        try { listener(snapshot); } catch { /* a viewer must not break the desk */ }
      }
    });
  }

  function syncRailIdea() {
    const text = producerPendingText();
    ideaStrip.hidden = !text;
    ideaStripText.textContent = text;
    producerTab.dataset.pending = text ? 'true' : 'false';
    producerTab.querySelector('.desk-rail__pending-text').textContent = text ? ' (idea pending)' : '';
  }

  function syncProposalButtons() {
    const groups = desk?.state()?.groups?.length || 0;
    askButton.disabled = activeLoad || groups < 1 ? 'true' : undefined;
    previewButton.disabled = pendingProposal && !auditioning() ? undefined : 'true';
    hearButton.disabled = pendingProposal ? undefined : 'true';
    hearButton.textContent = idea?.hearing === 'idea' ? 'Hear mine' : 'Hear it';
    // One button, named for what pressing it keeps or takes back.
    if (auditioning()) {
      approveButton.textContent = idea.hearing === 'idea' ? 'Keep it' : 'Keep mine';
      approveButton.disabled = undefined;
    } else if (idea?.hearing === 'kept') {
      approveButton.textContent = 'Undo';
      approveButton.disabled = undefined;
    } else {
      approveButton.textContent = 'Approve';
      approveButton.disabled = pendingProposal && proposalPreviewed ? undefined : 'true';
    }
    rejectButton.disabled = pendingProposal ? undefined : 'true';
    syncRailIdea();
    emitSession();
  }

  function syncLoadButtons() {
    const groups = desk?.state()?.groups || [];
    for (const id of GROUP_IDS) {
      const loaded = groups.some((group) => group.trackId === id);
      const loading = activeLoad?.groupId === id && !activeLoad.controller.signal.aborted;
      groupButtons[id].disabled = Boolean(activeLoad);
      groupUnloadButtons[id].disabled = !loaded && !loading;
    }
    syncProposalButtons();
  }

  function sayProposal(message, phase = 'notice') {
    producer.dataset.phase = phase;
    proposalDetails.hidden = phase !== 'preview';
    proposalStatus.textContent = message;
    try {
      onAnnounce?.(message);
    } catch {
      // An announcement listener is a viewer, not the approval path.
    }
  }

  // A live move by the musician. While an idea is being heard or can still be
  // undone, the move is simply theirs from then on: nothing puts that control
  // back. Otherwise it ends the pending proposal as before.
  function humanMove(control) {
    if (!idea) {
      dropPendingProposal();
      return;
    }
    if (control) idea.touched.add(control);
  }

  // Changes on a playing desk glide over a few milliseconds (the desk's own
  // AudioParam automation); on a stopped desk, or a stand-in without it, they
  // are plain assignments.
  function glide(change) {
    return typeof desk?.glide === 'function' ? desk.glide(change) : change();
  }

  // Put the desk back to the mix from just before the idea, except for the
  // controls the musician has moved since. Never plays anything.
  function returnToBefore() {
    const held = idea;
    idea = null;
    try {
      const state = glide(() => applyStemDeskMix(held.before, desk, held.touched)).state;
      renderLanes(state);
      refreshTransport(state);
      return true;
    } catch {
      // The desk changed under the idea (a group was replaced); there is
      // nothing of the old mix left to restore.
      return false;
    }
  }

  function dropPendingProposal() {
    const had = pendingProposal !== null || proposalPreviewed;
    const wasHearing = auditioning();
    if (wasHearing) returnToBefore();
    // A kept idea's Undo does not outlive a new track or a new suggestion.
    else idea = null;
    pendingProposal = null;
    proposalPreviewed = false;
    if (wasHearing) sayProposal('Back to your mix. Nothing was kept.');
    else if (had) sayProposal(PROPOSAL_UNAPPROVED);
    if (producer.dataset.phase === 'approved') {
      sayProposal('Last proposal approved. The mix has since been edited.');
    }
    syncProposalButtons();
  }

  function say(message) {
    status.textContent = message;
    lastMessage = message;
    emitSession();
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
  // The Crate follows Library changes made anywhere (rename, import, delete)
  // with one debounced re-read, once it has been opened.
  let crateRefreshTimer = null;
  let crateRefresh = () => {};
  if (store && typeof store.subscribeSlice === 'function') {
    unsubscribeNames = store.subscribeSlice('library', () => {
      if (disposed) return;
      refreshDisplayedNames();
      clearTimeout(crateRefreshTimer);
      crateRefreshTimer = setTimeout(() => { if (!disposed) crateRefresh(); }, 400);
    });
  }

  function createRowView(key) {
    const nameEl = createElement('div', { class: 'stem-desk__name' });
    const metaEl = createElement('div', { class: 'stem-desk__meta' });
    const silentEl = createElement('div', { class: 'stem-desk__meta stem-desk__silent' });
    const mute = createElement('button', {
      type: 'button',
      text: 'M',
      class: 'button button--sm stem-desk__mute',
    });
    const solo = createElement('button', {
      type: 'button',
      text: 'S',
      class: 'button button--sm stem-desk__solo',
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
      createElement('div', { class: 'stem-desk__lane-label' }, [nameEl, metaEl, silentEl]),
      createElement('div', { class: 'stem-desk__actions stem-desk__lane-controls' }, [mute, solo, gain, gainText]),
    ]);
    const view = { key, row, nameEl, metaEl, silentEl, mute, solo, gain, gainText, lane: null };

    mute.addEventListener('click', () => {
      if (!view.lane) return;
      humanMove(mixControl.mute(view.lane.key));
      const label = `${groupLabel(view.lane.trackId)} · ${stemLabel(view.lane.name)}`;
      const next = !view.lane.muted;
      const nextState = desk.setMuted(view.lane.key, next);
      say(`${label} ${next ? 'muted' : 'unmuted'}.`);
      renderLanes(nextState);
    });
    solo.addEventListener('click', () => {
      if (!view.lane) return;
      humanMove(null);
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
      humanMove(mixControl.gain(view.lane.key));
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
      ? 'Solo applies across both tracks. The crossfader and track levels can still silence a soloed lane.' + TWO_TRACK_POLICY
      : 'Solo applies across both tracks. The crossfader and track levels can still silence a soloed lane.' + ONE_TRACK_POLICY;

    const liveGroupIds = new Set(groups.map((group) => group.trackId));
    for (const id of GROUP_IDS) if (!liveGroupIds.has(id)) loadedTrackIds[id] = null;
    emitSession();
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
          humanMove(mixControl.level(group.trackId));
          const next = desk.setTrackLevel(group.trackId, value);
          refreshTransport(next);
          say(`Group ${group.trackId} level ${value} dB.`);
        });
        const timing = groupTimingRow(group.trackId, (delta) => {
          if (!desk) return;
          humanMove(mixControl.offset(group.trackId));
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
        }, [heading, rows, level.row, timing.row]);
        view = { section, heading, rows, level, timing };
        groupViews.set(group.trackId, view);
        // Insert a new A before a surviving B without remounting B's controls.
        const nextBank = group.trackId === 'A' ? groupViews.get('B')?.section : null;
        lanesMount.insertBefore(section, nextBank ?? null);
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
      // Removing and reinserting a focused toggle drops keyboard focus.
      // Keep the mounted rows in place whenever their order is unchanged.
      const mounted = view.rows.children;
      if (mounted.length !== rows.length || rows.some((row, index) => row !== mounted[index])) {
        replaceChildren(view.rows, rows);
      }
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
    crossfaderGains.textContent = `A ${value.gainA.toFixed(2)} / B ${value.gainB.toFixed(2)}`;
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
    transport.dataset.playing = String(playing);
    playButton.textContent = playing ? 'Restart' : 'Play';
    if (!playing) positionLabel.textContent = '0.0 s';
    if (state) updateCrossfader(state);
  }

  function clearPositionTimer() {
    window.clearInterval(positionTimer);
    positionTimer = null;
  }

  function startPositionTimer() {
    clearPositionTimer();
    positionTimer = window.setInterval(() => {
      if (!desk) return;
      const state = desk.state();
      if (state.status !== 'playing') {
        clearPositionTimer();
        positionLabel.textContent = '0.0 s';
        refreshTransport(state);
        renderLanes(state);
        // A load in flight stops the transport by design; that is not the
        // programme reaching its end and must not be announced as such.
        if (state.status === 'ready' && !activeLoad) say('The stem desk reached the end.');
        return;
      }
      positionLabel.textContent = `${state.positionSeconds.toFixed(1)} s`;
    }, 200);
  }

  playButton.addEventListener('click', async () => {
    const request = ++playRequest;
    const current = () => !disposed && request === playRequest;
    try {
      const before = await desk.resume();
      if (!current()) return;
      // The accepted single-track desk loops, so preserve that exactly.
      // Two tracks are a performance mix: play once, stop at the longest lane,
      // because looping unequal-length tracks would wrap them out of phase.
      const groups = desk.state().groups || [];
      const loop = groups.length <= 1;
      // One instrument sounds at a time: the arrangement stops when the desk plays.
      window.dispatchEvent(new CustomEvent(EXCLUSIVE_PLAY_EVENT, { detail: { owner: 'desk' } }));
      if (!current()) return;
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
      if (current()) say(err?.message || 'The stem desk could not start.');
    }
  });

  const onExclusivePlay = (event) => {
    if (event?.detail?.owner === 'desk' || !desk) return;
    if (desk.state().status === 'playing') stopButton.click();
    else playRequest += 1;
  };
  window.addEventListener(EXCLUSIVE_PLAY_EVENT, onExclusivePlay);

  stopButton.addEventListener('click', () => {
    if (!desk) return;
    playRequest += 1;
    clearPositionTimer();
    const state = desk.stop();
    renderLanes(state);
    positionLabel.textContent = '0.0 s';
    refreshTransport(state);
    say('Stem desk stopped.');
  });

  askButton.addEventListener('click', () => {
    if (!desk || activeLoad) return;
    if (idea) dropPendingProposal();
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
    sayProposal('Proposal not approved. Preview the suggested changes before approving.', 'ready');
    syncProposalButtons();
  });

  function showProposalDetails(target, state) {
    const targetsByGroup = GROUP_IDS.map((id) => {
      const group = target.groups[id];
      const lanes = state.lanes.filter((lane) => lane.trackId === id);
      const assignments = lanes.map((lane) => {
        const change = target.lanes[lane.key];
        return `${stemLabel(lane.name)} ${change.muted ? 'muted' : 'open'}, ${change.gainDb} dB`;
      });
      return createElement('li', {}, [
        createElement('strong', { text: `Group ${id} · ${group.levelDb} dB · entry ${formatEntryOffset(group.entryOffsetMs)}` }),
        createElement('p', { text: assignments.join(' · ') }),
      ]);
    });
    replaceChildren(proposalDetails, [
      createElement('p', { text: `Crossfader at ${target.crossfader}% toward B` }),
      createElement('ul', {}, targetsByGroup),
    ]);
  }

  previewButton.addEventListener('click', () => {
    if (!desk || !pendingProposal) return;
    const state = desk.state();
    const checked = validateStemDeskProposal(pendingProposal, state);
    if (!checked.ok) {
      pendingProposal = null;
      proposalPreviewed = false;
      sayProposal(checked.message);
      syncProposalButtons();
      return;
    }
    showProposalDetails(checked.proposal, state);
    proposalPreviewed = true;
    sayProposal(`Preview only. ${pendingProposal.rationale} Nothing is applied until Approve.`, 'preview');
    syncProposalButtons();
  });

  const HEARING_IDEA = 'Hearing the suggestion. Your own moves stay yours.';
  const HEARING_MINE = 'Hearing your mix. The suggestion is one press away.';

  hearButton.addEventListener('click', () => {
    if (!desk || !pendingProposal) return;
    if (auditioning()) {
      // Flip between the suggestion and the musician's mix on the one
      // transport. Controls the musician has touched are never moved.
      const next = idea.hearing === 'idea' ? 'mine' : 'idea';
      const mix = next === 'idea' ? idea.target : idea.before;
      const state = glide(() => applyStemDeskMix(mix, desk, idea.touched)).state;
      idea.hearing = next;
      renderLanes(state);
      refreshTransport(state);
      sayProposal(next === 'idea' ? HEARING_IDEA : HEARING_MINE, 'preview');
      syncProposalButtons();
      return;
    }
    const state = desk.state();
    const checked = validateStemDeskProposal(pendingProposal, state);
    if (!checked.ok) {
      pendingProposal = null;
      proposalPreviewed = false;
      sayProposal(checked.message);
      syncProposalButtons();
      return;
    }
    idea = { target: checked.proposal, before: captureStemDeskMix(state), touched: new Set(), hearing: 'idea' };
    showProposalDetails(checked.proposal, state);
    proposalPreviewed = true;
    let applied;
    try {
      applied = glide(() => applyStemDeskMix(checked.proposal, desk)).state;
    } catch (error) {
      returnToBefore();
      pendingProposal = null;
      proposalPreviewed = false;
      sayProposal(`Could not try the suggestion: ${error?.message || 'the desk refused it'}. Your mix is unchanged.`);
      syncProposalButtons();
      return;
    }
    renderLanes(applied);
    refreshTransport(applied);
    sayProposal(HEARING_IDEA, 'preview');
    syncProposalButtons();
  });

  // Keep it / Keep mine / Undo / Approve: one button that keeps what the
  // musician is hearing, or takes back the idea they last kept.
  approveButton.addEventListener('click', () => {
    if (!desk) return;
    if (idea?.hearing === 'kept') {
      returnToBefore();
      syncProposalButtons();
      sayProposal('Undone. Back to your mix from before the suggestion; your own moves stay.');
      if (document.activeElement === approveButton) askButton.focus();
      return;
    }
    if (auditioning()) {
      pendingProposal = null;
      proposalPreviewed = false;
      if (idea.hearing === 'mine') {
        // Keep what is heard: the musician's mix. The suggestion was never
        // applied to it, so nothing changes and there is nothing to undo.
        idea = null;
        syncProposalButtons();
        sayProposal('Kept your mix. The suggestion is set aside.');
        if (document.activeElement === approveButton) askButton.focus();
      } else {
        // Focus stays here: the same button is now Undo.
        idea.hearing = 'kept';
        syncProposalButtons();
        sayProposal('Kept the suggestion. Undo takes it back; your own moves stay.', 'approved');
      }
      return;
    }
    if (!pendingProposal || !proposalPreviewed) return;
    const before = captureStemDeskMix(desk.state());
    const result = glide(() => approveStemDeskProposal(pendingProposal, desk));
    pendingProposal = null;
    proposalPreviewed = false;
    if (result.ok) idea = { target: null, before, touched: new Set(), hearing: 'kept' };
    syncProposalButtons();
    if (!result.ok) {
      sayProposal(result.message);
      return;
    }
    renderLanes(result.state);
    refreshTransport(result.state);
    sayProposal(PROPOSAL_APPROVED, 'approved');
    if (document.activeElement === approveButton) askButton.focus();
  });

  rejectButton.addEventListener('click', () => {
    if (!pendingProposal) return;
    dropPendingProposal();
    if (document.activeElement === rejectButton) askButton.focus();
  });

  crossfaderInput.addEventListener('input', (event) => {
    if (!desk) return;
    humanMove(mixControl.crossfader);
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
        if (disposed) return false;
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
        if (!activeLoad?.controller.signal.aborted) {
          say(options.length
            ? 'Choose separated tracks for A and B, then load each group.'
            : 'No tracks are available.');
        }
        return options.length > 0;
      } catch (err) {
        if (!disposed && !activeLoad?.controller.signal.aborted) {
          say(`Could not list tracks: ${err?.message || 'request failed'}`);
        }
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
    const dialog = createElement('dialog', {
      class: 'dialog', 'aria-labelledby': 'stem-import-title', 'aria-describedby': 'stem-import-description',
    });
    const inputs = {};
    const status = createElement('p', { class: 'stem-desk__meta', role: 'status', text: '' });

    const body = createElement('div', { class: 'dialog__body' }, [
      createElement('h2', { class: 'dialog__title', id: 'stem-import-title', text: `Import my stems · ${title}` }),
      createElement('p', {
        class: 'dialog__description',
        id: 'stem-import-description',
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
      emitSession();
      stopSeparationWatch(groupId);
      dropPendingProposal();
      void reportReadiness(groupId);
    });
    groupChoose[groupId].addEventListener('click', () => { void onChoose(groupId); });
    groupImport[groupId].addEventListener('click', () => { openImportDialog(groupId); });
    groupProcess[groupId].addEventListener('click', () => { void onAdd(groupId); });

    const unloadButton = groupUnloadButtons[groupId];
    unloadButton.addEventListener('click', () => {
      const before = desk?.state();
      const loaded = before?.groups?.some((group) => group.trackId === groupId);
      const load = activeLoad?.groupId === groupId ? activeLoad : null;
      const loading = load && !load.controller.signal.aborted;
      if (!loaded && !loading) return;

      const restoreFocus = document.activeElement === unloadButton;
      playRequest += 1;
      readinessTokens[groupId] += 1;
      if (loading) load.controller.abort();
      if (loaded) {
        clearPositionTimer();
        dropPendingProposal();
        const state = desk.unloadGroup(groupId);
        renderLanes(state);
        refreshTransport(state);
        say(`Unloaded stems from group ${groupId}.${before.playing ? ' Playback stopped.' : ''}`);
      } else {
        say(`Cancelled the stem load for group ${groupId}.`);
      }
      syncLoadButtons();
      if (restoreFocus) {
        const next = groupButtons[groupId].disabled ? select : groupButtons[groupId];
        if (!next.disabled) next.focus();
      }
    });

    const loadButton = groupButtons[groupId];
    loadButton.addEventListener('click', async (event) => {
      // Keep the one load slot until a cancelled decode settles so rapid
      // reloads cannot queue extra decoded buffers.
      if (activeLoad) return;
      const controller = new AbortController();
      const { signal } = controller;
      const load = { groupId, controller };
      activeLoad = load;
      // A native keyboard click has no click count. Disabling the button can
      // drop focus to the body while the request is pending.
      let restoreFocus = event.detail === 0 && document.activeElement === loadButton;
      const relinquishFocus = () => {
        restoreFocus = false;
        document.removeEventListener('focusin', relinquishFocus, true);
        document.removeEventListener('pointerdown', relinquishFocus, true);
        window.removeEventListener('blur', relinquishFocus);
      };
      if (restoreFocus) {
        document.addEventListener('focusin', relinquishFocus, true);
        document.addEventListener('pointerdown', relinquishFocus, true);
        window.addEventListener('blur', relinquishFocus);
        signal.addEventListener('abort', relinquishFocus, { once: true });
      }
      try {
        dropPendingProposal();
        syncLoadButtons();
        if (!tracksLoaded) await ensureTracks();
        if (disposed || signal.aborted) return;
        const trackId = select.value;
        if (!trackId) {
          say(`Choose a track for group ${groupId} first.`);
          return;
        }
        const sectionChoice = groupSection[groupId].value;
        const fullLength = sectionChoice === 'full';
        const startSeconds = Number(groupStart[groupId].value);
        if (!fullLength && (!SECTION_SECONDS.has(sectionChoice)
          || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 3600)) {
          say(`Group ${groupId}: choose 30, 60, or 90 seconds, starting between 0 and 3600.`);
          return;
        }
        say(`Loading separated stems for group ${groupId}...`);
        const stems = await listStemsImpl(trackId, signal);
        if (disposed || signal.aborted) return;

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
          signal,
          limits: fullLength ? STEM_DESK_FULL_LIMITS : STEM_DESK_LIMITS,
        });
        if (disposed || signal.aborted) return;
        if (!state.playing) clearPositionTimer();
        renderLanes(state);
        refreshTransport(state);
        const groupLanes = state.lanes.filter((entry) => entry.trackId === groupId);
        const failures = Array.isArray(state.error?.failures) ? state.error.failures : [];
        const detail = failures[0] || null;
        const outcome = state.lastLoad?.byTrack?.[groupId] || null;
        const didNotCommit = outcome
          ? outcome.committed === false
          : failures.length >= lanes.length;
        if (!groupLanes.length) {
          // Show the real reason (byte counts, codes), not just "unavailable".
          const reason = detail
            ? `${detail.code || 'unavailable'} — ${detail.message || detail.name}`
            : (state.error?.message || 'no playable media');
          say(`Group ${groupId} was refused: ${reason}`);
        } else if (state.error?.code === 'S_DESK_FULL') {
          say(`Group ${groupId} was refused by the memory budget: ${state.error.message || detail?.message || 'over budget'}. The other group is unchanged.`);
        } else if (didNotCommit && groupLanes.length) {
          // The desk kept its previous group: saying "Loaded" here would claim
          // a refresh that did not happen. Prefer the desk's own commit flag;
          // fall back to "every requested lane failed" for a stand-in desk.
          say(
            `Group ${groupId} could not be reloaded; its existing ${groupLanes.length} lanes are unchanged. ` +
            `${detail?.code || 'Unavailable'} — ${detail?.message || detail?.name || 'no playable media'}. ${sectionNote}`,
          );
        } else if (detail) {
          loadedTrackIds[groupId] = trackId;
          say(
            `Loaded ${groupLanes.length} stems into group ${groupId}. ` +
            `${detail.code || 'Unavailable'} — ${detail.message || detail.name}. ${sectionNote}`,
          );
        } else {
          loadedTrackIds[groupId] = trackId;
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
        if (!disposed && !signal.aborted) {
          say(`Could not load group ${groupId}: ${err?.message || 'request failed'}`);
        }
      } finally {
        const target = document.activeElement;
        const shouldRestore = restoreFocus && !signal.aborted
          && (target === document.body || target === loadButton);
        relinquishFocus();
        signal.removeEventListener('abort', relinquishFocus);
        if (activeLoad === load) {
          activeLoad = null;
          if (!disposed) {
            syncLoadButtons();
            if (shouldRestore && loadButton.isConnected) loadButton.focus();
          }
        }
      }
    });
  }

  // ---- The Crate ---------------------------------------------------------
  // The bridge is the Crate's only way into the desk. Choose sets the bank's
  // own selector and fires its change handler; Load presses the bank's own
  // Load button; Separate uses the same job lookup and request as
  // Add / Process Track. None of them creates an AudioContext.
  async function separateForCrate(track) {
    const active = await findActiveSeparation(track.id);
    if (disposed) return null;
    let job = active;
    if (!job) {
      job = await submitSeparationImpl(track.id, 'demucs');
      if (disposed) return null;
      if (job && store) {
        try { store.dispatch({ type: 'jobs/upsert', job }); } catch { /* the Crate follows the job itself */ }
      }
    }
    // A bank already holding this track reports the job in its status line.
    for (const id of GROUP_IDS) {
      if (job && groupSelects[id].value === track.id) watchSeparation(id, track.id, job);
    }
    return job;
  }

  const crateBridge = {
    session: deskSession,
    subscribe(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    async choose(groupId, track) {
      if (!GROUP_IDS.includes(groupId) || !track?.id) throw new Error('unknown bank or track');
      if (activeLoad?.groupId === groupId && !activeLoad.controller.signal.aborted) {
        throw new Error(`bank ${groupId} is loading`);
      }
      // Fill the selectors first so a later list fetch cannot replace the choice.
      await ensureTracks();
      if (disposed) return;
      const select = groupSelects[groupId];
      if (select.value === track.id) return;
      rememberTrack(track, groupId);
      select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
    },
    load(groupId) {
      if (!GROUP_IDS.includes(groupId)) return;
      groupButtons[groupId].click();
    },
    separate: separateForCrate,
    watchJob: (jobId, onUpdate) => watchJobImpl(jobId, onUpdate),
  };
  const crate = mountCrate({
    container: crateHost,
    source: crateSource || createCrateSource({ fetchJson: get, patchJson: patch }),
    bridge: crateBridge,
    onAnnounce,
  });
  crate.toolbar?.appendChild(crateExpand);
  crateRefresh = () => crate.refresh();

  function setExpanded(open, { returnFocus = false } = {}) {
    rail.classList.toggle('desk-rail--expanded', open);
    crateExpand.setAttribute('aria-expanded', String(open));
    crateExpand.textContent = open ? 'Collapse' : 'Expand';
    if (returnFocus) crateExpand.focus();
  }

  function selectTab(name, { focus = false } = {}) {
    const showCrate = name === 'crate';
    rail.dataset.tab = showCrate ? 'crate' : 'producer';
    producerTab.setAttribute('aria-selected', String(!showCrate));
    crateTab.setAttribute('aria-selected', String(showCrate));
    producerTab.tabIndex = showCrate ? -1 : 0;
    crateTab.tabIndex = showCrate ? 0 : -1;
    producer.hidden = showCrate;
    cratePanel.hidden = !showCrate;
    if (!showCrate) setExpanded(false);
    if (showCrate) crate.activate();
    if (focus) (showCrate ? crateTab : producerTab).focus();
  }

  producerTab.addEventListener('click', () => selectTab('producer'));
  crateTab.addEventListener('click', () => selectTab('crate'));
  railTabs.addEventListener('keydown', (event) => {
    const keys = { ArrowLeft: 'producer', ArrowRight: 'crate', Home: 'producer', End: 'crate' };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const onCrate = rail.dataset.tab === 'crate';
    const next = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      ? (onCrate ? 'producer' : 'crate')
      : keys[event.key];
    selectTab(next, { focus: true });
  });
  ideaStripButton.addEventListener('click', () => selectTab('producer', { focus: true }));
  crateExpand.addEventListener('click', () => {
    const open = crateExpand.getAttribute('aria-expanded') !== 'true';
    setExpanded(open);
    if (open) crate.focusSearch();
  });
  cratePanel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !rail.classList.contains('desk-rail--expanded')) return;
    event.preventDefault();
    setExpanded(false, { returnFocus: true });
  });

  // Below 1100 px: the Crate opens as a modal sheet. The same Crate moves into
  // it and back, so a search or an open row survives.
  const sheetTitleId = `${railId}-sheet-title`;
  const sheetDone = createElement('button', { type: 'button', class: 'button button--sm', text: 'Done' });
  const sheetBody = createElement('div', { class: 'record-crate-sheet__body' });
  const sheet = createElement('dialog', {
    class: 'record-crate-sheet', 'aria-labelledby': sheetTitleId,
  }, [
    createElement('div', { class: 'record-crate-sheet__head' }, [
      createElement('h2', { id: sheetTitleId, class: 'record-crate-sheet__title', text: 'Crate' }),
      sheetDone,
    ]),
    sheetBody,
  ]);
  // The sheet exists only while open, so other dialogs stay unambiguous.
  function closeSheet() {
    if (sheet.open && typeof sheet.close === 'function') sheet.close();
    else if (sheet.hasAttribute('open')) {
      sheet.removeAttribute('open');
      sheet.dispatchEvent(new Event('close'));
    }
  }
  crateOpen.addEventListener('click', () => {
    setExpanded(false);
    if (railHost?.openSheet) {
      railHost.openSheet({ tab: 'crate', trigger: crateOpen });
      return;
    }
    if (!sheet.isConnected) root.appendChild(sheet);
    sheetBody.appendChild(crateHost);
    crate.setMirrorDeskMessages(true);
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
    crate.activate();
    crate.focusSearch();
  });
  sheetDone.addEventListener('click', closeSheet);
  sheet.addEventListener('close', () => {
    cratePanel.appendChild(crateHost);
    sheet.remove();
    crate.setMirrorDeskMessages(false);
    if (!disposed && crateOpen.isConnected) crateOpen.focus();
  });

  const railApi = {
    rail,
    inlineSlot: railSlot,
    crate,
    selectTab,
    setExpanded,
    isExpanded: () => rail.classList.contains('desk-rail--expanded'),
    tab: () => rail.dataset.tab,
    /** Hide the desk Producer's controls (not its idea) behind a note. */
    setProducerAway(text) {
      const away = Boolean(text);
      producer.dataset.away = away ? 'true' : 'false';
      producerAway.hidden = !away;
      producerAway.textContent = away ? text : '';
    },
  };
  const detachRail = railHost?.attach?.(rail, railApi) || null;

  return function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(crateRefreshTimer);
    try { detachRail?.(); } catch { /* the shell may already be gone */ }
    if (railHost) rail.remove();
    sessionListeners.clear();
    crate.dispose();
    closeSheet();
    window.removeEventListener(EXCLUSIVE_PLAY_EVENT, onExclusivePlay);
    unsubscribeNames();
    for (const groupId of GROUP_IDS) stopSeparationWatch(groupId);
    activeLoad?.controller.abort();
    clearPositionTimer();
    desk?.dispose();
    desk = null;
    container.replaceChildren();
  };
}

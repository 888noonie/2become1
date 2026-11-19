// components/source-picker.js — unified source picker (Library | Upload | YouTube).
//
// Phase 4.10: Library is the default tab when tracks exist. Upload supports
// click, keyboard, drag-and-drop, and multiple files. From a project slot, the
// first successful import is assigned to that slot. YouTube states "one video
// only" with a rights reminder. Opening/cancelling never clears the existing
// selection; closing does not cancel active imports.

import { createElement, replaceChildren } from '../dom.js';
import { closeDialog, openDialog } from './dialog.js';
import { showToast } from './toast.js';
import { formatBpm, formatKey, formatTime, sourceLabel } from '../format.js';
import {
  submitYouTube, submitUpload, getTrack,
} from '../api.js';
import { projectManager } from '../app-context.js';

const TABS = ['library', 'upload', 'youtube'];

/**
 * Open the source picker for a project slot, or for a caller that wants the
 * chosen library track back without assigning a deck.
 * @param {import('../js/state.js').StateStore} store
 * @param {'anchor'|'lead'|null} slot
 * @param {{ initialTab?: 'library'|'upload'|'youtube', onPick?: (track: object) => void, onImported?: (track: object) => void }} [options]
 */
export async function openSourcePicker(store, slot = null, options = {}) {
  const onPick = typeof options.onPick === 'function' ? options.onPick : null;
  const onImported = typeof options.onImported === 'function' ? options.onImported : null;
  store.dispatch({ type: 'sourcePicker/open', slot });

  const state = store.getState();
  const hasTracks = state.library.items.length > 0;
  const requested = TABS.includes(options.initialTab) ? options.initialTab : null;
  const initialTab = requested || (hasTracks ? 'library' : 'upload');
  store.dispatch({ type: 'sourcePicker/tab', tab: initialTab });

  const body = createElement('div', { class: 'picker' });
  const tabBar = createElement('div', { class: 'picker__tabs', role: 'tablist', 'aria-label': 'Choose a source' });
  const panel = createElement('div', { class: 'picker__panel', id: 'source-picker-panel', role: 'tabpanel', tabindex: '0' });

  body.appendChild(tabBar);
  body.appendChild(panel);

  let disposers = [];

  const setTab = (tab) => {
    store.dispatch({ type: 'sourcePicker/tab', tab });
    for (const btn of tabBar.querySelectorAll('.picker__tab')) {
      const selected = btn.dataset.tab === tab;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    }
    renderPanel(tab);
  };

  for (const tab of TABS) {
    const label = tab === 'library' ? 'Library' : tab === 'upload' ? 'Upload' : 'YouTube';
    tabBar.appendChild(createElement('button', {
      class: 'button button--ghost picker__tab', type: 'button', role: 'tab',
      id: `source-picker-tab-${tab}`, 'aria-controls': panel.id,
      tabindex: tab === initialTab ? '0' : '-1',
      'data-tab': tab, 'aria-selected': tab === initialTab ? 'true' : 'false',
      text: label,
      onclick: () => setTab(tab),
      onkeydown: (event) => {
        const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        const index = event.key === 'Home' ? 0
          : event.key === 'End' ? TABS.length - 1
          : offset ? (TABS.indexOf(tab) + offset + TABS.length) % TABS.length : -1;
        if (index < 0) return;
        event.preventDefault();
        const next = TABS[index];
        setTab(next);
        tabBar.querySelector(`[data-tab="${next}"]`).focus();
      },
    }));
  }

  const renderPanel = (tab) => {
    panel.setAttribute('aria-labelledby', `source-picker-tab-${tab}`);
    // Dispose any per-tab listeners.
    for (const dispose of disposers) dispose();
    disposers = [];

    if (tab === 'library') {
      renderLibraryPanel(panel, store, slot, disposers, onPick);
    } else if (tab === 'upload') {
      renderUploadPanel(panel, store, slot, disposers, onImported);
    } else {
      renderYouTubePanel(panel, store, slot, disposers, onImported);
    }
  };

  // The selected tab must have content on first open; changing tabs will
  // dispose and replace this panel through the same render path.
  renderPanel(initialTab);

  const result = await openDialog({
    title: slot ? `Choose ${slot === 'anchor' ? 'foundation' : 'lead'} track` : 'Add a track',
    description: 'Pick from your library, upload a file, or import a YouTube video.',
    body: [body],
    actions: [{ label: 'Close', value: 'close' }],
  });

  // Closing the picker never cancels active imports and never clears selection.
  for (const dispose of disposers) dispose();
  store.dispatch({ type: 'sourcePicker/close' });
  return result;
}

// ---------------------------------------------------------------------------
// Library tab
// ---------------------------------------------------------------------------

function renderLibraryPanel(panel, store, slot, disposers, onPick) {
  const listEl = createElement('div', { class: 'track-list', role: 'list' });
  panel.replaceChildren(listEl);

  const render = () => {
    const tracks = store.getState().library.items;
    if (tracks.length === 0) {
      listEl.replaceChildren(createElement('div', { class: 'state' }, [
        createElement('p', { text: 'Your library is empty. Use Upload or YouTube.' }),
      ]));
      return;
    }
    const cards = tracks.map((track) => {
      const btn = createElement('button', {
        class: 'button', type: 'button', text: 'Select',
        'aria-label': `Select ${track.name}`,
        onclick: () => assign(store, slot, track, onPick),
      });
      return createElement('div', { class: 'track-card picker__track', role: 'listitem' }, [
        createElement('div', { class: 'track-card__identity' }, [
          createElement('div', { class: 'track-card__title', text: track.name, title: track.name }),
          createElement('div', { class: 'track-card__meta' }, [
            createElement('span', { text: sourceLabel(track.source?.kind) }),
            createElement('span', { text: `${formatBpm(track)} BPM` }),
            createElement('span', { text: formatKey(track) }),
            createElement('span', { text: formatTime(track.duration) }),
          ]),
        ]),
        btn,
      ]);
    });
    replaceChildren(listEl, cards);
  };

  const unsubscribe = store.subscribeSlice('library', render);
  disposers.push(unsubscribe);
  render();
}

// ---------------------------------------------------------------------------
// Upload tab
// ---------------------------------------------------------------------------

function renderUploadPanel(panel, store, slot, disposers, onImported) {
  const fileInput = createElement('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.flac,.m4a,.ogg,.opus,.aiff,.aac', multiple: 'multiple', hidden: 'true' });
  const drop = createElement('button', {
    class: 'button button--ghost picker__drop', type: 'button',
    'aria-label': 'Upload audio files',
  }, [
    createElement('strong', { text: 'Drop audio files here' }),
    createElement('span', { text: 'or click to browse (multiple files supported)' }),
  ]);
  const nameInput = createElement('input', {
    class: 'input', type: 'text', maxlength: '200', autocomplete: 'off',
    id: 'source-track-name', placeholder: 'Name this track', 'aria-label': 'Track Name',
  });
  const importBtn = createElement('button', {
    class: 'button button--primary', type: 'button', text: 'Import',
  });
  const nameField = createElement('div', { class: 'field' }, [
    createElement('label', { for: 'source-track-name', text: 'Track Name' }),
    nameInput,
    createElement('p', {
      class: 'picker__hint',
      text: 'Leave blank to use the file name. A name applies when one file is imported.',
    }),
  ]);
  const status = createElement('div', { class: 'picker__hint', role: 'status' });

  panel.replaceChildren(fileInput, drop, nameField, importBtn, status);
  let pending = [];

  const openFile = () => fileInput.click();
  drop.addEventListener('click', openFile);
  ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add('picker__drop--active');
  }));
  ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.remove('picker__drop--active');
  }));
  drop.addEventListener('drop', (event) => {
    const files = [...event.dataTransfer.files];
    if (files.length) stageFiles(files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) stageFiles([...fileInput.files]);
  });

  const stageFiles = (files) => {
    pending = files;
    if (files.length === 1) {
      const base = files[0].name.replace(/\.[^.]+$/, '');
      nameInput.value = base;
      status.textContent = files[0].name;
    } else {
      nameInput.value = '';
      status.textContent = `${files.length} files selected. Each keeps its file name.`;
    }
  };

  const handleFiles = async (files) => {
    const custom = nameInput.value.trim();
    if (files.length > 1 && custom) {
      showToast('A custom name applies to one file at a time. These files keep their own names.', 'danger');
    }
    const displayName = files.length === 1 ? custom : '';
    for (const file of files) {
      status.textContent = `Uploading ${file.name}…`;
      try {
        const job = await submitUpload(file, (percent) => {
          status.textContent = `Uploading ${file.name}: ${percent}%`;
        }, undefined, displayName);
        store.dispatch({ type: 'jobs/upsert', job });
        // 202 response replaces upload progress with backend job state.
        status.textContent = `Processing ${file.name}…`;
        await followImport(job, store, slot, status, onImported);
      } catch (err) {
        status.textContent = '';
        showToast(err.message, 'danger');
      }
    }
    pending = [];
  };

  importBtn.addEventListener('click', () => {
    if (!pending.length) {
      showToast('Choose an audio file first.', 'danger');
      return;
    }
    const files = pending;
    handleFiles(files);
  });
}

// ---------------------------------------------------------------------------
// YouTube tab
// ---------------------------------------------------------------------------

function renderYouTubePanel(panel, store, slot, disposers, onImported) {
  const urlInput = createElement('input', {
    class: 'input', type: 'url', inputmode: 'url', autocomplete: 'url',
    id: 'source-youtube-url', placeholder: 'https://youtu.be/…', 'aria-label': 'YouTube URL',
  });
  const nameInput = createElement('input', {
    class: 'input', type: 'text', maxlength: '200', autocomplete: 'off',
    id: 'source-track-name', placeholder: 'Name this track', 'aria-label': 'Track Name',
  });
  const submitBtn = createElement('button', { class: 'button button--primary', type: 'button', text: 'Import' });
  const status = createElement('div', { class: 'picker__hint', role: 'status' });
  const rights = createElement('p', {
    class: 'picker__rights',
    text: 'One video only. Only import audio you have the right to use.',
  });

  const nameField = createElement('div', { class: 'field' }, [
    createElement('label', { for: 'source-track-name', text: 'Track Name' }),
    nameInput,
    createElement('p', {
      class: 'picker__hint',
      text: 'Leave blank to use the video title. The address and the downloaded file stay as they are.',
    }),
  ]);
  const form = createElement('div', { class: 'field' }, [
    createElement('label', { for: 'source-youtube-url', text: 'YouTube URL' }),
    createElement('div', { class: 'picker__submit-row' }, [urlInput, submitBtn]),
  ]);

  panel.replaceChildren(nameField, form, status, rights);

  const submit = async () => {
    const url = urlInput.value.trim();
    if (!url) {
      showToast('Enter a YouTube URL.', 'danger');
      return;
    }
    submitBtn.disabled = true;
    status.textContent = 'Submitting…';
    try {
      const job = await submitYouTube(url, nameInput.value);
      store.dispatch({ type: 'jobs/upsert', job });
      status.textContent = 'Downloading…';
      await followImport(job, store, slot, status, onImported);
    } catch (err) {
      status.textContent = '';
      showToast(err.message, 'danger');
    } finally {
      submitBtn.disabled = false;
    }
  };

  submitBtn.addEventListener('click', submit);
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
}

// ---------------------------------------------------------------------------
// Shared import follow-up
// ---------------------------------------------------------------------------

function followImport(job, store, slot, statusEl, onImported) {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const handle = (updated) => {
      if (!updated || updated.id !== job.id || settled) return;
      const detail = updated.progress_detail || {};
      if (detail.percent != null) {
        statusEl.textContent = `${updated.message || 'Downloading'} ${Math.round(detail.percent)}%`;
      } else {
        statusEl.textContent = updated.message || updated.stage || 'Working…';
      }
      if (updated.status === 'complete') {
        settled = true;
        unsubscribe();
        onComplete(updated, store, slot, statusEl, onImported).then(resolve);
      } else if (updated.status === 'failed' || updated.status === 'cancelled' || updated.status === 'interrupted') {
        settled = true;
        unsubscribe();
        statusEl.textContent = '';
        showToast(updated.error || `Import ${updated.status}.`, 'danger');
        resolve();
      }
    };
    // JobCoordinator is the sole API monitor and store updater. The picker
    // observes shared state only, so it cannot duplicate monitor callbacks or
    // announcements while still surviving dialog closure until terminal.
    unsubscribe = store.subscribeSlice('jobs', (jobs) => {
      handle(jobs.items.find((item) => item.id === job.id));
    });
    handle(store.getState().jobs.items.find((item) => item.id === job.id));
  });
}

async function onComplete(job, store, slot, statusEl, onImported) {
  const trackId = job.result?.track_id;
  if (!trackId) {
    statusEl.textContent = '';
    return;
  }
  try {
    const track = await getTrack(trackId);
    // Deduplicated import adds the returned track ID only once.
    store.dispatch({ type: 'library/upsert-track', track });
    if (slot) {
      projectManager.assign(slot, trackId);
      showToast(`Assigned "${track.name}" as ${slot === 'anchor' ? 'foundation' : 'lead'}.`, 'success');
    } else {
      showToast(`Imported "${track.name}".`, 'success');
    }
    if (onImported) await onImported(track);
  } catch (err) {
    showToast(err.message, 'danger');
  }
  statusEl.textContent = '';
}

function assign(store, slot, track, onPick) {
  if (onPick) {
    onPick(track);
    closeDialog('pick');
    return;
  }
  if (slot) {
    projectManager.assign(slot, track.id);
    showToast(`Assigned "${track.name}" as ${slot === 'anchor' ? 'foundation' : 'lead'}.`, 'success');
  }
}

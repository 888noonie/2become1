// components/source-picker.js — unified source picker (Library | Upload | YouTube).
//
// Phase 4.10: Library is the default tab when tracks exist. Upload supports
// click, keyboard, drag-and-drop, and multiple files. From a project slot, the
// first successful import is assigned to that slot. YouTube states "one video
// only" with a rights reminder. Opening/cancelling never clears the existing
// selection; closing does not cancel active imports.

import { createElement, replaceChildren } from '../dom.js';
import { openDialog } from './dialog.js';
import { showToast } from './toast.js';
import { announceJob } from '../announce.js';
import { formatBpm, formatKey, formatTime, sourceLabel } from '../format.js';
import {
  submitYouTube, submitUpload, watchJob, getTrack,
} from '../api.js';

const TABS = ['library', 'upload', 'youtube'];

/**
 * Open the source picker for a project slot.
 * @param {import('../js/state.js').StateStore} store
 * @param {'anchor'|'lead'|null} slot
 */
export async function openSourcePicker(store, slot = null) {
  store.dispatch({ type: 'sourcePicker/open', slot });

  const state = store.getState();
  const hasTracks = state.library.items.length > 0;
  const initialTab = hasTracks ? 'library' : 'upload';
  store.dispatch({ type: 'sourcePicker/tab', tab: initialTab });

  const body = createElement('div', { class: 'picker' });
  const tabBar = createElement('div', { class: 'picker__tabs', role: 'tablist', 'aria-label': 'Choose a source' });
  const panel = createElement('div', { class: 'picker__panel' });

  body.appendChild(tabBar);
  body.appendChild(panel);

  let disposers = [];

  const setTab = (tab) => {
    store.dispatch({ type: 'sourcePicker/tab', tab });
    for (const btn of tabBar.querySelectorAll('.picker__tab')) {
      btn.setAttribute('aria-selected', btn.dataset.tab === tab ? 'true' : 'false');
    }
    renderPanel(tab);
  };

  for (const tab of TABS) {
    const label = tab === 'library' ? 'Library' : tab === 'upload' ? 'Upload' : 'YouTube';
    tabBar.appendChild(createElement('button', {
      class: 'picker__tab', type: 'button', role: 'tab',
      'data-tab': tab, 'aria-selected': tab === initialTab ? 'true' : 'false',
      text: label,
      onclick: () => setTab(tab),
    }));
  }

  const renderPanel = (tab) => {
    // Dispose any per-tab listeners.
    for (const dispose of disposers) dispose();
    disposers = [];

    if (tab === 'library') {
      renderLibraryPanel(panel, store, slot, disposers);
    } else if (tab === 'upload') {
      renderUploadPanel(panel, store, slot, disposers);
    } else {
      renderYouTubePanel(panel, store, slot, disposers);
    }
  };

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

function renderLibraryPanel(panel, store, slot, disposers) {
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
        onclick: () => assign(store, slot, track),
      });
      return createElement('div', { class: 'track-card', role: 'listitem' }, [
        createElement('div', { class: 'track-card__title', text: track.name }),
        createElement('div', { class: 'track-card__meta' }, [
          createElement('span', { text: sourceLabel(track.source?.kind) }),
          createElement('span', { text: `${formatBpm(track)} BPM` }),
          createElement('span', { text: formatKey(track) }),
          createElement('span', { text: formatTime(track.duration) }),
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

function renderUploadPanel(panel, store, slot, disposers) {
  const fileInput = createElement('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.flac,.m4a,.ogg,.opus,.aiff,.aac', multiple: 'multiple', hidden: 'true' });
  const drop = createElement('div', {
    class: 'picker__drop', role: 'button', tabindex: '0',
    'aria-label': 'Upload audio files',
  }, [
    createElement('strong', { text: 'Drop audio files here' }),
    createElement('span', { text: 'or click to browse (multiple files supported)' }),
  ]);
  const status = createElement('div', { class: 'picker__hint' });

  panel.replaceChildren(fileInput, drop, status);

  const openFile = () => fileInput.click();
  drop.addEventListener('click', openFile);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFile();
    }
  });
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
    if (files.length) handleFiles(files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles([...fileInput.files]);
  });

  const handleFiles = async (files) => {
    for (const file of files) {
      status.textContent = `Uploading ${file.name}…`;
      try {
        const job = await submitUpload(file, (percent) => {
          status.textContent = `Uploading ${file.name}: ${percent}%`;
        });
        store.dispatch({ type: 'jobs/upsert', job });
        // 202 response replaces upload progress with backend job state.
        status.textContent = `Processing ${file.name}…`;
        await followImport(job, store, slot, status);
      } catch (err) {
        status.textContent = '';
        showToast(err.message, 'danger');
      }
    }
  };
}

// ---------------------------------------------------------------------------
// YouTube tab
// ---------------------------------------------------------------------------

function renderYouTubePanel(panel, store, slot, disposers) {
  const urlInput = createElement('input', {
    class: 'input', type: 'url', inputmode: 'url', autocomplete: 'url',
    placeholder: 'https://youtu.be/…', 'aria-label': 'YouTube URL',
  });
  const submitBtn = createElement('button', { class: 'button button--primary', type: 'button', text: 'Import' });
  const status = createElement('div', { class: 'picker__hint' });
  const rights = createElement('p', {
    class: 'picker__rights',
    text: 'One video only. Only import audio you have the right to use.',
  });

  const form = createElement('div', { class: 'field' }, [
    createElement('label', { text: 'YouTube URL' }),
    createElement('div', { class: 'library-toolbar' }, [urlInput, submitBtn]),
  ]);

  panel.replaceChildren(form, status, rights);

  const submit = async () => {
    const url = urlInput.value.trim();
    if (!url) {
      showToast('Enter a YouTube URL.', 'danger');
      return;
    }
    submitBtn.disabled = true;
    status.textContent = 'Submitting…';
    try {
      const job = await submitYouTube(url);
      store.dispatch({ type: 'jobs/upsert', job });
      status.textContent = 'Downloading…';
      await followImport(job, store, slot, status);
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

function followImport(job, store, slot, statusEl) {
  return new Promise((resolve) => {
    const unsubscribe = watchJob(job.id, (updated) => {
      const previous = store.getState().jobs.items.find((item) => item.id === updated.id) || null;
      store.dispatch({ type: 'jobs/upsert', job: updated });
      announceJob(updated, previous);
      const detail = updated.progress_detail || {};
      if (detail.percent != null) {
        statusEl.textContent = `${updated.message || 'Downloading'} ${Math.round(detail.percent)}%`;
      } else {
        statusEl.textContent = updated.message || updated.stage || 'Working…';
      }
      if (updated.status === 'complete') {
        unsubscribe();
        onComplete(updated, store, slot, statusEl).then(resolve);
      } else if (updated.status === 'failed' || updated.status === 'cancelled' || updated.status === 'interrupted') {
        unsubscribe();
        statusEl.textContent = '';
        showToast(updated.error || `Import ${updated.status}.`, 'danger');
        resolve();
      }
    });
  });
}

async function onComplete(job, store, slot, statusEl) {
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
      store.dispatch({ type: 'project/assign-slot', slot, trackId });
      showToast(`Assigned "${track.name}" as ${slot === 'anchor' ? 'foundation' : 'lead'}.`, 'success');
    } else {
      showToast(`Imported "${track.name}".`, 'success');
    }
  } catch (err) {
    showToast(err.message, 'danger');
  }
  statusEl.textContent = '';
}

function assign(store, slot, track) {
  if (slot) {
    store.dispatch({ type: 'project/assign-slot', slot, trackId: track.id });
    showToast(`Assigned "${track.name}" as ${slot === 'anchor' ? 'foundation' : 'lead'}.`, 'success');
  }
}

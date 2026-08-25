// components/analysis-dialog.js — accessible track analysis inspection and override.
//
// Phase 5 (Task 4): show effective, detected, and current overrides separately
// for BPM, tonic/mode, first beat, and suggested downbeat. Confidence is
// informational; low confidence says `Check this`, never `Wrong`.
// Save validated track PATCH atomically. `Reset to detected` sends JSON nulls
// for every override field rather than copying detected numbers into overrides.

import { createElement } from '../dom.js';
import { openDialog } from './dialog.js';
import { showToast } from './toast.js';
import { updateTrackAnalysis } from '../api.js';

const TONICS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MODES = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
];

function hasAnyOverrideValue(overrides) {
  if (!overrides) return false;
  return overrides.bpm != null ||
    overrides.tonic != null ||
    overrides.mode != null ||
    overrides.first_beat != null ||
    overrides.suggested_downbeat != null;
}

export async function openAnalysisDialog({ track, store, onAnnounce, trigger = null }) {
  // The API returns flat detected and overrides objects on every track.
  const detected = track.detected || {};
  const overrides = track.overrides || {};
  const detectedKey = detected.key || track.key || {};
  const detectedBeatGrid = detected.beat_grid || track.beat_grid || {};

  // Form inputs for overrides
  const bpmInput = createElement('input', {
    class: 'input',
    type: 'number',
    step: '0.1',
    min: '40',
    max: '260',
    placeholder: String(detected.bpm != null ? detected.bpm.toFixed(1) : ''),
    value: overrides.bpm != null ? String(overrides.bpm) : '',
    'aria-label': 'Override BPM',
  });

  const tonicSelect = createElement('select', {
    class: 'select',
    'aria-label': 'Override Key Tonic',
  }, [
    createElement('option', { value: '', text: '— Select Tonic —' }),
    ...TONICS.map((t) => createElement('option', {
      value: t,
      text: t,
      selected: overrides.tonic === t ? 'true' : null,
    })),
  ]);
  if (overrides.tonic) {
    tonicSelect.value = overrides.tonic;
  }

  const modeSelect = createElement('select', {
    class: 'select',
    'aria-label': 'Override Key Mode',
  }, [
    createElement('option', { value: '', text: '— Select Mode —' }),
    ...MODES.map((m) => createElement('option', {
      value: m.value,
      text: m.label,
      selected: overrides.mode === m.value ? 'true' : null,
    })),
  ]);
  if (overrides.mode) {
    modeSelect.value = overrides.mode;
  }

  const firstBeatInput = createElement('input', {
    class: 'input',
    type: 'number',
    step: '0.001',
    min: '0',
    placeholder: String(detectedBeatGrid.first_beat != null ? detectedBeatGrid.first_beat.toFixed(3) : ''),
    value: overrides.first_beat != null ? String(overrides.first_beat) : '',
    'aria-label': 'Override First Beat (s)',
  });

  const downbeatInput = createElement('input', {
    class: 'input',
    type: 'number',
    step: '0.001',
    min: '0',
    placeholder: String(detectedBeatGrid.suggested_downbeat != null ? detectedBeatGrid.suggested_downbeat.toFixed(3) : ''),
    value: overrides.suggested_downbeat != null ? String(overrides.suggested_downbeat) : '',
    'aria-label': 'Override Suggested Downbeat (s)',
  });

  // Confidence & detected info table
  const confVal = track.confidence ?? track.key?.confidence;
  const confText = typeof confVal === 'number' && confVal < 0.6
    ? 'Check this'
    : (typeof confVal === 'number' ? `${Math.round(confVal * 100)}%` : '—');

  const detKeyText = detectedKey
    ? `${detectedKey.tonic || '—'} ${detectedKey.mode || ''}`.trim()
    : '—';
  const detBpmText = detected.bpm != null ? `${detected.bpm.toFixed(1)} BPM` : '—';
  const detFirstBeatText = detectedBeatGrid.first_beat != null
    ? `${detectedBeatGrid.first_beat.toFixed(3)} s`
    : '—';
  const detDownbeatText = detectedBeatGrid.suggested_downbeat != null
    ? `${detectedBeatGrid.suggested_downbeat.toFixed(3)} s`
    : '—';

  // Effective values are `override ?? detected`; show them explicitly so the
  // three layers (detected / override / effective) are all visible.
  const effBpm = overrides.bpm != null ? overrides.bpm : detected.bpm;
  const effTonic = overrides.tonic != null ? overrides.tonic : detectedKey.tonic;
  const effMode = overrides.mode != null ? overrides.mode : detectedKey.mode;
  const effFirstBeat = overrides.first_beat != null ? overrides.first_beat : detectedBeatGrid.first_beat;
  const effDownbeat = overrides.suggested_downbeat != null ? overrides.suggested_downbeat : detectedBeatGrid.suggested_downbeat;

  const effBpmText = effBpm != null ? `${Number(effBpm).toFixed(1)} BPM` : '—';
  const effKeyText = effTonic ? `${effTonic} ${effMode || ''}`.trim() : '—';
  const effFirstBeatText = effFirstBeat != null ? `${Number(effFirstBeat).toFixed(3)} s` : '—';
  const effDownbeatText = effDownbeat != null ? `${Number(effDownbeat).toFixed(3)} s` : '—';

  const infoSection = createElement('div', { class: 'analysis-dialog__info' }, [
    createElement('div', { class: 'analysis-dialog__row' }, [
      createElement('strong', { text: 'Detected BPM:' }),
      createElement('span', { text: detBpmText }),
    ]),
    createElement('div', { class: 'analysis-dialog__row' }, [
      createElement('strong', { text: 'Detected Key:' }),
      createElement('span', { text: detKeyText }),
    ]),
    createElement('div', { class: 'analysis-dialog__row' }, [
      createElement('strong', { text: 'First Beat / Downbeat:' }),
      createElement('span', { text: `${detFirstBeatText} / ${detDownbeatText}` }),
    ]),
    createElement('div', { class: 'analysis-dialog__row' }, [
      createElement('strong', { text: 'Confidence:' }),
      createElement('span', {
        class: confText === 'Check this' ? 'badge badge--warning' : '',
        text: confText,
      }),
    ]),
    createElement('div', { class: 'analysis-dialog__row analysis-dialog__row--effective' }, [
      createElement('strong', { text: 'Effective (used for mixing):' }),
      createElement('span', { text: `${effBpmText} • ${effKeyText} • ${effFirstBeatText} / ${effDownbeatText}` }),
    ]),
  ]);

  const formSection = createElement('div', { class: 'analysis-dialog__form' }, [
    createElement('h4', { text: 'Overrides (leave blank to use detected)' }),
    createElement('label', { class: 'label' }, [
      createElement('span', { text: 'BPM' }),
      bpmInput,
    ]),
    createElement('label', { class: 'label' }, [
      createElement('span', { text: 'Key Tonic & Mode' }),
      createElement('div', { class: 'input-group' }, [tonicSelect, modeSelect]),
    ]),
    createElement('label', { class: 'label' }, [
      createElement('span', { text: 'First Beat (seconds)' }),
      firstBeatInput,
    ]),
    createElement('label', { class: 'label' }, [
      createElement('span', { text: 'Suggested Downbeat (seconds)' }),
      downbeatInput,
    ]),
  ]);

  let resetRequested = false;
  const resetBtn = createElement('button', {
    class: 'button button--danger',
    type: 'button',
    text: 'Reset to detected',
    onclick: () => {
      resetRequested = true;
      bpmInput.value = '';
      tonicSelect.value = '';
      modeSelect.value = '';
      firstBeatInput.value = '';
      downbeatInput.value = '';
      onAnnounce?.('Analysis inputs reset to detected defaults.');
    },
  });

  const bodyNodes = [infoSection, formSection, createElement('div', { class: 'analysis-dialog__reset-wrapper' }, [resetBtn])];

  const result = await openDialog({
    title: `Edit Analysis: ${track.name}`,
    body: bodyNodes,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save Analysis', value: 'save', kind: 'primary' },
    ],
    trigger,
  });

  if (result !== 'save') return;

  try {
    let payload;
    if (resetRequested && !hasAnyOverrideValue({
      bpm: bpmInput.value.trim() ? Number(bpmInput.value.trim()) : null,
      tonic: tonicSelect.value.trim() || null,
      mode: modeSelect.value.trim() || null,
      first_beat: firstBeatInput.value.trim() ? Number(firstBeatInput.value.trim()) : null,
      suggested_downbeat: downbeatInput.value.trim() ? Number(downbeatInput.value.trim()) : null,
    })) {
      // Send explicit JSON nulls for reset
      payload = {
        bpm: null,
        tonic: null,
        mode: null,
        first_beat: null,
        suggested_downbeat: null,
      };
    } else {
      // Build override payload
      const bpmVal = bpmInput.value.trim() ? Number(bpmInput.value.trim()) : null;
      const tonicVal = tonicSelect.value.trim() || null;
      const modeVal = modeSelect.value.trim() || null;
      const firstBeatVal = firstBeatInput.value.trim() ? Number(firstBeatInput.value.trim()) : null;
      const downbeatVal = downbeatInput.value.trim() ? Number(downbeatInput.value.trim()) : null;

      if (bpmVal != null && (!Number.isFinite(bpmVal) || bpmVal <= 0)) {
        showToast('Invalid BPM value', 'danger');
        return;
      }

      payload = {
        bpm: bpmVal,
        tonic: tonicVal,
        mode: modeVal,
        first_beat: firstBeatVal,
        suggested_downbeat: downbeatVal,
      };
    }

    const updated = await updateTrackAnalysis(track.id, payload);
    // Upsert into store library & deck tracks
    store.dispatch({ type: 'library/upsert-track', track: updated });
    store.dispatch({ type: 'deckTrack/set', trackId: updated.id, track: updated });
    showToast(`Analysis updated for "${updated.name}".`, 'success');
    onAnnounce?.(`Analysis updated for ${updated.name}.`);
  } catch (err) {
    showToast(err.message || 'Failed to update analysis', 'danger');
  }
}

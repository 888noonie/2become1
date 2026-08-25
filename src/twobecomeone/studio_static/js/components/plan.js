// components/plan.js — grouped arrangement controls and exact server plan.
//
// Phase 5 (Task 6):
// 1. Group controls by intent:
//    - Timing: duration, snap setting.
//    - Harmony: pitch_mode ('match' Foundation key vs 'preserve' Lead pitch).
//    - Mix: Foundation & Lead gains with numeric values and reset defaults.
// 2. Storage keys align with backend: anchor_start, lead_start, duration,
//    anchor_gain, lead_gain, snap, pitch_mode.
// 3. Debounces/aborts obsolete POST /api/renders/plan requests. Renders
//    server-authored tempo ratio, BPM change, semitone shift, selected
//    variants, expected duration, and actionable warnings.
// 4. Clearly labeled arrangement-ready state (render/preview are Phase 6).

import { createElement, replaceChildren } from '../dom.js';
import { planRender } from '../api.js';
import { projectManager } from '../app-context.js';
import { formatTime } from '../format.js';

export function mountPlan({ container, store }) {
  const root = createElement('section', {
    class: 'studio-plan',
    'aria-label': 'Arrangement and Render Plan',
  });
  container.replaceChildren(root);

  let abortController = null;
  let debounceTimer = null;
  let lastPlanKey = '';

  function render(state) {
    const project = state.currentProject || {};
    const settings = project.settings || {};
    const anchorId = project.anchor_track_id;
    const leadId = project.lead_track_id;

    // Both tracks required for a plan
    const isReady = Boolean(anchorId && leadId);

    // --- Controls Section ---
    const timingGroup = createElement('fieldset', { class: 'plan-group' }, [
      createElement('legend', { class: 'plan-group__title', text: 'Timing' }),
      createElement('div', { class: 'plan-group__fields' }, [
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Duration (seconds, blank = auto)' }),
          createElement('input', {
            class: 'input',
            type: 'number',
            step: '0.1',
            min: '1',
            max: '3600',
            placeholder: 'Auto (full overlap)',
            value: settings.duration != null ? String(settings.duration) : '',
            'aria-label': 'Mash duration in seconds',
            onchange: (e) => {
              const val = e.target.value.trim();
              const num = val ? Number(val) : null;
              if (num != null && (num <= 0 || num > 3600)) return;
              projectManager.save({ settings: { ...settings, duration: num } });
            },
          }),
        ]),
        createElement('label', { class: 'checkbox-label' }, [
          createElement('input', {
            type: 'checkbox',
            checked: settings.snap !== false ? 'true' : null,
            'aria-label': 'Snap cues to beat grid',
            onchange: (e) => {
              projectManager.save({ settings: { ...settings, snap: e.target.checked } });
            },
          }),
          createElement('span', { text: 'Snap cues to detected beat grid' }),
        ]),
      ]),
    ]);

    const harmonyGroup = createElement('fieldset', { class: 'plan-group' }, [
      createElement('legend', { class: 'plan-group__title', text: 'Harmony' }),
      createElement('div', { class: 'plan-group__fields' }, [
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Pitch Mode' }),
          createElement('select', {
            class: 'select',
            'aria-label': 'Pitch adjustment mode',
            onchange: (e) => {
              projectManager.save({ settings: { ...settings, pitch_mode: e.target.value } });
            },
          }, [
            createElement('option', {
              value: 'match',
              text: 'Match Foundation Key (Camelot harmonic shift)',
              selected: (settings.pitch_mode || 'match') === 'match' ? 'true' : null,
            }),
            createElement('option', {
              value: 'preserve',
              text: 'Preserve Original Lead Pitch (no pitch shift)',
              selected: settings.pitch_mode === 'preserve' ? 'true' : null,
            }),
          ]),
        ]),
      ]),
    ]);

    const mixGroup = createElement('fieldset', { class: 'plan-group' }, [
      createElement('legend', { class: 'plan-group__title', text: 'Mix & Gains' }),
      createElement('div', { class: 'plan-group__fields' }, [
        createElement('div', { class: 'gain-control' }, [
          createElement('label', { class: 'label' }, [
            createElement('span', { text: `Foundation Gain: ${(settings.anchor_gain ?? 0.8).toFixed(2)}x` }),
            createElement('input', {
              class: 'input-range',
              type: 'range',
              min: '0',
              max: '2',
              step: '0.05',
              value: String(settings.anchor_gain ?? 0.8),
              'aria-label': 'Foundation gain',
              oninput: (e) => {
                const num = Number(e.target.value);
                projectManager.save({ settings: { ...settings, anchor_gain: num } });
              },
            }),
          ]),
        ]),
        createElement('div', { class: 'gain-control' }, [
          createElement('label', { class: 'label' }, [
            createElement('span', { text: `Lead Gain: ${(settings.lead_gain ?? 0.8).toFixed(2)}x` }),
            createElement('input', {
              class: 'input-range',
              type: 'range',
              min: '0',
              max: '2',
              step: '0.05',
              value: String(settings.lead_gain ?? 0.8),
              'aria-label': 'Lead gain',
              oninput: (e) => {
                const num = Number(e.target.value);
                projectManager.save({ settings: { ...settings, lead_gain: num } });
              },
            }),
          ]),
        ]),
        createElement('button', {
          class: 'button button--sm',
          type: 'button',
          text: 'Reset Gains (0.8x)',
          onclick: () => {
            projectManager.save({ settings: { ...settings, anchor_gain: 0.8, lead_gain: 0.8 } });
          },
        }),
      ]),
    ]);

    const controlsContainer = createElement('div', { class: 'plan-controls' }, [
      timingGroup,
      harmonyGroup,
      mixGroup,
    ]);

    // --- Server Plan Output Card ---
    const planDisplay = createElement('div', { class: 'plan-output', id: 'plan-output' });

    if (!isReady) {
      replaceChildren(planDisplay, [
        createElement('div', { class: 'plan-output__empty' }, [
          createElement('p', {
            text: 'Choose both Foundation and Lead tracks to calculate the mash arrangement plan.',
          }),
        ]),
      ]);
    } else {
      const planState = state.plan || { loading: true, data: null, error: null };
      if (planState.loading) {
        replaceChildren(planDisplay, [
          createElement('div', { class: 'plan-output__loading', text: 'Computing arrangement plan…' }),
        ]);
      } else if (planState.error) {
        replaceChildren(planDisplay, [
          createElement('div', { class: 'plan-output__error', text: `Plan unavailable: ${planState.error}` }),
        ]);
      } else if (planState.data) {
        const d = planState.data;
        const semitones = d.semitone_shift;
        const semitoneText = semitones === 0
          ? '0 semitones (exact match or preserved)'
          : `${semitones > 0 ? '+' : ''}${semitones} semitone${Math.abs(semitones) === 1 ? '' : 's'}`;

        const bpmChangeText = d.bpm_change_percent != null
          ? `${d.bpm_change_percent >= 0 ? '+' : ''}${d.bpm_change_percent.toFixed(1)}%`
          : '—';

        const tempoRatioText = d.tempo_ratio != null ? `${d.tempo_ratio.toFixed(3)}x` : '—';

        const metricsGrid = createElement('div', { class: 'plan-metrics' }, [
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Tempo Stretch' }),
            createElement('span', { class: 'plan-metric__val', text: `${tempoRatioText} (${bpmChangeText})` }),
          ]),
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Harmonic Shift' }),
            createElement('span', { class: 'plan-metric__val', text: semitoneText }),
          ]),
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Mash Duration' }),
            createElement('span', { class: 'plan-metric__val', text: formatTime(d.output_duration) }),
          ]),
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Pitch Mode' }),
            createElement('span', { class: 'plan-metric__val', text: d.pitch_mode === 'preserve' ? 'Preserve Pitch' : 'Match Key' }),
          ]),
        ]);

        const warningsEl = createElement('div', { class: 'plan-warnings' });
        if (d.warnings && d.warnings.length > 0) {
          for (const w of d.warnings) {
            warningsEl.appendChild(createElement('div', { class: 'badge badge--warning', text: `⚠️ ${w}` }));
          }
        }

        const variantsEl = createElement('div', { class: 'plan-variants' }, [
          createElement('span', {
            class: 'badge',
            text: `Foundation: ${d.anchor_variant || 'full'}`,
          }),
          createElement('span', {
            class: 'badge',
            text: `Lead: ${d.lead_variant || 'full'}`,
          }),
        ]);

        const readyBadge = createElement('div', { class: 'plan-ready' }, [
          createElement('span', { class: 'badge badge--success', text: '✓ Arrangement Plan Verified' }),
          createElement('span', { class: 'plan-hint', text: 'Render & Preview flows will activate in Phase 6.' }),
        ]);

        replaceChildren(planDisplay, [
          createElement('h3', { class: 'plan-output__title', text: 'Exact Render Plan (Server-Authored)' }),
          metricsGrid,
          variantsEl,
          warningsEl.hasChildNodes() ? warningsEl : null,
          readyBadge,
        ].filter(Boolean));
      }
    }

    replaceChildren(root, [
      createElement('h2', { class: 'studio-plan__title', text: 'Arrangement & Plan' }),
      controlsContainer,
      planDisplay,
    ]);
  }

  // Fetch plan from server
  async function fetchPlan() {
    const state = store.getState();
    const project = state.currentProject || {};
    const anchorId = project.anchor_track_id;
    const leadId = project.lead_track_id;

    if (!anchorId || !leadId) {
      store.dispatch({ type: 'plan/set', loading: false, data: null, error: null });
      return;
    }

    const s = project.settings || {};
    const body = {
      anchor_id: anchorId,
      lead_id: leadId,
      anchor_start: Number(s.anchor_start ?? 0),
      lead_start: Number(s.lead_start ?? 0),
      duration: s.duration != null ? Number(s.duration) : null,
      anchor_gain: Number(s.anchor_gain ?? 0.8),
      lead_gain: Number(s.lead_gain ?? 0.8),
      anchor_variant: project.anchor_variant || 'full',
      lead_variant: project.lead_variant || 'full',
      pitch_mode: s.pitch_mode || 'match',
    };

    const planKey = JSON.stringify(body);
    if (planKey === lastPlanKey && state.plan?.data) {
      return;
    }
    lastPlanKey = planKey;

    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    store.dispatch({ type: 'plan/set', loading: true, error: null });

    try {
      const data = await planRender(body, abortController.signal);
      store.dispatch({ type: 'plan/set', loading: false, data, error: null });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      store.dispatch({ type: 'plan/set', loading: false, data: null, error: err.message || 'Failed to compute plan' });
    }
  }

  function queueFetchPlan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fetchPlan();
    }, 250);
  }

  const unsubProject = store.subscribeSlice('currentProject', () => {
    queueFetchPlan();
    render(store.getState());
  });

  const unsubPlan = store.subscribeSlice('plan', () => {
    render(store.getState());
  });

  render(store.getState());
  queueFetchPlan();

  return function dispose() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (abortController) abortController.abort();
    unsubProject();
    unsubPlan();
  };
}

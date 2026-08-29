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
// 4. Clearly labeled arrangement-ready state used by Phase 6 actions.

import { createElement, replaceChildren } from '../dom.js';
import { planRender } from '../api.js';
import { projectManager as globalProjectManager } from '../app-context.js';
import { buildRenderBody } from '../render.js';
import { formatTime } from '../format.js';

export function mountPlan({ container, store, projectManager = globalProjectManager }) {
  if (!store) {
    throw new Error('mountPlan requires a store');
  }
  const root = createElement('section', {
    class: 'studio-plan',
    'aria-label': 'Arrangement and Render Plan',
  });
  container.replaceChildren(root);

  let abortController = null;
  let debounceTimer = null;
  let lastPlanKey = '';

  function requestForCurrentProject() {
    const state = store.getState();
    const project = state.currentProject || {};
    if (!project.anchor_track_id || !project.lead_track_id) return null;
    try {
      const body = buildRenderBody(project, { preview: false });
      const { preview: _preview, ...planned } = body;
      return planned;
    } catch {
      return null;
    }
  }

  function render(state) {
    const project = state.currentProject || {};
    const settings = project.settings || {};
    const anchorId = project.anchor_track_id;
    const leadId = project.lead_track_id;

    // Both tracks required for a plan
    const isReady = Boolean(anchorId && leadId);
    const anchorTrack = state.deckTracks?.[anchorId] || null;
    const leadTrack = state.deckTracks?.[leadId] || null;
    const anchorBpm = anchorTrack?.bpm ?? null;
    const leadBpm = leadTrack?.bpm ?? null;
    const tempoMode = settings.tempo_mode || 'foundation';
    const intendedOutputBpm = tempoMode === 'custom'
      ? settings.target_bpm
      : tempoMode === 'lead' ? leadBpm : anchorBpm;

    // --- Tempo card ---
    const saveSetting = (patch) => projectManager.save({ settings: { ...settings, ...patch } });

    const tempoModeOptions = [
      ['foundation', 'Foundation'],
      ['lead', 'Lead'],
      ['custom', 'Custom'],
    ].map(([value, label]) => createElement('button', {
      type: 'button',
      class: `seg${tempoMode === value ? ' seg--active' : ''}`,
      'aria-pressed': tempoMode === value ? 'true' : 'false',
      text: label,
      onclick: () => {
        const patch = { tempo_mode: value };
        if (value === 'custom') {
          const existing = settings.target_bpm;
          patch.target_bpm = Number.isFinite(existing)
            ? existing
            : (state.plan?.data?.output_bpm ?? anchorBpm ?? leadBpm ?? 120);
        } else {
          patch.target_bpm = null;
        }
        saveSetting(patch);
      },
    }));

    const tempoRows = [
      ['Foundation', anchorBpm, 'anchor_tempo_ratio', 'anchor_bpm_change_percent'],
      ['Lead', leadBpm, 'lead_tempo_ratio', 'lead_bpm_change_percent'],
    ];
    const adjustTarget = (factor) => {
      const current = Number.isFinite(intendedOutputBpm) ? intendedOutputBpm : null;
      if (current == null) return;
      const target = Math.round(current * factor * 10) / 10;
      if (target < 20 || target > 400) return;
      saveSetting({ tempo_mode: 'custom', target_bpm: target });
    };

    const tempoGroup = createElement('fieldset', { class: 'plan-group' }, [
      createElement('legend', { class: 'plan-group__title', text: 'Output BPM' }),
      createElement('div', { class: 'plan-group__fields' }, [
        createElement('div', { class: 'seg', role: 'group', 'aria-label': 'Output BPM source' }, tempoModeOptions),
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Custom output BPM' }),
          createElement('input', {
            class: 'input', type: 'number', step: '0.1', min: '20', max: '400',
            value: settings.target_bpm != null ? String(settings.target_bpm) : '',
            disabled: tempoMode !== 'custom' ? 'true' : null,
            placeholder: 'e.g. 128',
            'aria-label': 'Custom output BPM',
            onchange: (e) => {
              const num = e.target.value.trim() ? Number(e.target.value) : null;
              if (num == null || !Number.isFinite(num) || num < 20 || num > 400) return;
              saveSetting({ target_bpm: num });
            },
          }),
        ]),
        createElement('div', { class: 'plan-quick-actions' }, [
          createElement('button', {
            class: 'button button--sm', type: 'button', text: '½ BPM',
            'aria-label': 'Halve the current output BPM',
            disabled: !Number.isFinite(intendedOutputBpm) || intendedOutputBpm / 2 < 20 ? 'true' : null,
            onclick: () => adjustTarget(0.5),
          }),
          createElement('button', {
            class: 'button button--sm', type: 'button', text: '×2 BPM',
            'aria-label': 'Double the current output BPM',
            disabled: !Number.isFinite(intendedOutputBpm) || intendedOutputBpm * 2 > 400 ? 'true' : null,
            onclick: () => adjustTarget(2),
          }),
        ]),
        createElement('button', {
          class: 'button button--sm', type: 'button', text: 'Reset to Foundation',
          onclick: () => saveSetting({ tempo_mode: 'foundation', target_bpm: null }),
        }),
        createElement('div', { class: 'plan-tempo-rows' }, tempoRows.map(([role, bpm, _ratioKey, _pctKey]) => {
          const srcBpm = bpm != null ? `${bpm.toFixed(1)} BPM` : '—';
          const target = Number.isFinite(intendedOutputBpm)
            ? `${intendedOutputBpm.toFixed(1)} BPM`
            : 'output';
          return createElement('div', { class: 'plan-tempo-row', role: 'row' }, [
            createElement('span', { class: 'plan-tempo-row__role', text: role }),
            createElement('span', { class: 'plan-tempo-row__val', text: `${srcBpm} → ${target}` }),
          ]);
        })),
        createElement('p', {
          class: 'plan-hint',
          text: 'Both decks are aligned to the output BPM. Stretch ratios are shown in the plan below.',
        }),
      ]),
    ]);

    // --- Arrangement card ---
    const arrangementMode = settings.arrangement_mode || 'overlay';
    const arrangementButtons = [
      ['overlay', 'Overlay'],
      ['transition', 'Transition A → B'],
    ].map(([value, label]) => createElement('button', {
      type: 'button',
      class: `seg${arrangementMode === value ? ' seg--active' : ''}`,
      'aria-pressed': arrangementMode === value ? 'true' : 'false',
      text: label,
      onclick: () => saveSetting({ arrangement_mode: value }),
    }));

    const arrangementGroup = createElement('fieldset', { class: 'plan-group' }, [
      createElement('legend', { class: 'plan-group__title', text: 'Arrangement' }),
      createElement('div', { class: 'plan-group__fields' }, [
        createElement('div', { class: 'seg', role: 'group', 'aria-label': 'Arrangement mode' }, arrangementButtons),
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Transition start (output seconds)' }),
          createElement('input', {
            class: 'input', type: 'number', step: '0.1', min: '0',
            value: settings.transition_start != null ? String(settings.transition_start) : '0',
            disabled: arrangementMode !== 'transition' ? 'true' : null,
            'aria-label': 'Transition start in seconds',
            onchange: (e) => {
              const num = e.target.value.trim() ? Number(e.target.value) : 0;
              if (!Number.isFinite(num) || num < 0) return;
              saveSetting({ transition_start: num });
            },
          }),
        ]),
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Crossfade duration (0 = hard cut)' }),
          createElement('input', {
            class: 'input', type: 'number', step: '0.1', min: '0', max: '30',
            value: settings.crossfade_duration != null ? String(settings.crossfade_duration) : '0',
            disabled: arrangementMode !== 'transition' ? 'true' : null,
            'aria-label': 'Crossfade duration in seconds',
            onchange: (e) => {
              const num = e.target.value.trim() ? Number(e.target.value) : 0;
              if (!Number.isFinite(num) || num < 0 || num > 30) return;
              saveSetting({ crossfade_duration: num });
            },
          }),
        ]),
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Crossfade curve' }),
          createElement('select', {
            class: 'select',
            disabled: arrangementMode !== 'transition' ? 'true' : null,
            'aria-label': 'Crossfade curve',
            onchange: (e) => saveSetting({ crossfade_curve: e.target.value }),
          }, [
            createElement('option', {
              value: 'equal_power',
              text: 'Equal-power (smooth)',
              selected: (settings.crossfade_curve || 'equal_power') === 'equal_power' ? 'true' : null,
            }),
            createElement('option', {
              value: 'linear',
              text: 'Linear',
              selected: settings.crossfade_curve === 'linear' ? 'true' : null,
            }),
          ]),
        ]),
        createElement('p', {
          class: 'plan-hint',
          text: arrangementMode === 'transition'
            ? 'Foundation begins at 0; Lead enters at the transition start. A zero crossfade is an explicit hard cut.'
            : 'Both decks begin together; the automatic duration is the shorter aligned overlap.',
        }),
      ]),
    ]);

    // --- Channel strips ---
    const channelGroup = (role) => {
      const isAnchor = role === 'anchor';
      const roleLabel = isAnchor ? 'Foundation' : 'Lead';
      const gain = settings[`${role}_gain`] ?? 0.8;
      const pan = settings[`${role}_pan`] ?? 0;
      const eq = settings[`${role}_eq`] || { low: 0, mid: 0, high: 0 };
      const bandLabel = (band) => ({ low: 'Low', mid: 'Mid', high: 'High' }[band]);
      const bandFreq = { low: '120 Hz', mid: '1 kHz', high: '8 kHz' };
      const resetChannel = () => saveSetting({
        [`${role}_gain`]: 0.8, [`${role}_pan`]: 0,
        [`${role}_eq`]: { low: 0, mid: 0, high: 0 },
      });
      const pairedControl = ({ label, value, min, max, step, aria, save }) =>
        createElement('div', { class: 'plan-control-pair' }, [
          createElement('span', { class: 'plan-control-pair__label', text: label }),
          createElement('input', {
            class: 'input-range', type: 'range', min: String(min), max: String(max),
            step: String(step), value: String(value), 'aria-label': aria,
            oninput: (e) => save(Number(e.target.value)),
          }),
          createElement('input', {
            class: 'input plan-control-pair__number', type: 'number',
            min: String(min), max: String(max), step: String(step), value: String(value),
            'aria-label': `${aria} numeric value`,
            onchange: (e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next >= min && next <= max) save(next);
            },
          }),
        ]);
      return createElement('fieldset', {
        class: `plan-group plan-group--channel plan-group--${role}`,
      }, [
        createElement('legend', { class: 'plan-group__title', text: `${roleLabel} Channel` }),
        createElement('div', { class: 'plan-group__fields' }, [
          pairedControl({
            label: `Gain: ${gain.toFixed(2)}×`, value: gain, min: 0, max: 2, step: 0.05,
            aria: `${roleLabel} gain`, save: (value) => saveSetting({ [`${role}_gain`]: value }),
          }),
          pairedControl({
            label: `Pan: ${pan === 0 ? 'C' : pan > 0 ? `R ${pan.toFixed(2)}` : `L ${Math.abs(pan).toFixed(2)}`}`,
            value: pan, min: -1, max: 1, step: 0.05, aria: `${roleLabel} pan`,
            save: (value) => saveSetting({ [`${role}_pan`]: value }),
          }),
          createElement('div', { class: 'plan-eq' }, ['low', 'mid', 'high'].map((band) =>
            pairedControl({
              label: `${bandLabel(band)} ${bandFreq[band]}: ${(eq[band] ?? 0) > 0 ? '+' : ''}${(eq[band] ?? 0).toFixed(1)} dB`,
              value: eq[band] ?? 0, min: -12, max: 12, step: 0.5,
              aria: `${roleLabel} ${bandLabel(band)} EQ`,
              save: (value) => saveSetting({
                [`${role}_eq`]: { ...eq, [band]: value },
              }),
            })
          )),
          createElement('button', {
            class: 'button button--sm', type: 'button', text: `Reset ${roleLabel} channel`,
            onclick: resetChannel,
          }),
        ]),
      ]);
    };

    const timingGroup = createElement('fieldset', { class: 'plan-group' }, [
      createElement('legend', { class: 'plan-group__title', text: 'Timing' }),
      createElement('div', { class: 'plan-group__fields' }, [
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Duration (seconds, blank = auto)' }),
          createElement('input', {
            class: 'input', type: 'number', step: '0.1', min: '1', max: '3600',
            placeholder: 'Auto (full overlap)',
            value: settings.duration != null ? String(settings.duration) : '',
            'aria-label': 'Mash duration in seconds',
            onchange: (e) => {
              const val = e.target.value.trim();
              const num = val ? Number(val) : null;
              if (num != null && (num <= 0 || num > 3600)) return;
              saveSetting({ duration: num });
            },
          }),
        ]),
        createElement('label', { class: 'checkbox-label' }, [
          createElement('input', {
            type: 'checkbox',
            checked: settings.snap !== false ? 'true' : null,
            'aria-label': 'Snap cues to beat grid',
            onchange: (e) => saveSetting({ snap: e.target.checked }),
          }),
          createElement('span', { text: 'Snap cues to detected beat grid' }),
        ]),
        createElement('label', { class: 'label' }, [
          createElement('span', { text: 'Pitch Mode' }),
          createElement('select', {
            class: 'select', 'aria-label': 'Pitch adjustment mode',
            onchange: (e) => saveSetting({ pitch_mode: e.target.value }),
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

    const controlsContainer = createElement('div', { class: 'plan-controls' }, [
      tempoGroup,
      arrangementGroup,
      timingGroup,
      channelGroup('anchor'),
      channelGroup('lead'),
      createElement('div', { class: 'plan-reset-mixer' }, [
        createElement('button', {
          class: 'button button--sm', type: 'button', text: 'Reset mixer',
          onclick: () => saveSetting({
            anchor_gain: 0.8, lead_gain: 0.8,
            anchor_pan: 0, lead_pan: 0,
            anchor_eq: { low: 0, mid: 0, high: 0 },
            lead_eq: { low: 0, mid: 0, high: 0 },
          }),
        }),
      ]),
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

        const outputBpm = d.output_bpm != null ? `${d.output_bpm.toFixed(1)} BPM` : '—';
        const tempoModeLabel = { foundation: 'Foundation', lead: 'Lead', custom: 'Custom' }[d.tempo_mode] || 'Foundation';
        const outputDuration = d.duration?.output ?? d.output_duration ?? 0;

        const stretchRow = (roleLabel, ratio, pct) => {
          const ratioText = ratio != null ? `${ratio.toFixed(3)}x` : '—';
          const pctText = pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—';
          return createElement('div', { class: 'plan-stretch-row', role: 'row' }, [
            createElement('span', { class: 'plan-stretch-row__role', text: roleLabel }),
            createElement('span', { class: 'plan-stretch-row__val', text: `${ratioText}  (${pctText})` }),
          ]);
        };

        const metricsEl = createElement('div', { class: 'plan-metrics' }, [
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Output BPM' }),
            createElement('span', { class: 'plan-metric__val', text: `${outputBpm} (${tempoModeLabel})` }),
          ]),
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Harmonic Shift' }),
            createElement('span', { class: 'plan-metric__val', text: semitoneText }),
          ]),
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Mash Duration' }),
            createElement('span', { class: 'plan-metric__val', text: formatTime(outputDuration) }),
          ]),
          createElement('div', { class: 'plan-metric' }, [
            createElement('span', { class: 'plan-metric__label', text: 'Pitch Mode' }),
            createElement('span', { class: 'plan-metric__val', text: d.pitch_mode === 'preserve' ? 'Preserve Pitch' : 'Match Key' }),
          ]),
        ]);

        const stretches = createElement('div', { class: 'plan-stretch' }, [
          stretchRow('Foundation stretch', d.anchor_tempo_ratio, d.anchor_bpm_change_percent),
          stretchRow('Lead stretch', d.lead_tempo_ratio, d.lead_bpm_change_percent),
        ]);

        // Output-clock visualization (semantic DOM, explanatory, non-draggable).
        const clockDuration = Math.max(0.001, outputDuration);
        const anchorStart = d.sources?.anchor?.output_start ?? 0;
        const leadStart = d.sources?.lead?.output_start ?? 0;
        const cross = d.transition?.crossfade_duration ?? 0;
        const pct = (t) => `${Math.max(0, Math.min(100, (t / clockDuration) * 100))}%`;
        const anchorEnd = d.sources?.anchor?.output_end ?? outputDuration;
        const anchorW = pct(Math.max(0, anchorEnd - anchorStart));
        const leadW = pct(Math.max(0, outputDuration - leadStart));
        const fadeW = pct(cross);

        const clock = createElement('div', {
          class: 'plan-clock', role: 'img',
          'aria-label': d.arrangement_mode === 'transition'
            ? `Transition: foundation from 0, lead at ${formatTime(leadStart)}, crossfade ${formatTime(cross)}.`
            : 'Overlay: both decks begin together.',
        }, [
          createElement('div', {
            class: 'plan-clock__bar plan-clock__bar--anchor',
            style: { left: pct(anchorStart), width: anchorW },
          }, [
            createElement('span', { class: 'plan-clock__label', text: 'Foundation' }),
          ]),
          createElement('div', {
            class: 'plan-clock__bar plan-clock__bar--lead',
            style: { left: pct(leadStart), width: leadW },
          }, [
            createElement('span', { class: 'plan-clock__label', text: 'Lead' }),
          ]),
          d.arrangement_mode === 'transition' && cross > 0
            ? createElement('div', {
                class: 'plan-clock__fade',
                style: { left: pct(leadStart), width: fadeW },
              }, [createElement('span', { class: 'plan-clock__label', text: 'crossfade' })])
            : null,
        ]);
        const clockLegend = createElement('div', { class: 'plan-clock__legend' }, [
          createElement('span', { class: 'badge badge--anchor', text: 'Foundation' }),
          createElement('span', { class: 'badge badge--lead', text: 'Lead' }),
          d.arrangement_mode === 'transition'
            ? createElement('span', { class: 'badge badge--warning', text: d.transition?.crossfade_duration > 0 ? 'crossfade' : 'hard cut' })
            : null,
        ]);

        // Per-source consumed source time from the server plan (authoritative).
        const sourceTimes = createElement('div', { class: 'plan-source-times' }, [
          createElement('p', {
            class: 'plan-hint',
            text: d.sources?.anchor
              ? `Foundation source: starts ${formatTime(d.sources.anchor.source_start)}, consumes ${formatTime(d.sources.anchor.source_consumed)} source time.`
              : '',
          }),
          createElement('p', {
            class: 'plan-hint',
            text: d.sources?.lead
              ? `Lead source: starts ${formatTime(d.sources.lead.source_start)}, consumes ${formatTime(d.sources.lead.source_consumed)} source time at ${formatTime(d.sources.lead.output_start)} on the output clock.`
              : '',
          }),
        ]);

        const warningsEl = createElement('div', { class: 'plan-warnings' });
        if (d.warnings && d.warnings.length > 0) {
          for (const w of d.warnings) {
            warningsEl.appendChild(createElement('div', { class: 'badge badge--warning', text: `⚠️ ${w}` }));
          }
        }

        const variantsEl = createElement('div', { class: 'plan-variants' }, [
          createElement('span', { class: 'badge badge--anchor', text: `Foundation: ${d.anchor_variant || 'full'}` }),
          createElement('span', { class: 'badge badge--lead', text: `Lead: ${d.lead_variant || 'full'}` }),
        ]);

        const readyBadge = createElement('div', { class: 'plan-ready' }, [
          createElement('span', { class: 'badge badge--success', text: '✓ Arrangement Plan Verified' }),
          createElement('span', { class: 'plan-hint', text: 'Use the Preview and Render actions below.' }),
        ]);

        replaceChildren(planDisplay, [
          createElement('h3', { class: 'plan-output__title', text: 'Exact Render Plan (Server-Authored)' }),
          metricsEl,
          stretches,
          clockLegend,
          clock,
          sourceTimes,
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
    const body = requestForCurrentProject();
    if (!body) {
      store.dispatch({
        type: 'plan/set', loading: false, data: null, error: null, request: null,
      });
      return;
    }

    const planKey = JSON.stringify(body);
    const state = store.getState();
    if (planKey === lastPlanKey && state.plan?.data) {
      return;
    }
    lastPlanKey = planKey;

    if (abortController) {
      abortController.abort();
    }
    const controller = new AbortController();
    abortController = controller;

    store.dispatch({ type: 'plan/set', loading: true, error: null, request: body });

    try {
      const data = await planRender(body, controller.signal);
      if (controller.signal.aborted || abortController !== controller) return;
      store.dispatch({
        type: 'plan/set', loading: false, data, error: null, request: body,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (controller.signal.aborted || abortController !== controller) return;
      store.dispatch({
        type: 'plan/set', loading: false, data: null,
        error: err.message || 'Failed to compute plan', request: body,
      });
    }
  }

  function queueFetchPlan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fetchPlan();
    }, 250);
  }

  function invalidateAndQueuePlan(force = false) {
    const body = requestForCurrentProject();
    const current = store.getState().plan || {};
    if (!body) {
      if (current.data || current.loading || current.error || current.request) {
        store.dispatch({
          type: 'plan/set', loading: false, data: null, error: null, request: null,
        });
      }
      queueFetchPlan();
      return;
    }
    const changed = JSON.stringify(body) !== JSON.stringify(current.request);
    if (force) lastPlanKey = '';
    if (force || changed || !current.data) {
      if ((force || changed) && abortController) abortController.abort();
      // Invalidate synchronously. The 250ms debounce delays only the network
      // request, never the truthfulness of render-action readiness.
      store.dispatch({
        type: 'plan/set', loading: true, data: null, error: null, request: body,
      });
    }
    queueFetchPlan();
  }

  const unsubProject = store.subscribeSlice('currentProject', () => {
    invalidateAndQueuePlan();
    render(store.getState());
  });

  const unsubPlan = store.subscribeSlice('plan', () => {
    render(store.getState());
  });

  // Committing or reverting a Ghost changes server-owned render inputs while
  // leaving ordinary project fields unchanged. Force a fresh authoritative
  // plan and synchronously disable render actions until it arrives.
  const unsubSession = store.subscribeSlice('session', () => {
    invalidateAndQueuePlan(true);
    render(store.getState());
  });

  render(store.getState());
  invalidateAndQueuePlan();

  return function dispose() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (abortController) abortController.abort();
    unsubProject();
    unsubPlan();
    unsubSession();
  };
}

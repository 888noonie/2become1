// components/stem-dialog.js — accessible separation modal and stem tray.
//
// Phase 5 (Task 5):
// - Offers Auto, Demucs (4-stem), and Center/side.
// - Never implies center/side is isolated vocals (labelled truthfully as Center / Sides).
// - Submits separation job, monitors via SSE, handles CUDA OOM warnings gracefully.
// - Once complete, displays stem tray with truthful name/method/model/device,
//   Play/Stop via global AudioController, Use in this deck, and Download.

import { createElement, replaceChildren } from '../dom.js';
import { openDialog } from './dialog.js';
import { showToast } from './toast.js';
import {
  submitSeparation,
  listStems,
  watchJob,
  stemAudioUrl,
} from '../api.js';
import { audioController } from '../audio.js';
import { projectManager } from '../app-context.js';

export async function openStemDialog({ track, role, store, onAnnounce, trigger = null }) {
  let activeUnsub = null;
  let dialogClose = null;

  const stemListContainer = createElement('div', { class: 'stem-tray__list' });
  const jobStatusEl = createElement('div', {
    class: 'stem-dialog__status',
    role: 'status',
    'aria-live': 'polite',
  });

  const methodSelect = createElement('select', {
    class: 'select',
    'aria-label': 'Separation method',
  }, [
    createElement('option', { value: 'auto', text: 'Auto (Recommended / CUDA Demucs)' }),
    createElement('option', { value: 'demucs', text: 'Demucs 4-Stem (Vocals, Drums, Bass, Other)' }),
    createElement('option', { value: 'ffmpeg', text: 'Center / Sides (Stereo DSP phase cancel)' }),
  ]);

  const separateBtn = createElement('button', {
    class: 'button button--primary',
    type: 'button',
    text: 'Start Separation',
  });

  async function loadAndRenderStems() {
    try {
      const data = await listStems(track.id);
      const variants = data.variants || [];
      const currentProject = store.getState().currentProject || {};
      const currentVariant = (role === 'anchor' ? currentProject.anchor_variant : currentProject.lead_variant) || 'full';

      if (variants.length === 0) {
        replaceChildren(stemListContainer, [
          createElement('p', { class: 'stem-tray__empty', text: 'No stems separated yet.' }),
        ]);
        return;
      }

      const rows = variants.map((v) => {
        const isSelected = v.name === currentVariant;
        const isFull = v.name === 'full';

        // Truthful label
        let displayName = v.name;
        if (v.name === 'center') displayName = 'Center (Mid channel DSP)';
        else if (v.name === 'side') displayName = 'Sides (Side channel DSP)';
        else if (v.name === 'vocals') displayName = 'Vocals (Demucs)';
        else if (v.name === 'drums') displayName = 'Drums (Demucs)';
        else if (v.name === 'bass') displayName = 'Bass (Demucs)';
        else if (v.name === 'other') displayName = 'Other / Instruments (Demucs)';
        else if (isFull) displayName = 'Full Original Mix';

        const metaDetails = [];
        if (v.method) metaDetails.push(`Method: ${v.method}`);
        if (v.model_name) metaDetails.push(`Model: ${v.model_name}`);
        if (v.device) metaDetails.push(`Device: ${v.device}`);

        const rowEl = createElement('div', {
          class: `stem-row ${isSelected ? 'stem-row--selected' : ''}`,
        });

        const infoEl = createElement('div', { class: 'stem-row__info' }, [
          createElement('div', { class: 'stem-row__name', text: displayName }),
          metaDetails.length > 0
            ? createElement('div', { class: 'stem-row__meta', text: metaDetails.join(' • ') })
            : null,
        ]);

        // Audition button (global AudioController)
        const playback = store.getState().playback;
        const isAuditioning = playback.playing && (
          playback.source?.url === v.audio_url ||
          (playback.source?.trackId === track.id && playback.source?.variant === v.name)
        );

        const playBtn = createElement('button', {
          class: `button button--sm ${isAuditioning ? 'button--primary' : ''}`,
          type: 'button',
          text: isAuditioning ? 'Stop' : 'Audition',
          onclick: () => {
            if (isAuditioning) {
              audioController.stop();
            } else {
              audioController.play({
                trackId: track.id,
                url: v.audio_url,
                kind: isFull ? 'track' : 'stem',
                stemName: isFull ? null : v.name,
                variant: v.name,
              });
            }
          },
        });

        // Use in Deck button
        const useBtn = createElement('button', {
          class: `button button--sm ${isSelected ? 'button--success' : ''}`,
          type: 'button',
          text: isSelected ? 'Active in Deck' : 'Use in Deck',
          disabled: isSelected ? 'true' : null,
          onclick: () => {
            const key = role === 'anchor' ? 'anchor_variant' : 'lead_variant';
            projectManager.save({ [key]: v.name });
            store.dispatch({ type: 'project/patch-local', fields: { [key]: v.name } });
            showToast(`Selected "${v.name}" for ${role === 'anchor' ? 'Foundation' : 'Lead'}.`, 'success');
            onAnnounce?.(`Selected ${v.name} for ${role === 'anchor' ? 'foundation' : 'lead'}.`);
            loadAndRenderStems();
          },
        });

        // Download button
        let downloadBtn = null;
        if (!isFull && v.stem_set_id) {
          const downloadUrl = stemAudioUrl(v.stem_set_id, v.name, { download: true });
          downloadBtn = createElement('a', {
            class: 'button button--sm',
            href: downloadUrl,
            download: `${track.name}-${v.name}.wav`,
            text: 'Download',
          });
        }

        const actionsEl = createElement('div', { class: 'stem-row__actions' }, [
          playBtn,
          useBtn,
          downloadBtn,
        ]);

        rowEl.appendChild(infoEl);
        rowEl.appendChild(actionsEl);
        return rowEl;
      });

      replaceChildren(stemListContainer, rows);
    } catch (err) {
      replaceChildren(stemListContainer, [
        createElement('p', { class: 'stem-tray__error', text: `Failed to load stems: ${err.message}` }),
      ]);
    }
  }

  separateBtn.onclick = async () => {
    separateBtn.disabled = true;
    const method = methodSelect.value;
    jobStatusEl.textContent = 'Submitting separation job…';

    try {
      const job = await submitSeparation(track.id, method);
      // Upsert job into global Activity store
      store.dispatch({ type: 'jobs/upsert', job });

      if (job.status === 'complete') {
        // Cache hit
        jobStatusEl.textContent = 'Stem separation found in cache.';
        showToast('Stems available immediately (cached).', 'success');
        separateBtn.disabled = false;
        await loadAndRenderStems();
        return;
      }

      jobStatusEl.textContent = `Separating (${method})…`;

      if (activeUnsub) activeUnsub();
      activeUnsub = watchJob(job.id, async (updated) => {
        store.dispatch({ type: 'jobs/upsert', job: updated });
        if (updated.status === 'running') {
          let msg = `Separating (${updated.progress_phase || 'processing'})…`;
          if (updated.progress_detail) {
            msg += ` ${updated.progress_detail}`;
          }
          jobStatusEl.textContent = msg;
        } else if (updated.status === 'complete') {
          jobStatusEl.textContent = 'Separation complete!';
          showToast('Stem separation finished successfully.', 'success');
          separateBtn.disabled = false;
          if (activeUnsub) {
            activeUnsub();
            activeUnsub = null;
          }
          await loadAndRenderStems();
        } else if (updated.status === 'failed' || updated.status === 'cancelled') {
          const errText = updated.error?.message || updated.progress_detail || 'Separation failed';
          jobStatusEl.textContent = `Error: ${errText}`;
          showToast(`Separation ${updated.status}: ${errText}`, 'danger');
          separateBtn.disabled = false;
          if (activeUnsub) {
            activeUnsub();
            activeUnsub = null;
          }
        }
      });
    } catch (err) {
      jobStatusEl.textContent = `Failed: ${err.message}`;
      showToast(err.message || 'Separation failed', 'danger');
      separateBtn.disabled = false;
    }
  };

  const bodyEl = createElement('div', { class: 'stem-dialog' }, [
    createElement('div', { class: 'stem-dialog__section' }, [
      createElement('h4', { text: 'New Separation' }),
      createElement('div', { class: 'input-group' }, [methodSelect, separateBtn]),
      jobStatusEl,
    ]),
    createElement('div', { class: 'stem-dialog__section' }, [
      createElement('h4', { text: 'Available Variants & Stems' }),
      stemListContainer,
    ]),
  ]);

  // Initial stems load
  loadAndRenderStems();

  // Subscribe to playback changes to update Audition buttons
  const unsubPlayback = store.subscribeSlice('playback', () => {
    loadAndRenderStems();
  });

  await openDialog({
    title: `Stems & Separation: ${track.name}`,
    body: [bodyEl],
    actions: [{ label: 'Done', value: 'close' }],
    trigger,
  });

  if (activeUnsub) activeUnsub();
  unsubPlayback();
}

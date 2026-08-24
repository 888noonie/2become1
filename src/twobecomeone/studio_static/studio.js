const state = { anchor: null, lead: null, activeJob: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 5000);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let body = null;
  try { body = await response.json(); } catch { /* file or empty response */ }
  if (!response.ok) throw new Error(body?.error || body?.detail || `Request failed (${response.status})`);
  return body;
}

async function checkEngine() {
  try {
    const health = await api('/api/health');
    $('#engine-pill').classList.add('ready');
    $('#engine-status').textContent = `${health.preferred_device.toUpperCase()} ENGINE · LOCAL`;
  } catch (error) {
    $('#engine-status').textContent = 'ENGINE OFFLINE';
    toast(error.message);
  }
}

function setupDropCard(card) {
  const slot = card.dataset.slot;
  const zone = $('.drop-zone', card);
  const input = $('input[type=file]', card);
  const choose = () => input.click();
  zone.addEventListener('click', choose);
  zone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
  });
  input.addEventListener('change', () => input.files[0] && uploadTrack(slot, input.files[0], card));
  ['dragenter', 'dragover'].forEach(name => zone.addEventListener(name, event => {
    event.preventDefault(); zone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(name => zone.addEventListener(name, event => {
    event.preventDefault(); zone.classList.remove('dragging');
  }));
  zone.addEventListener('drop', event => {
    const file = event.dataTransfer.files[0];
    if (file) uploadTrack(slot, file, card);
  });
  $('.replace', card).addEventListener('click', choose);
}

async function uploadTrack(slot, file, card) {
  $('.drop-zone', card).hidden = true;
  $('.track-result', card).hidden = true;
  $('.uploading', card).hidden = false;
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const track = await api('/api/tracks', { method: 'POST', body: form });
    state[slot] = track;
    renderTrack(card, track);
    updateConsole();
  } catch (error) {
    $('.drop-zone', card).hidden = false;
    toast(error.message);
  } finally {
    $('.uploading', card).hidden = true;
  }
}

function renderTrack(card, track) {
  const result = $('.track-result', card);
  $('h2', result).textContent = track.name;
  $('[data-field=bpm]', result).textContent = Number(track.bpm).toFixed(1);
  $('[data-field=key]', result).textContent = `${track.key.tonic} ${track.key.mode === 'major' ? 'maj' : 'min'}`;
  $('[data-field=duration]', result).textContent = formatTime(track.duration);
  $('audio', result).src = track.audio_url;
  result.hidden = false;
}

function updateConsole() {
  const ready = state.anchor && state.lead;
  $('#console').hidden = !ready;
  if (!ready) return;
  const ratio = state.anchor.bpm / state.lead.bpm;
  const delta = ((ratio - 1) * 100);
  const gridReady = state.anchor.beat_grid?.suggested_downbeat != null && state.lead.beat_grid?.suggested_downbeat != null;
  const confidence = gridReady ? Math.round(Math.min(state.anchor.beat_grid.confidence, state.lead.beat_grid.confidence) * 100) : null;
  $('#compatibility').innerHTML = `<span>${ratio.toFixed(3)}× TEMPO · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%${confidence == null ? '' : ` · GRID ${confidence}%`}</span>`;
  $('#auto-sync').hidden = !gridReady;
  const maxDuration = Math.max(3, Math.min(180, Math.floor(Math.min(state.anchor.duration, state.lead.duration))));
  $('#duration').max = maxDuration;
  $('#duration').value = Math.min(12, maxDuration);
  syncControls();
  $('#console').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function syncControls() {
  $('#anchor-start-out').value = `${Number($('#anchor-start').value).toFixed(1)}s`;
  $('#lead-start-out').value = `${Number($('#lead-start').value).toFixed(1)}s`;
  $('#duration-out').value = `${$('#duration').value}s`;
  $('#anchor-gain-out').value = `${Math.round($('#anchor-gain').value * 100)}%`;
  $('#lead-gain-out').value = `${Math.round($('#lead-gain').value * 100)}%`;
}

function renderPayload(preview) {
  return {
    anchor_id: state.anchor.id,
    lead_id: state.lead.id,
    anchor_start: Number($('#anchor-start').value),
    lead_start: Number($('#lead-start').value),
    duration: preview ? Math.min(12, Number($('#duration').value)) : Number($('#duration').value),
    anchor_gain: Number($('#anchor-gain').value),
    lead_gain: Number($('#lead-gain').value),
    use_vocals: $('#use-vocals').checked,
    stem_method: 'auto',
    preview,
  };
}

async function submitRender(preview) {
  if (!state.anchor || !state.lead || state.activeJob) return;
  setButtons(true);
  $('#render-deck').hidden = false;
  $('#result-player').hidden = true;
  updateJob({ progress: 0, stage: 'queued', message: 'Waiting for the render engine', status: 'queued', kind: preview ? 'preview' : 'render' });
  $('#render-deck').scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const job = await api('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(renderPayload(preview)),
    });
    state.activeJob = job.id;
    followJob(job.id);
  } catch (error) {
    state.activeJob = null;
    setButtons(false);
    toast(error.message);
  }
}

function followJob(jobId) {
  const events = new EventSource(`/api/jobs/${jobId}/events`);
  events.addEventListener('job', event => {
    const job = JSON.parse(event.data);
    updateJob(job);
    if (job.status === 'complete' || job.status === 'failed') {
      events.close(); state.activeJob = null; setButtons(false);
      if (job.status === 'complete') { showResult(job); loadRecent(); }
      else toast(job.error || 'Render failed');
    }
  });
  events.onerror = () => {
    events.close();
    pollJob(jobId);
  };
}

async function pollJob(jobId) {
  try {
    const job = await api(`/api/jobs/${jobId}`);
    updateJob(job);
    if (job.status === 'complete') { state.activeJob = null; setButtons(false); showResult(job); loadRecent(); }
    else if (job.status === 'failed') { state.activeJob = null; setButtons(false); toast(job.error || 'Render failed'); }
    else setTimeout(() => pollJob(jobId), 650);
  } catch (error) { state.activeJob = null; setButtons(false); toast(error.message); }
}

function updateJob(job) {
  $('#progress-bar').style.width = `${job.progress || 0}%`;
  $('#progress-value').textContent = `${job.progress || 0}%`;
  $('#render-stage').textContent = (job.stage || 'queued').toUpperCase();
  $('#render-message').textContent = job.message || 'Working locally…';
  $('#render-kicker').textContent = job.kind === 'preview' ? 'QUICK CHEMISTRY CHECK' : 'IN THE MIX';
  $('#render-title').textContent = job.status === 'complete' ? 'That’s the one.' : job.status === 'failed' ? 'The mix hit a snag.' : 'Finding the sweet spot…';
}

function showResult(job) {
  $('#result-audio').src = `${job.audio_url}?v=${Date.now()}`;
  $('#download-link').href = `${job.audio_url}?download=true`;
  $('#result-player').hidden = false;
}

function setButtons(disabled) {
  $('#preview-button').disabled = disabled;
  $('#render-button').disabled = disabled;
}

async function loadRecent() {
  try {
    const { jobs } = await api('/api/jobs');
    const completed = jobs.filter(job => job.status === 'complete').slice(0, 5);
    $('#recent').hidden = completed.length === 0;
    $('#recent-list').innerHTML = completed.map(job => `
      <div class="recent-item">
        <div><strong>${job.kind === 'preview' ? 'Preview' : 'Full mashup'}</strong><small>${new Date(job.created_at * 1000).toLocaleString()} · ${job.result?.duration?.toFixed(1) || '—'}s</small></div>
        <a href="${job.audio_url}?download=true">Download ↓</a>
      </div>`).join('');
  } catch { /* recent history is non-critical */ }
}

$$('.track-card').forEach(setupDropCard);
$$('.control-grid input[type=range]').forEach(input => input.addEventListener('input', syncControls));
$('#preview-button').addEventListener('click', () => submitRender(true));
$('#render-button').addEventListener('click', () => submitRender(false));
$('#auto-sync').addEventListener('click', () => {
  if (!state.anchor?.beat_grid || !state.lead?.beat_grid) return;
  $('#anchor-start').value = state.anchor.beat_grid.suggested_downbeat;
  $('#lead-start').value = state.lead.beat_grid.suggested_downbeat;
  syncControls();
  toast('Suggested downbeats aligned. Use your ears and fine-tune if needed.');
});
checkEngine();
loadRecent();

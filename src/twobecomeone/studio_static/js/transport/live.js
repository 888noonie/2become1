// js/transport/live.js — pure live placement resolution for committed layers.
//
// Phase 12A.2. Maps a committed layer's authoritative launch receipt onto the
// live Deck B transport: the layer's absolute launch beat is converted to a
// future Web Audio clock time (whole-phrase stepping, finite minimum lead),
// and the layer's asset ring duration + linear gain are derived from the
// layer's own transform facts. Pure math only — no Web Audio, timers, DOM,
// or clock reads. The result is frozen; scheduling intent, never a physical
// speaker/sample-accuracy claim.
//
// Mirrors the render authority (_resolve_committed_layer, studio.py):
//   accepted_destination_time = originSeconds + launchBeat * 60 / targetBpm
//   duration                 = region span * 60 / targetBpm
// Under live grid parity the live transport's beat math places that time on
// the shared AudioContext clock via the same formulas resolveNextPhrase uses:
//   launchAudioTime = startedAtAudioTime + (launchBeat - beatAtStart) / bps

import { buildFailure, buildSuccess, ERROR_CODES } from '../actions/errors.js';
import { normalizeTransport } from './normalize.js';

export const LIVE_MIN_LEAD_SECONDS = 0.25;
export const LIVE_EPSILON = 1e-9;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Resolve one committed layer's next live placement.
 *
 * @param {object} layer — committed layer with launchReceipt, transformSpec, placement
 * @param {object} rawTransport — live Deck B transport (pre-normalization)
 * @param {number} nowAudioTime — AudioContext.currentTime when resolving
 * @returns {{ ok: true, value: object } | { ok: false, code: string }}
 *   value: { launchBeat, launchAudioTime, phraseIndex, phraseBeats,
 *            durationSeconds, gainLinear, gridRevision, assetId, contentHash }
 */
export function resolveLivePlacement(layer, rawTransport, nowAudioTime) {
  const norm = normalizeTransport(rawTransport);
  if (!norm.ok) return norm;
  const transport = norm.value;
  if (!transport.playing) {
    return buildFailure(ERROR_CODES.T_TRANSPORT_NOT_PLAYING);
  }
  if (!finiteNumber(nowAudioTime)) {
    return buildFailure(ERROR_CODES.T_INVALID_TIME, { value: nowAudioTime, field: 'nowAudioTime' });
  }

  const receipt = layer?.launchReceipt;
  if (!receipt || typeof receipt !== 'object') {
    return buildFailure(ERROR_CODES.L_LAYER_INVALID, { reason: 'missing launchReceipt' });
  }
  const launchBeat = Number(receipt.launchBeat);
  if (!finiteNumber(launchBeat)) {
    return buildFailure(ERROR_CODES.L_LAYER_INVALID, { reason: 'invalid launchBeat' });
  }
  const targetBpm = Number(receipt.targetBpm);
  if (!finiteNumber(targetBpm) || targetBpm <= 0) {
    return buildFailure(ERROR_CODES.L_LAYER_INVALID, { reason: 'invalid targetBpm' });
  }
  const assetId = layer?.asset?.id ?? layer?.acceptedAsset?.id ?? receipt.assetId;
  const contentHash = layer?.asset?.contentHash ?? layer?.acceptedAsset?.contentHash ?? receipt.contentHash;
  if (!assetId || !contentHash) {
    return buildFailure(ERROR_CODES.L_LAYER_INVALID, { reason: 'missing asset identity' });
  }

  const bps = transport.tempoBpm / 60;
  const pb = transport.beatsPerBar * transport.phraseBars;

  // Whole-phrase stepping to the next future instance (epsilon-stable: an
  // instance exactly at now is past, mirroring resolveNextPhrase's rule).
  let instanceBeat = launchBeat;
  while (true) {
    const instanceTime = transport.startedAtAudioTime
      + (instanceBeat - transport.beatAtStart) / bps;
    if (instanceTime - nowAudioTime > LIVE_EPSILON) {
      if (instanceTime - nowAudioTime >= LIVE_MIN_LEAD_SECONDS) {
        break; // future with a safe lead: schedule this instance
      }
    }
    instanceBeat += pb; // past, on-now, or unsafe lead: the following phrase
  }

  // Asset ring duration: region span at the asset's baked tempo (asset time,
  // unaffected by live tempo variance inside the parity tolerance).
  const region = layer?.transformSpec?.semanticRegion || {};
  const startBeat = Number(region.startBeat);
  const endBeat = Number(region.endBeat);
  if (!finiteNumber(startBeat) || !finiteNumber(endBeat) || endBeat <= startBeat) {
    return buildFailure(ERROR_CODES.L_LAYER_INVALID, { reason: 'invalid semanticRegion' });
  }
  const durationSeconds = (endBeat - startBeat) * 60 / targetBpm;

  // Linear gain from the durable placement (never baked into the asset).
  const gainDb = Number(layer?.placement?.gainDb ?? 0);
  if (!finiteNumber(gainDb)) {
    return buildFailure(ERROR_CODES.L_LAYER_INVALID, { reason: 'invalid gainDb' });
  }
  const gainLinear = Math.pow(10, gainDb / 20);

  const launchAudioTime = transport.startedAtAudioTime
    + (instanceBeat - transport.beatAtStart) / bps;
  const phraseIndex = Math.floor(instanceBeat / pb);

  return buildSuccess(Object.freeze({
    launchBeat: instanceBeat,
    launchAudioTime,
    phraseIndex,
    phraseBeats: pb,
    durationSeconds,
    gainLinear,
    gridRevision: transport.gridRevision,
    assetId,
    contentHash,
  }));
}
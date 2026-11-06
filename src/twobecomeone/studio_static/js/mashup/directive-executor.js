// mashup/directive-executor.js — apply a validated playback directive to mixer ports.
// Missing or throwing ports are declined. Invalid directives touch nothing.

import { validatePlaybackDirective } from './contracts.js';

const PORT_NAMES = Object.freeze({
  eq: 'setEq',
  gain: 'setGain',
  crossfader: 'setCrossfader',
  filter: 'setFilter',
  loop: 'setLoop',
  play: 'play',
  pause: 'pause',
});

function thrownError(err) {
  const message = err instanceof Error && err.message ? err.message : 'INVALID_DIRECTIVE';
  const code = message.split(':')[0] || 'INVALID_DIRECTIVE';
  return { applied: [], declined: [], error: { code, message } };
}

function callPort(op, port) {
  switch (op.op) {
    case 'eq':
      port(op.deck, op.band, op.db);
      return;
    case 'gain':
      port(op.deck, op.value);
      return;
    case 'crossfader':
      port(op.position);
      return;
    case 'filter':
      port(op.deck, op.mode, op.amount);
      return;
    case 'loop':
      port(op.deck, { bars: op.bars, enabled: op.enabled });
      return;
    case 'play':
    case 'pause':
      port(op.deck);
      return;
    default:
      throw new Error('PORT_MISSING');
  }
}

export function applyDirective(directive, ports) {
  let validated;
  try {
    validated = validatePlaybackDirective(directive);
  } catch (err) {
    return thrownError(err);
  }
  if (!validated.ok) {
    const error = validated.error || { code: 'DIRECTIVE_FAILED', message: 'Directive was not ok.' };
    return {
      applied: [],
      declined: [],
      error: { code: error.code, message: error.message },
    };
  }
  const bank = ports && typeof ports === 'object' ? ports : {};
  const applied = [];
  const declined = [];
  for (const op of validated.ops) {
    const name = PORT_NAMES[op.op];
    const port = name ? bank[name] : undefined;
    if (typeof port !== 'function') {
      declined.push({ op, code: 'PORT_MISSING' });
      continue;
    }
    try {
      callPort(op, port);
      applied.push(op);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      declined.push({ op, code: 'PORT_FAILED', message });
    }
  }
  return { applied, declined, error: null };
}

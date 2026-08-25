// js/audio.js — global audio singleton.
//
// Phase 4.5: one AudioController owns one authoritative HTMLAudioElement.
// Starting a new track stops and resets the previous source. No autoplay.
// play() promise rejections (AbortError from rapid source swaps) are caught.

class AudioController {
  constructor() {
    this._audio = new Audio();
    this._audio.preload = 'metadata';
    this._current = null; // { trackId, url }
    this._listeners = new Set();
    this._bind();
  }

  _bind() {
    this._audio.addEventListener('timeupdate', () => this._emit('time', this._audio.currentTime));
    this._audio.addEventListener('durationchange', () => this._emit('duration', this._audio.duration));
    this._audio.addEventListener('ended', () => this._emit('ended', null));
    this._audio.addEventListener('error', () => {
      this._emit('error', { message: 'Audio is unavailable' });
    });
  }

  _emit(type, payload) {
    for (const fn of this._listeners) {
      try { fn(type, payload); } catch (err) { console.error(err); }
    }
  }

  /** Subscribe to audio events. Returns an unsubscribe function. */
  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get current() {
    return this._current ? { ...this._current } : null;
  }

  get playing() {
    return !this._audio.paused && !this._audio.ended;
  }

  get time() {
    return this._audio.currentTime;
  }

  get duration() {
    return this._audio.duration || 0;
  }

  /**
   * Load and play a track. Stops and resets any previous source first.
   * @param {string} trackId
   * @param {string} url
   */
  play(trackId, url) {
    this.stop();
    this._current = { trackId, url };
    this._audio.src = url;
    this._audio.play().catch((err) => {
      if (err && err.name !== 'AbortError') {
        console.error('audio play error', err);
        this._emit('error', { message: 'Audio is unavailable' });
      }
    });
    this._emit('play', { trackId });
  }

  pause() {
    this._audio.pause();
    this._emit('pause', { trackId: this._current?.trackId ?? null });
  }

  /** Stop playback and reset the source. */
  stop() {
    this._audio.pause();
    this._audio.removeAttribute('src');
    this._audio.load();
    this._current = null;
    this._emit('stop', null);
  }

  seek(seconds) {
    if (Number.isFinite(seconds)) {
      this._audio.currentTime = Math.max(0, seconds);
    }
  }
}

// Single authoritative instance.
export const audioController = new AudioController();

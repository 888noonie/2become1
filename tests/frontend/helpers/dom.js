// tests/frontend/helpers/dom.js — jsdom setup helper for frontend unit tests.

import { JSDOM } from 'jsdom';

/**
 * Create a fresh jsdom environment and install globals needed by the modules
 * under test (document, window, EventTarget, CustomEvent, structuredClone,
 * EventSource, Audio, XMLHttpRequest, fetch).
 */
export function setupDom(html = '<!doctype html><html><body><div id="main"></div><div id="toast" hidden></div><div id="dialog-layer"></div><div id="active-badge" hidden></div><div id="now-playing" hidden><span id="now-playing-title"></span></div></body></html>') {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });

  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.EventTarget = window.EventTarget;
  globalThis.FormData = window.FormData;
  globalThis.File = window.File;
  globalThis.Blob = window.Blob;
  // structuredClone: Node provides a native global; leave it untouched.
  try {
    globalThis.navigator = window.navigator;
  } catch {
    Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  }

  // EventSource stub (jsdom lacks it).
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.onerror = null;
      this.readyState = 0;
      FakeEventSource.instances.push(this);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    close() {
      this.readyState = 2;
      this.closed = true;
    }
    // Test helper: emit an event.
    emit(type, data) {
      if (this.listeners[type]) this.listeners[type]({ data });
    }
    // Test helper: trigger error.
    error() {
      if (this.onerror) this.onerror();
    }
  }
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource;

  // Audio stub.
  class FakeAudio {
    constructor() {
      this.paused = true;
      this.ended = false;
      this.currentTime = 0;
      this.duration = 0;
      this.src = '';
      this._listeners = {};
    }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    removeEventListener(type, fn) { delete this._listeners[type]; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() { this.src = ''; }
    _emit(type) { if (this._listeners[type]) this._listeners[type](); }
  }
  globalThis.Audio = FakeAudio;

  // XMLHttpRequest stub with upload progress.
  class FakeXHR {
    constructor() {
      this.upload = {
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
      };
      this.status = 200;
      this.response = null;
      this._listeners = {};
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    addEventListener(type, fn) { this._listeners[type] = fn; }
    send() {
      // Resolve asynchronously with a 202 job.
      setTimeout(() => {
        this.status = 202;
        this.response = { id: 'job-1', status: 'queued', kind: 'import' };
        if (this._listeners.load) this._listeners.load();
      }, 0);
    }
    abort() { if (this._listeners.abort) this._listeners.abort(); }
  }
  globalThis.XMLHttpRequest = FakeXHR;

  // fetch stub (configurable per test).
  globalThis.fetch = async () => {
    throw new Error('fetch not stubbed in this test');
  };

  // Polyfill <dialog>.showModal()/close()/open (jsdom does not implement them).
  const proto = window.HTMLDialogElement?.prototype;
  if (proto && !proto.showModal) {
    proto.showModal = function () {
      this.setAttribute('open', '');
      this._returnValue = '';
    };
    proto.close = function (returnValue) {
      this.removeAttribute('open');
      this._returnValue = returnValue ?? '';
      this.dispatchEvent(new window.Event('close'));
    };
    Object.defineProperty(proto, 'open', {
      get() { return this.hasAttribute('open'); },
      configurable: true,
    });
    Object.defineProperty(proto, 'returnValue', {
      get() { return this._returnValue ?? ''; },
      set(v) { this._returnValue = v; },
      configurable: true,
    });
  }

  return dom;
}

export function teardownDom(dom) {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.Node;
  delete globalThis.HTMLElement;
  delete globalThis.CustomEvent;
  delete globalThis.EventTarget;
  delete globalThis.FormData;
  delete globalThis.File;
  delete globalThis.Blob;
  delete globalThis.navigator;
  delete globalThis.EventSource;
  delete globalThis.Audio;
  delete globalThis.XMLHttpRequest;
  delete globalThis.fetch;
}

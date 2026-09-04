'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.TSS_SCRIPT || path.resolve(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const brace = source.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      return `${source.slice(start - 6, start) === 'async ' ? 'async ' : ''}${source.slice(start, i + 1)}`;
    }
  }
  throw new Error(`unclosed ${name}`);
}

const plain = value => JSON.parse(JSON.stringify(value));
const tests = [];
const test = (name, run) => tests.push({ name, run });

function harness({ stored = {}, deniedRead = false, deniedWrite = false, gm = null, fault = null } = {}) {
  const storage = new Map(Object.entries(stored));
  const storageCalls = [];
  const timers = new Map();
  const elements = new Map();
  const contexts = [];
  const bindings = new WeakMap();
  let timerId = 0;
  let clock = 0;
  let writesDenied = deniedWrite;
  let failGm = false;
  let gmValue = gm;
  let faultUsed = false;
  const allocations = {};
  const inject = kind => {
    allocations[kind] = (allocations[kind] || 0) + 1;
    if (!faultUsed && fault?.kind === kind && allocations[kind] === fault.at) {
      faultUsed = true;
      throw new Error(`injected ${kind}`);
    }
  };
  const param = value => ({
    value,
    setValueAtTime(next) { this.value = next; },
    setTargetAtTime(next) { this.value = next; },
    cancelScheduledValues() {},
  });
  const node = (kind, context) => ({
    kind, context, connections: [], gain: param(1), frequency: param(0), Q: param(0), fftSize: 2048,
    connect(target) {
      if (kind === 'source') inject('source-connect');
      if (context.state === 'closed') throw new Error('closed graph');
      this.connections.push(target);
    },
    disconnect() { this.connections = []; },
    getFloatTimeDomainData(buffer) { buffer.fill(context.signalLevel); },
  });
  class AudioContext {
    constructor() {
      this.state = 'running'; this.currentTime = 1; this.signalLevel = 0.5;
      this.destination = node('destination', this);
      contexts.push(this);
    }
    createGain() { inject('gain'); return node('gain', this); }
    createWaveShaper() { inject('clipper'); return node('clipper', this); }
    createBiquadFilter() { inject('filter'); return node('filter', this); }
    createAnalyser() { inject('analyser'); return node('analyser', this); }
    createMediaElementSource(audio) {
      if (bindings.has(audio)) throw new DOMException('Already bound', 'InvalidStateError');
      inject('binding');
      const result = node('source', this);
      bindings.set(audio, result);
      return result;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const makeElement = tag => {
    const element = {
      tagName: tag.toUpperCase(), dataset: {}, style: { setProperty() {} }, children: [],
      src: '', currentSrc: '', currentTime: 0, duration: 240, readyState: 2,
      paused: true, ended: false, volume: 0.1, textContent: '', value: '',
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
      remove() { this.removed = true; elements.delete(this.id); },
      querySelector(selector) {
        if (!this.queries) this.queries = new Map();
        if (!this.queries.has(selector)) this.queries.set(selector, makeElement('div'));
        return this.queries.get(selector);
      },
      querySelectorAll() { return []; },
      setAttribute() {}, addEventListener() {}, removeEventListener() {},
      removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } },
      load() { this.currentSrc = this.src; },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
      focus() {}, select() {},
    };
    return element;
  };
  const body = makeElement('body');
  const document = {
    body, documentElement: makeElement('html'), visibilityState: 'visible',
    createElement: makeElement,
    getElementById: id => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  };
  const listeners = {};
  const sandbox = vm.createContext({
    window: { AudioContext, addEventListener(name, fn) { listeners[name] = fn; } },
    document, AbortController, DOMException, URL, Float32Array, console: { info() {} },
    location: { href: 'https://soundcloud.com/list?secret=hidden' },
    navigator: { clipboard: { writeText: async text => { sandbox.copiedReport = text; } } },
    localStorage: {
      getItem(key) {
        storageCalls.push({ operation: 'get', key });
        if (deniedRead) throw new Error('SecurityError');
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storageCalls.push({ operation: 'set', key });
        if (writesDenied) throw new Error('QuotaExceededError');
        storage.set(key, String(value));
      },
      removeItem(key) {
        storageCalls.push({ operation: 'remove', key });
        if (writesDenied) throw new Error('SecurityError');
        storage.delete(key);
      },
    },
    GM_getValue: () => gmValue,
    GM_setValue(key, value) { if (failGm) throw new Error('GM unavailable'); gmValue = plain(value); },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Date: class extends Date { static now() { return clock; } },
    performance: { now: () => clock },
    EQ_BANDS: [60, 230, 910, 3600, 14000].map(frequency => ({ type: 'peaking', frequency, q: 1 })),
    trackId: meta => meta?.id || '', normalizeTrackUrl: value => value || '',
    syncCrossfadeVolume() {}, syncPlaybackVolumeControls() {}, setSoundCloudVolume() {},
    currentDeckAudio: () => sandbox.state?._decks[sandbox.state._deckIndex] || null,
    checkSleepTimerDeadline() {}, paused: () => false,
    SVG: { close: '' }, esc: value => String(value),
  });
  const start = source.indexOf('const pageWindow =');
  const end = source.indexOf('\n};', source.indexOf('const state =', start)) + 3;
  sandbox.state = vm.runInContext(`${source.slice(start, end)}\nstate;`, sandbox);
  const load = names => vm.runInContext(names.map(extractFunction).join('\n'), sandbox);
  const graphFunctions = ['ensureCrossfadeDecks', 'retireAudioGraph', 'ensureAutoLevelAudioGraph', 'syncDeckProcessingRouting',
    'syncSafetyClipper', 'resumeAudioGraph', 'suspendAudioGraph', 'syncEqualizer', 'autoLevelTrackKey',
    'applyCachedAutoLevel', 'calculateAutoLevelGain', 'processAutoLevel', 'saveAutoLevelCacheSoon', 'setAudioParamImmediately'];
  load(graphFunctions);
  return {
    sandbox, state: sandbox.state, storage, storageCalls, timers, contexts, bindings, elements, listeners, load,
    advance(ms) { clock += ms; },
    allowWrites() { writesDenied = false; },
    failGm(value) { failGm = value; },
    gm: () => gmValue,
    execute(code) { return vm.runInContext(code, sandbox); },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
    },
  };
}

function reaches(sourceNode, target, seen = new Set()) {
  if (sourceNode === target) return true;
  if (!sourceNode || seen.has(sourceNode)) return false;
  seen.add(sourceNode);
  return sourceNode.connections.some(next => reaches(next, target, seen));
}

test('denied storage initializes defaults and volume/Auto controls still change audible routing', () => {
  const h = harness({ deniedRead: true, deniedWrite: true });
  assert.equal(h.state.playbackVolume, 0.1);
  assert.equal(h.execute("safeStorage.getItem('denied')"), null);
  h.load(['setPlaybackVolume', 'setAutoLevelEnabled']);
  h.state._decks = h.sandbox.ensureCrossfadeDecks();
  h.state._deckGains = [1, 0];
  assert.equal(h.sandbox.setAutoLevelEnabled(true), true);
  const graph = h.state._deckAudioGraphs[0];
  assert.equal(reaches(graph.source, graph.analyser), true);
  h.load(['syncCrossfadeVolume']);
  h.sandbox.scheduledCrossfadeGain = () => null;
  h.sandbox.setPlaybackVolume(0.37);
  assert.equal(h.state._audioMaster.gain.value, 0.37);
  assert.equal(h.sandbox.setAutoLevelEnabled(false), true);
  assert.equal(reaches(graph.source, graph.analyser), false);
  assert.equal(reaches(graph.source, h.state._audioContext.destination), true);
  h.state.safetyClipper = true;
  h.sandbox.syncSafetyClipper();
  assert.equal(reaches(graph.source, h.state._audioClipper), true);
});

test('allocation failure on the second deck preserves native output before any binding', () => {
  const h = harness({ fault: { kind: 'analyser', at: 2 } });
  const decks = h.sandbox.ensureCrossfadeDecks();
  decks[0].src = decks[0].currentSrc = 'playing-stream';
  decks[0].paused = false;
  assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), false);
  assert.equal(h.state._decks[0], decks[0]);
  assert.equal(decks[0].paused, false);
  assert.equal(h.bindings.has(decks[0]), false);
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), true);
  assert.equal(reaches(h.state._deckAudioGraphs[0].source, h.state._audioContext.destination), true);
});

for (const fault of [{ kind: 'source-connect', at: 1 }, { kind: 'binding', at: 2 }]) {
  test(`post-binding ${fault.kind} failure retires poisoned elements and recovers without rebinding`, () => {
    const h = harness({ fault });
    const old = h.sandbox.ensureCrossfadeDecks().slice();
    assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), false);
    assert.equal(old.every(audio => audio.removed), true);
    assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), true);
    const fresh = h.state._decks;
    assert.equal(fresh.some(audio => old.includes(audio)), false);
    for (const graph of h.state._deckAudioGraphs) {
      assert.equal(reaches(graph.source, h.state._audioContext.destination), true);
    }
    assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), true);
    assert.equal(h.state._decks, fresh);
  });
}

test('closed context invalidates old scheduled work and rebuilds context and bound decks together', () => {
  const h = harness();
  assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), true);
  const context = h.state._audioContext;
  const decks = h.state._decks.slice();
  let resolved;
  h.state._crossfadeSchedule = { resolve(value) { resolved = value; } };
  h.state._deckPrepareTokens = [4, 8];
  context.close();
  assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), true);
  assert.equal(resolved, false);
  assert.notEqual(h.state._audioContext, context);
  assert.equal(h.state._decks.some(audio => decks.includes(audio)), false);
  assert.deepEqual(plain(h.state._deckPrepareTokens), [5, 9]);
  for (const graph of h.state._deckAudioGraphs) assert.equal(reaches(graph.source, h.state._audioContext.destination), true);
});

test('hung resume and suspend return failure by deadline and do not poison future graph rebuilds', async () => {
  for (const operation of ['resume', 'suspend']) {
    const h = harness();
    h.sandbox.ensureAutoLevelAudioGraph();
    const old = h.state._audioContext;
    old.state = operation === 'resume' ? 'suspended' : 'running';
    old[operation] = () => new Promise(() => {});
    const pending = h.sandbox[`${operation}AudioGraph`]();
    h.runTimers(5000);
    assert.equal(await pending, false);
    assert.equal(h.sandbox.ensureAutoLevelAudioGraph(), true);
    assert.notEqual(h.state._audioContext, old);
  }
});

test('cancelled and user-paused resume never acknowledges playback readiness', async () => {
  const h = harness();
  h.sandbox.ensureAutoLevelAudioGraph();
  h.state._audioContext.state = 'suspended';
  h.state._audioContext.resume = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = h.sandbox.resumeAudioGraph(controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(h.timers.size, 0);
  h.state._userPaused = true;
  h.state._audioContext.state = 'running';
  assert.equal(await h.sandbox.resumeAudioGraph(), false);
});

test('clipper-only saved settings build processing before preparation, while all-off stays native', async () => {
  for (const enabled of [false, true]) {
    const h = harness({ stored: { tss_safety_clipper: String(enabled) } });
    h.state.active = true;
    h.state.meta = [{ id: 'full-track', link: '/artist/track' }];
    h.sandbox.resolveCrossfadeStreams = async () => ['https://media.example/stream'];
    h.sandbox.waitForDeck = async () => true;
    h.sandbox.deckIsPreviewLimited = () => false;
    h.sandbox.resetDeck = (audio, index) => {
      audio.pause();
      audio.removeAttribute('src');
      h.state._deckTracks[index] = null;
      h.state._deckGains[index] = 0;
    };
    h.sandbox.recordPlaybackDiagnostic = (event, detail) => { throw new Error(`${event}: ${JSON.stringify(detail)}`); };
    h.load(['prepareCrossfadeDeck']);
    const deck = await h.sandbox.prepareCrossfadeDeck(0, 0);
    assert.equal(deck.src, 'https://media.example/stream');
    if (enabled) {
      const graph = h.state._deckAudioGraphs[0];
      assert.equal(reaches(graph.source, h.state._audioClipper), true);
      assert.equal(reaches(graph.source, h.state._audioContext.destination), true);
    } else {
      assert.equal(h.state._audioContext, null);
      assert.equal(h.bindings.has(deck), false);
    }
  }
});

test('EQ changes relearn post-EQ loudness and replay selects only the matching measurement', () => {
  const h = harness();
  Object.assign(h.state, { autoLevel: true, eqEnabled: true, eqBands: [12, 0, 0, 0, 0], playbackVolume: 0.4, meta: [{ id: 'track' }] });
  h.sandbox.ensureAutoLevelAudioGraph();
  h.state._deckTracks[0] = 0; h.state._deckGains[0] = 1;
  const audio = h.state._decks[0];
  audio.currentSrc = 'stream'; audio.paused = false;
  h.sandbox.applyCachedAutoLevel(0, 0);
  const sample = () => { for (let i = 0; i < 12; i++) { h.advance(80); h.sandbox.processAutoLevel(); } };
  sample();
  const graph = h.state._deckAudioGraphs[0];
  const boostedGain = graph.currentGain;
  assert.ok(boostedGain < 0.5);
  h.state.eqEnabled = false;
  h.sandbox.syncEqualizer();
  assert.equal(graph.settled, false);
  h.state._audioContext.signalLevel = 0.15;
  sample();
  assert.ok(graph.currentGain > boostedGain * 2);
  const flatGain = graph.currentGain;
  h.state.eqEnabled = true;
  h.sandbox.applyCachedAutoLevel(0, 0);
  assert.equal(graph.currentGain, boostedGain);
  h.state.eqEnabled = false;
  h.sandbox.applyCachedAutoLevel(0, 0);
  assert.equal(graph.currentGain, flatGain);
});

test('malformed lifetime records normalize and failed writes retain deltas for retry', () => {
  for (const value of [null, [], 'bad', { played: '9', elapsed: 1e309, playCounts: { 0: '3', 1: -1, 2: 2 } }]) {
    const h = harness({ stored: { tss_lifetime: JSON.stringify(value) }, deniedWrite: true });
    h.execute("const LIFETIME_KEY = 'tss_lifetime';");
    h.load(['sanitizeLifetimeStats', 'loadLifetimeStats', 'saveLifetimeStats']);
    assert.equal(h.sandbox.loadLifetimeStats().played, 0);
    assert.equal(h.sandbox.loadLifetimeStats().elapsed, 0);
    h.state.stats = { played: 2, elapsed: 12, playCounts: { 0: 2 } };
    assert.equal(h.sandbox.saveLifetimeStats(), false);
    assert.equal(h.state._lifetimeBase, null);
    h.allowWrites();
    assert.equal(h.sandbox.saveLifetimeStats(), true);
    assert.equal(h.sandbox.saveLifetimeStats(), true);
    const saved = JSON.parse(h.storage.get('tss_lifetime'));
    assert.equal(saved.played, 2); assert.equal(saved.elapsed, 12); assert.equal(saved.playCounts[0], 2);
  }
});

test('malformed lifetime storage cannot strand the stats popup or its reset and close controls', () => {
  const h = harness({ stored: { tss_lifetime: 'null' } });
  h.execute("const LIFETIME_KEY = 'tss_lifetime';");
  h.load(['sanitizeLifetimeStats', 'loadLifetimeStats', 'showStats', 'renderStats', 'fmtTime']);
  h.sandbox.closeEqualizer = () => {};
  for (const id of ['tss-stats-close', 'tss-stats-reset', 'tss-stats-header']) {
    const element = h.sandbox.document.createElement('div');
    element.id = id;
    h.sandbox.document.body.appendChild(element);
  }
  h.state.stats = { played: 2, elapsed: 9, playCounts: { 0: 2 } };
  h.sandbox.showStats();
  const overlay = h.elements.get('tss-stats-overlay');
  assert.equal(overlay.querySelector('#tss-stats-lifetime').textContent, '2 tracks / 9s');
  h.elements.get('tss-stats-reset').onclick();
  assert.deepEqual(plain(h.state.stats), { played: 0, elapsed: 0, playCounts: {} });
  assert.equal(h.storage.has('tss_lifetime'), false);
  assert.equal(overlay.querySelector('#tss-stats-lifetime').textContent, '0 tracks / 0s');
  h.elements.get('tss-stats-close').onclick();
  assert.equal(h.elements.has('tss-stats-overlay'), false);
});

test('pagehide flush includes elapsed listening delta and repeated exit cannot double count', () => {
  const h = harness();
  h.execute("const LIFETIME_KEY = 'tss_lifetime'; let equalizerPersistTimer = null; let customPresetsPending = false;");
  h.load(['sanitizeLifetimeStats', 'loadLifetimeStats', 'saveLifetimeStats', 'tickPlayTime']);
  h.sandbox.flushEqualizerPersistence = () => {};
  const hookStart = source.lastIndexOf("window.addEventListener('pagehide', () => {");
  const hookEnd = source.indexOf('\n});', hookStart) + 4;
  h.execute(source.slice(hookStart, hookEnd));
  h.state.active = true;
  h.state.stats = { played: 3, elapsed: 0, playCounts: { 0: 3 } };
  h.sandbox.tickPlayTime();
  h.advance(5250);
  h.listeners.pagehide();
  h.listeners.pagehide();
  h.sandbox.saveLifetimeStats();
  const next = harness({ stored: Object.fromEntries(h.storage) });
  next.execute("const LIFETIME_KEY = 'tss_lifetime';");
  next.load(['sanitizeLifetimeStats', 'loadLifetimeStats']);
  assert.deepEqual(plain(next.sandbox.loadLifetimeStats()), { played: 3, elapsed: 5, playCounts: { 0: 3 } });
});

test('legacy diagnostic records are purged without loading or rewriting them', async () => {
  const legacy = { at: '2026-01-01T00:00:00.000Z', event: 'recovery-failed', details: 'previous page fault' };
  const h = harness({ stored: { tss_playback_diagnostics: JSON.stringify([null, [], false, legacy]) } });
  h.load(['safeMediaUrl', 'playbackDiagnosticSnapshot', 'showPlaybackDiagnostics',
    'showPlaybackReportHelp', 'recordPlaybackDiagnostic', 'updatePlaybackDiagnosticButton']);
  assert.equal(h.storage.has('tss_playback_diagnostics'), false);
  assert.deepEqual(plain(h.sandbox.playbackDiagnosticSnapshot().diagnostics), []);
  h.sandbox.showPlaybackDiagnostics();
  const overlay = h.elements.get('tss-debug-overlay');
  await overlay.querySelector('#tss-debug-copy').onclick({ currentTarget: overlay.querySelector('#tss-debug-copy') });
  assert.deepEqual(JSON.parse(h.sandbox.copiedReport).diagnostics, []);
  overlay.querySelector('#tss-debug-close').onclick();

  h.sandbox.recordPlaybackDiagnostic('recovery-failed', { reason: 'new page fault' });
  const current = h.sandbox.playbackDiagnosticSnapshot().diagnostics;
  assert.deepEqual(plain(current.map(entry => ({ event: entry.event, reason: entry.reason }))),
    [{ event: 'recovery-failed', reason: 'new page fault' }]);
  assert.equal(h.storage.has('tss_playback_diagnostics'), false);
  assert.equal(h.storageCalls.some(call => call.key === 'tss_playback_diagnostics' && call.operation !== 'remove'), false);
});

test('Copy report survives dispatch cleanup while clipboard access settles or rejects', async () => {
  const h = harness();
  h.load(['safeMediaUrl', 'playbackDiagnosticSnapshot', 'showPlaybackDiagnostics',
    'showPlaybackReportHelp', 'updatePlaybackDiagnosticButton']);
  h.sandbox.showPlaybackDiagnostics();
  const overlay = h.elements.get('tss-debug-overlay');
  const report = overlay.querySelector('#tss-debug-report').textContent;
  const button = overlay.querySelector('#tss-debug-copy');
  for (const rejected of [false, true]) {
    let settle;
    let submitted;
    h.sandbox.navigator.clipboard.writeText = text => {
      submitted = text;
      return new Promise((resolve, reject) => {
        settle = () => rejected ? reject(new DOMException('Clipboard denied', 'NotAllowedError')) : resolve();
      });
    };
    const event = { currentTarget: button };
    const pending = button.onclick(event);
    event.currentTarget = null; // Real DOM clears currentTarget when synchronous dispatch finishes.
    settle();
    await pending;
    assert.deepEqual(JSON.parse(submitted), JSON.parse(report));
    assert.equal(h.elements.get('tss-debug-overlay'), overlay, 'the report remains available after either clipboard outcome');
    assert.equal(overlay.querySelector('#tss-debug-report').textContent, report);
  }
});

test('only current page faults expose a report, with Clear allowing a later genuine fault', () => {
  const mount = stored => {
    const h = harness({ stored });
    h.load(['recordPlaybackDiagnostic', 'updatePlaybackDiagnosticButton', 'safeMediaUrl',
      'playbackDiagnosticSnapshot', 'showPlaybackDiagnostics', 'showPlaybackReportHelp']);
    const button = h.sandbox.document.createElement('button');
    button.id = 'tss-playback-debug';
    button.onclick = h.sandbox.showPlaybackDiagnostics;
    h.sandbox.document.body.appendChild(button);
    h.sandbox.updatePlaybackDiagnosticButton();
    return { h, button };
  };
  const { h, button } = mount({
    tss_playback_diagnostics: JSON.stringify([{ at: '2026-01-01T00:00:00.000Z', event: 'recovery-failed' }]),
  });
  assert.equal(button.hidden, true);
  assert.equal(button.dataset.status, 'none');

  h.sandbox.recordPlaybackDiagnostic('custom-start-retry', { attempt: 1 });
  assert.equal(button.hidden, true, 'a recoverable retry does not mark playback as failed');
  assert.equal(button.dataset.status, 'none');
  h.sandbox.recordPlaybackDiagnostic('custom-start-exhausted', { attempted: 3 });
  assert.equal(button.hidden, false);
  assert.equal(button.dataset.status, 'current');
  button.onclick();
  const overlay = h.elements.get('tss-debug-overlay');
  const report = JSON.parse(overlay.querySelector('#tss-debug-report').textContent);
  assert.deepEqual(report.diagnostics.map(entry => entry.event), ['custom-start-retry', 'custom-start-exhausted']);
  assert.equal(report.diagnostics.at(-1).attempted, 3);
  assert.equal(h.storage.has('tss_playback_diagnostics'), false);
  assert.equal(h.storageCalls.some(call => call.key === 'tss_playback_diagnostics' && call.operation === 'set'), false);

  const reloaded = mount(Object.fromEntries(h.storage));
  assert.equal(reloaded.button.hidden, true, 'reloading never restores a previous page warning');
  assert.equal(reloaded.button.dataset.status, 'none');
  reloaded.h.sandbox.showPlaybackDiagnostics();
  const freshReport = JSON.parse(reloaded.h.elements.get('tss-debug-overlay').querySelector('#tss-debug-report').textContent);
  assert.deepEqual(freshReport.diagnostics, []);

  overlay.querySelector('#tss-debug-clear').onclick();
  assert.equal(h.elements.has('tss-debug-overlay'), false);
  assert.deepEqual(plain(h.sandbox.playbackDiagnosticSnapshot().diagnostics), []);
  assert.equal(button.hidden, true);
  assert.equal(button.dataset.status, 'none');
  h.sandbox.recordPlaybackDiagnostic('custom-start-retry', { attempt: 1 });
  assert.equal(button.hidden, true, 'Clear does not turn a subsequent retry into a fault');
  h.sandbox.recordPlaybackDiagnostic('recovery-failed', { reason: 'media-error' });
  assert.equal(button.hidden, false);
  assert.equal(button.dataset.status, 'current');
  button.onclick();
  const nextReport = JSON.parse(h.elements.get('tss-debug-overlay').querySelector('#tss-debug-report').textContent);
  assert.deepEqual(nextReport.diagnostics.map(entry => entry.event), ['custom-start-retry', 'recovery-failed']);
  assert.equal(nextReport.diagnostics.at(-1).reason, 'media-error');
  assert.equal(h.storageCalls.some(call => call.key === 'tss_playback_diagnostics' && call.operation === 'set'), false);
});

test('frozen crossfade worker resolves despite invalid current diagnostic entries', () => {
  const h = harness();
  h.load(['safeMediaUrl', 'playbackDiagnosticSnapshot', 'recordPlaybackDiagnostic', 'updatePlaybackDiagnosticButton', 'settleScheduledCrossfade']);
  h.sandbox.ensureAutoLevelAudioGraph();
  h.state.active = true;
  h.state._decks[1].paused = false;
  h.state._decks[1].currentSrc = 'https://media.example/track?secret=hidden';
  h.state._playbackDiagnostics.push(null);
  let resolved;
  h.state._crossfadeSchedule = {
    incomingIndex: 1, endTime: 13, createdAt: 0, lastClockValue: 1,
    lastClockAdvanceAt: 0, lastIncomingTime: 0, lastIncomingAdvanceAt: 0,
    resolve(value) { resolved = value; },
  };
  h.advance(3000);
  h.sandbox.settleScheduledCrossfade();
  assert.equal(resolved, false);
  const report = h.sandbox.playbackDiagnosticSnapshot();
  assert.equal(report.diagnostics.at(-1).event, 'crossfade-clock-stall');
  assert.equal(report.decks[1].source, 'https://media.example/track');
});

test('invalid Auto Level cache entries cannot suppress learning and loaded cache is bounded', () => {
  const entries = Object.fromEntries(Array.from({ length: 305 }, (_, index) =>
    [`track-${index}`, { rms: 0.2, peak: 0.4, ts: index }]
  ));
  entries.invalid = { rms: '0.3', peak: 0.4, ts: 1000 };
  entries.impossible = { rms: 0.8, peak: 0.2, ts: 1000 };
  entries.empty = null;
  const h = harness({ stored: { tss_auto_level_cache_v4: JSON.stringify(entries) } });
  assert.equal(Object.keys(h.state._autoLevelCache).length, 300);
  assert.equal(h.state._autoLevelCache.invalid, undefined);
  assert.equal(h.state._autoLevelCache.impossible, undefined);
  assert.equal(h.state._autoLevelCache['track-0'], undefined);
  assert.deepEqual(plain(h.state._autoLevelCache['track-304']), entries['track-304']);
});

test('failed authoritative preset writes remain visibly unsaved until retry, including deletion', () => {
  for (const next of [{ B: [1, 2, 3, 4, 5] }, {}]) {
    const h = harness({ gm: { A: [0, 0, 0, 0, 0] } });
    h.execute('let equalizerPersistTimer = null; let customPresetsPending = false;');
    h.load(['flushEqualizerPersistence', 'persistEqualizer', 'updateEqualizerPersistenceStatus']);
    const overlay = h.sandbox.document.createElement('div');
    overlay.id = 'tss-eq-overlay'; h.sandbox.document.body.appendChild(overlay);
    h.state.customEqPresets = next;
    h.failGm(true);
    assert.equal(h.sandbox.persistEqualizer({ customPresets: true, immediate: true }), false);
    assert.equal(h.execute('customPresetsPending'), true);
    assert.equal(h.state._equalizerSaveFailed, true);
    assert.equal(overlay.querySelector('#tss-eq-save-row').dataset.open, 'true');
    assert.ok(overlay.querySelector('#tss-eq-save-error').textContent.length > 0);
    assert.deepEqual(h.gm(), { A: [0, 0, 0, 0, 0] });
    h.failGm(false);
    assert.equal(h.sandbox.flushEqualizerPersistence(), true);
    assert.equal(h.execute('customPresetsPending'), false);
    assert.equal(overlay.querySelector('#tss-eq-save-error').textContent, '');
    const reloaded = harness({ gm: h.gm(), stored: { tss_eq_custom_presets: JSON.stringify({ Stale: [0, 0, 0, 0, 0] }) } });
    assert.deepEqual(plain(reloaded.state.customEqPresets), next);
  }
});

(async () => {
  for (const { name, run } of tests) {
    let timeout;
    try {
      await Promise.race([
        Promise.resolve().then(run),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    console.log(`ok - ${name}`);
  }
  console.log('\nAll audio persistence tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

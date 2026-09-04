'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(process.env.TSS_SCRIPT || path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');
const icons = vm.runInNewContext(`${source.match(/const SVG = \{[\s\S]*?\n\};/)[0]}\nSVG;`);
function extractFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const start = match.index;
  const brace = source.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) {
    event.target ||= this;
    event.currentTarget = this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => {};
    event.stopImmediatePropagation ||= () => {};
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    this[`on${type}`]?.(event);
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((n, listeners) => n + listeners.size, 0); }
}

class Element extends Target {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.className = '';
    this.text = '';
    this.disabled = false;
    this.hidden = false;
    this.paused = true;
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  }
  get isConnected() { return this === this.ownerDocument.body || this === this.ownerDocument.head || Boolean(this.parentNode?.isConnected); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
    if (name === 'disabled') this.disabled = false;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
    this.parentNode = null;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 400, width: 400, height: 500 }; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
  set innerHTML(html) {
    this.textContent = '';
    const stack = [this];
    for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1).text += token; continue; }
      const tag = /^<([\w-]+)/.exec(token)?.[1];
      if (!tag) continue;
      const child = this.ownerDocument.createElement(tag);
      const attributes = token.slice(tag.length + 1, -1);
      for (const match of attributes.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
        child.setAttribute(match[1], match[2] ?? match[3] ?? '');
      }
      stack.at(-1).appendChild(child);
      if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag) && !token.endsWith('/>')) stack.push(child);
    }
  }
  matches(selector) {
    const attribute = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(selector);
    if (attribute && (this.getAttribute(attribute[1]) === null || (attribute[2] !== undefined && this.getAttribute(attribute[1]) !== attribute[2]))) return false;
    const simple = selector.replace(/\[[^\]]+\]/g, '');
    if (simple.startsWith('#')) return this.id === simple.slice(1);
    if (simple.startsWith('.')) return this.className.split(' ').includes(simple.slice(1));
    return !simple || this.tagName.toLowerCase() === simple;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/);
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(parts.at(-1)) && (parts.length === 1 || child.parentNode?.closest(parts.slice(0, -1).join(' ')))) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.emit('click'); }
  play() { this.paused = false; this.emit('play'); return Promise.resolve(); }
  pause() { this.paused = true; this.emit('pause'); }
}

class Document extends Target {
  constructor() {
    super();
    this.title = 'Native SoundCloud';
    this.head = new Element('head', this);
    this.body = new Element('body', this);
    this.documentElement = new Element('html', this);
    this.activeElement = this.body;
  }
  createElement(tag) {
    const element = new Element(tag, this);
    if (tag === 'iframe') {
      element.contentWindow = makeWindow();
      element.contentDocument = element.contentWindow.document;
    }
    return element;
  }
  getElementById(id) { return this.querySelector(`#${id}`); }
  querySelectorAll(selector) { return [...this.head.querySelectorAll(selector), ...this.body.querySelectorAll(selector)]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function makeWindow() {
  const window = new Target();
  window.document = new Document();
  window.closed = false;
  window.close = () => { window.closed = true; window.emit('pagehide'); };
  window.focus = () => {};
  return window;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function harness(extra = {}) {
  const document = new Document();
  const timers = new Map();
  const intervals = new Map();
  let serial = 0;
  const state = {
    active: true, loading: false, busy: true, pos: 0, queue: [0, 1, 2, 3], playNext: [], priority: {},
    meta: ['A', 'B', 'C', 'D'].map(title => ({ title, artist: 'Artist' })), stats: {},
    _deckTrack: 0, _nativeTrack: null, _playbackEpoch: 1, _playbackAbort: new AbortController(),
    _pipOpenTransaction: null, _ownPipWindow: null, _ownPipMode: null, _ownPipHost: null, _videoPip: null,
    _tabTitleBeforePlayback: null, _tabTitleValue: '', _browserMetadataKey: '', crossfadeSeconds: 0,
    crossfadeStatus: 'off', safetyClipper: true, _decks: [], history: [], pipArtworkMode: 'compact',
  };
  const noOp = () => {};
  const context = {
    state, document, pageWindow: { document, navigator: {} }, window: { innerWidth: 1200, innerHeight: 800 },
    location: { href: 'https://soundcloud.com/a/sets/b' }, navigator: {},
    console: { warn: noOp, log: noOp }, AbortController, DOMException, queueMicrotask,
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++serial; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    safeStorage: { getItem: () => null, setItem: () => true },
    requestAnimationFrame: noOp, DEFAULT_WAVE_HEIGHTS: [], waveformRequest: 0, SVG: icons, paused: () => false,
    esc: value => String(value), currentDeckAudio: () => null,
    isCollectionPage: () => false, playerTitle: () => '', playbackTiming: () => ({ current: 0, duration: 0 }),
    upcomingTrackIndex: () => undefined, formatPlaybackClock: () => '0:00', trackId: () => '',
    ...Object.fromEntries([
      'toggle', 'prevTrack', 'next', 'showStats', 'showEqualizer', 'reshuffleCurrentPage', 'seekTo',
      'toggleSidebar', 'setSleepTimer', 'showPlaybackDiagnostics', 'updatePlaybackDiagnosticButton',
      'setCrossfadeSeconds', 'syncCrossfadeControls', 'setPlaybackVolume', 'setAutoLevelEnabled',
      'syncPlaybackVolumeControls', 'syncEqualizer', 'initializePlaybackVolume', 'syncSidebarToHub',
      'setCrossfadeStatus', 'updateProgressBar', 'renderWaveform', 'loadTrackWaveform', 'pauseSoundCloudTransport',
      'pauseSoundCloud', 'stopCrossfadeDecks', 'resetLiveQueueSync', 'saveLifetimeStats', 'recordPlaybackDiagnostic',
      'resetPlaybackTimeBaseline', 'flushPlaybackTime', 'accruePlaybackTime', 'showMergeToast', 'pause',
      'drawVideoPipFrame', 'setOwnPipArtworkMode', 'syncOwnPipWindow', 'renderOwnPipQueue',
      'showOwnPipSoundMenu', 'toggleOwnPipTrackLike', 'setOwnPipArtworkMode', 'refreshUpcomingCrossfadePreparation',
      'badges', 'renderList', 'queueNext', 'jumpTo', 'removeTrackFromUpcoming',
    ].map(name => [name, noOp])),
    ensureAutoLevelAudioGraph: () => { throw new Error('Stop must not initialize the graph'); },
    start: () => { throw new Error('Stop must not start another queue'); },
    isTrueShuffleAudio: () => false,
    ...extra,
  };
  const sandbox = vm.createContext(context);
  function load(...names) { vm.runInContext(names.map(extractFunction).join('\n'), sandbox); }
  const runTimers = delay => {
    for (const [id, timer] of [...timers]) if (timer.delay <= delay) { timers.delete(id); timer.fn(); }
  };
  return { context: sandbox, state, document, timers, intervals, load, runTimers };
}

const pipFunctions = [
  'withDeadline', 'pipTransactionIsCurrent', 'exitOwnedVideoPip', 'ownPipIsOpen', 'setOwnPipButtonState',
  'closeOwnPip', 'documentPipApi', 'standardVideoPipSupported', 'openVideoPipFallback',
  'openInPagePipFallback', 'openOwnPip', 'mountOwnPipWindow', 'ownPipDimensions',
];

for (const loading of [false, true]) {
  test(`mounted ${loading ? 'Cancel' : 'Stop'} releases busy state while keeping native playback blocked`, () => {
    const h = harness();
    h.state.loading = loading;
    h.state.active = !loading;
    h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying', 'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub', 'nativePlaybackAllowed', 'installNativePlaybackGuard');
    h.context.mkHub();
    h.context.installNativePlaybackGuard();
    const nativeButton = h.document.createElement('button');
    nativeButton.className = 'playControls__play';
    assert.equal(h.document.emit('click', { target: nativeButton }).defaultPrevented, true);
    const button = h.document.getElementById('tss-hub-start');
    assert.equal(button.disabled, false);
    button.click();
    assert.equal(h.state.active, false);
    assert.equal(h.state.loading, false);
    assert.equal(h.state.busy, false);
    assert.equal(h.document.emit('click', { target: nativeButton }).defaultPrevented, true);
  });
}

function diagnosticHarness() {
  const h = harness();
  h.state._playbackDiagnostics = [];
  h.state._playbackDiagnosticFault = false;
  vm.runInContext(source.match(/const PLAYBACK_DIAGNOSTIC_FAULTS = new Set\(\[[\s\S]*?\]\);/)[0], h.context);
  h.load('updatePlaybackDiagnosticButton', 'sanitizePlaybackDiagnostics', 'recordPlaybackDiagnostic',
    'safeMediaUrl', 'playbackDiagnosticSnapshot', 'showPlaybackDiagnostics', 'showPlaybackReportHelp');
  return h;
}

test('a recorded playback fault and its report remain reachable beside PiP after Stop', () => {
  const h = diagnosticHarness();
  h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying',
    'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub');
  h.context.mkHub();
  const diagnostic = h.document.getElementById('tss-playback-debug');
  const icon = diagnostic.querySelector('svg');
  const pip = h.document.getElementById('tss-hub-pip');
  assert.ok(icon, 'the mounted control has its exclamation icon');
  assert.equal(h.document.getElementById('tss-hub-hdr').contains(diagnostic), true);
  assert.equal(diagnostic.parentNode, pip.parentNode);
  assert.equal(diagnostic.parentNode.children.indexOf(diagnostic) + 1, pip.parentNode.children.indexOf(pip));
  assert.equal(diagnostic.hidden, true);
  assert.equal(diagnostic.dataset.status, 'none');
  h.context.recordPlaybackDiagnostic('custom-start-retry', { attempt: 1 });
  assert.equal(diagnostic.hidden, true);
  assert.equal(diagnostic.querySelector('svg'), icon);
  h.context.recordPlaybackDiagnostic('custom-start-exhausted', { attempted: 3 });
  assert.equal(diagnostic.hidden, false);
  assert.equal(diagnostic.dataset.status, 'current');
  assert.equal(diagnostic.querySelector('svg'), icon);
  diagnostic.click();
  const beforeStop = JSON.parse(h.document.getElementById('tss-debug-report').textContent);
  h.document.getElementById('tss-debug-close').click();
  h.document.getElementById('tss-hub-start').click();
  assert.equal(h.state.active, false);
  assert.equal(diagnostic.hidden, false);
  assert.equal(diagnostic.dataset.status, 'current');
  assert.equal(diagnostic.isConnected, true);
  assert.equal(diagnostic.querySelector('svg'), icon, 'hub updates preserve the source SVG instead of replacing it with report text');
  for (let node = diagnostic; node; node = node.parentNode) {
    assert.notEqual(node.style.display, 'none');
    assert.equal(node.hidden, false);
  }
  diagnostic.click();
  const stoppedReport = JSON.parse(h.document.getElementById('tss-debug-report').textContent);
  assert.equal(stoppedReport.state.active, false);
  assert.deepEqual(stoppedReport.diagnostics, beforeStop.diagnostics);
  assert.equal(stoppedReport.diagnostics.at(-1).event, 'custom-start-exhausted');
  assert.equal(stoppedReport.diagnostics.at(-1).attempted, 3);
});

test('separate reporting instructions close or return without discarding the current report', () => {
  const h = diagnosticHarness();
  h.context.recordPlaybackDiagnostic('recovery-failed', { reason: 'media-error' });
  h.context.showPlaybackDiagnostics();
  const reportOverlay = h.document.getElementById('tss-debug-overlay');
  const reportDialog = reportOverlay.querySelector('.tss-debug-dialog');
  const report = h.document.getElementById('tss-debug-report').textContent;
  const helpButton = h.document.getElementById('tss-debug-help');

  for (const control of ['tss-debug-help-close', 'tss-debug-help-back']) {
    helpButton.focus();
    helpButton.click();
    const helpOverlay = h.document.getElementById('tss-debug-help-overlay');
    assert.ok(helpOverlay);
    assert.notEqual(helpOverlay, reportOverlay);
    assert.equal(reportOverlay.isConnected, true);
    assert.equal(reportDialog.getAttribute('inert'), '');
    assert.equal(reportDialog.getAttribute('aria-hidden'), 'true');
    assert.equal(h.document.getElementById('tss-debug-report').textContent, report);

    h.document.getElementById(control).click();
    assert.equal(h.document.getElementById('tss-debug-help-overlay'), null);
    assert.equal(h.document.getElementById('tss-debug-overlay'), reportOverlay);
    assert.equal(reportDialog.getAttribute('inert'), null);
    assert.equal(reportDialog.getAttribute('aria-hidden'), null);
    assert.equal(h.document.activeElement, helpButton);
    assert.equal(h.document.getElementById('tss-debug-report').textContent, report);
  }
  const diagnostics = JSON.parse(report).diagnostics;
  assert.deepEqual(diagnostics.map(entry => ({ event: entry.event, reason: entry.reason })),
    [{ event: 'recovery-failed', reason: 'media-error' }]);
});

test('deferred document PiP is disposed after stop, including after a new playback epoch starts', async () => {
  const pending = deferred();
  const h = harness();
  h.context.pageWindow.documentPictureInPicture = { requestWindow: () => pending.promise };
  h.load(...pipFunctions);
  const opening = h.context.openOwnPip();
  h.state.active = false;
  h.context.closeOwnPip();
  h.state._playbackEpoch++;
  h.state.active = true;
  const acquired = makeWindow();
  pending.resolve(acquired);
  assert.equal(await opening, false);
  await flush();
  assert.equal(acquired.closed, true);
  assert.equal(h.document.querySelectorAll('#tss-inline-pip').length, 0);
  assert.equal(h.state._ownPipWindow, null);
});

test('concurrent PiP opens share acquisition and mount one fallback with removable window listeners', async () => {
  const pending = deferred();
  let requests = 0;
  const h = harness();
  h.context.pageWindow.documentPictureInPicture = { requestWindow: () => { requests++; return pending.promise; } };
  h.load(...pipFunctions);
  const first = h.context.openOwnPip();
  const second = h.context.openOwnPip();
  pending.reject(new Error('unsupported'));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(requests, 1);
  assert.equal(h.document.querySelectorAll('#tss-inline-pip').length, 1);
  const pipWindow = h.state._ownPipWindow;
  h.context.closeOwnPip();
  assert.equal(h.document.querySelectorAll('#tss-inline-pip').length, 0);
  assert.equal(pipWindow.listenerCount(), 0);
});

test('protected returned WindowProxy closes safely and uses the supported fallback without speculative unwrapping', async () => {
  const h = harness();
  let closed = 0;
  const protectedWindow = { close: () => { closed++; }, get document() { throw new Error('Permission denied'); } };
  h.context.pageWindow.documentPictureInPicture = { requestWindow: () => Promise.resolve(protectedWindow) };
  h.load(...pipFunctions);
  assert.equal(await h.context.openOwnPip(), true);
  assert.equal(closed, 1);
  assert.equal(h.state._ownPipMode, 'inline');
  h.context.closeOwnPip();
});

test('timed-out document acquisition cannot replace its already-mounted fallback later', async () => {
  const pending = deferred();
  const h = harness();
  h.context.pageWindow.documentPictureInPicture = { requestWindow: () => pending.promise };
  h.load(...pipFunctions);
  const opening = h.context.openOwnPip();
  h.runTimers(5000);
  assert.equal(await opening, true);
  const fallback = h.state._ownPipWindow;
  const acquired = makeWindow();
  pending.resolve(acquired);
  await flush();
  assert.equal(acquired.closed, true);
  assert.equal(h.state._ownPipWindow, fallback);
  h.context.closeOwnPip();
});

function videoHarness(requestPictureInPicture) {
  const h = harness();
  let stops = 0;
  const track = { stop: () => { stops++; } };
  const createElement = h.document.createElement.bind(h.document);
  let video;
  h.document.createElement = tag => {
    const element = createElement(tag);
    if (tag === 'canvas') element.captureStream = () => ({ getTracks: () => [track] });
    if (tag === 'video') {
      video = element;
      element.requestPictureInPicture = () => requestPictureInPicture(element, h);
    }
    return element;
  };
  h.context.pageWindow.document.pictureInPictureEnabled = true;
  h.context.pageWindow.HTMLVideoElement = { prototype: { requestPictureInPicture() {} } };
  h.load(...pipFunctions);
  return { ...h, get video() { return video; }, get stops() { return stops; } };
}

test('video PiP pending at stop releases unpublished stream, listeners and late native acquisition', async () => {
  const pending = deferred();
  const h = videoHarness((video, fixture) => pending.promise.then(() => { fixture.document.pictureInPictureElement = video; }));
  let exits = 0;
  h.document.exitPictureInPicture = () => { exits++; h.document.pictureInPictureElement = null; return Promise.reject(new Error('already closing')); };
  const opening = h.context.openOwnPip();
  await flush();
  h.state.active = false;
  h.context.closeOwnPip();
  assert.equal(await opening, false);
  assert.equal(h.stops, 1);
  assert.equal(h.video.listenerCount(), 0);
  assert.equal(h.document.querySelectorAll('video').length, 0);
  pending.resolve();
  await flush();
  assert.equal(exits, 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.state._videoPip, null);
});

test('published video close handles rejected exit while releasing timer, listeners and media track', async () => {
  const h = videoHarness((video, fixture) => { fixture.document.pictureInPictureElement = video; return Promise.resolve(); });
  h.document.exitPictureInPicture = () => Promise.reject(new Error('exit rejected'));
  assert.equal(await h.context.openOwnPip(), true);
  h.context.closeOwnPip();
  await flush();
  assert.equal(h.stops, 1);
  assert.equal(h.video.listenerCount(), 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.document.querySelectorAll('video').length, 0);
});

function contextMenuHarness() {
  const h = harness();
  h.context.removeFromQueue = index => h.state.queue.splice(index, 1);
  h.load('showCtxMenu');
  const open = ti => {
    h.context.showCtxMenu({ preventDefault() {}, stopPropagation() {}, clientX: 50, clientY: 50 }, h.state.queue.indexOf(ti), ti);
    return h.document.getElementById('tss-ctx');
  };
  const click = (menu, label) => menu.children.find(child => child.textContent.includes(label)).click();
  return { ...h, open, click };
}

test('a stale sidebar menu removes its original track after playback advances, not its old index', () => {
  const h = contextMenuHarness();
  const menu = h.open(2);
  h.state.queue.shift();
  h.click(menu, 'remove');
  assert.deepEqual(h.state.queue, [1, 3]);
});

test('stale sidebar move controls use identity and recheck current-track boundaries', () => {
  const h = contextMenuHarness();
  const down = h.open(2);
  h.state.queue.shift();
  h.click(down, 'move down');
  assert.deepEqual(h.state.queue, [1, 3, 2]);
  const up = h.open(2);
  h.state.queue.shift();
  h.click(up, 'move up');
  assert.deepEqual(h.state.queue, [3, 2]);
  const removed = h.open(2);
  h.state.queue.pop();
  h.click(removed, 'remove');
  assert.deepEqual(h.state.queue, [3]);
});

test('menus from an earlier queue epoch cannot alter reused track indices and release document listeners', () => {
  const h = contextMenuHarness();
  const baseline = h.document.listenerCount();
  for (let i = 0; i < 3; i++) {
    const menu = h.open(2);
    h.runTimers(0);
    h.state._playbackEpoch++;
    h.click(menu, 'remove');
  }
  assert.deepEqual(h.state.queue, [0, 1, 2, 3]);
  assert.equal(h.document.listenerCount(), baseline);
});

test('PiP track menus dispose delayed listeners on close, replacement, actions and parent close', () => {
  const h = harness();
  h.load('showOwnPipTrackMenu', 'closeOwnPip', 'setOwnPipButtonState', 'ownPipIsOpen');
  const player = h.document.createElement('div');
  player.id = 'tss-pip-player';
  h.document.body.appendChild(player);
  const anchor = h.document.createElement('button');
  player.appendChild(anchor);
  const baseline = h.document.listenerCount();
  const open = () => { h.context.showOwnPipTrackMenu(h.document, anchor, 2, 0); return h.document.getElementById('tss-pip-track-menu'); };
  open().querySelector('.tss-pip-menu-title button').click();
  h.runTimers(0);
  assert.equal(h.document.listenerCount(), baseline);
  open();
  h.runTimers(0);
  open().querySelector('[data-action="next"]').click();
  h.runTimers(0);
  assert.equal(h.document.listenerCount(), baseline);
  open();
  h.runTimers(0);
  h.context.closeOwnPip();
  assert.equal(h.document.listenerCount(), baseline);
  assert.equal(h.document.getElementById('tss-pip-track-menu'), null);
});

test('stopping restores only owned MediaSession state and never overwrites newer native metadata', () => {
  const native = { title: 'Native before shuffle' };
  const mediaSession = { metadata: native, playbackState: 'playing' };
  const h = harness({ pageWindow: { navigator: { mediaSession }, MediaMetadata: class { constructor(data) { Object.assign(this, data); } } } });
  h.load('syncBrowserNowPlaying');
  h.context.syncBrowserNowPlaying();
  assert.equal(mediaSession.metadata.title, 'A');
  assert.equal(mediaSession.playbackState, 'playing');
  h.state.active = false;
  h.context.syncBrowserNowPlaying();
  assert.equal(mediaSession.metadata, native);
  assert.equal(mediaSession.playbackState, 'paused');
  h.state.active = true;
  h.context.syncBrowserNowPlaying();
  const newer = { title: 'New native playback' };
  mediaSession.metadata = newer;
  mediaSession.playbackState = 'playing';
  h.state.active = false;
  h.context.syncBrowserNowPlaying();
  assert.equal(mediaSession.metadata, newer);
  assert.equal(mediaSession.playbackState, 'playing');
});

test('without previous media metadata, stopping clears the custom track and its playing state', () => {
  const mediaSession = { metadata: null, playbackState: 'none' };
  const h = harness({ pageWindow: { navigator: { mediaSession }, MediaMetadata: class { constructor(data) { Object.assign(this, data); } } } });
  h.load('syncBrowserNowPlaying');
  h.context.syncBrowserNowPlaying();
  h.state.active = false;
  h.context.syncBrowserNowPlaying();
  assert.equal(mediaSession.metadata, null);
  assert.equal(mediaSession.playbackState, 'none');
});

test('bridge descriptor failure is atomic across retries and successful installation remains idempotent', () => {
  let nativeCalls = 0;
  const original = () => { nativeCalls++; return 'native'; };
  const player = { getCurrentSound: original };
  Object.defineProperty(player, 'getCurrentQueueItem', { value: () => null, writable: false, configurable: true });
  const h = harness({ pageWindow: { scPlayer: player }, betterFeedPipActive: () => false });
  h.load('installBetterFeedPipBridge');
  for (let i = 0; i < 20; i++) assert.equal(h.context.installBetterFeedPipBridge(), false);
  assert.equal(player.getCurrentSound, original);
  assert.equal(player.getCurrentSound(), 'native');
  Object.defineProperty(player, 'getCurrentQueueItem', { writable: true });
  assert.equal(h.context.installBetterFeedPipBridge(), true);
  const installed = player.getCurrentSound;
  assert.equal(h.context.installBetterFeedPipBridge(), true);
  assert.equal(player.getCurrentSound, installed);
  assert.equal(player.getCurrentSound(), 'native');
  assert.equal(nativeCalls, 2);
});

test('bridge rolls back earlier writable methods when a later definition fails', () => {
  const original = () => 'native';
  const target = { getCurrentSound: original };
  const player = new Proxy(target, {
    defineProperty(object, name, descriptor) {
      if (name === 'isPlaying') throw new Error('definition denied');
      return Reflect.defineProperty(object, name, descriptor);
    },
  });
  const h = harness({ pageWindow: { scPlayer: player }, betterFeedPipActive: () => false });
  h.load('installBetterFeedPipBridge');
  assert.equal(h.context.installBetterFeedPipBridge(), false);
  assert.equal(player.getCurrentSound, original);
  assert.equal(player.getCurrentSound(), 'native');
  assert.equal(Object.hasOwn(target, 'getCurrentQueueItem'), false);
});

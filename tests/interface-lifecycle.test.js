'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(process.env.TSS_SCRIPT || path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');
const compactReports = source.includes('function compactPlaybackReport(');
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
function dialogSnapshot(document) {
  if (compactReports) {
    const details = document.getElementById('tss-debug-details');
    details.open = true;
    details.emit('toggle');
    return JSON.parse(document.getElementById('tss-debug-full-report').textContent);
  }
  return JSON.parse(document.getElementById('tss-debug-report').textContent);
}

class Target {
  constructor() { this.listeners = new Map(); this.captureListeners = new Map(); }
  addEventListener(type, fn, options = false) {
    const listeners = (options === true || options.capture) ? this.captureListeners : this.listeners;
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  }
  removeEventListener(type, fn, options = false) {
    const listeners = (options === true || options.capture) ? this.captureListeners : this.listeners;
    listeners.get(type)?.delete(fn);
  }
  emit(type, event = {}) {
    event.type ||= type;
    event.target ||= this;
    event.currentTarget = this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => {};
    event.stopImmediatePropagation ||= () => {};
    const ancestors = [];
    for (let node = this; node; node = node.parentNode) ancestors.push(node);
    for (const node of ancestors.reverse()) {
      event.currentTarget = node;
      for (const fn of [...(node.captureListeners.get(type) || [])]) fn(event);
    }
    event.currentTarget = this;
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    this[`on${type}`]?.(event);
    return event;
  }
  listenerCount() {
    return [this.listeners, this.captureListeners]
      .reduce((total, events) => total + [...events.values()].reduce((n, listeners) => n + listeners.size, 0), 0);
  }
}

class Element extends Target {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.nodeType = tag === '#fragment' ? 11 : 1;
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = new Proxy({}, {
      set: (data, name, value) => {
        data[name] = String(value);
        this.attributes[`data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] = String(value);
        return true;
      },
      deleteProperty: (data, name) => {
        delete data[name];
        delete this.attributes[`data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`];
        return true;
      },
    });
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      getPropertyValue(name) { return this[name] ?? ''; },
      removeProperty(name) {
        const value = this.getPropertyValue(name);
        delete this[name];
        return value;
      },
    };
    let cssText = '';
    Object.defineProperty(this.style, 'cssText', {
      get: () => cssText,
      set: value => {
        cssText = String(value);
        for (const key of Object.keys(this.style)) if (typeof this.style[key] !== 'function') delete this.style[key];
        for (const declaration of cssText.split(';')) {
          const colon = declaration.indexOf(':');
          if (colon < 0) continue;
          const name = declaration.slice(0, colon).trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          this.style[name] = declaration.slice(colon + 1).trim();
        }
      },
    });
    this.className = '';
    this.text = '';
    this.disabled = false;
    this.hidden = false;
    this.tabIndex = ['button', 'input', 'select', 'textarea', 'a'].includes(tag) ? 0 : -1;
    this.paused = true;
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
  }
  get childNodes() { return this.children; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() { return this === this.ownerDocument.body || this === this.ownerDocument.head || Boolean(this.parentNode?.isConnected); }
  get inert() { return this.getAttribute('inert') !== null; }
  set inert(value) { if (value) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
    if (name === 'tabindex') this.tabIndex = Number(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  getAttribute(name) { return name === 'src' ? this.src ?? this.attributes[name] ?? null : this.attributes[name] ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
    if (name === 'disabled') this.disabled = false;
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, reference) {
    if (node === reference) return node;
    for (const child of node.nodeType === 11 ? [...node.children] : [node]) {
      child.remove();
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      assert.ok(index >= 0, 'insertBefore reference must belong to its parent');
      this.children.splice(index, 0, child);
      child.parentNode = this;
    }
    return node;
  }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  replaceChild(node, previous) {
    this.insertBefore(node, previous);
    previous.remove();
    return previous;
  }
  remove() {
    if (this.isConnected && this.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
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
  click() { if (!this.disabled) this.emit('click', { detail: 0 }); }
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
    this.selection = {
      ranges: [],
      removeAllRanges() { this.ranges = []; },
      addRange(range) { this.ranges.push(range); },
    };
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
  createDocumentFragment() { return new Element('#fragment', this); }
  createRange() { return { selectNodeContents(node) { this.selectedNode = node; } }; }
  getSelection() { return this.selection; }
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

function mountQueueSurface(h, list = h.document.createElement('div'), search = h.document.createElement('input')) {
  const surface = h.document.createElement('section');
  surface.id = 'tss-sidebar';
  surface.hidden = true;
  const content = h.document.createElement('div');
  content.id = 'tss-sidebar-content';
  const header = h.document.createElement('div');
  header.className = 'tss-side-head';
  list.id = 'tss-sidebar-list';
  search.id = 'tss-search';
  search.value = '';
  header.appendChild(search);
  content.append(header, list);
  const resize = h.document.createElement('button');
  resize.id = 'tss-sidebar-resize';
  const heightResize = h.document.createElement('button');
  heightResize.id = 'tss-sidebar-height-resize';
  surface.append(resize, heightResize, content);
  h.document.body.appendChild(surface);
  return { surface, content, list, search };
}

function deferSurfaceAnimations(surface) {
  const animations = [];
  surface.animate = (frames, timing = {}) => {
    const completion = deferred();
    completion.promise.catch(() => {});
    const animation = {
      finished: completion.promise,
      onfinish: null,
      effect: {
        target: surface,
        getTiming: () => ({ ...timing, iterations: timing.iterations ?? 1 }),
        getComputedTiming: () => ({ endTime: timing.duration ?? 0 }),
      },
      playState: 'running',
      canceled: false,
      cancel() {
        this.canceled = true;
        this.playState = 'idle';
        completion.reject(new DOMException('Animation canceled', 'AbortError'));
      },
      queueFinish() {
        this.playState = 'finished';
        completion.resolve(this);
        const onfinish = this.onfinish;
        return () => onfinish?.({ type: 'finish', target: this });
      },
      finish() { queueMicrotask(this.queueFinish()); },
    };
    animations.push(animation);
    return animation;
  };
  return animations;
}

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
    URL, getComputedStyle: element => element.style,
    location: { origin: 'https://soundcloud.com', href: 'https://soundcloud.com/a/sets/b' }, navigator: {},
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
  if (source.includes('function setReducedVisualEffects(')) {
    const preference = source.match(/^\s*reduceVisualEffects:\s*(.+),$/m);
    assert.ok(preference, 'missing persisted visual-effects state initializer');
    state.reduceVisualEffects = vm.runInContext(preference[1], sandbox);
  }
  if (source.includes('function setScrollLongTitles(')) {
    const preference = source.match(/^\s*scrollLongTitles:\s*(.+),$/m);
    state.scrollLongTitles = vm.runInContext(preference[1], sandbox);
  }
  function load(...names) {
    const rowHelpers = ['bindQueueRowActions', 'bindPlayNextRowAction']
      .filter(name => source.includes(`function ${name}(`));
    const identityHelpers = [
      'soundCloudInteger', 'soundCloudHref', 'normalizeTrackUrl', 'getLink', 'trackId', 'trackCacheKey',
      'indexTrackMeta', 'trackIdentityIndex', 'matchingTrackIndex', 'soundCloudTrackMatches',
      'soundCloudPermalinkConflicts', 'soundCloudLinkMatches', 'soundCloudPlayerMatches',
      'soundCloudRowsByLink', 'matchingSoundCloudRow',
    ].filter(name => source.includes(`function ${name}(`));
    const hubHelpers = names.includes('updateHub') ? ['refreshPlayBtn'] : [];
    const waveformHelpers = names.some(name => ['updateHub', 'loadTrackWaveform',
      'drawOwnPipWaveform', 'drawVideoPipFrame', 'syncBetterFeedPipWindow'].includes(name))
      ? ['soundCloudInteger', 'waveformTrackKey']
        .filter(name => source.includes(`function ${name}(`))
      : [];
    const viewHelpers = [
      'motionIsInstant', 'animateSurface', 'setHubView', 'syncHubView', 'setHubMini',
      'syncSettingsTabs', 'setSettingsTab', 'setSidebarTab', 'updateTabStyles',
      'applyVisualEffects', 'setReducedVisualEffects', 'setScrollLongTitles', 'syncOwnPipMarquee',
    ]
      .filter(name => source.includes(`function ${name}(`));
    vm.runInContext([...new Set([...rowHelpers, ...hubHelpers, ...waveformHelpers, ...identityHelpers, ...viewHelpers, ...names])].map(extractFunction).join('\n'), sandbox);
  }
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

function renderedPipHarness(extra = {}) {
  const h = harness(extra);
  h.state.els = [];
  h.state.roundPlayed = 0;
  h.state.roundTotal = h.state.queue.length;
  h.load(...pipFunctions, 'syncOwnPipWindow', 'renderOwnPipQueue', 'ownPipQueueOrder',
    'ownPipWindowTitle', 'ownPipArtworkSource', 'drawOwnPipWaveform', 'setOwnPipArtworkMode',
    'nextOwnPipArtworkMode', 'syncOwnPipMarquee', 'normalizeTrackUrl', 'syncBrowserNowPlaying',
    'currentTrackLikeState', 'findSoundCloudLikeButton', 'soundCloudLikeButtonState',
    ...['boundSoundCloudRow'].filter(name => source.includes(`function ${name}(`)));
  return h;
}

test('opening the real PiP queue after hidden player updates renders current queue, history and search results', () => {
  const h = renderedPipHarness();
  const pip = makeWindow();
  h.context.mountOwnPipWindow(pip);
  const doc = pip.document;
  const toggle = doc.getElementById('tss-pip-view-toggle');
  const titles = () => doc.querySelectorAll('.tss-pip-queue-title').map(row => row.textContent);
  toggle.click();
  assert.deepEqual(titles(), ['A', 'B', 'C', 'D']);
  toggle.click();

  h.state.meta.push({ title: 'Echo', artist: 'Guest' });
  h.state.queue = [0, 3, 1, 2, 4];
  h.state.pos = 1;
  h.state._deckTrack = 3;
  h.state.playNext = [4];
  h.state.roundPlayed = 1;
  h.state.history = [0, 1, 3];
  h.context.syncOwnPipWindow();
  assert.equal(doc.getElementById('tss-pip-stage').dataset.view, 'player');
  toggle.click();
  assert.deepEqual(titles(), ['D', 'Echo', 'B', 'C']);
  assert.equal(doc.querySelector('.tss-pip-queue-row[aria-current="true"]').querySelector('.tss-pip-queue-title').textContent, 'D');
  doc.getElementById('tss-pip-tab-history').click();
  assert.deepEqual(titles(), ['D', 'B', 'A']);
  toggle.click();

  h.state.history = [0, 2, 3, 4];
  h.context.syncOwnPipWindow();
  toggle.click();
  assert.deepEqual(titles(), ['Echo', 'D', 'C', 'A']);
  const search = doc.getElementById('tss-pip-queue-search');
  search.value = 'echo';
  search.emit('input');
  assert.deepEqual(titles(), ['Echo']);
  doc.getElementById('tss-pip-tab-queue').click();
  assert.deepEqual(titles(), ['Echo']);
  toggle.click();
  h.state.queue = [0, 3, 1, 2];
  h.state.playNext = [];
  h.context.syncOwnPipWindow();
  toggle.click();
  assert.deepEqual(titles(), [], 'a hidden removal must not leave an old matching row');
  search.value = '';
  search.emit('input');
  assert.deepEqual(titles(), ['D', 'B', 'C']);
  if (source.includes('function applyVisualEffects(')) {
    toggle.click();
    h.state.meta[3].title = 'Retitled current track';
    h.state.meta[3].artwork = 'https://i1.sndcdn.com/current-t200x200.jpg';
    h.context.syncOwnPipWindow();
    toggle.click();
    assert.deepEqual(titles(), ['Retitled current track', 'B', 'C'],
      'unchanged queue order must not preserve stale hidden metadata');
    assert.equal(doc.querySelector('.tss-pip-queue-row[aria-current="true"]').querySelector('img').src,
      h.state.meta[3].artwork);
  }
});

if (source.includes('function setReducedVisualEffects(')) {
  test('the Settings preference persists across reloads and follows current and newly mounted PiP documents', () => {
    const stored = new Map();
    const safeStorage = {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    };
    const h = renderedPipHarness({ safeStorage });
    h.load('mkHub', 'updateHub');
    h.context.mkHub();
    const pip = makeWindow();
    h.context.mountOwnPipWindow(pip);
    const control = h.document.getElementById('tss-reduce-visual-effects');
    assert.ok(control, 'the explicit preference must be reachable in Settings');
    revealHubControl(h, control);
    assert.equal(control.getAttribute('type'), 'checkbox');
    assert.ok(control.getAttribute('aria-label') || control.closest('label') || h.document.querySelector(`label[for="${control.id}"]`),
      'the checkbox must have an accessible label');
    const queue = h.state.queue.slice();
    const epoch = h.state._playbackEpoch;
    control.checked = true;
    control.emit('change');
    assert.equal(h.state.reduceVisualEffects, true);
    assert.equal(stored.get('tss_reduce_visual_effects'), 'true');
    for (const doc of [h.document, pip.document]) {
      assert.equal(doc.documentElement.getAttribute('data-tss-reduce-visual-effects'), 'true');
    }
    assert.deepEqual(h.state.queue, queue);
    assert.equal(h.state._playbackEpoch, epoch, 'the preference must not restart playback');
    assert.equal(h.state.active, true);

    const reloaded = renderedPipHarness({ safeStorage });
    reloaded.load('mkHub', 'updateHub');
    reloaded.context.mkHub();
    const nextPip = makeWindow();
    reloaded.context.mountOwnPipWindow(nextPip);
    assert.equal(reloaded.state.reduceVisualEffects, true, 'the real state initializer must restore the saved preference');
    assert.equal(reloaded.document.getElementById('tss-reduce-visual-effects').checked, true);
    for (const doc of [reloaded.document, nextPip.document]) {
      assert.equal(doc.documentElement.getAttribute('data-tss-reduce-visual-effects'), 'true');
    }
    const nextControl = reloaded.document.getElementById('tss-reduce-visual-effects');
    revealHubControl(reloaded, nextControl);
    nextControl.checked = false;
    nextControl.emit('change');
    assert.equal(stored.get('tss_reduce_visual_effects'), 'false');
    assert.equal(reloaded.state.reduceVisualEffects, false);
    for (const doc of [reloaded.document, nextPip.document]) {
      assert.equal(doc.documentElement.hasAttribute('data-tss-reduce-visual-effects'), false);
    }
    assert.equal(renderedPipHarness({ safeStorage }).state.reduceVisualEffects, false);
  });

  test('enabling reduced effects settles actual Settings and queue-tab transitions through their render cleanup', async () => {
    const h = queueScrollHarness();
    h.load('mkHub', 'updateHub', 'syncBrowserNowPlaying', 'setOwnPipButtonState', 'ownPipIsOpen');
    h.context.mkHub();
    const main = h.document.getElementById('tss-hub-main-view');
    const settings = h.document.getElementById('tss-hub-settings-view');
    const audioPanel = h.document.getElementById('tss-settings-panel-audio');
    const infoPanel = h.document.getElementById('tss-settings-panel-info');
    const mainAnimations = deferSurfaceAnimations(main);
    const settingsAnimations = deferSurfaceAnimations(settings);
    const audioAnimations = deferSurfaceAnimations(audioPanel);
    const infoAnimations = deferSurfaceAnimations(infoPanel);
    const listAnimations = deferSurfaceAnimations(h.list);
    h.context.renderList();
    h.context.animateSurface(h.surface, true, { kind: 'queue', instant: true });
    h.context.setHubView('settings');
    h.context.setSettingsTab('info');
    h.context.setSidebarTab('history');
    assert.equal(main.dataset.motion, 'exiting');
    assert.equal(settings.dataset.motion, 'entering');
    assert.equal(audioPanel.dataset.motion, 'exiting');
    assert.equal(infoPanel.dataset.motion, 'entering');
    assert.equal(h.list._tssTabSwap, true);
    assert.equal(h.list.inert, true);
    const oldRows = h.list.children.slice();

    h.context.setReducedVisualEffects(true);
    await flush();
    assert.equal(main.hidden, true);
    assert.equal(main.inert, true);
    assert.equal(settings.hidden, false);
    assert.equal(settings.inert, false);
    assert.equal(settings.dataset.motion, 'open');
    assert.equal(audioPanel.hidden, true);
    assert.equal(audioPanel.inert, true);
    assert.equal(infoPanel.hidden, false);
    assert.equal(infoPanel.inert, false);
    assert.equal(infoPanel.dataset.motion, 'open');
    assert.equal(h.list._tssTabSwap, false, 'the outgoing tab completion must perform its pending real render');
    assert.equal(h.list.hidden, false);
    assert.equal(h.list.inert, false);
    assert.equal(h.list.dataset.motion, 'open');
    assert.equal(oldRows.some(row => h.list.contains(row)), false);
    assert.deepEqual(h.list.children.map(row => row.children[2].children[0].textContent),
      [...h.state.history].reverse().map(ti => h.state.meta[ti].title));
    assert.ok(h.list.children.length > 0, 'the selected history must not remain an empty/inert transition surface');
    for (const surface of [main, settings, audioPanel, infoPanel, h.list]) assert.equal(surface._tssMotion, null);
    for (const animation of [...mainAnimations, ...settingsAnimations, ...audioAnimations, ...infoAnimations, ...listAnimations]) {
      assert.equal(animation.canceled, true, 'completion must release the owned fill effect');
    }
    h.context.setReducedVisualEffects(false);
    h.context.setSidebarTab('queue');
    assert.equal(h.list.dataset.motion, 'exiting', 'disabling the preference restores normal pointer transitions');
    h.context.setReducedVisualEffects(true);
    await flush();
    assert.equal(h.list.hidden, false);
    assert.equal(h.list.inert, false);
    assert.equal(h.list._tssTabSwap, false);
    assert.equal(h.list.children.length, h.state.queue.length);
  });

  test('reducing effects during a narrow queue exit releases its footprint and restores player focus', async () => {
    const h = queueScrollHarness();
    h.load('mkHub', 'updateHub', 'syncBrowserNowPlaying', 'setOwnPipButtonState', 'ownPipIsOpen',
      'syncSidebarToHub', 'toggleSidebar');
    h.context.mkHub();
    const hub = h.document.getElementById('tss-hub');
    hub.getBoundingClientRect = () => ({ left: 16, right: 416, top: 16, bottom: 516, width: 400, height: 500 });
    h.context.window.innerWidth = 440;
    h.context.animateSurface(h.surface, true, { kind: 'queue', instant: true });
    h.context.syncSidebarToHub();
    assert.equal(h.surface.dataset.layout, 'narrow');
    assert.equal(hub.dataset.queueView, 'true');
    const roots = deferSurfaceAnimations(h.surface);
    const foregrounds = deferSurfaceAnimations(h.content);
    h.context.toggleSidebar();
    assert.equal(h.surface.dataset.motion, 'exiting');
    assert.equal(h.surface.hidden, false);
    assert.equal(hub.dataset.queueView, 'true', 'the footprint remains while the real exit is pending');
    h.context.setReducedVisualEffects(true);
    await flush();
    assert.equal(h.state.sidebarOpen, false);
    assert.equal(h.surface.hidden, true);
    assert.equal(h.surface.inert, true);
    assert.equal(h.surface.dataset.motion, 'closed');
    assert.equal(hub.dataset.queueView, 'false');
    assert.equal(h.document.getElementById('tss-hub-queue-space').hidden, true);
    assert.equal(h.document.activeElement, h.document.getElementById('tss-hub-qico'));
    assert.equal(roots[0].canceled, true);
    assert.equal(foregrounds[0].canceled, true);
    h.context.setReducedVisualEffects(false);
    h.context.toggleSidebar({ instant: true });
    assert.equal(h.surface.hidden, false);
    assert.equal(h.surface.inert, false);
    assert.equal(hub.dataset.queueView, 'true');
  });
}

if (source.includes('function setScrollLongTitles(')) {
  for (const initiallyReduced of [false, true]) {
    test(`mounted scrolling preference persists independently and propagates to existing and new PiP (reduced effects initially ${initiallyReduced})`, () => {
      const stored = new Map([['tss_reduce_visual_effects', String(initiallyReduced)]]);
      const safeStorage = {
        getItem: key => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      };
      const mountHub = () => {
        const h = renderedPipHarness({ safeStorage });
        h.load('mkHub', 'updateHub');
        h.context.mkHub();
        return h;
      };
      const mountMeasuredPip = h => {
        const pip = makeWindow();
        const createElement = pip.document.createElement.bind(pip.document);
        pip.document.createElement = tag => {
          const element = createElement(tag);
          Object.defineProperties(element, {
            clientWidth: { get() { return this.id === 'tss-pip-title' ? 120 : 0; } },
            scrollWidth: { get() { return this.id === 'tss-pip-title-text' ? 260 : 0; } },
          });
          return element;
        };
        h.context.mountOwnPipWindow(pip);
        return pip;
      };
      const change = (h, id, checked) => {
        const control = h.document.getElementById(id);
        revealHubControl(h, control);
        control.checked = checked;
        control.emit('change');
        return control;
      };
      const overflow = pip => pip.document.getElementById('tss-pip-title').dataset.overflow;
      const h = mountHub();
      const pip = mountMeasuredPip(h);
      const control = h.document.getElementById('tss-scroll-long-titles');
      const effects = h.document.getElementById('tss-reduce-visual-effects');
      assert.equal(control.getAttribute('type'), 'checkbox');
      assert.ok(control.closest('label') || h.document.querySelector(`label[for="${control.id}"]`),
        'the real Settings checkbox must have an accessible label');
      assert.ok(h.document.getElementById(control.getAttribute('aria-describedby')),
        'the scrolling preference must expose its helper text');
      assert.equal(control.checked, true, 'scrolling defaults on even with a saved reduced-effects preference');
      assert.equal(h.state.scrollLongTitles, true);
      assert.equal(effects.checked, initiallyReduced);
      assert.equal(overflow(pip), 'true');
      assert.equal(stored.get('tss_reduce_visual_effects'), String(initiallyReduced));
      const queue = h.state.queue.slice();
      const epoch = h.state._playbackEpoch;
      const timers = h.timers.size;
      const intervals = h.intervals.size;

      change(h, control.id, false);
      assert.equal(h.state.scrollLongTitles, false);
      assert.equal(overflow(pip), 'false', 'the already-open PiP must stop without a polling tick');
      assert.equal(h.state.reduceVisualEffects, initiallyReduced);
      assert.equal(effects.checked, initiallyReduced);
      assert.equal(stored.get('tss_reduce_visual_effects'), String(initiallyReduced));
      assert.equal(stored.get('tss_scroll_long_titles'), 'false');

      change(h, effects.id, !initiallyReduced);
      assert.equal(h.state.reduceVisualEffects, !initiallyReduced);
      assert.equal(h.state.scrollLongTitles, false);
      assert.equal(control.checked, false);
      assert.equal(overflow(pip), 'false');
      assert.equal(stored.get('tss_scroll_long_titles'), 'false');
      assert.equal(stored.get('tss_reduce_visual_effects'), String(!initiallyReduced));
      assert.equal(pip.document.documentElement.getAttribute('data-tss-reduce-visual-effects'),
        !initiallyReduced ? 'true' : null);

      h.context.closeOwnPip();
      const replacement = mountMeasuredPip(h);
      assert.equal(overflow(replacement), 'false', 'a new PiP must inherit disabled scrolling');
      assert.equal(replacement.document.documentElement.getAttribute('data-tss-reduce-visual-effects'),
        !initiallyReduced ? 'true' : null);
      assert.deepEqual(h.state.queue, queue);
      assert.equal(h.state._playbackEpoch, epoch);
      assert.equal(h.state.active, true);
      assert.equal(h.timers.size, timers, 'preference changes must not introduce timers');
      assert.equal(h.intervals.size, intervals, 'preference changes must not introduce polling');

      const reloaded = mountHub();
      const nextPip = mountMeasuredPip(reloaded);
      assert.equal(reloaded.state.scrollLongTitles, false, 'the real initializer must restore disabled scrolling');
      assert.equal(reloaded.document.getElementById(control.id).checked, false);
      assert.equal(reloaded.state.reduceVisualEffects, !initiallyReduced);
      assert.equal(overflow(nextPip), 'false');
      change(reloaded, control.id, true);
      assert.equal(reloaded.state.scrollLongTitles, true);
      assert.equal(overflow(nextPip), 'true', 'enabling must update the current PiP without changing reduced effects');
      assert.equal(reloaded.state.reduceVisualEffects, !initiallyReduced);
      assert.equal(reloaded.document.getElementById(effects.id).checked, !initiallyReduced);
      assert.equal(stored.get('tss_reduce_visual_effects'), String(!initiallyReduced));
      assert.equal(stored.get('tss_scroll_long_titles'), 'true');
      const enabledReload = mountHub();
      assert.equal(enabledReload.state.scrollLongTitles, true);
      assert.equal(enabledReload.document.getElementById(control.id).checked, true);
      assert.equal(overflow(mountMeasuredPip(enabledReload)), 'true');
      assert.equal(enabledReload.state.reduceVisualEffects, !initiallyReduced);
    });
  }
}

if (source.includes('function animateSurface(')) {
  test('motion policy distinguishes zero-detail clicks from keyboard activation and explicit instant actions', () => {
    const h = harness();
    h.load('motionIsInstant');
    const button = h.document.createElement('button');
    const other = h.document.createElement('button');
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, target: button }), false,
      'detail=0 by itself is not evidence of keyboard input');
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 1, target: button }), false);
    assert.equal(h.context.motionIsInstant({ type: 'keydown', key: 'Enter' }), true);
    assert.equal(h.context.motionIsInstant({ type: 'keyup', key: ' ' }), true);
    assert.equal(h.context.motionIsInstant({ instant: true }), true);

    h.context.motionIsInstant.keyboardTarget = button;
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, target: button }), true);
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, target: button }), false,
      'observed keyboard activation applies to only its following click');
    h.context.motionIsInstant.keyboardTarget = button;
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, target: other }), false,
      'keyboard input on another control must not suppress this click');
    h.context.motionIsInstant.keyboardTarget = button;
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, pointerType: 'mouse', target: button }), false,
      'explicit pointer input must not inherit pending keyboard modality');
    h.context.motionIsInstant.keyboardTarget = button;
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 1, target: button }), false,
      'ordinary pointer clicks must not inherit pending keyboard modality');
    h.context.motionIsInstant.keyboardTarget = button;
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, isTrusted: false, target: button }), false,
      'explicitly synthetic clicks must not inherit pending keyboard modality');

    h.context.window.matchMedia = query => {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return { matches: true };
    };
    assert.equal(h.context.motionIsInstant({ type: 'click', detail: 0, target: button }), true);
  });

  test('reduced-motion preference commits animated-capable surfaces without starting Web Animations', () => {
    const h = harness();
    h.context.window.matchMedia = () => ({ matches: true });
    h.load('animateSurface');
    for (const kind of ['view', 'tab', 'queue']) {
      const surface = kind === 'queue' ? mountQueueSurface(h).surface : h.document.createElement('section');
      surface.hidden = true;
      surface.animate = () => { assert.fail('reduced motion must not start Web Animations'); };
      const content = surface.querySelector('#tss-sidebar-content');
      if (content) content.animate = surface.animate;
      let completions = 0;
      for (const visible of [true, false]) {
        h.context.animateSurface(surface, visible, { kind, onFinish: () => { completions++; } });
        assert.equal(surface.hidden, !visible);
        assert.equal(surface.inert, !visible);
        assert.equal(surface.getAttribute('aria-hidden'), String(!visible));
        assert.equal(surface.dataset.surfaceOpen, String(visible));
        assert.equal(surface.dataset.motion, visible ? 'open' : 'closed');
      }
      assert.equal(completions, 2);
    }
  });

  for (const kind of ['view', 'tab', 'queue']) test(`${kind} surfaces without Web Animations immediately commit visibility and interaction state`, () => {
    const h = harness();
    h.load('animateSurface');
    const surface = kind === 'queue' ? mountQueueSurface(h).surface : h.document.createElement('section');
    surface.hidden = true;
    h.document.body.appendChild(surface);
    const content = surface.querySelector('#tss-sidebar-content');
    if (content) content.animate = () => { assert.fail('the foreground cannot animate without its root'); };
    let completions = 0;

    for (const visible of [true, false]) {
      h.context.animateSurface(surface, visible, { kind, onFinish: () => { completions++; } });
      assert.equal(surface.hidden, !visible);
      assert.equal(surface.inert, !visible);
      assert.equal(surface.getAttribute('aria-hidden'), String(!visible));
      assert.equal(surface.dataset.surfaceOpen, String(visible));
      assert.equal(surface.dataset.motion, visible ? 'open' : 'closed');
    }
    assert.equal(completions, 2);
  });

  for (const kind of ['view', 'tab']) test(`an exiting ${kind} surface is inert while rendered and stale completion cannot close its rapid reopen`, async () => {
    const h = harness();
    h.load('animateSurface');
    const surface = h.document.createElement('section');
    surface.hidden = true;
    h.document.body.appendChild(surface);
    h.context.animateSurface(surface, true, { kind, instant: true });
    const animations = deferSurfaceAnimations(surface);
    let closed = 0;
    let reopened = 0;
    h.context.animateSurface(surface, false, { kind, onFinish: () => { closed++; } });
    assert.equal(animations.length, 1, 'closing must start a real deferred animation');
    assert.equal(surface.hidden, false, 'exit remains rendered until completion');
    assert.equal(surface.inert, true, 'exit becomes noninteractive immediately');
    assert.equal(surface.getAttribute('aria-hidden'), 'true');
    assert.equal(surface.dataset.surfaceOpen, 'false');
    assert.equal(surface.dataset.motion, 'exiting');
    const deliverOldFinish = animations[0].queueFinish();

    h.context.animateSurface(surface, true, { kind, onFinish: () => { reopened++; } });
    assert.equal(animations.length, 2, 'rapid reopen must animate from the current surface');
    deliverOldFinish();
    await flush();
    assert.equal(surface.hidden, false);
    assert.equal(surface.inert, false);
    assert.equal(surface.getAttribute('aria-hidden'), 'false');
    assert.equal(surface.dataset.surfaceOpen, 'true');
    assert.equal(surface.dataset.motion, 'entering');
    assert.equal(closed, 0, 'a superseded exit must not invoke its completion');

    animations[1].finish();
    await flush();
    assert.equal(surface.hidden, false);
    assert.equal(surface.dataset.motion, 'open');
    assert.equal(reopened, 1);
    h.context.animateSurface(surface, false, { kind, onFinish: () => { closed++; } });
    assert.equal(surface.hidden, false);
    animations[2].finish();
    await flush();
    assert.equal(surface.hidden, true, 'the current exit still hides the surface when it finishes');
    assert.equal(surface.inert, true);
    assert.equal(surface.dataset.motion, 'closed');
    assert.equal(closed, 1);
  });

  test('queue foreground and root share one exit/reopen lifecycle without replacing mounted rows or their scroll state', async () => {
    const h = queueScrollHarness();
    const { surface, content, list } = h;
    h.context.renderList();
    list.scrollTop = 2400;
    const row = list.children[60];
    const selections = [];
    h.context.jumpTo = (...selection) => selections.push(selection);
    h.context.animateSurface(surface, true, { kind: 'queue', instant: true });
    const roots = deferSurfaceAnimations(surface);
    const foregrounds = deferSurfaceAnimations(content);
    let closed = 0;
    let reopened = 0;

    h.context.animateSurface(surface, false, { kind: 'queue', onFinish: () => { closed++; } });
    assert.equal(roots.length, 1);
    assert.equal(foregrounds.length, 1, 'the mounted foreground must participate in the exit');
    assert.equal(surface.hidden, false);
    assert.equal(surface.inert, true);
    assert.equal(surface.getAttribute('aria-hidden'), 'true');
    assert.equal(surface.dataset.motion, 'exiting');
    const deliverOldRootFinish = roots[0].queueFinish();
    const deliverOldContentFinish = foregrounds[0].queueFinish();

    h.context.animateSurface(surface, true, { kind: 'queue', onFinish: () => { reopened++; } });
    assert.equal(roots.length, 2);
    assert.equal(foregrounds.length, 2);
    assert.equal(roots[0].canceled, true, 'reopen releases the superseded root animation');
    assert.equal(foregrounds[0].canceled, true, 'reopen also releases its paired foreground');
    deliverOldRootFinish();
    deliverOldContentFinish();
    await flush();
    assert.equal(surface.hidden, false);
    assert.equal(surface.inert, false);
    assert.equal(surface.getAttribute('aria-hidden'), 'false');
    assert.equal(surface.dataset.surfaceOpen, 'true');
    assert.equal(surface.dataset.motion, 'entering');
    assert.equal(foregrounds[1].canceled, false, 'stale exit delivery must not cancel the new foreground');
    assert.equal(closed, 0);
    assert.equal(reopened, 0);

    foregrounds[1].finish();
    await flush();
    assert.equal(surface.dataset.motion, 'entering', 'foreground completion alone cannot settle the root');
    assert.equal(reopened, 0);
    roots[1].finish();
    await flush();
    assert.equal(surface.dataset.motion, 'open');
    assert.equal(reopened, 1);
    assert.equal(foregrounds[1].canceled, true, 'root completion releases the foreground fill effect');
    assert.equal(surface._tssMotion, null);
    assert.equal(surface._tssContentMotion, null);

    h.context.animateSurface(surface, false, { kind: 'queue', onFinish: () => { closed++; } });
    roots[2].finish();
    await flush();
    assert.equal(surface.hidden, true);
    assert.equal(surface.inert, true);
    assert.equal(surface.dataset.motion, 'closed');
    assert.equal(closed, 1);
    assert.equal(foregrounds[2].canceled, true, 'an unfinished foreground cannot outlive the completed exit');
    assert.equal(surface._tssMotion, null);
    assert.equal(surface._tssContentMotion, null);

    h.context.animateSurface(surface, true, { kind: 'queue', instant: true });
    foregrounds[2].finish();
    await flush();
    assert.equal(surface.hidden, false, 'late foreground delivery cannot hide an instantly reopened queue');
    assert.equal(surface.dataset.motion, 'open');
    assert.equal(closed, 1);
    assert.equal(surface.querySelector('#tss-sidebar-content'), content);
    assert.equal(list.parentElement, content);
    assert.equal(h.search.closest('.tss-side-head').parentElement, content);
    assert.equal(h.document.getElementById('tss-sidebar-resize').parentElement, surface);
    assert.equal(h.document.getElementById('tss-sidebar-height-resize').parentElement, surface);
    assert.equal(list.scrollTop, 2400, 'only the list retains the browsing position across queue motion');
    assert.equal(list.children[60], row, 'queue motion must not rebuild the mounted list');
    row.click();
    assert.deepEqual(selections, [[60, 60]], 'the preserved row still activates its original queue track');
  });

  for (const policy of ['explicit instant', 'reduced motion', 'unavailable Web Animations']) {
    test(`${policy} reopening cancels both animations of a pending queue exit`, async () => {
      const h = harness();
      h.load('animateSurface');
      const { surface, content } = mountQueueSurface(h);
      h.context.animateSurface(surface, true, { kind: 'queue', instant: true });
      const roots = deferSurfaceAnimations(surface);
      const foregrounds = deferSurfaceAnimations(content);
      let closed = 0;
      let reopened = 0;
      h.context.animateSurface(surface, false, { kind: 'queue', onFinish: () => { closed++; } });
      const deliverOldRootFinish = roots[0].queueFinish();
      const deliverOldContentFinish = foregrounds[0].queueFinish();
      if (policy === 'reduced motion') h.context.window.matchMedia = () => ({ matches: true });
      if (policy === 'unavailable Web Animations') surface.animate = undefined;
      h.context.animateSurface(surface, true, {
        kind: 'queue', instant: policy === 'explicit instant', onFinish: () => { reopened++; },
      });
      deliverOldRootFinish();
      deliverOldContentFinish();
      await flush();
      assert.equal(roots.length, 1, 'the replacement must settle without starting another root animation');
      assert.equal(foregrounds.length, 1, 'the replacement must not leave a new foreground animation');
      assert.equal(roots[0].canceled, true);
      assert.equal(foregrounds[0].canceled, true);
      assert.equal(surface._tssMotion, null);
      assert.equal(surface._tssContentMotion, null);
      assert.equal(surface.hidden, false);
      assert.equal(surface.inert, false);
      assert.equal(surface.getAttribute('aria-hidden'), 'false');
      assert.equal(surface.dataset.surfaceOpen, 'true');
      assert.equal(surface.dataset.motion, 'open');
      assert.equal(closed, 0);
      assert.equal(reopened, 1);
    });
  }
}

function revealHubControl(h, control) {
  const settings = h.document.getElementById('tss-hub-settings-view');
  if (settings?.contains(control)) {
    if (h.document.getElementById('tss-hub').dataset.view !== 'settings') {
      h.document.getElementById('tss-hub-settings').click();
    }
    const panel = control.closest('[role="tabpanel"]');
    if (panel && settings.contains(panel)) {
      const tab = h.document.getElementById(panel.getAttribute('aria-labelledby'));
      assert.ok(tab, 'each Settings panel must have a reachable tab');
      tab.click();
      assert.equal(tab.getAttribute('aria-selected'), 'true');
    }
  }
  for (let node = control; node; node = node.parentNode) {
    assert.equal(node.hidden, false, 'the control must be visible before interaction');
    assert.notEqual(node.style.display, 'none', 'the control must not be inside a hidden view');
    assert.equal(node.inert, false, 'the control must not be inside an inert view');
    assert.notEqual(node.getAttribute('aria-hidden'), 'true', 'the control must be available to assistive technology');
  }
}

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
    revealHubControl(h, button);
    button.click();
    assert.equal(h.state.active, false);
    assert.equal(h.state.loading, false);
    assert.equal(h.state.busy, false);
    assert.equal(h.document.emit('click', { target: nativeButton }).defaultPrevented, true);
  });
}

if (source.includes('function setHubView(')) {
  test('session transitions retain one actionable control across player and Settings views', () => {
    const h = harness();
    h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying',
      'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub');
    h.state.active = false;
    h.state.loading = false;
    h.context.mkHub();
    const action = h.document.getElementById('tss-hub-start');
    const transport = h.document.getElementById('tss-hub-play');

    for (const [active, loading] of [[false, true], [true, false], [false, false], [true, false]]) {
      const completingFocusedLoad = h.state.loading && active && h.document.activeElement === action;
      h.state.active = active;
      h.state.loading = loading;
      h.context.updateHub();
      if (completingFocusedLoad) {
        const focused = h.document.activeElement;
        assert.equal(h.document.getElementById('tss-hub').dataset.view, 'main');
        assert.equal(h.document.getElementById('tss-hub').contains(focused), true);
        assert.equal(focused.isConnected, true);
        assert.ok(['BUTTON', 'INPUT', 'SELECT'].includes(focused.tagName));
        assert.equal(focused.disabled, false);
        for (let node = focused; node; node = node.parentNode) {
          assert.equal(node.hidden, false, 'loading completion must not leave focus in a hidden view');
          assert.notEqual(node.style.display, 'none');
          assert.equal(node.inert, false);
          assert.notEqual(node.getAttribute('aria-hidden'), 'true');
        }
      }
      assert.equal(h.document.getElementById('tss-hub-start'), action);
      assert.equal(h.document.querySelectorAll('#tss-hub-start').length, 1);
      assert.equal(action.disabled, false);
      revealHubControl(h, action);
      h.context.setHubView('main');
      if (active) revealHubControl(h, transport);
      if (loading) action.focus();
    }

    h.context.setHubView('settings');
    h.context.setHubMini(true);
    assert.equal(h.document.getElementById('tss-hub-play'), transport);
    assert.equal(h.document.querySelectorAll('#tss-hub-play').length, 1);
    h.context.setHubMini(false);
    h.context.setHubView('main');
    revealHubControl(h, transport);
    revealHubControl(h, action);
    action.click();
    assert.equal(h.state.active, false);
    assert.equal(h.state.loading, false);
    assert.equal(h.state.busy, false);
    assert.equal(h.document.getElementById('tss-hub-start'), action);
    h.context.setHubView('main');
    revealHubControl(h, action);
  });
}

if (source.includes('function setSettingsTab(')) {
  test('Settings tabs expose one panel, support keyboard selection and retain selection across player navigation', () => {
    let statsOpened = 0;
    const h = harness({ showStats: () => { statsOpened++; } });
    h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying',
      'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub');
    h.context.mkHub();
    const hub = h.document.getElementById('tss-hub');
    const settings = h.document.getElementById('tss-hub-settings');
    const queue = h.state.queue.slice();
    const position = h.state.pos;
    const assertSelected = selected => {
      assert.equal(hub.dataset.settingsTab, selected);
      for (const key of ['audio', 'session', 'info']) {
        const tab = h.document.getElementById(`tss-settings-tab-${key}`);
        const panel = h.document.getElementById(tab.getAttribute('aria-controls'));
        const active = key === selected;
        assert.equal(tab.getAttribute('role'), 'tab');
        assert.equal(tab.parentNode.getAttribute('role'), 'tablist');
        assert.equal(tab.getAttribute('aria-selected'), String(active));
        assert.equal(tab.tabIndex, active ? 0 : -1);
        assert.equal(panel.getAttribute('role'), 'tabpanel');
        assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
        assert.equal(panel.hidden, !active);
        assert.equal(panel.inert, !active);
        assert.equal(panel.getAttribute('aria-hidden'), String(!active));
      }
    };

    settings.click();
    assertSelected('audio');
    revealHubControl(h, h.document.getElementById('tss-hub-crossfade'));
    assertSelected('audio');
    const audio = h.document.getElementById('tss-settings-tab-audio');
    audio.focus();
    assert.equal(audio.emit('keydown', { key: 'ArrowRight' }).defaultPrevented, true);
    assertSelected('session');
    const session = h.document.getElementById('tss-settings-tab-session');
    assert.equal(h.document.activeElement, session);
    session.emit('keydown', { key: 'End' });
    assertSelected('info');
    assert.equal(h.document.activeElement, h.document.getElementById('tss-settings-tab-info'));
    const stats = h.document.getElementById('tss-hub-stats');
    revealHubControl(h, stats);
    assertSelected('info');
    stats.click();
    assert.equal(statsOpened, 1);

    settings.click();
    assert.equal(hub.dataset.view, 'main');
    settings.click();
    assert.equal(hub.dataset.view, 'settings');
    assertSelected('info');
    h.document.getElementById('tss-settings-tab-info').emit('keydown', { key: 'Home' });
    assertSelected('audio');
    assert.equal(h.document.activeElement, audio);
    assert.deepEqual(h.state.queue, queue);
    assert.equal(h.state.pos, position);
  });

  test('mounted Settings and tabs animate zero-detail clicks, preserve running sync and honor captured keyboard input', () => {
    const h = harness();
    h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying',
      'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub');
    h.context.mkHub();
    const hub = h.document.getElementById('tss-hub');
    const settings = h.document.getElementById('tss-hub-settings');
    const main = h.document.getElementById('tss-hub-main-view');
    const view = h.document.getElementById('tss-hub-settings-view');
    const audio = h.document.getElementById('tss-settings-tab-audio');
    const session = h.document.getElementById('tss-settings-tab-session');
    const info = h.document.getElementById('tss-settings-tab-info');
    const animations = [];
    for (const surface of [main, view, ...['audio', 'session', 'info'].map(tab =>
      h.document.getElementById(`tss-settings-panel-${tab}`))]) {
      surface.animate = () => {
        const completion = deferred();
        completion.promise.catch(() => {});
        const animation = {
          finished: completion.promise, onfinish: null, canceled: false,
          cancel() { this.canceled = true; completion.reject(new DOMException('Animation canceled', 'AbortError')); },
          finish() { completion.resolve(); this.onfinish?.(); },
        };
        animations.push(animation);
        return animation;
      };
    }
    const finishAnimations = () => { for (const animation of animations) if (!animation.canceled) animation.finish(); };

    settings.emit('click', { detail: 0 });
    assert.equal(hub.dataset.view, 'settings');
    assert.equal(animations.length, 2, 'zero-detail Settings activation must animate both surfaces');
    assert.equal(main.dataset.motion, 'exiting');
    assert.equal(main.hidden, false);
    assert.equal(main.inert, true);
    assert.equal(view.dataset.motion, 'entering');
    assert.equal(view.inert, false);
    h.context.updateHub();
    assert.equal(animations.length, 2, 'routine sync must not replace a running transition');
    assert.equal(animations.some(animation => animation.canceled), false,
      'routine instant sync must not cancel or settle a running transition');
    assert.equal(main.dataset.motion, 'exiting');
    assert.equal(view.dataset.motion, 'entering');
    finishAnimations();
    assert.equal(main.hidden, true);
    assert.equal(view.dataset.motion, 'open');

    settings.click();
    assert.equal(animations.length, 4, 'script-driven zero-detail clicks also animate');
    finishAnimations();
    settings.emit('keydown', { key: 'Enter' });
    settings.emit('click', { detail: 0, isTrusted: true });
    assert.equal(animations.length, 4, 'captured Enter activation commits both surfaces instantly');
    assert.equal(main.hidden, true);
    assert.equal(view.dataset.motion, 'open');

    session.emit('pointerdown', { pointerType: 'mouse' });
    session.emit('click', { detail: 0 });
    assert.equal(hub.dataset.settingsTab, 'session');
    assert.equal(animations.length, 6, 'zero-detail tab activation animates outgoing and incoming panels');
    finishAnimations();
    session.emit('keydown', { key: 'ArrowRight' });
    assert.equal(hub.dataset.settingsTab, 'info');
    assert.equal(h.document.activeElement, info);
    assert.equal(animations.length, 6, 'arrow-key selection remains instant');
    audio.emit('keydown', { key: ' ' });
    audio.emit('click', { detail: 0, isTrusted: true });
    assert.equal(hub.dataset.settingsTab, 'audio');
    assert.equal(animations.length, 6, 'captured Space activation remains instant');

    session.emit('keydown', { key: 'Enter' });
    session.emit('pointerdown', { pointerType: 'mouse' });
    session.emit('click', { detail: 0, isTrusted: true });
    assert.equal(animations.length, 8, 'captured pointer input clears pending keyboard modality');
    finishAnimations();
    assert.equal(h.document.getElementById('tss-settings-panel-session').dataset.motion, 'open');
  });
}

function diagnosticHarness() {
  const h = harness();
  h.state._playbackDiagnostics = [];
  h.state._playbackDiagnosticFault = false;
  h.state._playbackDiagnosticIncident = null;
  if (compactReports) h.state._transitionDiagnostics = true;
  const diagnosticConfig = [
    /const DIAGNOSTIC_NUMBER_FIELDS = new Set\([\s\S]*?\n\]\);/,
    /const DIAGNOSTIC_BOOLEAN_FIELDS = new Set\([\s\S]*?\n\]\);/,
    /const DIAGNOSTIC_STRING_FIELDS = new Set\([\s\S]*?\n\]\);/,
    /const DIAGNOSTIC_NESTED_FIELDS = new Set\([\s\S]*?\n\]\);/,
    /const DIAGNOSTIC_SAFE_LABELS = \{[\s\S]*?\n\};/,
  ].map(pattern => source.match(pattern)?.[0] || '').join('\n');
  vm.runInContext(diagnosticConfig, h.context);
  vm.runInContext(source.match(/const PLAYBACK_DIAGNOSTIC_FAULTS = new Set\(\[[\s\S]*?\]\);/)[0], h.context);
  h.load(...['playbackDiagnosticContext', 'capturePlaybackDiagnosticIncident', 'compactPlaybackReport', 'recordTransitionDiagnostic']
    .filter(name => source.includes(`function ${name}(`)));
  h.load('safeDiagnosticVersion', 'playbackErrorName', 'safeDiagnosticString', 'sanitizeDiagnosticRecord',
    'sanitizePlaybackDiagnostics', 'playbackDiagnosticHostWindow', 'playbackDiagnosticPageKind',
    'playbackDiagnosticEnvironment', 'playbackDiagnosticCapabilities', 'diagnosticDeckStreamKind',
    'updatePlaybackDiagnosticButton', 'recordPlaybackDiagnostic', 'playbackDiagnosticSnapshot',
    'showPlaybackDiagnostics', 'showPlaybackReportHelp');
  return h;
}

test('a recorded playback fault and its report remain reachable after ending the session', () => {
  const h = diagnosticHarness();
  h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying',
    'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub');
  h.context.mkHub();
  const diagnostic = h.document.getElementById('tss-playback-debug');
  assert.equal(diagnostic.hidden, true);
  assert.equal(diagnostic.dataset.status, 'none');
  h.context.recordPlaybackDiagnostic('custom-start-retry', { attempt: 1 });
  assert.equal(diagnostic.hidden, true);
  h.context.recordPlaybackDiagnostic('custom-start-candidate-failed', {
    attempted: 1, failureStage: 'stream-resolution', failureReason: 'http-rate-limited',
  });
  assert.equal(diagnostic.hidden, false, 'the diagnostic build makes an in-progress candidate failure reportable');
  assert.equal(diagnostic.dataset.status, 'current');
  h.context.recordPlaybackDiagnostic('custom-start-exhausted', { attempted: 3 });
  assert.equal(diagnostic.hidden, false);
  assert.equal(diagnostic.dataset.status, 'current');
  revealHubControl(h, diagnostic);
  if (!compactReports && typeof h.context.setSettingsTab === 'function') {
    assert.equal(h.document.getElementById('tss-hub').dataset.settingsTab, 'info');
  }
  diagnostic.click();
  const beforeStop = dialogSnapshot(h.document);
  h.document.getElementById('tss-debug-close').click();
  const endSession = h.document.getElementById('tss-hub-start');
  revealHubControl(h, endSession);
  if (typeof h.context.setSettingsTab === 'function') {
    assert.equal(h.document.getElementById('tss-hub').dataset.settingsTab, 'session');
  }
  endSession.click();
  assert.equal(h.state.active, false);
  assert.equal(diagnostic.hidden, false);
  assert.equal(diagnostic.dataset.status, 'current');
  assert.equal(diagnostic.isConnected, true);
  if (typeof h.context.setSettingsTab === 'function') {
    assert.equal(h.document.getElementById('tss-hub').dataset.settingsTab, 'session',
      'ending playback must not discard the selected Settings tab');
  }
  revealHubControl(h, diagnostic);
  if (!compactReports && typeof h.context.setSettingsTab === 'function') {
    assert.equal(h.document.getElementById('tss-hub').dataset.settingsTab, 'info');
  }
  diagnostic.click();
  const stoppedReport = dialogSnapshot(h.document);
  assert.equal(stoppedReport.state.active, false);
  assert.deepEqual(stoppedReport.diagnostics, beforeStop.diagnostics);
  assert.deepEqual(stoppedReport.diagnostics.map(entry => entry.event), [
    'custom-start-retry', 'custom-start-candidate-failed', 'custom-start-exhausted',
  ]);
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
  const diagnostics = dialogSnapshot(h.document).diagnostics;
  assert.deepEqual(diagnostics.map(entry => ({ event: entry.event, reason: entry.reason })),
    [{ event: 'recovery-failed', reason: 'media-error' }]);
});

test('fault-only header report survives full, mini, Settings and Stop; Clear hides it and restores header focus',
  { skip: !compactReports }, () => {
    for (const mini of [false, true]) for (const settingsOpen of [false, true]) {
      const h = diagnosticHarness();
      h.context.window.innerWidth = 320;
      h.load('withDeadline', 'invalidatePlaybackSession', 'closeOwnPip', 'syncBrowserNowPlaying',
        'setOwnPipButtonState', 'ownPipIsOpen', 'stop', 'updateHub', 'mkHub');
      h.context.mkHub();
      h.context.setHubMini(mini, false);
      if (settingsOpen) {
        h.context.setHubView('settings', false);
        h.document.getElementById('tss-settings-tab-info').click();
      }
      const hub = h.document.getElementById('tss-hub');
      const button = h.document.getElementById('tss-playback-debug');
      const header = h.document.getElementById('tss-hub-hdr');
      assert.equal(button.closest('#tss-hub-hdr'), header);
      assert.equal(h.document.querySelectorAll('#tss-playback-debug').length, 1);
      assert.equal(h.document.getElementById('tss-settings-panel-info').contains(button), false);
      assert.equal(button.hidden, true, 'transition observations being enabled must not expose a startup error');
      assert.equal(h.state._transitionDiagnostics, true);
      assert.equal(hub.dataset.mini, String(mini));

      const context = h.context.playbackDiagnosticContext;
      let captures = 0;
      h.context.playbackDiagnosticContext = () => { captures++; return context(); };
      const timers = h.timers.size;
      for (const event of ['media-playing', 'media-waiting', 'media-stalled', 'fade-scheduled', 'fade-completed']) {
        h.context.recordTransitionDiagnostic(event, { readyState: 4, elapsedMs: 20 });
      }
      h.context.recordPlaybackDiagnostic('recovery-start', { attempt: 1 });
      assert.equal(captures, 0, 'normal observations must not collect fault-time snapshots');
      assert.equal(h.timers.size, timers, 'reporting must not add playback timers');
      assert.equal(button.hidden, true);
      assert.equal(h.state._playbackDiagnosticIncident, null);

      h.context.recordPlaybackDiagnostic('recovery-failed', { reason: 'media-error', mediaErrorCode: 3 });
      assert.equal(captures, 1);
      assert.equal(button.hidden, false);
      assert.equal(button.dataset.status, 'current');
      assert.equal(button.closest('#tss-hub-hdr'), header);
      button.focus();
      button.click();
      assert.match(h.document.getElementById('tss-debug-report').textContent, /recovery-failed/);
      h.document.getElementById('tss-debug-close').click();
      assert.equal(h.document.activeElement, button, 'normal close restores the visible error opener');

      h.context.stop();
      assert.equal(h.state.active, false);
      assert.equal(button.hidden, false);
      assert.equal(h.state._playbackDiagnosticIncident.fault.event, 'recovery-failed');
      button.focus();
      button.click();
      h.document.getElementById('tss-debug-clear').click();
      assert.equal(h.document.getElementById('tss-debug-overlay'), null);
      assert.equal(button.hidden, true);
      assert.equal(h.state._playbackDiagnosticFault, false);
      assert.equal(h.state._playbackDiagnosticIncident, null);
      assert.equal(h.state._playbackDiagnostics.length, 0);
      assert.equal(h.document.activeElement, h.document.getElementById('tss-hub-settings'),
        'Clear restores a reachable header control, not hidden player content');
      h.context.recordTransitionDiagnostic('media-stalled', { currentTime: 5 });
      assert.equal(button.hidden, true);
      h.context.recordPlaybackDiagnostic('playback-operation-failed', { operation: 'play' });
      assert.equal(button.hidden, false);
      assert.equal(h.state._playbackDiagnosticIncident.fault.event, 'playback-operation-failed');
    }
  });

test('mounted Copy report stays compact by default; verbose export requires the native disclosure',
  { skip: !compactReports }, async () => {
    const h = diagnosticHarness();
    const copied = [];
    h.context.navigator.clipboard = { writeText: async text => { copied.push(text); } };
    h.context.recordPlaybackDiagnostic('recovery-failed', { reason: 'media-error', mediaErrorCode: 3 });
    h.context.showPlaybackDiagnostics();
    const overlay = h.document.getElementById('tss-debug-overlay');
    const report = h.document.getElementById('tss-debug-report').textContent;
    const details = h.document.getElementById('tss-debug-details');
    const full = h.document.getElementById('tss-debug-full-report');
    const fullCopy = h.document.getElementById('tss-debug-copy-full');
    const copy = h.document.getElementById('tss-debug-copy');
    assert.ok(report.length <= 1800);
    assert.match(report, /Latest fault: recovery-failed/);
    assert.equal(full.textContent, '', 'full serialization must be lazy');
    assert.equal(fullCopy.hidden, true);
    await fullCopy.onclick({ currentTarget: fullCopy });
    assert.equal(copied.length, 0, 'closed verbose content must not be copied through a programmatic click');
    await copy.onclick({ currentTarget: copy });
    assert.equal(copied.at(-1), report);
    assert.equal(copy.textContent, 'Copied');

    details.open = true;
    details.emit('toggle');
    assert.equal(fullCopy.hidden, false);
    const snapshot = JSON.parse(full.textContent);
    assert.equal(snapshot.incident.fault.event, 'recovery-failed');
    assert.equal(snapshot.incident.fault.mediaErrorCode, 3);
    await fullCopy.onclick({ currentTarget: fullCopy });
    assert.equal(copied.at(-1), full.textContent);
    await copy.onclick({ currentTarget: copy });
    assert.equal(copied.at(-1), report, 'opening full details must not change the default copy action');
    details.open = false;
    details.emit('toggle');
    assert.equal(fullCopy.hidden, true);
    const count = copied.length;
    await fullCopy.onclick({ currentTarget: fullCopy });
    assert.equal(copied.length, count);
    assert.equal(h.document.getElementById('tss-debug-overlay'), overlay);
  });

test('blocked clipboard selects the actual compact or full report and safely settles after dialog close',
  { skip: !compactReports }, async () => {
    for (const verbose of [false, true]) {
      const h = diagnosticHarness();
      const clipboard = deferred();
      let submitted;
      h.context.navigator.clipboard = { writeText: text => { submitted = text; return clipboard.promise; } };
      h.context.recordPlaybackDiagnostic('recovery-failed', { reason: 'media-error' });
      h.context.showPlaybackDiagnostics();
      const overlay = h.document.getElementById('tss-debug-overlay');
      if (verbose) {
        const details = h.document.getElementById('tss-debug-details');
        details.open = true;
        details.emit('toggle');
      }
      const button = h.document.getElementById(verbose ? 'tss-debug-copy-full' : 'tss-debug-copy');
      const pre = h.document.getElementById(verbose ? 'tss-debug-full-report' : 'tss-debug-report');
      const event = { currentTarget: button };
      const pending = button.onclick(event);
      event.currentTarget = null;
      clipboard.reject(new DOMException('Clipboard denied', 'NotAllowedError'));
      await pending;
      assert.equal(submitted, pre.textContent);
      assert.equal(button.textContent, 'Copy blocked');
      assert.equal(h.document.getElementById('tss-debug-overlay'), overlay);
      assert.equal(h.document.activeElement, pre);
      assert.equal(h.document.selection.ranges[0].selectedNode, pre,
        'the fallback selects the real report, not a placeholder or another disclosure');
      const status = h.document.getElementById('tss-debug-copy-status');
      assert.equal(status.hidden, false);
      assert.match(status.textContent, /Report selected.*Ctrl\+C.*Cmd\+C/);
    }
    for (const rejected of [false, true]) {
      const h = diagnosticHarness();
      const clipboard = deferred();
      h.context.navigator.clipboard = { writeText: () => clipboard.promise };
      h.context.showPlaybackDiagnostics();
      const copy = h.document.getElementById('tss-debug-copy');
      const originalLabel = copy.textContent;
      const event = { currentTarget: copy };
      const pending = copy.onclick(event);
      event.currentTarget = null;
      h.document.getElementById('tss-debug-close').click();
      if (rejected) clipboard.reject(new DOMException('Clipboard denied', 'NotAllowedError'));
      else clipboard.resolve();
      await pending;
      assert.equal(h.document.getElementById('tss-debug-overlay'), null);
      assert.equal(copy.textContent, originalLabel, 'a settled clipboard promise must not mutate a closed dialog');
      assert.equal(h.document.activeElement, h.document.body);
    }
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

function queueScrollHarness() {
  const h = harness({ refreshPlayBtn() {} });
  const rowHeight = 56;
  const scrollCalls = [];
  // Clearing the list collapses its layout; assigning scrollTop before rebuilding
  // therefore cannot preserve a user's position. Rows have fixed fixture heights.
  class QueueList extends Element {
    constructor() {
      super('div', h.document);
      this.clientHeight = rowHeight * 5;
      this._scrollTop = 0;
    }
    get scrollHeight() { return this.children.length * rowHeight; }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    get textContent() { return super.textContent; }
    set textContent(value) { super.textContent = value; this.scrollTop = 0; }
  }
  const list = new QueueList();
  const queueSurface = mountQueueSurface(h, list);
  const createElement = h.document.createElement.bind(h.document);
  h.document.createElement = tag => {
    const element = createElement(tag);
    element.scrollIntoView = () => {
      if (element.parentNode !== list) return;
      scrollCalls.push(element);
      const top = list.children.indexOf(element) * rowHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight;
    };
    return element;
  };
  Object.assign(h.state, {
    sidebarOpen: true, sidebarTab: 'queue', pos: 12, roundPlayed: 12,
    queue: Array.from({ length: 120 }, (_, index) => index),
    meta: Array.from({ length: 120 }, (_, index) => ({
      title: `${index % 2 ? 'Beta' : 'Alpha'} ${String(index).padStart(3, '0')}`,
      artist: 'Artist',
    })),
    stats: { played: 12 },
    history: [0, 1, 2],
  });
  h.load('mkRow', 'renderHistory', 'renderList');
  return { ...h, ...queueSurface, scrollCalls, rowHeight };
}

test('repeated queue refreshes preserve a distant browsing position instead of revealing the playing track', () => {
  const h = queueScrollHarness();
  h.context.renderList();
  assert.equal(h.list.scrollTop, 8 * h.rowHeight, 'first render reveals the offscreen current track');
  assert.equal(h.scrollCalls.length, 1);
  assert.ok(h.scrollCalls[0].textContent.includes(h.state.meta[12].title));

  h.list.scrollTop = 2400;
  h.scrollCalls.length = 0;
  for (let refresh = 0; refresh < 3; refresh++) {
    h.context.renderList();
    assert.equal(h.list.scrollTop, 2400);
    assert.equal(h.scrollCalls.length, 0);
  }
  h.state.meta[80].title = 'Updated queue metadata';
  h.context.renderList();
  assert.ok(h.list.textContent.includes('Updated queue metadata'));
  assert.equal(h.list.scrollTop, 2400);
  assert.equal(h.scrollCalls.length, 0);
});

test('queue removal and playback advance update rows without interrupting queue browsing', () => {
  const h = queueScrollHarness();
  h.context.renderList();
  h.list.scrollTop = 2400;
  h.scrollCalls.length = 0;

  h.state.queue.splice(20, 1);
  h.context.renderList();
  assert.equal(h.list.textContent.includes(h.state.meta[20].title), false);
  assert.equal(h.list.scrollTop, 2400);
  assert.equal(h.scrollCalls.length, 0);

  h.state.pos++;
  h.state.roundPlayed++;
  h.state.stats.played++;
  h.context.renderList();
  const playing = h.list.querySelectorAll('.tss-queue-status').find(status => status.textContent === 'playing');
  assert.ok(playing.parentNode.textContent.includes(h.state.meta[h.state.queue[h.state.pos]].title));
  assert.equal(h.list.scrollTop, 2400);
  assert.equal(h.scrollCalls.length, 0);
});

test('equivalent searches preserve browsing while new searches start at the top and clearing reveals current', () => {
  const h = queueScrollHarness();
  h.context.renderList();
  h.list.scrollTop = 2400;
  h.scrollCalls.length = 0;

  h.search.value = 'Alpha';
  h.context.renderList();
  assert.equal(h.list.scrollTop, 0);
  assert.equal(h.scrollCalls.length, 0);
  assert.ok(h.list.textContent.includes('Alpha 118'));
  assert.equal(h.list.textContent.includes('Beta 119'), false);

  h.list.scrollTop = 1400;
  h.search.value = 'ALPHA';
  h.context.renderList();
  assert.equal(h.list.scrollTop, 1400);
  assert.equal(h.scrollCalls.length, 0);

  h.search.value = 'Beta';
  h.context.renderList();
  assert.equal(h.list.scrollTop, 0);
  assert.equal(h.scrollCalls.length, 0);
  assert.ok(h.list.textContent.includes('Beta 119'));
  assert.equal(h.list.textContent.includes('Alpha 118'), false);

  h.list.scrollTop = 1400;
  h.search.value = '';
  h.context.renderList();
  assert.equal(h.list.scrollTop, 8 * h.rowHeight);
  assert.equal(h.scrollCalls.length, 1);
  assert.ok(h.scrollCalls[0].textContent.includes(h.state.meta[12].title));
});

test('returning from history reveals current in the full queue and starts filtered results at the top', () => {
  const h = queueScrollHarness();
  h.context.renderList();
  h.list.scrollTop = 2400;
  h.state.sidebarTab = 'history';
  h.context.renderList();
  h.state.sidebarTab = 'queue';
  h.scrollCalls.length = 0;
  h.context.renderList();
  assert.equal(h.list.scrollTop, 8 * h.rowHeight);
  assert.equal(h.scrollCalls.length, 1);
  assert.ok(h.scrollCalls[0].textContent.includes(h.state.meta[12].title));

  h.search.value = 'Alpha';
  h.context.renderList();
  h.list.scrollTop = 1400;
  h.state.sidebarTab = 'history';
  h.context.renderList();
  h.state.sidebarTab = 'queue';
  h.scrollCalls.length = 0;
  h.context.renderList();
  assert.equal(h.list.scrollTop, 0);
  assert.equal(h.scrollCalls.length, 0);
  assert.ok(h.list.textContent.includes('Alpha 118'));
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

if (source.includes('_pipBridgeOriginals')) {
  function bridgePlaybackHarness(player) {
    const h = harness({ pageWindow: { scPlayer: player } });
    const deck = h.document.createElement('audio');
    Object.assign(deck, { duration: 120, currentTime: 12, paused: false });
    h.state._deckIndex = 0;
    h.state._decks = [deck];
    h.load('installBetterFeedPipBridge', 'betterFeedPipActive', 'betterFeedPipSound',
      'currentDeckAudio', 'activeAudio', 'parseTimeText', 'playbackTiming',
      'updateProgressBar', 'updateHub', 'syncBrowserNowPlaying');
    return { ...h, deck };
  }

  test('same-object native method replacements retain custom projection and seek controls without wrapper recursion', () => {
    const nativeSound = { id: 41, attributes: { title: 'Native' } };
    const player = {
      nativeSound, nativePosition: 9,
      getCurrentSound() { return this.nativeSound; },
      seekCurrentTo(amount) { this.nativePosition = Number(typeof amount === 'function' ? amount() : amount) / 1000; },
      seekCurrentBy(amount) { this.nativePosition += Number(typeof amount === 'function' ? amount() : amount) / 1000; },
    };
    const initialRelativeSeek = player.seekCurrentBy;
    const h = bridgePlaybackHarness(player);
    assert.equal(h.context.installBetterFeedPipBridge(), true);
    assert.equal(player.getCurrentSound().attributes.title, 'A');
    assert.equal(player.getCurrentSound().player.getPosition(), 12000);
    assert.equal(player.isPlaying(), true);
    const nativeReplacement = function () { return this.replacementSound; };
    const replacementSeek = function (amount) {
      this.nativePosition = 100 + Number(typeof amount === 'function' ? amount() : amount) / 1000;
    };
    player.replacementSound = { id: 42, attributes: { title: 'Replacement native' } };
    player.getCurrentSound = nativeReplacement;
    player.seekCurrentTo = replacementSeek;
    assert.equal(h.context.installBetterFeedPipBridge(), true);
    assert.equal(h.state._pipBridgeOriginals.getCurrentSound, nativeReplacement);
    assert.equal(h.state._pipBridgeOriginals.seekCurrentTo, replacementSeek);
    assert.equal(h.state._pipBridgeOriginals.seekCurrentBy, initialRelativeSeek,
      'an unchanged installed wrapper must resolve to its original native method');
    assert.equal(player.getCurrentSound().attributes.title, 'A');
    player.seekCurrentTo(() => 30000);
    assert.equal(h.deck.currentTime, 30);
    player.seekCurrentBy(() => 200000);
    assert.equal(h.deck.currentTime, 120, 'relative custom seeks remain bounded by deck duration');
    player.seekCurrentBy(-200000);
    assert.equal(h.deck.currentTime, 0);
    assert.equal(player.nativePosition, 9, 'active custom controls must not act on the native player');
    h.deck.paused = true;
    assert.equal(player.isPlaying(), false);
    h.deck.paused = false;

    for (const id of [43, 44, 45]) {
      player.replacementSound = { id };
      player.getCurrentSound = nativeReplacement;
      assert.equal(h.context.installBetterFeedPipBridge(), true);
      const wrappers = h.state._pipBridgeWrappers;
      assert.equal(h.context.installBetterFeedPipBridge(), true);
      assert.equal(h.state._pipBridgeWrappers, wrappers, 'unchanged installations must remain idempotent');
      assert.equal(player.getCurrentSound, wrappers.getCurrentSound);
      assert.equal(h.state._pipBridgeOriginals.seekCurrentBy, initialRelativeSeek);
      assert.equal(player.getCurrentSound().id, -1);
      h.state.active = false;
      assert.equal(player.getCurrentSound(), player.replacementSound);
      player.seekCurrentTo(() => 5000);
      assert.equal(player.nativePosition, 105, 'inactive controls must use the new native implementation');
      player.seekCurrentBy(2000);
      assert.equal(player.nativePosition, 107, 'unchanged native methods must remain reachable without recursive wrapping');
      assert.equal(h.deck.currentTime, 0);
      h.state.active = true;
    }
    h.state._deckTrack = 1;
    assert.equal(player.getCurrentSound().attributes.title, 'B', 'reinstallation must not freeze the custom projection');
  });

  for (const failure of ['locked descriptor', 'definition failure']) {
    test(`a same-player reinstall with ${failure} rolls back without committing bridge identities`, () => {
      let denyDefinition = false;
      const target = { nativeSound: { id: 51 }, getCurrentSound() { return this.nativeSound; } };
      const player = new Proxy(target, {
        defineProperty(object, name, descriptor) {
          if (denyDefinition && name === 'isPlaying') throw new Error('definition denied');
          return Reflect.defineProperty(object, name, descriptor);
        },
      });
      const h = bridgePlaybackHarness(player);
      assert.equal(h.context.installBetterFeedPipBridge(), true);
      const committedOriginals = h.state._pipBridgeOriginals;
      const committedWrappers = h.state._pipBridgeWrappers;
      const replacement = function () { return this.nativeSound; };
      player.getCurrentSound = replacement;
      if (failure === 'locked descriptor') Object.defineProperty(target, 'getCurrentQueueItem', { writable: false });
      else denyDefinition = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(h.context.installBetterFeedPipBridge(), false);
        assert.equal(player.getCurrentSound, replacement, 'rollback must preserve SoundCloud replacement, not an obsolete wrapper');
        assert.equal(player.getCurrentQueueItem, committedWrappers.getCurrentQueueItem);
        assert.equal(player.seekCurrentBy, committedWrappers.seekCurrentBy);
        assert.equal(h.state._pipBridgeOriginals, committedOriginals);
        assert.equal(h.state._pipBridgeWrappers, committedWrappers);
      }
      if (failure === 'locked descriptor') Object.defineProperty(target, 'getCurrentQueueItem', { writable: true });
      else denyDefinition = false;
      assert.equal(h.context.installBetterFeedPipBridge(), true);
      assert.equal(player.getCurrentSound().attributes.title, 'A');
      player.seekCurrentTo(45000);
      assert.equal(h.deck.currentTime, 45);
      h.state.active = false;
      assert.equal(player.getCurrentSound(), target.nativeSound);
      const installed = player.getCurrentSound;
      assert.equal(h.context.installBetterFeedPipBridge(), true);
      assert.equal(player.getCurrentSound, installed);
    });
  }
}

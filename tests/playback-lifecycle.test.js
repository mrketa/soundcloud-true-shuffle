const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

const diagnosticConstants = [
  source.match(/const DIAGNOSTIC_NUMBER_FIELDS = new Set\([\s\S]*?\n\]\);/)?.[0],
  source.match(/const DIAGNOSTIC_BOOLEAN_FIELDS = new Set\([\s\S]*?\n\]\);/)?.[0],
  source.match(/const DIAGNOSTIC_STRING_FIELDS = new Set\([\s\S]*?\n\]\);/)?.[0],
  source.match(/const DIAGNOSTIC_NESTED_FIELDS = new Set\([\s\S]*?\n\]\);/)?.[0],
  source.match(/const DIAGNOSTIC_SAFE_LABELS = \{[\s\S]*?\n\};/)?.[0],
].filter(Boolean).join('\n');
const diagnosticHelpers = [
  'safeDiagnosticVersion', 'playbackErrorName', 'safeDiagnosticString', 'sanitizeDiagnosticRecord',
  'sanitizePlaybackDiagnostics', 'playbackDiagnosticHostWindow',
  'playbackDiagnosticPageKind', 'playbackDiagnosticEnvironment',
  'playbackDiagnosticCapabilities', 'diagnosticDeckStreamKind', 'diagnosticStreamQuality',
];
function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) {
      return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function clock() {
  let now = 0, id = 0;
  const jobs = new Map();
  return {
    jobs,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms = 0) { const token = ++id; jobs.set(token, { fn, at: now + ms }); return token; },
    clearTimeout(token) { jobs.delete(token); },
    async tick(ms) {
      const target = now + ms;
      await flush();
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        jobs.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
function audio() {
  const listeners = new Map();
  return {
    src: '', currentSrc: '', paused: true, ended: false, readyState: 0,
    currentTime: 0, duration: 120, volume: 0, plays: 0, loads: 0, pauses: 0,
    listeners,
    play() { this.plays++; this.paused = false; return Promise.resolve(); },
    pause() { this.pauses++; this.paused = true; },
    load() { this.loads++; this.currentSrc = this.src; },
    removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); },
  };
}
function fixture(names, overrides = {}) {
  const timers = clock();
  const decks = [audio(), audio()];
  const state = {
    active: true, busy: false, loading: false, _playbackEpoch: 1,
    _playbackAbort: new AbortController(), _collectionEpoch: 1, _userPaused: false,
    _decks: decks, _deckIndex: -1, _deckTrack: null, _nativeTrack: null,
    _deckPrepareTokens: [0, 0], _deckTracks: [null, null], _deckGains: [0, 0],
    _deckAudioGraphs: [], _audioContext: null, _crossfadeToken: 0,
    _crossfadePrefetchToken: 0, crossfadeSeconds: 0, _crossfading: false,
    _streamCache: new Map(), _clientId: '', queue: [0, 1, 2], pos: 0,
    meta: [0, 1, 2].map(id => ({ title: `Track ${id}`, link: `https://soundcloud.com/artist/${id}`, sourcePage: 'https://soundcloud.com/artist/likes', durationMs: 120000 })),
    els: [], history: [], playNext: [], roundPlayed: 0, roundTotal: 3,
    stats: { played: 0, playCounts: {} }, skipCounts: {}, priority: {},
  };
  const diagnostics = [];
  const context = {
    state, console, URL, DOMException, AbortController, ...timers,
    document: { body: { contains: () => true }, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, removeEventListener() {} },
    normalizeTrackUrl: value => String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase(),
    ensureCrossfadeDecks: () => state._decks, ensureAutoLevelAudioGraph: () => true,
    currentDeckAudio: () => state._decks[state._deckIndex] || null,
    resumeAudioGraph: async () => true, applyCachedAutoLevel() {}, syncCrossfadeVolume() {},
    setAudioParamImmediately() {}, setCrossfadeStatus() {}, pauseSoundCloudTransport() {}, pauseSoundCloud() {},
    installBetterFeedPipBridge() {}, animateDeckCrossfade: async () => true,
    prefetchUpcomingCrossfadeTrack: async () => {}, refreshPlayBtn() {}, updateProgressBar() {}, updateHub() {},
    recordPlaybackDiagnostic: (type, info) => diagnostics.push({ type, ...info }),
    performance: { now: () => timers.Date.now() },
    trackPlayed: ti => { state.stats.played++; state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1; },
    trackAvailable: ti => Boolean(state.meta[ti] && !state.meta[ti].unavailable),
    consumeCurrentQueueTrack: () => { state.history.push(state.queue.shift()); },
    badges() {}, renderList() {}, updateSleepDisplay() {}, showMergeToast() {},
    pause() { state._userPaused = true; }, stop() { state.active = false; state.busy = false; },
    wait: ms => new Promise(resolve => timers.setTimeout(resolve, ms)),
    ...overrides,
  };
  context.isHlsStreamUrl ||= value => {
    const url = String(value || '').toLowerCase();
    return url.includes('/hls') || url.includes('.m3u8');
  };
  context.loadStreamOnDeck ||= async (audio, _index, streamUrl, timeout, signal, isCurrent, diagnosticTrace) => {
    audio.preload = 'auto';
    audio.src = streamUrl;
    const source = audio.src;
    audio.load();
    const ready = typeof context.waitForDeck === 'function'
      ? await context.waitForDeck(audio, timeout, signal, isCurrent, diagnosticTrace)
      : true;
    return { supported: true, ready, player: null, source, failed: !ready };
  };
  vm.createContext(context);
  vm.runInContext(diagnosticConstants, context);
  vm.runInContext([...new Set([...diagnosticHelpers, ...names])].map(extractFunction).join('\n'), context);
  return { context, state: context.state, timers, decks: context.state._decks, diagnostics };
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const deckFunctions = ['playbackErrorName', 'resetDeck', 'deckIsPreviewLimited', 'prepareCrossfadeDeck'];
const foregroundFunctions = ['resetDeck', 'playDeckWithDeadline', 'playWithCrossfadeDeck', 'withDeadline'];

test('a rejected Next releases only its operation and the second Next still plays', async () => {
  let calls = 0;
  const h = fixture(['runPlaybackOperation', 'next'], { playAt: async () => { if (++calls === 1) throw new Error('decoder failed'); } });
  assert.equal(await h.context.next(), false);
  assert.equal(h.state.busy, false);
  await h.context.next();
  assert.equal(calls, 2);
  assert.equal(h.state.busy, false);
  assert(h.diagnostics.some(item => item.type === 'playback-operation-failed'));
});

test('seek-only Back preserves a pending recovery handoff and resumes from the requested start', async () => {
  const resume = deferred();
  let h;
  h = fixture(['runPlaybackOperation', 'prevTrack', 'recoverCurrentDeckStream',
    'cancelCrossfadeForRecovery', 'resetDeck', 'withDeadline', 'playDeckWithDeadline'], {
    resolveCrossfadeStreams: async () => ['https://media.example/refreshed'],
    loadStreamOnDeck: async (audio, _index, url) => {
      audio.src = url;
      audio.load();
      return { supported: true, ready: true, player: null, source: audio.src };
    },
    waitForDeck: async () => true,
    resumeAudioGraph: () => resume.promise,
    currentSec: () => h.decks[0].currentTime,
    seekTo: () => { h.decks[0].currentTime = 0; },
  });
  h.state._deckIndex = 0;
  h.state._deckTrack = 0;
  h.state._deckTracks[0] = 0;
  h.decks[0].src = 'https://media.example/expired';
  h.decks[0].currentTime = 8;
  const recovery = h.context.recoverCurrentDeckStream(h.decks[0], 8);
  await flush();
  assert.equal(h.decks[0].paused, true);
  await h.context.prevTrack();
  resume.resolve(true);
  assert.equal(await recovery, true);
  assert.equal(h.decks[0].paused, false);
  assert.equal(h.decks[0].currentTime, 0);
});

test('Next cannot race the accepted initial playback operation', async () => {
  const started = deferred();
  let nextCalls = 0;
  const h = fixture(['runPlaybackOperation', 'next'], { playAt: async () => { nextCalls++; } });
  const initial = h.context.runPlaybackOperation('start', () => started.promise);
  await h.context.next();
  assert.equal(nextCalls, 0);
  assert.deepEqual(h.state.queue, [0, 1, 2]);
  assert.equal(h.state.busy, true);
  started.resolve(true);
  await initial;
  await h.context.next();
  assert.equal(nextCalls, 1);
});

test('foreground pending media play exhausts its bounded attempts, unlocks, and later retry works', async () => {
  const h = fixture([...foregroundFunctions, ...deckFunctions.filter(name => name !== 'resetDeck'),
    'playAt', 'runPlaybackOperation', 'next', 'stopCrossfadeDecks'], {
    resolveCrossfadeStreams: async () => ['https://media.example/play'],
    waitForDeck: async () => true,
  });
  h.state.queue = [0, 1];
  h.decks.forEach(deck => { deck.play = () => new Promise(() => {}); });
  const next = h.context.next();
  await h.timers.tick(10000);
  await next;
  assert.equal(h.state.busy, false);
  assert.equal(h.state.suspended, true);
  assert.equal(h.state.stats.played, 0);
  h.decks.forEach(deck => {
    deck.play = () => { deck.paused = false; return Promise.resolve(); };
  });
  await h.timers.tick(5000);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.suspended, false);
  assert.equal(h.state.stats.played, 1);
});
test('diagnostic resource tracing records status and timing without request credentials', async () => {
  let requestUrl = '';
  const h = fixture([
    'playbackErrorName', 'recordCustomStartRequest', 'withDeadline', 'fetchSoundCloudResource',
  ], {
    performance: { now: () => 50 },
    fetch: async (url, options) => {
      requestUrl = String(url);
      assert.equal(options.diagnosticTrace, undefined);
      assert.equal(options.diagnosticStage, undefined);
      return { ok: false, status: 429 };
    },
  });
  const trace = { requestCount: 0, requests: [] };
  const result = await h.context.fetchSoundCloudResource(
    'https://api.soundcloud.com/stream?client_id=private-client&track_authorization=private-track',
    'json',
    { diagnosticTrace: trace, diagnosticStage: 'progressive-stream' },
  );

  assert.equal(result.status, 429);
  assert.match(requestUrl, /private-client/);
  assert.deepEqual(trace.requests, [{
    stage: 'progressive-stream', status: 429, elapsedMs: 0,
  }]);
  assert.equal(JSON.stringify(trace).includes('private-client'), false);
  assert.equal(JSON.stringify(trace).includes('private-track'), false);
});

test('stream lookup trace identifies HTTP rate limiting without preserving request credentials', async () => {
  const requestUrls = [];
  const h = fixture([
    'playbackErrorName', 'recordCustomStartRequest', 'withDeadline', 'fetchSoundCloudResource',
    'createCustomStartTrace', 'discoverSoundCloudClientId', 'discoverSoundCloudClientIdFromBundle',
    'isHlsManifestUrl', 'isHlsStreamUrl', 'directHlsStreamUrls',
    'resolveProgressiveStreams', 'fetchPlaybackTrack', 'resolveCrossfadeStreams',
  ], {
    performance: {
      now: () => 50,
      getEntriesByType: () => [{ name: 'https://api.soundcloud.com/tracks?client_id=private-client' }],
    },
    hydrationTrackForPlayback: () => null,
    syncTrackPlaybackAccess: () => false,
    fetch: async url => {
      requestUrls.push(String(url));
      return { ok: false, status: 429 };
    },
  });
  h.state._diagnosticBuild = true;
  h.state.meta[0].artist = 'Known artist';
  h.state.meta[0].trackAuthorization = 'private-track';
  h.state.meta[0].transcodings = [{
    url: 'https://api.soundcloud.com/stream?signature=private-signature',
    protocol: 'progressive',
    mimeType: 'audio/mpeg',
  }];
  const trace = h.context.createCustomStartTrace(0);

  assert.deepEqual(await h.context.resolveCrossfadeStreams(h.state.meta[0], { diagnosticTrace: trace }), []);
  assert.equal(trace.reason, 'http-rate-limited');
  assert.equal(h.state.meta[0].requiresNativePlayback, undefined, 'HTTP 429 with a known progressive candidate stays on the transient failure path');
  assert.equal(trace.clientIdFound, true);
  assert.equal(trace.clientIdSource, 'resource-history');
  assert.equal(trace.authorizationPresent, true);
  assert.deepEqual(trace.requests.map(request => [request.stage, request.status]), [
    ['progressive-stream', 429],
    ['url-resolve', 429],
  ]);
  assert(requestUrls.some(url => url.includes('private-client')));
  assert.equal(JSON.stringify(trace).includes('private-client'), false);
  assert.equal(JSON.stringify(trace).includes('private-track'), false);
  assert.equal(JSON.stringify(trace).includes('private-signature'), false);
});

test('HLS AAC endpoints resolve to signed manifests for the custom decks', async () => {
  const requests = [];
  const h = fixture([
    'playbackErrorName', 'recordCustomStartRequest', 'withDeadline', 'fetchSoundCloudResource',
    'createCustomStartTrace', 'customStartDiagnosticDetails',
    'discoverSoundCloudClientId', 'discoverSoundCloudClientIdFromBundle',
    'resolveProgressiveStreams', 'isHlsStreamUrl', 'isHlsManifestUrl', 'directHlsStreamUrls',
    'resolveHlsStreamUrls', 'resolveCrossfadeStreams',
  ], {
    performance: {
      now: () => 50,
      getEntriesByType: () => [{ name: 'https://api.soundcloud.com/tracks?client_id=private-client' }],
    },
    hydrationTrackForPlayback: () => null,
    syncTrackPlaybackAccess: () => false,
    fetch: async url => {
      const endpoint = new URL(String(url));
      requests.push(endpoint);
      const quality = endpoint.pathname.includes('aac_160k') ? '160k' : '96k';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: `https://media.example/aac_${quality}/playlist.m3u8?signature=private-stream-token`,
        }),
      };
    },
  });
  h.state._diagnosticBuild = true;
  const meta = h.state.meta[0];
  meta.artist = 'Known artist';
  meta.trackAuthorization = 'private-track';
  meta.transcodings = [
    {
      url: 'https://api.soundcloud.com/tracks/42/streams/aac_96k/hls',
      protocol: 'hls',
      preset: 'aac_96k',
      mimeType: 'application/vnd.apple.mpegurl',
    },
    {
      url: 'https://api.soundcloud.com/tracks/42/streams/aac_160k/hls',
      protocol: 'hls',
      preset: 'aac_160k',
      mimeType: 'application/vnd.apple.mpegurl',
    },
  ];
  const trace = h.context.createCustomStartTrace(0);

  const urls = await h.context.resolveCrossfadeStreams(meta, { diagnosticTrace: trace });

  assert.deepEqual(urls.map(url => new URL(url).pathname), [
    '/aac_160k/playlist.m3u8', '/aac_96k/playlist.m3u8',
  ]);
  assert.equal(requests[0].pathname, '/tracks/42/streams/aac_160k/hls');
  assert.equal(requests[0].searchParams.get('client_id'), 'private-client');
  assert.equal(requests[0].searchParams.get('track_authorization'), 'private-track');
  assert.equal(meta.requiresNativePlayback, undefined);
  assert.equal(trace.progressiveCandidates, 0);
  assert.equal(trace.hlsCandidates, 2);
  assert.equal(trace.hlsStreamUrls, 2);
  assert.equal(trace.hlsMode, 'mse');
  assert.equal(trace.reason, 'hls-mse-candidate');
  const details = h.context.customStartDiagnosticDetails(trace);
  assert.equal(details.hlsCandidates, 2);
  assert.equal(details.hlsStreamUrls, 2);
  assert.equal(details.hlsMode, 'mse');
  assert.deepEqual(trace.requests.map(request => [request.stage, request.status]), [
    ['hls-stream', 200], ['hls-stream', 200],
  ]);
  assert.equal(JSON.stringify(trace).includes('private-client'), false);
  assert.equal(JSON.stringify(trace).includes('private-track'), false);
  assert.equal(JSON.stringify(trace).includes('private-stream-token'), false);
});

test('valid track metadata without supported stream transcodings does not request native playback', async () => {
  let h;
  h = fixture([
    'playbackErrorName', 'recordCustomStartRequest', 'createCustomStartTrace',
    'discoverSoundCloudClientId', 'discoverSoundCloudClientIdFromBundle',
    'isHlsManifestUrl', 'isHlsStreamUrl', 'directHlsStreamUrls',
    'resolveProgressiveStreams', 'fetchPlaybackTrack', 'resolveCrossfadeStreams',
  ], {
    performance: {
      now: () => 50,
      getEntriesByType: () => [{ name: 'https://api.soundcloud.com/tracks?client_id=private-client' }],
    },
    hydrationTrackForPlayback: () => null,
    syncTrackPlaybackAccess: () => false,
    fetchSoundCloudResource: async () => ({
      ok: true,
      status: 200,
      data: {
        id: 42,
        permalink_url: h.state.meta[0].link,
        track_authorization: 'private-track',
        media: { transcodings: [] },
      },
    }),
  });
  h.state._diagnosticBuild = true;
  h.state.meta[0].artist = 'Known artist';
  h.state.meta[0].soundcloudId = 42;
  const trace = h.context.createCustomStartTrace(0);

  assert.deepEqual(await h.context.resolveCrossfadeStreams(h.state.meta[0], { diagnosticTrace: trace }), []);
  assert.equal(trace.trackMetadataFound, true);
  assert.equal(trace.progressiveCandidates, 0);
  assert.equal(trace.hlsCandidates, 0);
  assert.equal(trace.reason, 'unsupported-stream-protocol');
  assert.equal(h.state.meta[0].requiresNativePlayback, undefined);
});

test('HLS manifests play on the existing True Shuffle deck and reset destroys the MSE player', async () => {
  const instances = [];
  class FakeHls {
    constructor(config) { this.config = config; this.handlers = new Map(); this.destroyed = false; instances.push(this); }
    on(event, handler) { this.handlers.set(event, handler); }
    loadSource(url) { this.source = url; }
    attachMedia(audio) {
      this.audio = audio;
      audio.src = 'blob:https://soundcloud.com/true-shuffle';
      audio.currentSrc = audio.src;
      audio.readyState = 2;
      audio.emit('canplay');
    }
    destroy() { this.destroyed = true; }
  }
  FakeHls.Events = { ERROR: 'hlsError' };
  FakeHls.isSupported = () => true;
  const streamUrl = 'https://media.example/aac_160k/playlist.m3u8?signature=private-stream-token';
  const h = fixture([
    'playbackErrorName', 'resetDeck', 'deckIsPreviewLimited', 'prepareCrossfadeDeck',
    'loadStreamOnDeck', 'prepareHlsDeck', 'hlsJsConstructor', 'hlsDiagnosticCode',
    'isHlsStreamUrl', 'waitForDeck',
  ], {
    pageWindow: { Hls: FakeHls },
    resolveCrossfadeStreams: async () => [streamUrl],
  });
  h.state._deckHlsPlayers = [null, null];
  const trace = {};

  const deck = await h.context.prepareCrossfadeDeck(0, 0, { diagnosticTrace: trace });

  assert.equal(deck, h.decks[0]);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].source, streamUrl);
  assert.equal(instances[0].audio, h.decks[0]);
  assert.match(deck.src, /^blob:/);
  assert.equal(h.state._deckHlsPlayers[0], instances[0]);
  assert.equal(h.state._deckTracks[0], 0);
  assert.equal(h.state.meta[0].requiresNativePlayback, undefined);
  assert.equal(trace.hlsMode, 'mse');
  assert.equal(trace.reason, 'media-ready');
  assert.equal(JSON.stringify(trace).includes('private-stream-token'), false);

  h.context.resetDeck(deck, 0);
  assert.equal(instances[0].destroyed, true);
  assert.equal(h.state._deckHlsPlayers[0], null);
  assert.equal(h.state._deckTracks[0], null);
  assert.equal(deck.src, '');
});

test('HLS startup falls back only when MSE is unsupported', async () => {
  class UnsupportedHls {}
  UnsupportedHls.Events = { ERROR: 'hlsError' };
  UnsupportedHls.isSupported = () => false;
  const h = fixture([
    'playbackErrorName', 'resetDeck', 'deckIsPreviewLimited', 'prepareCrossfadeDeck',
    'loadStreamOnDeck', 'prepareHlsDeck', 'hlsJsConstructor', 'hlsDiagnosticCode',
    'isHlsStreamUrl', 'waitForDeck',
  ], {
    pageWindow: { Hls: UnsupportedHls },
    resolveCrossfadeStreams: async () => ['https://media.example/aac_160k/playlist.m3u8'],
  });
  h.state._deckHlsPlayers = [null, null];
  const trace = {};

  assert.equal(await h.context.prepareCrossfadeDeck(0, 0, { diagnosticTrace: trace }), null);
  assert.equal(h.state.meta[0].requiresNativePlayback, true);
  assert.equal(h.state.meta[0].nativePlaybackReason, 'hls-mse-unavailable');
  assert.equal(trace.hlsMode, 'unsupported');
  assert.equal(trace.nativeFallbackReason, 'hls-mse-unavailable');
});

test('fatal HLS manifest errors retain only sanitized type, detail and HTTP status', async () => {
  class FatalHls {
    constructor() { this.handlers = new Map(); }
    on(event, handler) { this.handlers.set(event, handler); }
    loadSource(url) {
      this.source = url;
      this.handlers.get('hlsError')?.('hlsError', {
        fatal: true, type: 'networkError', details: 'manifestLoadError',
        response: { code: 403 }, url: 'https://media.example/playlist.m3u8?private=secret',
      });
    }
    attachMedia(audio) { audio.src = 'blob:https://soundcloud.com/true-shuffle'; }
    destroy() {}
  }
  FatalHls.Events = { ERROR: 'hlsError' };
  FatalHls.isSupported = () => true;
  const h = fixture([
    'prepareHlsDeck', 'resetDeck', 'hlsJsConstructor', 'hlsDiagnosticCode', 'waitForDeck',
  ], { pageWindow: { Hls: FatalHls } });
  h.state._deckHlsPlayers = [null, null];
  h.state._deckIndex = 0;
  h.state._deckTrack = 7;
  h.state._deckTracks[0] = 7;
  const trace = {};

  const result = await h.context.prepareHlsDeck(
    h.decks[0], 0, 'https://media.example/playlist.m3u8?private=secret', 500, null, () => true, trace,
  );

  assert.equal(result.ready, false);
  assert.equal(trace.hlsMode, 'mse');
  assert.equal(trace.hlsErrorType, 'networkError');
  assert.equal(trace.hlsErrorDetail, 'manifestLoadError');
  assert.equal(trace.hlsStatus, 403);
  assert.equal(JSON.stringify(trace).includes('private=secret'), false);
  assert.deepEqual(h.diagnostics.filter(item => item.type === 'hls-playback-failed').map(item => [
    item.trackIndex, item.errorType, item.errorDetail, item.status,
  ]), [[7, 'networkError', 'manifestLoadError', 403]]);
  h.context.resetDeck(h.decks[0], 0);
});

test('fatal HLS after readiness invalidates standby and foreground preparation reloads it', async () => {
  const instances = [];
  class FakeHls {
    constructor() { this.handlers = new Map(); this.destroyed = false; instances.push(this); }
    on(event, handler) { this.handlers.set(event, handler); }
    loadSource(url) { this.source = url; }
    attachMedia(deck) {
      this.audio = deck;
      deck.src = deck.currentSrc = 'blob:https://soundcloud.com/true-shuffle';
      deck.readyState = 2;
      deck.emit('canplay');
    }
    destroy() { this.destroyed = true; }
  }
  FakeHls.Events = { ERROR: 'hlsError' };
  FakeHls.isSupported = () => true;
  let h;
  h = fixture([
    'resetDeck', 'deckIsPreviewLimited', 'prepareCrossfadeDeck', 'loadStreamOnDeck',
    'prepareHlsDeck', 'hlsJsConstructor', 'hlsDiagnosticCode', 'isHlsStreamUrl', 'waitForDeck',
    'upcomingTrackIndex', 'upcomingCrossfadeDeckReady',
  ], {
    pageWindow: { Hls: FakeHls },
    resolveCrossfadeStreams: async () => ['https://media.example/aac_160k/playlist.m3u8'],
    setCrossfadeStatus: status => { if (h) h.state.crossfadeStatus = status; },
  });
  h.state._deckHlsPlayers = [null, null];
  h.state._deckIndex = 0;
  h.state._deckTrack = 0;
  h.state._deckTracks[0] = 0;
  h.state.crossfadeSeconds = 6;
  h.state.crossfadeStatus = 'ready';

  assert.equal(await h.context.prepareCrossfadeDeck(1, 1), h.decks[1]);
  assert.equal(h.context.upcomingCrossfadeDeckReady(), true);
  instances[0].handlers.get('hlsError')('hlsError', {
    fatal: true, type: 'networkError', details: 'fragLoadError',
    response: { code: 503 }, url: 'https://media.example/segment.m4s?signature=private',
  });

  assert.equal(h.state._deckHlsFailed[1], true);
  const failure = h.diagnostics.find(item => item.type === 'hls-playback-failed');
  assert.deepEqual([failure.trackIndex, failure.errorType, failure.errorDetail, failure.status],
    [1, 'networkError', 'fragLoadError', 503]);
  assert.equal(JSON.stringify(failure).includes('private'), false);
  assert.equal(h.state.crossfadeStatus, 'fallback');
  assert.equal(h.context.upcomingCrossfadeDeckReady(), false);
  assert.equal(await h.context.prepareCrossfadeDeck(1, 1), h.decks[1]);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].destroyed, true);
  assert.equal(h.state._deckHlsPlayers[1], instances[1]);
  assert.equal(h.state._deckHlsFailed[1], false);
  assert.equal(h.context.upcomingCrossfadeDeckReady(), true);
});

test('deck readiness diagnostics distinguish media errors from a successful readiness event', async () => {
  const h = fixture(['waitForDeck']);
  const deck = h.decks[0];
  deck.readyState = 1;
  deck.networkState = 3;
  deck.error = { code: 4 };
  const trace = {};
  const pending = h.context.waitForDeck(deck, 5000, null, () => true, trace);
  deck.emit('error');

  assert.equal(await pending, false);
  assert.equal(trace.mediaWaitOutcome, 'error');
  assert.equal(trace.readyState, 1);
  assert.equal(trace.networkState, 3);
  assert.equal(trace.mediaErrorCode, 4);
  assert.equal(deck.listeners.get('error').size, 0);
});

test('media play diagnostics retain rejection class but not media URL or error text', async () => {
  const h = fixture(['withDeadline', 'playDeckWithDeadline']);
  const deck = h.decks[0];
  deck.src = 'https://media.example/track?signature=private-token';
  deck.play = () => Promise.reject(Object.assign(new Error('private-token'), { name: 'NotAllowedError' }));
  const trace = {};

  await assert.rejects(
    h.context.playDeckWithDeadline(deck, 0, null, () => true, trace),
    { name: 'NotAllowedError' },
  );
  assert.equal(trace.failureStage || trace.stage, 'audio-play');
  assert.equal(trace.reason, 'play-rejected');
  assert.equal(trace.errorName, 'NotAllowedError');
  assert.equal(JSON.stringify(trace).includes('private-token'), false);
});

test('diagnostic mode records a failed candidate separately when a later track starts', async () => {
  const h = fixture(['createCustomStartTrace', 'customStartDiagnosticDetails', 'playAt'], {
    stopCrossfadeDecks() {},
    playWithCrossfadeDeck: async (ti, _countPlay, _fade, trace) => {
      if (ti === 0) {
        trace.stage = 'stream-resolution';
        trace.reason = 'http-rate-limited';
        trace.requests.push({ stage: 'progressive-stream', status: 429, elapsedMs: 8 });
        return false;
      }
      return true;
    },
  });
  h.state._diagnosticBuild = true;
  h.state.queue = [0, 1];
  h.state.pos = 0;
  h.context.performance = { now: () => 100 };

  assert.equal(await h.context.playAt(0), true);
  const failed = h.diagnostics.find(entry => entry.type === 'custom-start-candidate-failed');
  const recovered = h.diagnostics.find(entry => entry.type === 'custom-start-recovered');
  assert.equal(failed.trackIndex, 0);
  assert.equal(failed.failureStage, 'stream-resolution');
  assert.equal(failed.failureReason, 'http-rate-limited');
  assert.equal(failed.requests[0].status, 429);
  assert.equal(failed.passExhausted, false);
  assert.equal(recovered.trackIndex, 1);
  assert.equal(recovered.precedingFailedCandidates, 1);
  assert.equal(h.diagnostics.some(entry => entry.type === 'custom-start-exhausted'), false);
});

test('diagnostic mode records terminal queue exhaustion and the scheduled retry', async () => {
  const h = fixture(['createCustomStartTrace', 'customStartDiagnosticDetails', 'playAt', 'runPlaybackOperation'], {
    stopCrossfadeDecks() {},
    playWithCrossfadeDeck: async (_ti, _countPlay, _fade, trace) => {
      trace.stage = 'stream-resolution';
      trace.reason = 'unsupported-stream-protocol';
      trace.requests.push({ stage: 'url-resolve', status: 503, elapsedMs: 17 });
      return false;
    },
  });
  h.state._diagnosticBuild = true;
  h.state.queue = [0];
  h.state.pos = 0;
  h.context.performance = { now: () => 100 };

  assert.equal(await h.context.playAt(0), false);
  const exhausted = h.diagnostics.find(entry => entry.type === 'custom-start-exhausted');
  const retry = h.diagnostics.find(entry => entry.type === 'custom-retry-scheduled');
  assert.equal(exhausted.trackIndex, 0);
  assert.equal(exhausted.attempted, 1);
  assert.equal(exhausted.passExhausted, true);
  assert.equal(exhausted.requests[0].status, 503);
  assert.equal(h.state.suspended, true);
  assert.notEqual(h.state._customPlaybackRetryTimer, null);
  h.context.playWithCrossfadeDeck = async () => true;
  await h.timers.tick(5000);
  const recovered = h.diagnostics.find(entry => entry.type === 'custom-start-recovered');
  assert.equal(recovered.precedingFailedCandidates, 1);
  assert.equal(h.state._customPlaybackRetryTimer, null);
  assert.equal(retry.delayMs, 5000);
  assert.equal(h.state.suspended, false);
});

test('diagnostic snapshot exposes privacy-safe playback state, features, fallback, and retry', () => {
  const h = fixture(['playbackDiagnosticSnapshot'], {
    location: { href: 'https://soundcloud.com/private-user/likes?secret=hidden', pathname: '/you/likes' },
  });
  h.state._diagnosticBuild = true;
  h.state.autoLevel = true;
  h.state.eqEnabled = true;
  h.state.safetyClipper = false;
  h.state.crossfadeSeconds = 4;
  h.state._customPlaybackRetryTimer = 17;
  h.state._nativeTrack = 0;
  h.state.meta[0].nativePlaybackReason = 'hls-mse-unavailable';
  h.state._playbackDiagnostics = [];

  const report = h.context.playbackDiagnosticSnapshot();
  assert.deepEqual(report.state.audioFeatures, {
    autoLevel: true, eqEnabled: true, safetyClipper: false, crossfadeSeconds: 4,
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.pageKind, 'likes');
  assert.equal(report.state.retryPending, true);
  assert.equal(report.state.nativeTrackIndex, 0);
  assert.equal(report.state.nativeFallbackReason, 'hls-mse-unavailable');
  assert.equal('page' in report, false);
  assert.equal('currentTrack' in report.state, false);
  assert.equal(JSON.stringify(report).includes('private-user'), false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('stale operation completion cannot release the busy owner of a restarted session', async () => {
  const old = deferred(), current = deferred();
  const h = fixture(['runPlaybackOperation', 'invalidatePlaybackSession']);
  const first = h.context.runPlaybackOperation('old', () => old.promise);
  h.context.invalidatePlaybackSession();
  const second = h.context.runPlaybackOperation('new', () => current.promise);
  old.reject(new Error('old failure'));
  await first;
  assert.equal(h.state.busy, true);
  current.resolve(true);
  assert.equal(await second, true);
  assert.equal(h.state.busy, false);
});

for (const oldReady of [false, true]) {
  test(`superseded readiness ${oldReady ? 'success' : 'timeout'} cannot reset or publish the replacement deck`, async () => {
    const readiness = [deferred(), deferred()];
    let waits = 0;
    const h = fixture(deckFunctions, {
      resolveCrossfadeStreams: async meta => [`https://media.example/${meta.title}`],
      waitForDeck: () => readiness[waits++].promise,
    });
    const first = h.context.prepareCrossfadeDeck(0, 0);
    await flush();
    const second = h.context.prepareCrossfadeDeck(0, 1);
    await flush();
    readiness[1].resolve(true);
    assert.equal(await second, h.decks[0]);
    const sourceB = h.decks[0].src;
    readiness[0].resolve(oldReady);
    assert.equal(await first, null);
    assert.equal(h.decks[0].src, sourceB);
    assert.equal(h.state._deckTracks[0], 1);
    assert.equal(h.state.meta[0].requiresNativePlayback, undefined);
  });
}

test('aborting readiness settles immediately and removes media listeners and timer', async () => {
  const h = fixture(['waitForDeck']);
  const controller = new AbortController();
  const pending = h.context.waitForDeck(h.decks[0], 5000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(h.decks[0].listeners.get('canplay').size, 0);
  assert.equal(h.decks[0].listeners.get('error').size, 0);
  assert.equal(h.timers.jobs.size, 0);
});

test('graph replacement occurs before preparation captures a physical deck', async () => {
  let h;
  const replacement = audio();
  h = fixture(deckFunctions, {
    ensureAutoLevelAudioGraph() { h.state._decks = [replacement, audio()]; return true; },
    resolveCrossfadeStreams: async () => ['https://media.example/new'], waitForDeck: async () => true,
  });
  const retired = h.decks[0];
  h.state.safetyClipper = true;
  assert.equal(await h.context.prepareCrossfadeDeck(0, 0), replacement);
  assert.equal(retired.src, '');
  assert.equal(replacement.src, 'https://media.example/new');
});

test('accepted collection replacement discards a warmed standby with the same numeric track index', async () => {
  let h;
  const replacement = [0, 1].map(index => ({
    title: index ? 'D' : 'C', link: `https://soundcloud.com/new/${index}`,
    sourcePage: 'https://soundcloud.com/new/likes', durationMs: 120000,
  }));
  h = fixture([...foregroundFunctions, ...deckFunctions.filter(name => name !== 'resetDeck'),
    'invalidatePlaybackSession', 'stopCrossfadeDecks', 'runPlaybackOperation', 'playAt',
    'refreshUpcomingCrossfadePreparation', 'reshuffleCurrentPage'], {
    validPage: () => true, location: { href: 'https://soundcloud.com/new/likes' },
    playlistBase: value => value,
    beginCollectionRequest: () => {
      h.state.busy = h.state.loading = true;
      return { signal: new AbortController().signal };
    },
    collectionRequestCurrent: () => true,
    finishCollectionRequest: () => { h.state.busy = h.state.loading = false; },
    fetchLivePlaylistSnapshot: async () => null,
    loadTracks: async () => [],
    completePlaylistCollection: async () => ({ meta: replacement, els: [null, null] }),
    buildReshuffledQueue: indices => indices,
    resetLiveQueueSync() {}, registerLiveQueueSource() {}, saveLifetimeStats() {}, startWatcher() {},
    resolveCrossfadeStreams: async meta => [`https://media.example/${meta.title}`],
    waitForDeck: async () => true,
  });
  h.state.meta[0].title = 'B';
  h.state.meta[1].title = 'A';
  h.state.queue = [1, 0];
  h.state.playlistUrl = 'https://soundcloud.com/old/likes';
  h.state._liveSyncSources = new Map();
  h.state._deckIndex = 1;
  h.state._deckTrack = 1;
  h.state._deckTracks[1] = 1;
  h.decks[1].src = 'https://media.example/A';
  h.decks[1].paused = false;
  await h.context.prepareCrossfadeDeck(0, 0);
  h.decks[0].readyState = 2;
  assert.equal(h.decks[0].src, 'https://media.example/B');
  await h.context.reshuffleCurrentPage();
  assert.equal(h.state.meta[h.state._deckTrack].title, 'C');
  assert.equal(h.state._decks[h.state._deckIndex].src, 'https://media.example/C');
  assert.equal(h.state.stats.played, 1);
  assert.equal(h.state.busy, false);
});

test('foreground playback repairs a closed graph before choosing its outgoing and incoming decks', async () => {
  let h;
  const repaired = [audio(), audio()];
  h = fixture([...foregroundFunctions, ...deckFunctions.filter(name => name !== 'resetDeck')], {
    ensureAutoLevelAudioGraph() {
      if (h.state._audioContext?.state === 'closed') {
        h.state._decks = repaired;
        h.state._deckIndex = -1;
        h.state._deckTrack = null;
        h.state._deckTracks = [null, null];
        h.state._audioContext = { state: 'running' };
      }
      return true;
    },
    resolveCrossfadeStreams: async () => ['https://media.example/repaired'], waitForDeck: async () => true,
  });
  const retired = h.decks[0];
  retired.src = 'https://media.example/retired';
  retired.paused = false;
  h.state._deckIndex = 0;
  h.state._deckTrack = 0;
  h.state._audioContext = { state: 'closed' };
  assert.equal(await h.context.playWithCrossfadeDeck(1, true, 4), true);
  assert.equal(repaired[0].plays, 1);
  assert.equal(h.state._deckIndex, 0);
  assert.equal(h.state._deckTrack, 1);
  assert.equal(retired.plays, 0);
  assert.equal(h.state.stats.played, 1);
});

test('Stop during stream lookup prevents retry, play, and stale queue rotation after restart', async () => {
  const streams = deferred();
  let lookups = 0;
  const h = fixture([...foregroundFunctions, ...deckFunctions.filter(name => name !== 'resetDeck'), 'playAt', 'invalidatePlaybackSession'], {
    resolveCrossfadeStreams: () => { lookups++; return streams.promise; }, waitForDeck: async () => true,
  });
  const pending = h.context.playAt(0);
  await flush();
  h.context.invalidatePlaybackSession();
  h.state.active = false;
  h.state.active = true;
  h.state._playbackRequest = {};
  h.state.queue = [2, 1];
  h.decks[0].src = 'https://media.example/new-session';
  h.state._deckTracks[0] = 2;
  streams.resolve(['https://media.example/old']);
  assert.equal(await pending, null);
  assert.equal(lookups, 1);
  assert.equal(h.decks[0].plays, 0);
  assert.equal(h.decks[0].src, 'https://media.example/new-session');
  assert.deepEqual(h.state.queue, [2, 1]);
});

test('a second explicit Play rebuilds a failed graph and resumes the same track without recounting it', async () => {
  let h, resumes = 0;
  const freshDecks = [audio(), audio()];
  h = fixture([...foregroundFunctions, ...deckFunctions.filter(name => name !== 'resetDeck'),
    'runPlaybackOperation', 'playAt', 'toggle'], {
    ensureAutoLevelAudioGraph() {
      if (h.state._audioGraphFailed) {
        h.state._decks = freshDecks;
        h.state._deckIndex = -1;
        h.state._deckTrack = null;
        h.state._deckTracks = [null, null];
        h.state._audioGraphFailed = false;
        h.state._audioContext = { state: 'running' };
      }
      return true;
    },
    resumeAudioGraph: async () => {
      if (++resumes === 1) { h.state._audioGraphFailed = true; return false; }
      return true;
    },
    resolveCrossfadeStreams: async () => ['https://media.example/restored'],
    waitForDeck: async () => true,
    currentSec: () => h.state._decks[h.state._deckIndex]?.currentTime || 0,
    seekTo: value => { h.state._decks[h.state._deckIndex].currentTime = value; },
  });
  h.state._audioContext = { state: 'suspended' };
  h.state._deckIndex = 0;
  h.state._deckTrack = 0;
  h.state._deckTracks[0] = 0;
  h.state._userPaused = true;
  h.decks[0].src = 'https://media.example/old-context';
  h.decks[0].currentTime = 8;
  await h.context.toggle();
  assert.equal(h.state._audioGraphFailed, true);
  assert.equal(h.decks[0].plays, 0);
  await h.context.toggle();
  const playing = h.state._decks[h.state._deckIndex];
  assert.equal(playing, freshDecks[0]);
  assert.equal(playing.paused, false);
  assert.equal(playing.currentTime, 8);
  assert.equal(playing.src, 'https://media.example/restored');
  assert.equal(h.state._deckTrack, 0);
  assert.equal(h.state.stats.played, 0);
});

test('pause during preparation preserves the prepared source without starting or counting it', async () => {
  const preparation = deferred();
  const h = fixture([...foregroundFunctions, 'playAt', 'runPlaybackOperation', 'toggle'], { prepareCrossfadeDeck: () => preparation.promise });
  const pending = h.context.playWithCrossfadeDeck(0, true, 0);
  h.decks[0].src = 'https://media.example/prepared';
  h.state._deckTracks[0] = 0;
  h.state._userPaused = true;
  preparation.resolve(h.decks[0]);
  assert.equal(await pending, null);
  assert.equal(h.decks[0].plays, 0);
  assert.equal(h.decks[0].src, 'https://media.example/prepared');
  assert.equal(h.state.stats.played, 0);
  assert.equal(h.state._pendingPlaybackTrack.ti, 0);
  await h.context.toggle();
  assert.equal(h.decks[0].plays, 1);
  assert.equal(h.state._deckTrack, 0);
  assert.equal(h.state.stats.played, 1);
  assert.equal(h.state._userPaused, false);
  assert.equal(h.state._pendingPlaybackTrack, null);
});

test('failed graph resume does not accept paused=false as successful audible playback', async () => {
  let h;
  h = fixture(foregroundFunctions, {
    prepareCrossfadeDeck: async index => {
      h.decks[index].src = 'https://media.example/current';
      h.decks[index].paused = false;
      h.state._deckTracks[index] = 0;
      return h.decks[index];
    },
    resumeAudioGraph: async () => false,
  });
  const trace = {};
  assert.equal(await h.context.playWithCrossfadeDeck(0, true, 0, trace), false);
  assert.equal(trace.stage, 'audio-context-resume');
  assert.equal(trace.reason, 'audio-context-resume-failed');
  assert.equal(trace.errorName, 'Error');
  assert.equal(h.decks[0].plays, 0);
  assert.equal(h.state.stats.played, 0);
  assert.equal(h.decks[0].paused, true);
});

test('a never-settling media play times out and a late fulfillment cannot restart the abandoned attempt', async () => {
  const playing = deferred();
  const h = fixture(['withDeadline', 'playDeckWithDeadline', 'resetDeck']);
  const deck = h.decks[0];
  deck.src = 'https://media.example/pending';
  h.state._deckTracks[0] = 0;
  deck.play = () => playing.promise;
  const pending = h.context.playDeckWithDeadline(deck, 0, h.state._playbackAbort.signal, () => true);
  const rejected = assert.rejects(pending, error => error.name === 'TimeoutError');
  await h.timers.tick(5000);
  await rejected;
  assert.equal(deck.paused, true);
  assert.equal(h.state._deckTracks[0], 0, 'recovery retains the identity it must retry');
  deck.paused = false;
  playing.resolve();
  await flush();
  assert.equal(deck.paused, true);
});

test('late fulfillment from an old preparation cannot pause the same URL in a new preparation', async () => {
  const playing = deferred();
  const h = fixture(['withDeadline', 'playDeckWithDeadline', 'resetDeck']);
  const deck = h.decks[0];
  deck.src = 'https://media.example/reused';
  let current = true;
  deck.play = () => playing.promise;
  const pending = h.context.playDeckWithDeadline(deck, 0, h.state._playbackAbort.signal, () => current);
  current = false;
  h.state._deckPrepareTokens[0]++;
  deck.paused = false;
  playing.resolve();
  assert.equal(await pending, null);
  assert.equal(deck.paused, false);
});

test('a timed-out play cannot pause a later successful resume of the same source and preparation', async () => {
  const oldPlay = deferred();
  const h = fixture(['withDeadline', 'playDeckWithDeadline', 'resetDeck']);
  const deck = h.decks[0];
  deck.src = 'https://media.example/same';
  h.state._deckTracks[0] = 0;
  deck.play = () => oldPlay.promise;
  const first = h.context.playDeckWithDeadline(deck, 0, h.state._playbackAbort.signal, () => true);
  const failed = assert.rejects(first, error => error.name === 'TimeoutError');
  await h.timers.tick(5000);
  await failed;
  deck.play = () => { deck.paused = false; return Promise.resolve(); };
  assert.equal(await h.context.playDeckWithDeadline(deck, 0, h.state._playbackAbort.signal, () => true), true);
  oldPlay.resolve();
  await flush();
  assert.equal(deck.paused, false);
});

test('failed or canceled crossfade result never resets the outgoing deck or counts a play', async () => {
  for (const result of [false, null]) {
    let h;
    h = fixture(foregroundFunctions, {
      prepareCrossfadeDeck: async index => {
        h.decks[index].src = 'https://media.example/incoming';
        h.state._deckTracks[index] = 1;
        return h.decks[index];
      },
      animateDeckCrossfade: async () => result,
    });
    h.state._deckIndex = 0;
    h.state._deckTrack = 0;
    h.decks[0].src = 'https://media.example/outgoing';
    h.decks[0].paused = false;
    assert.equal(await h.context.playWithCrossfadeDeck(1, true, 4), result);
    assert.equal(h.decks[0].src, 'https://media.example/outgoing');
    assert.equal(h.state.stats.played, 0);
  }
});

test('a completed old crossfade cannot reset a restarted session or clear its retry timer', async () => {
  const mixed = deferred();
  let h;
  h = fixture([...foregroundFunctions, 'invalidatePlaybackSession'], {
    prepareCrossfadeDeck: async index => {
      h.decks[index].src = 'https://media.example/old-incoming';
      h.state._deckTracks[index] = 1;
      return h.decks[index];
    },
    animateDeckCrossfade: () => mixed.promise,
  });
  h.state._deckIndex = 0;
  h.decks[0].src = 'https://media.example/old-outgoing';
  h.decks[0].paused = false;
  const pending = h.context.playWithCrossfadeDeck(1, true, 4);
  await flush();
  h.context.invalidatePlaybackSession();
  h.state._playbackRequest = {};
  h.decks[0].src = 'https://media.example/restarted';
  h.state._customPlaybackRetryTimer = 987;
  mixed.resolve(true);
  assert.equal(await pending, null);
  assert.equal(h.decks[0].src, 'https://media.example/restarted');
  assert.equal(h.state._customPlaybackRetryTimer, 987);
  assert.equal(h.state.stats.played, 0);
});

test('a stopped native pre-click delay never clicks an old queue row', async () => {
  let clicks = 0;
  const row = { scrollIntoView() {}, dispatchEvent() {}, querySelector: () => ({ click() { clicks++; } }) };
  const h = fixture(['withDeadline', 'playWithSoundCloudSession', 'invalidatePlaybackSession'], {
    MouseEvent: function MouseEvent() {}, stopCrossfadeDecks() {},
  });
  h.state.meta[0].requiresNativePlayback = true;
  h.state.els = [row];
  const pending = h.context.playWithSoundCloudSession(0);
  h.context.invalidatePlaybackSession();
  h.state.active = false;
  assert.equal(await pending, null);
  await h.timers.tick(1000);
  assert.equal(clicks, 0);
});

const resolverFunctions = [
  'playbackErrorName', 'recordCustomStartRequest',
  'discoverSoundCloudClientId', 'discoverSoundCloudClientIdFromBundle',
  'isHlsManifestUrl', 'isHlsStreamUrl', 'directHlsStreamUrls',
  'resolveProgressiveStreams', 'fetchPlaybackTrack', 'resolveCrossfadeStreams',
];
test('credential rejection skips obsolete A and B then reaches valid bundle C across later retries', async () => {
  const A = 'old-client-a', B = 'old-client-b', C = 'valid-client-cccccccccccccccc';
  const tried = [];
  let bundles = 0;
  const h = fixture(resolverFunctions, {
    performance: { getEntriesByType: () => [{ name: `https://api.example/?client_id=${B}` }, { name: `https://api.example/?client_id=${A}` }] },
    document: { scripts: [{ src: 'https://a-v2.sndcdn.com/assets/current.js' }] },
    hydrationTrackForPlayback: () => null, syncTrackPlaybackAccess: () => false,
    fetchSoundCloudResource: async (url, format) => {
      if (format === 'text') { bundles++; return { ok: true, data: `client_id:"${C}"` }; }
      const client = new URL(url).searchParams.get('client_id');
      tried.push(client);
      return client === C
        ? { ok: true, status: 200, data: { url: 'https://media.example/valid' } }
        : { ok: false, status: 401, data: null };
    },
  });
  const meta = h.state.meta[0];
  meta.artist = 'Known';
  meta.transcodings = [{ url: 'https://api.example/progressive', protocol: 'progressive', mimeType: 'audio/mpeg' }];
  assert.deepEqual(await h.context.resolveCrossfadeStreams(meta), ['https://media.example/valid']);
  assert(tried.includes(A));
  assert(tried.includes(B));
  assert.equal(tried[tried.length - 1], C);
  assert.equal(bundles, 1);
  const before = tried.length;
  assert.deepEqual(await h.context.resolveCrossfadeStreams(meta, { forceRefresh: true }), ['https://media.example/valid']);
  assert.deepEqual(tried.slice(before), [C]);
});

test('a forbidden track cannot blacklist a valid client ID for an unrelated public track', async () => {
  const client = 'valid-client-for-public-tracks';
  const h = fixture(resolverFunctions, {
    performance: { getEntriesByType: () => [{ name: `https://api.example/?client_id=${client}` }] },
    document: { scripts: [] }, hydrationTrackForPlayback: () => null,
    syncTrackPlaybackAccess: () => false,
    fetchSoundCloudResource: async endpoint => {
      const url = new URL(endpoint);
      if (url.pathname === '/public-stream') return { ok: true, status: 200, data: { url: 'https://media.example/public' } };
      return { ok: false, status: 403, data: null };
    },
  });
  const privateTrack = { title: 'Private', link: 'https://soundcloud.com/a/private', artist: 'Artist',
    transcodings: [{ url: 'https://api.example/private-stream', protocol: 'progressive', mimeType: 'audio/mpeg' }] };
  const publicTrack = { title: 'Public', link: 'https://soundcloud.com/a/public', artist: 'Artist',
    transcodings: [{ url: 'https://api.example/public-stream', protocol: 'progressive', mimeType: 'audio/mpeg' }] };
  assert.deepEqual(await h.context.resolveCrossfadeStreams(privateTrack), []);
  assert.deepEqual(await h.context.resolveCrossfadeStreams(publicTrack), ['https://media.example/public']);
});

for (const pendingBody of [false, true]) {
  test(`a pending progressive ${pendingBody ? 'response body' : 'fetch'} cannot hide an earlier working stream`, async () => {
    const stalled = deferred();
    let count = 0;
    const h = fixture(['playbackErrorName', 'withDeadline', 'fetchSoundCloudResource', 'resolveProgressiveStreams'], {
      fetch: () => {
        if (++count === 1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ url: 'https://media.example/working' }) });
        return pendingBody ? Promise.resolve({ ok: true, status: 200, json: () => stalled.promise }) : stalled.promise;
      },
    });
    const pending = h.context.resolveProgressiveStreams({ transcodings: [
      { url: 'https://api.example/a', protocol: 'progressive', mimeType: 'audio/mpeg' },
      { url: 'https://api.example/b', protocol: 'progressive', mimeType: 'audio/ogg' },
    ] }, 'client');
    await h.timers.tick(10000);
    assert.deepEqual(await pending, { urls: ['https://media.example/working'], authFailed: false });
    assert.equal(h.timers.jobs.size, 0);
  });
}

test('expired stream URLs are pruned and large libraries retain only the newest 128 reusable entries', async () => {
  const h = fixture(['resolveCrossfadeStreams', 'isHlsManifestUrl', 'directHlsStreamUrls'], {
    discoverSoundCloudClientIdFromBundle: async () => 'client',
    hydrationTrackForPlayback: meta => meta,
    syncTrackPlaybackAccess: () => false,
    resolveProgressiveStreams: async track => ({ urls: [`https://media.example/${track.title}`], authFailed: false }),
  });
  h.state._streamCache.set('expired', { ts: -1800001, urls: ['old'] });
  for (let i = 0; i < 130; i++) {
    await h.context.resolveCrossfadeStreams({ link: `https://soundcloud.com/a/${i}`, title: String(i), artist: 'Artist' });
  }
  assert.equal(h.state._streamCache.size, 128);
  assert.equal(h.state._streamCache.has('expired'), false);
  assert.equal(h.state._streamCache.has('https://soundcloud.com/a/0'), false);
  assert.deepEqual(await h.context.resolveCrossfadeStreams({ link: 'https://soundcloud.com/a/129' }), ['https://media.example/129']);
});

test('Stop releases active/busy/loading before throwing teardown and still stops the worker and remaining deck', () => {
  let terminated = 0, persisted = 0;
  const h = fixture(['invalidatePlaybackSession', 'resetDeck', 'stopCrossfadeDecks', 'stop'], {
    closeOwnPip() { throw new Error('PiP teardown'); },
    syncBrowserNowPlaying() {}, resetLiveQueueSync() {}, saveLifetimeStats() { persisted++; },
  });
  h.state.busy = h.state.loading = true;
  h.state.worker = { postMessage() { throw new Error('worker send'); }, terminate() { terminated++; } };
  h.decks[0].src = 'a'; h.decks[1].src = 'b';
  h.decks[0].pause = () => { throw new Error('media pause'); };
  const oldSignal = h.state._playbackAbort.signal;
  h.context.stop();
  assert.equal(oldSignal.aborted, true);
  assert.equal(h.state.active, false);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.loading, false);
  assert.equal(h.state._userPaused, true);
  assert.equal(terminated, 1);
  assert.equal(persisted, 1);
  assert.equal(h.decks[1].src, '');
  assert.equal(h.decks[1].paused, true);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`test did not settle: ${name}`)), 2000); }),
      ]);
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`not ok - ${name}`);
      console.error(error.stack || error);
    } finally {
      clearTimeout(timer);
    }
  }
  if (failed) { process.exitCode = 1; console.error(`\n${failed} playback lifecycle regression test(s) failed.`); }
  else console.log('\nAll playback lifecycle regression tests passed.');
})();

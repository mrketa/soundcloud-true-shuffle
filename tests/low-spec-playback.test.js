'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(process.env.TSS_SCRIPT
  ? path.resolve(process.env.TSS_SCRIPT)
  : path.resolve(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return source.slice(source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start, end + 2);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}

function observe(promise) {
  const result = { settled: false };
  Promise.resolve(promise).then(
    value => Object.assign(result, { settled: true, value }),
    error => Object.assign(result, { settled: true, error }),
  );
  return result;
}

function createClock() {
  let now = 100000, nextId = 0;
  const jobs = new Map();
  return {
    now: () => now,
    jobs,
    setTimeout(callback, delay = 0) {
      const id = ++nextId;
      jobs.set(id, { callback, at: now + Math.max(1, delay) });
      return id;
    },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      const target = now + ms;
      await flush();
      let callbacks = 0;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++callbacks <= 2000, 'mock clock must not spin indefinitely');
        now = next[1].at;
        jobs.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function createHarness(t, options = {}) {
  const clock = createClock();
  const players = [];
  const lookups = [];
  const played = [];
  const contexts = [];
  const bindings = new WeakMap();
  const makeAudio = () => {
    const listeners = new Map();
    let src = '';
    return {
      tagName: 'AUDIO', dataset: {}, style: {}, volume: 1, currentTime: 0,
      duration: options.duration ?? 120, paused: true, ended: false, readyState: 0,
      networkState: 1, plays: 0,
      get src() { return src; },
      set src(value) { src = value; this.readyState = 0; this.currentTime = 0; },
      get currentSrc() { return src; },
      play() { this.plays++; this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
      load() {
        this.paused = true;
        if (src && !src.startsWith('blob:')) { this.readyState = 4; this.emit('canplay'); }
      },
      removeAttribute(name) { if (name === 'src') { src = ''; this.readyState = 0; } },
      remove() { this.removed = true; },
      addEventListener(type, callback, settings) {
        const entries = listeners.get(type) || [];
        entries.push({ callback, once: settings?.once });
        listeners.set(type, entries);
      },
      removeEventListener(type, callback) {
        listeners.set(type, (listeners.get(type) || []).filter(entry => entry.callback !== callback));
      },
      emit(type) {
        for (const entry of [...(listeners.get(type) || [])]) {
          if (entry.once) this.removeEventListener(type, entry.callback);
          entry.callback({ target: this });
        }
      },
      listenerCount: () => [...listeners.values()].reduce((count, entries) => count + entries.length, 0),
    };
  };
  const param = value => ({
    value,
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; },
    linearRampToValueAtTime() {},
  });
  const node = (kind, context) => ({
    kind, context, connections: [], gain: param(1), frequency: param(0), Q: param(0),
    connect(target) {
      assert.equal(context.state, 'running', 'cannot route a retired context');
      this.connections.push(target);
    },
    disconnect() { this.connections = []; },
  });
  class AudioContext {
    constructor() {
      this.state = 'running';
      this.destination = node('destination', this);
      contexts.push(this);
    }
    get currentTime() { return clock.now() / 1000; }
    createGain() { return node('gain', this); }
    createWaveShaper() { return node('clipper', this); }
    createBiquadFilter() { return node('filter', this); }
    createAnalyser() { return node('analyser', this); }
    createMediaElementSource(audio) {
      assert.equal(bindings.has(audio), false, 'media elements cannot be rebound');
      const result = node('source', this);
      bindings.set(audio, result);
      return result;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  class Hls {
    static Events = {
      ERROR: 'hlsError', MEDIA_ATTACHED: 'mediaAttached',
      MANIFEST_PARSED: 'manifestParsed', FRAG_LOADED: 'fragLoaded', FRAG_BUFFERED: 'fragBuffered',
    };
    static isSupported() { return true; }
    constructor() {
      this.handlers = new Map(); this.sources = []; this.destroyed = false;
      players.push(this);
    }
    on(type, callback) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type).add(callback);
    }
    off(type, callback) { this.handlers.get(type)?.delete(callback); }
    emit(type, data) {
      for (const callback of [...(this.handlers.get(type) || [])]) callback(type, data);
    }
    loadSource(url) {
      this.sources.push(url); this.url = url;
      this.emit(Hls.Events.MANIFEST_PARSED);
    }
    attachMedia(audio) {
      this.media = audio;
      audio._attachedPlayer = this;
      audio.src = `blob:hls-${players.indexOf(this)}`;
      for (const callback of [...(this.handlers.get(Hls.Events.MEDIA_ATTACHED) || [])]) callback();
      if (options.autoBuffer || this.buffered) this.buffer();
    }
    buffer() {
      if (this.destroyed) return;
      this.buffered = true;
      this.emit(Hls.Events.FRAG_LOADED);
      if (this.media?._attachedPlayer !== this) return;
      this.emit(Hls.Events.FRAG_BUFFERED);
      this.media.readyState = 4;
      this.media.emit('canplay');
    }
    destroy() {
      this.destroyed = true;
      if (this.media?._attachedPlayer === this) {
        this.media._attachedPlayer = null;
        this.media.pause();
        this.media.removeAttribute('src');
      }
      this.handlers.clear();
    }
  }
  const state = {
    active: true, busy: false, _playbackEpoch: 1, _collectionEpoch: 1,
    _playbackAbort: new AbortController(), _playbackRequest: null, _userPaused: false,
    _decks: [makeAudio(), makeAudio()], _deckIndex: 0, _deckTrack: 0,
    _deckTracks: [0, null], _deckGains: [1, 0], _deckPrepareTokens: [0, 0],
    _deckAudioGraphs: [], _audioContext: null, _audioGraphFailed: false,
    _crossfadeToken: 0, _crossfadePrefetchToken: 0, _crossfading: false,
    _crossfadeSchedule: null, _crossfadeStreamWarmup: null,
    _streamCache: new Map(), _autoLevelCache: {},
    autoLevel: false, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    safetyClipper: false, playbackVolume: 0.4,
    crossfadeSeconds: 2, crossfadeCurve: 'clean', playNext: [], queue: [0, 1, 2, 3], pos: 0,
    meta: [0, 1, 2, 3].map(id => ({ id, title: `Track ${id}`, link: `https://soundcloud.com/test/${id}`, durationMs: (options.duration ?? 120) * 1000 })),
  };
  const context = vm.createContext({
    state, console, URL, AbortController, DOMException, Float32Array,
    window: { AudioContext }, pageWindow: { Hls },
    document: { createElement: makeAudio, body: { appendChild() {} }, getElementById: () => null },
    EQ_BANDS: [60, 230, 910, 3600, 14000].map(frequency => ({ type: 'peaking', frequency, q: 1 })),
    CROSSFADE_MIN_DURATION_SECONDS: 0.25,
    Date: { now: clock.now }, performance: { now: clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    trackId: meta => String(meta?.id ?? ''), normalizeTrackUrl: url => String(url || ''),
    playbackErrorName: error => error?.name || 'Error', recordPlaybackDiagnostic() {},
    resolveCrossfadeStreams: async (meta, request) => {
      lookups.push({ meta, request });
      return options.resolve ? options.resolve(meta, request) : [`https://media.example/${meta.id}/playlist.m3u8`];
    },
    currentDeckAudio: () => state._decks[state._deckIndex] || null,
    diagnosticDeckStreamKind: () => 'hls-mse', diagnosticStreamQuality: () => 'aac-160',
    setCrossfadeStatus: value => { state.crossfadeStatus = value; },
    pauseSoundCloudTransport() {}, pauseSoundCloud() {}, installBetterFeedPipBridge() {},
    refreshPlayBtn() {}, updateProgressBar() {}, updateHub() {},
    trackPlayed: ti => played.push(ti),
    safeStorage: { setItem() {} }, syncPlaybackVolumeControls() {},
    syncCrossfadeVolume() {},
  });
  const functions = [
    'withDeadline', 'invalidatePlaybackSession', 'ensureCrossfadeDecks',
    'autoLevelTrackKey', 'calculateAutoLevelGain', 'applyCachedAutoLevel',
    'ensureAutoLevelAudioGraph', 'retireAudioGraph', 'syncEqualizer', 'syncDeckProcessingRouting',
    'resumeAudioGraph', 'setAutoLevelEnabled', 'setAudioParamImmediately',
    ...(source.includes('function schedulePairedCrossfade(')
      ? ['crossfadeAutomationPlan', 'schedulePairedCrossfade']
      : ['scheduleAudioParamCurve']),
    ...(source.includes('function crossfadeAutomationTiming(') ? ['crossfadeAutomationTiming'] : []),
    'hlsJsConstructor', 'hlsDiagnosticCode', 'isHlsStreamUrl', 'prepareHlsDeck', 'loadStreamOnDeck',
    'waitForDeck', 'resetDeck', 'stopCrossfadeDecks', 'deckIsPreviewLimited', 'prepareCrossfadeDeck',
    'crossfadeGains', 'waitForCrossfadeSchedule', 'animateDeckCrossfade',
    'destroyCrossfadePreflight', 'preflightCrossfadeHls', 'warmUpcomingCrossfadeStreams',
    'upcomingTrackIndex', 'upcomingCrossfadeDeckReady', 'prefetchUpcomingCrossfadeTrack', 'refreshUpcomingCrossfadePreparation',
    'playDeckWithDeadline', 'playWithCrossfadeDeck',
  ];
  // The older implementation has no split preparation body; exercise its real behavior too.
  if (source.includes('function runCrossfadeDeckPreparation(')) {
    functions.push('crossfadePreparationMatches', 'runCrossfadeDeckPreparation');
  }
  vm.runInContext(functions.map(extractFunction).join('\n'), context);
  const original = state._decks[0];
  original.src = 'https://media.example/current.mp3';
  original.load(); original.paused = false;
  t.after(async () => {
    state.active = false;
    context.invalidatePlaybackSession();
    context.stopCrossfadeDecks();
    await flush();
    for (const player of players) if (!player.destroyed) player.destroy();
    clock.jobs.clear();
    assert.equal(state._decks.every(audio => audio.listenerCount() === (audio._tssTransitionMedia ? 3 : 0)),
      true, 'media wait listeners are released; only one transition observer remains per deck');
  });
  return { context, state, clock, players, lookups, played, contexts };
}

function assertFinished(result, value, message) {
  assert.equal(result.settled, true, message);
  assert.ifError(result.error);
  assert.equal(result.value, value, message);
}

async function beginFade(h) {
  h.state.pos = 1;
  const result = observe(h.context.playWithCrossfadeDeck(1, true, 2));
  await flush();
  assert.equal(h.state._crossfading, true, 'a real two-deck handoff is underway');
  assert.ok(h.state._crossfadeSchedule, 'the handoff uses the audio clock');
  return result;
}

test('an unrelated queue refresh during a fade completes playback and releases mixing', async t => {
  const h = createHarness(t, { autoBuffer: true });
  const outgoing = h.state._decks[0];
  const result = await beginFade(h);
  h.state.queue.push(0);
  h.context.refreshUpcomingCrossfadePreparation();
  await h.clock.advance(2400);
  assertFinished(result, true, 'queue maintenance must not cancel the audible handoff');
  assert.equal(h.state._crossfading, false);
  assert.equal(h.state._crossfadeSchedule, null);
  assert.equal(h.state.crossfadeStatus, 'ready');
  assert.equal(outgoing.paused, true);
  assert.equal(h.state._decks[1].paused, false);
  assert.equal(h.state._deckTrack, 1);
  assert.deepEqual(h.played, [1]);
  assert.equal(h.state._deckTracks[0], 2, 'the released deck can prepare the following track');
});

test('changing lookahead during a fade cancels only stale lookahead and prepares the authoritative target', async t => {
  const oldLookahead = deferred();
  const h = createHarness(t, {
    autoBuffer: true,
    resolve: meta => meta.id === 2 ? oldLookahead.promise : [`https://media.example/${meta.id}/playlist.m3u8`],
  });
  const result = await beginFade(h);
  const incoming = h.state._decks[1];
  const incomingSource = incoming.src;
  const oldRequest = h.lookups.find(item => item.meta.id === 2).request;
  h.state.playNext = [3];
  h.context.refreshUpcomingCrossfadePreparation();
  assert.equal(oldRequest.signal.aborted, true, 'obsolete speculative lookup is canceled');
  assert.equal(incoming.src, incomingSource);
  assert.equal(incoming.paused, false);
  oldLookahead.resolve(['https://media.example/stale/playlist.m3u8']);
  await h.clock.advance(2400);
  assertFinished(result, true, 'a queue target change must not invalidate either mixing deck');
  assert.equal(h.state._crossfading, false);
  assert.equal(h.state._deckTracks[0], 3);
  assert.equal(h.players.some(player => player.sources.includes('https://media.example/stale/playlist.m3u8')), false);
  assert.equal(h.state._deckTrack, 1);
  assert.deepEqual(h.played, [1]);
});

test('a buffered short-track preflight survives unrelated refresh and is adopted after the fade', async t => {
  const h = createHarness(t, { autoBuffer: true, duration: 4 });
  const result = await beginFade(h);
  const preflight = h.players.find(player => player.url.includes('/2/'));
  assert.ok(preflight && !preflight.media, 'lookahead manifest is fetched while both decks are occupied');
  preflight.buffer();
  h.state.queue.push(0);
  h.context.refreshUpcomingCrossfadePreparation();
  await h.clock.advance(2400);
  assertFinished(result, true, 'the current short-track fade must finish');
  assert.equal(h.state._deckHlsPlayers[0], preflight, 'the downloaded lookahead remains usable on the released deck');
  assert.equal(preflight.destroyed, false);
  assert.equal(preflight.media, h.state._decks[0]);
  assert.equal(h.state._decks[0].readyState, 4);
  assert.deepEqual(preflight.sources, ['https://media.example/2/playlist.m3u8']);
});

test('an in-flight HLS standby survives unrelated queue refresh and becomes playable without a second buffer', async t => {
  const h = createHarness(t);
  const pending = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await flush();
  const player = h.players[0];
  assert.ok(player?.media, 'the standby is waiting for its first media buffer');
  h.state.queue.push(0);
  h.context.refreshUpcomingCrossfadePreparation();
  player.buffer();
  await h.clock.advance(2);
  assertFinished(pending, h.state._decks[1], 'the existing network/media preparation must satisfy standby readiness');
  assert.equal(player.destroyed, false);
  assert.equal(h.state._deckHlsPlayers[1], player);
  assert.equal(h.state._deckTracks[1], 1);
  assert.equal(h.state._decks[1].readyState, 4);
  assert.equal(h.state._decks[0].paused, false, 'the current track continues playing');
});

test('a ready HLS standby stays immediately playable after unrelated queue refresh', async t => {
  const options = { autoBuffer: true };
  const h = createHarness(t, options);
  const ready = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await flush();
  assertFinished(ready, h.state._decks[1], 'the standby begins with usable buffered media');
  const player = h.players[0];
  // No later request is allowed an automatic buffer: startup must use the ready deck.
  options.autoBuffer = false;
  h.state.queue.push(0);
  h.context.refreshUpcomingCrossfadePreparation();
  await flush();
  h.state.pos = 1;
  const result = observe(h.context.playWithCrossfadeDeck(1, true, 0));
  await flush();
  assertFinished(result, true, 'refreshing unrelated rows must not discard the ready-to-play target');
  assert.equal(h.state._deckHlsPlayers[1], player);
  assert.equal(player.destroyed, false);
  assert.equal(h.state._decks[1].paused, false);
  assert.deepEqual(h.played, [1]);
});

test('changing a pending standby target cancels its old media and starts only the new target', async t => {
  const h = createHarness(t);
  const stale = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await flush();
  const oldPlayer = h.players[0];
  h.state.playNext = [3];
  h.context.refreshUpcomingCrossfadePreparation();
  await flush();
  const player = h.state._deckHlsPlayers[1];
  assert.ok(player && player !== oldPlayer, 'the authoritative target owns the standby media');
  assert.equal(oldPlayer.destroyed, true);
  oldPlayer.buffer();
  assert.equal(h.state._decks[1].readyState, 0, 'stale media cannot make the replacement appear ready');
  player.buffer();
  await flush();
  assert.equal(stale.settled, true);
  assert.equal(h.state._deckTracks[1], 3);
  assert.equal(h.state._decks[1].readyState, 4);
  h.state.playNext = [];
  h.state.pos = 3;
  const result = observe(h.context.playWithCrossfadeDeck(3, true, 0));
  await flush();
  assertFinished(result, true, 'only the newly buffered target can become foreground playback');
  assert.equal(h.state._deckTrack, 3);
  assert.equal(h.state._decks[1].plays, 1);
  assert.equal(h.state._decks[1].paused, false);
  assert.deepEqual(h.played, [3]);
});

test('foreground Next promotes the exact in-flight standby and starts the correct track once', async t => {
  const h = createHarness(t);
  const pending = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await flush();
  const player = h.players[0];
  h.state._playbackRequest = { operationId: 1 };
  h.state.busy = true;
  h.state.pos = 1;
  const foreground = observe(h.context.playWithCrossfadeDeck(1, true, 0));
  await flush();
  player.buffer();
  await h.clock.advance(2);
  assertFinished(foreground, true, 'the already downloading target must start without abandoning its buffer');
  assert.equal(h.state._deckTrack, 1);
  assert.equal(h.state._decks[1].paused, false);
  assert.equal(h.state._decks[1].plays, 1);
  assert.equal(h.state._deckHlsPlayers[1], player);
  assert.equal(player.destroyed, false);
  assert.deepEqual(player.sources, ['https://media.example/1/playlist.m3u8']);
  assert.deepEqual(h.played, [1]);
  assert.equal(pending.settled, true, 'the displaced lookahead consumer also settles');
});

test('foreground promotion also keeps the speculative stream lookup usable after consuming its queue slot', async t => {
  const lookups = [];
  const h = createHarness(t, {
    autoBuffer: true,
    resolve: meta => {
      if (meta.id !== 1) return [`https://media.example/${meta.id}/playlist.m3u8`];
      const lookup = deferred();
      lookups.push(lookup);
      return lookup.promise;
    },
  });
  t.after(() => lookups.forEach(lookup => lookup.resolve([])));
  h.context.warmUpcomingCrossfadeStreams();
  await flush();
  const pending = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await flush();
  h.state.pos = 1;
  h.state._playbackRequest = { operationId: 1 };
  h.state.busy = true;
  const foreground = observe(h.context.playWithCrossfadeDeck(1, true, 0));
  await flush();
  // Only the original request has completed; an unnecessary restart has no buffer to play.
  lookups[0].resolve(['https://media.example/1/playlist.m3u8']);
  await flush();
  assertFinished(foreground, true, 'consuming the queue slot must transfer the lookup to its foreground owner');
  assert.equal(h.state._deckTrack, 1);
  assert.equal(h.state._decks[1].paused, false);
  assert.equal(h.state._decks[1].plays, 1);
  assert.equal(h.state._deckHlsPlayers[1].url, 'https://media.example/1/playlist.m3u8');
  assert.equal(h.lookups.filter(item => item.meta.id === 1).length, 1, 'the existing lookup supplies playback rather than a replacement request');
  assert.equal(pending.settled, true);
  assert.deepEqual(h.played, [1]);
});

test('replacing metadata for a ready queue index cannot replay the former track source', async t => {
  const h = createHarness(t, {
    autoBuffer: true,
    resolve: meta => [`https://media.example/${meta.variant || meta.id}/playlist.m3u8`],
  });
  const ready = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await flush();
  assertFinished(ready, h.state._decks[1], 'the old metadata owns a fully prepared standby');
  const oldPlayer = h.state._deckHlsPlayers[1];
  h.state.meta[1] = { ...h.state.meta[1], variant: 'replacement' };
  h.state.pos = 1;
  const result = observe(h.context.playWithCrossfadeDeck(1, true, 0));
  await flush();
  assertFinished(result, true, 'the replacement identity must be playable at the existing queue index');
  assert.equal(h.state._deckHlsPlayers[1].url, 'https://media.example/replacement/playlist.m3u8');
  assert.notEqual(h.state._deckHlsPlayers[1], oldPlayer);
  assert.equal(oldPlayer.destroyed, true);
  assert.equal(h.state._decks[1].paused, false);
  assert.deepEqual(h.played, [1]);
});

for (const change of ['stop and restart', 'replace metadata']) {
  test(`${change} cancels stale preparation rather than promoting it into a new track identity`, async t => {
    const oldLookup = deferred();
    const h = createHarness(t, {
      autoBuffer: true,
      resolve: meta => meta === oldMeta ? oldLookup.promise : ['https://media.example/replacement/playlist.m3u8'],
    });
    const oldMeta = h.state.meta[1];
    const old = observe(h.context.prefetchUpcomingCrossfadeTrack());
    await flush();
    const oldSignal = h.lookups[0].request.signal;
    if (change === 'stop and restart') {
      h.state.active = false;
      h.context.invalidatePlaybackSession();
      h.context.stopCrossfadeDecks();
      h.state.active = true;
    } else {
      h.state.meta[1] = { ...oldMeta, link: 'https://soundcloud.com/test/replacement' };
    }
    // A new foreground operation must not consume a promise owned by the old session/metadata.
    if (change === 'stop and restart') h.state.meta[1] = { ...oldMeta };
    h.state._playbackRequest = { operationId: 2 };
    h.state.pos = 1;
    const current = observe(h.context.playWithCrossfadeDeck(1, true, 0));
    await flush();
    assertFinished(current, true, 'replacement playback cannot wait for the obsolete request');
    assert.equal(oldSignal.aborted, true);
    const currentAudio = h.state._decks[h.state._deckIndex];
    const currentPlayer = h.state._deckHlsPlayers[h.state._deckIndex];
    const currentSource = currentAudio.src;
    oldLookup.resolve(['https://media.example/obsolete/playlist.m3u8']);
    await h.clock.advance(2);
    assert.equal(old.settled, true);
    assert.equal(currentAudio.src, currentSource);
    assert.equal(currentAudio.paused, false);
    assert.equal(h.state._deckHlsPlayers[h.state._deckIndex], currentPlayer);
    assert.equal(h.players.some(player => player.sources.includes('https://media.example/obsolete/playlist.m3u8')), false);
    assert.deepEqual(h.played, [1]);
  });
}

test('a failed speculative warmup still falls back to successful ordinary preparation', async t => {
  let attempts = 0;
  const h = createHarness(t, {
    autoBuffer: true,
    resolve: meta => {
      if (meta.id === 1 && ++attempts === 1) throw new Error('temporary speculative endpoint failure');
      return [`https://media.example/${meta.id}/playlist.m3u8`];
    },
  });
  h.context.warmUpcomingCrossfadeStreams();
  await flush();
  const ready = observe(h.context.prefetchUpcomingCrossfadeTrack());
  await h.clock.advance(2);
  assertFinished(ready, h.state._decks[1], 'speculative failure must not poison the later playable standby');
  assert.equal(h.state._deckTracks[1], 1);
  assert.equal(h.state._decks[1].readyState, 4);
  assert.equal(h.state._decks[0].paused, false);
});

function routeToDestination(graph, context) {
  const paths = [];
  const visit = (current, route) => {
    assert.equal(route.includes(current), false, 'processing topology cannot contain a feedback loop');
    const nextRoute = [...route, current];
    if (current === context.destination) { paths.push(nextRoute); return; }
    for (const next of current.connections) visit(next, nextRoute);
  };
  visit(graph.source, []);
  assert.equal(paths.length, 1, 'each deck must have exactly one audible route, without silence or parallel bypass');
  return paths[0];
}

function assertProcessing(h, graph, eq, auto, expectedGain) {
  const route = routeToDestination(graph, h.state._audioContext);
  const expected = [graph.source, ...(eq ? graph.eqFilters : []),
    ...(auto ? [graph.analyser, graph.autoGain] : []), graph.mixGain, h.state._audioMaster,
    h.state._audioContext.destination];
  assert.equal(route.length, expected.length);
  route.forEach((node, index) => assert.equal(node, expected[index]));
  graph.eqFilters.forEach((filter, index) => assert.equal(filter.gain.value, eq ? h.state.eqBands[index] : 0));
  assert.equal(graph.autoGain.gain.value, auto ? expectedGain : 1);
}

test('reusing the audio graph preserves EQ band edits and AutoLevel on/off/on audible topology', t => {
  const h = createHarness(t);
  h.state._deckTracks = [0, 1];
  assert.equal(h.context.ensureAutoLevelAudioGraph(), true);
  const graphs = h.state._deckAudioGraphs;
  const context = h.state._audioContext;
  const cacheMeasurements = () => {
    for (const ti of h.state._deckTracks) {
      h.state._autoLevelCache[h.context.autoLevelTrackKey(ti)] = { rms: 0.45, peak: 0.95 };
    }
  };
  for (const [eq, auto] of [[false, false], [true, false], [true, true], [false, true], [false, false], [true, true]]) {
    h.state.eqEnabled = eq;
    h.state.eqBands = [3, -2, 1, -4, 2];
    cacheMeasurements();
    h.context.syncEqualizer();
    assert.equal(h.context.setAutoLevelEnabled(auto), true);
    assert.equal(h.context.ensureAutoLevelAudioGraph(), true);
    assert.equal(h.context.ensureAutoLevelAudioGraph(), true);
    assert.equal(h.state._audioContext, context);
    assert.equal(h.state._deckAudioGraphs, graphs);
    graphs.forEach(graph => assertProcessing(h, graph, eq, auto, 0.5));
  }
  h.state.eqBands = [-5, 2, 4, 0, -1];
  cacheMeasurements();
  h.context.syncEqualizer();
  h.context.ensureAutoLevelAudioGraph();
  graphs.forEach(graph => assertProcessing(h, graph, true, true, 0.5));
});

test('unchanged processing flags still apply to replacement graphs after a closed context', t => {
  const h = createHarness(t);
  h.state.eqEnabled = true;
  h.state.autoLevel = true;
  h.state.eqBands = [4, -3, 2, -1, 5];
  assert.equal(h.context.ensureAutoLevelAudioGraph(), true);
  const oldContext = h.state._audioContext;
  const oldDecks = h.state._decks.slice();
  oldContext.close();
  assert.equal(h.context.ensureAutoLevelAudioGraph(), true);
  assert.notEqual(h.state._audioContext, oldContext);
  assert.equal(h.state._decks.some(audio => oldDecks.includes(audio)), false);
  assert.equal(h.state._decks.length, 2);
  h.state._deckAudioGraphs.forEach(graph => assertProcessing(h, graph, true, true, graph.currentGain));
});

function createQueueHarness(t) {
  const clock = createClock();
  class QueueNode {
    constructor(tag, document) {
      this.tagName = tag.toUpperCase(); this.ownerDocument = document;
      this.nodeType = tag === '#fragment' ? 11 : 1;
      this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {};
      this.style = {};
      let cssText = '';
      Object.defineProperty(this.style, 'cssText', {
        get: () => cssText,
        set: value => {
          cssText = String(value);
          for (const key of Object.keys(this.style)) delete this.style[key];
          for (const declaration of cssText.split(';')) {
            const colon = declaration.indexOf(':');
            if (colon < 0) continue;
            const name = declaration.slice(0, colon).trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            this.style[name] = declaration.slice(colon + 1).trim();
          }
        },
      });
      this.className = ''; this._text = ''; this._scrollTop = 0; this.clientHeight = 280;
      this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
    }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    get nextSibling() {
      const siblings = this.parentNode?.children || [];
      return siblings[siblings.indexOf(this) + 1] || null;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, reference) {
      if (node === reference) return node;
      for (const child of node.nodeType === 11 ? [...node.children] : [node]) {
        child.remove();
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        assert.ok(index >= 0, 'insertion reference must belong to its parent');
        this.children.splice(index, 0, child);
        child.parentNode = this;
      }
      return node;
    }
    replaceChildren(...nodes) {
      this.children.forEach(child => { child.parentNode = null; });
      this.children = []; this._text = ''; this._scrollTop = 0;
      this.append(...nodes);
    }
    replaceChild(node, previous) {
      this.insertBefore(node, previous);
      previous.remove();
      return previous;
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    set innerHTML(html) {
      this.textContent = '';
      const stack = [this];
      for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
        const tag = /^<([\w-]+)/.exec(token)?.[1];
        if (!tag) continue;
        const child = this.ownerDocument.createElement(tag);
        for (const match of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
          child.setAttribute(match[1], match[2] ?? match[3] ?? '');
        }
        stack.at(-1).appendChild(child);
        if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag) && !token.endsWith('/>')) stack.push(child);
      }
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'class') this.className = String(value);
      if (name === 'id' || name === 'src') this[name] = String(value);
    }
    getAttribute(name) { return name === 'src' ? this.src ?? null : this.attributes[name] ?? null; }
    get scrollHeight() { return this.children.length * 56; }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    scrollIntoView() {
      const parent = this.parentNode;
      if (!parent || parent.id !== 'tss-sidebar-list') return;
      const top = parent.children.indexOf(this) * 56;
      if (top < parent.scrollTop) parent.scrollTop = top;
      else if (top + 56 > parent.scrollTop + parent.clientHeight) parent.scrollTop = top + 56 - parent.clientHeight;
    }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      return this.tagName.toLowerCase() === selector;
    }
    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (child.matches(selector)) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const listeners = new Map();
  const document = {
    createElement: tag => new QueueNode(tag, document),
    createDocumentFragment: () => new QueueNode('#fragment', document),
    getElementById: id => document.body.querySelector(`#${id}`),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  document.body = document.createElement('body');
  const list = document.createElement('div');
  list.id = 'tss-sidebar-list';
  const search = document.createElement('input');
  search.id = 'tss-search'; search.value = '';
  const count = document.createElement('div');
  count.id = 'tss-sidebar-count';
  document.body.append(list, search, count);
  const played = [], jumpRequests = [];
  const state = {
    active: true, busy: false, sidebarOpen: true, sidebarTab: 'queue', reduceVisualEffects: false,
    _playbackEpoch: 1, _playbackRequest: null, _deckTrack: 0,
    pos: 0, roundPlayed: 0, roundTotal: 40, stopAfterRound: false,
    queue: Array.from({ length: 40 }, (_, id) => id), playNext: [], history: [], dragSrc: null,
    stats: { played: 1 }, meta: Array.from({ length: 40 }, (_, id) => ({
      id, title: `${id % 2 ? 'Odd' : 'Even'} track ${id}`, artist: `Artist ${id}`,
      artwork: `https://images.example/${id}.jpg`, link: `https://soundcloud.com/test/${id}`,
    })),
  };
  const context = vm.createContext({
    state, document, Date: { now: clock.now },
    window: {
      innerWidth: 1200, innerHeight: 800,
      matchMedia: () => ({ matches: false }),
    },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    SVG: vm.runInNewContext(`${source.match(/const SVG = \{[\s\S]*?\n\};/)[0]}\nSVG;`),
    esc: value => String(value),
    trackAvailable: ti => Boolean(state.meta[ti] && !state.meta[ti].unavailable),
    buildBalancedRound: indices => indices.slice(),
    refreshPlayBtn() {}, refreshUpcomingCrossfadePreparation() {}, badges() {}, updateHub() {},
    recordPlaybackDiagnostic() {}, playbackErrorName: error => error?.name || 'Error',
    navigator: { clipboard: { writeText: async () => {} } },
    playAt: async (ti, countPlay = true) => {
      state._deckTrack = ti;
      if (countPlay) state.stats.played++;
      played.push(ti);
      return true;
    },
  });
  vm.runInContext([
    'renderList', 'renderHistory', 'mkRow', 'showCtxMenu', 'consumeCurrentQueueTrack',
    'finalizeLeavingCurrentTrack', 'recountRoundTotal', 'moveSelectedTrackToCurrent',
    'removePlayNextOccurrences', 'jumpTo', 'queueNext', 'removeFromQueue', 'runPlaybackOperation',
  ].concat(['bindQueueRowActions', 'bindPlayNextRowAction', 'motionIsInstant']
    .filter(name => source.includes(`function ${name}(`))).map(extractFunction).join('\n'), context);
  const jumpTo = context.jumpTo;
  context.jumpTo = (qi, ti) => { jumpRequests.push({ qi, ti }); return jumpTo(qi, ti); };
  t.after(() => {
    state._ctxMenuClose?.();
    clock.jobs.clear();
    assert.equal([...listeners.values()].every(entries => entries.size === 0), true);
  });
  const rowFor = ti => list.querySelectorAll('.tss-queue-row').find(row => row.textContent.includes(state.meta[ti].title));
  const consumeHead = async () => {
    assert.equal(context.consumeCurrentQueueTrack(), 0);
    await context.playAt(state.queue[state.pos], true);
    context.renderList();
  };
  return { context, state, document, list, search, count, played, jumpRequests, rowFor, consumeHead };
}

test('consuming the queue head leaves later row clicks targeting the shifted queue position and correct track', async t => {
  const h = createQueueHarness(t);
  h.context.renderList();
  h.list.scrollTop = 560;
  await h.consumeHead();
  assert.equal(h.list.scrollTop, 560, 'playback advance cannot interrupt distant queue browsing');
  const row = h.rowFor(3);
  assert.ok(row, 'the future track remains visible after head consumption');
  await row.onclick();
  assert.deepEqual(h.jumpRequests, [{ qi: 2, ti: 3 }]);
  assert.equal(h.state.queue[h.state.pos], 3);
  assert.equal(h.state._deckTrack, 3);
  assert.deepEqual(h.played, [1, 3]);
  assert.deepEqual(Array.from(h.state.history), [0, 1]);
  assert.equal(h.state.busy, false);
});

test('shifted future rows drag the displayed track to the displayed drop target', async t => {
  const h = createQueueHarness(t);
  h.context.renderList();
  await h.consumeHead();
  const sourceRow = h.rowFor(3), targetRow = h.rowFor(5);
  sourceRow.ondragstart({ dataTransfer: {} });
  targetRow.ondrop({ preventDefault() {} });
  assert.deepEqual(Array.from(h.state.queue.slice(0, 6)), [1, 2, 4, 5, 3, 6]);
  assert.equal(h.state.queue[h.state.pos], 1, 'reordering future rows cannot move the playing track');
  assert.equal(h.state._deckTrack, 1);
  assert.equal(h.state.dragSrc, null);
  assert.deepEqual(Array.from(h.state.history), [0]);
});

test('shifted row context menus expose current move eligibility and queue the displayed track', async t => {
  const h = createQueueHarness(t);
  h.context.renderList();
  await h.consumeHead();
  const row = h.rowFor(2);
  row.oncontextmenu({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 });
  const menu = h.document.getElementById('tss-ctx');
  const up = menu.children.find(item => item.textContent.includes('move up'));
  assert.equal(up.classList.contains('tss-ctx-disabled'), true, 'the first upcoming row cannot move before the playing row');
  assert.equal(typeof up.onclick, 'undefined');
  menu.children.find(item => item.textContent.includes('play next')).onclick();
  assert.deepEqual(Array.from(h.state.playNext), [2]);
  assert.equal(h.state.queue[h.state.pos], 1);
  assert.equal(h.document.getElementById('tss-ctx'), null);
});

test('metadata refresh, search, and history remain authoritative after queue rows shift', async t => {
  const h = createQueueHarness(t);
  h.context.renderList();
  await h.consumeHead();
  h.search.value = 'even';
  h.context.renderList();
  assert.equal(h.list.scrollTop, 0, 'a new search starts at the top');
  assert.equal(h.list.children.every(row => row.textContent.toLowerCase().includes('even')), true);
  h.list.scrollTop = 112;
  h.state.meta[6] = {
    ...h.state.meta[6], title: 'Even refreshed track 6', artist: 'New artist',
    artwork: 'https://images.example/replacement.jpg',
  };
  h.context.renderList();
  assert.equal(h.list.scrollTop, 112);
  const updated = h.rowFor(6);
  assert.ok(updated.textContent.includes('New artist'));
  assert.equal(updated.querySelector('img').src, 'https://images.example/replacement.jpg');
  assert.equal(h.list.textContent.includes('Even track 6'), false);
  h.state.meta[6] = { ...h.state.meta[6], title: 'No longer matches', artist: 'Different artist' };
  h.context.renderList();
  assert.equal(h.rowFor(6), undefined, 'changed metadata cannot leave a stale search result');
  h.state.history = [0, 4, 6];
  const queueBeforeHistory = Array.from(h.state.queue);
  h.state.sidebarTab = 'history';
  h.context.renderList();
  assert.equal(h.list.children.length, 2);
  assert.ok(h.list.children[0].textContent.includes('Even track 4'));
  assert.ok(h.list.children[1].textContent.includes('Even track 0'));
  h.list.children[0].onclick();
  assert.deepEqual(Array.from(h.state.playNext), [4]);
  assert.deepEqual(Array.from(h.state.history), [0, 4, 6]);
  assert.deepEqual(Array.from(h.state.queue), queueBeforeHistory);
  h.state.sidebarTab = 'queue';
  h.search.value = '';
  h.context.renderList();
  assert.equal(h.list.querySelectorAll('.tss-queue-row').length, h.state.queue.length + 1);
  assert.ok(h.rowFor(6).textContent.includes('No longer matches'));
  assert.equal(h.state._deckTrack, 1);
});

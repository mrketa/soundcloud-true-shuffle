const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');
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
    trackPlayed: ti => { state.stats.played++; state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1; },
    trackAvailable: ti => Boolean(state.meta[ti] && !state.meta[ti].unavailable),
    consumeCurrentQueueTrack: () => { state.history.push(state.queue.shift()); },
    badges() {}, renderList() {}, updateSleepDisplay() {}, showMergeToast() {},
    pause() { state._userPaused = true; }, stop() { state.active = false; state.busy = false; },
    wait: ms => new Promise(resolve => timers.setTimeout(resolve, ms)),
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(names.map(extractFunction).join('\n'), context);
  return { context, state: context.state, timers, decks: context.state._decks, diagnostics };
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const deckFunctions = ['resetDeck', 'deckIsPreviewLimited', 'prepareCrossfadeDeck'];
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
    resolveCrossfadeStream: async () => 'https://media.example/refreshed',
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
  assert.equal(await h.context.playWithCrossfadeDeck(0, true, 0), false);
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

const resolverFunctions = ['discoverSoundCloudClientId', 'discoverSoundCloudClientIdFromBundle', 'resolveProgressiveStreams', 'fetchPlaybackTrack', 'resolveCrossfadeStreams'];
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
    const h = fixture(['withDeadline', 'fetchSoundCloudResource', 'resolveProgressiveStreams'], {
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
  const h = fixture(['resolveCrossfadeStreams'], {
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

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.env.TSS_SCRIPT || path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const body = source.indexOf('{', source.indexOf(') {', start));
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      return `${source.slice(start - 6, start) === 'async ' ? 'async ' : ''}${source.slice(start, i + 1)}`;
    }
  }
  throw new Error(`Unterminated function ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function createHarness() {
  const a = 'https://soundcloud.com/user/sets/a';
  const b = 'https://soundcloud.com/user/sets/b';
  const c = 'https://soundcloud.com/user/sets/c';
  const location = { href: a, origin: 'https://soundcloud.com' };
  const history = {
    pushState(_data, _title, url) { location.href = String(url); },
    replaceState(_data, _title, url) { location.href = String(url); },
  };
  const state = {
    active: false, loading: false, busy: false, suspended: false, _userPaused: false,
    _playbackEpoch: 0, _playbackAbort: new AbortController(), _collectionEpoch: 0,
    _liveSyncSources: new Map(), _liveSyncInFlight: false, _liveSyncLastCheck: 0,
    meta: [], els: [], queue: [], playNext: [], pos: 0, history: [], priority: {},
    roundPlayed: 0, roundTotal: 0, playlistUrl: '', stopAfterRound: false,
    stats: { played: 0, elapsed: 0, playCounts: {} }, _deckTrack: null,
    _decks: [], _deckPrepareTokens: [],
  };
  const storage = new Map();
  const pages = new Map();
  const snapshots = new Map();
  const played = [];
  const workers = [];
  const intervals = new Map();
  const timers = new Map();
  const events = new Map();
  const pendingSync = [];
  let timerId = 0;
  let now = 100_000;
  let waitHook = null;
  let playHook = null;
  let networkHook = null;
  let timing = { current: 0, duration: 200, ended: false, source: 'audio' };
  let mounted = true;
  let navigations = 0;
  let binds = 0;
  let deadlineChecks = 0;
  const meta = (id, sourcePage = location.href, position = id) => ({
    soundcloudId: id, title: `Track ${id}`, artist: `Artist ${id}`,
    link: `https://soundcloud.com/artist/track-${id}`, sourcePage, playlistPosition: position,
  });
  const track = id => ({ id, title: `Track ${id}`, permalink_url: meta(id).link,
    publisher_metadata: { artist: `Artist ${id}` } });
  const document = {
    body: { scrollHeight: 100, contains: () => mounted, appendChild() {} },
    querySelectorAll: selector => selector.includes('.trackList__item') ? pages.get(location.href) || [] : [],
    getElementById: () => null,
    addEventListener: (type, callback) => events.set(type, callback),
    removeEventListener: (type, callback) => { if (events.get(type) === callback) events.delete(type); },
    createElement: () => ({ click() { navigations++; }, remove() {} }),
  };
  const dependencies = {
    state, location, document, URL, AbortController, pendingSync,
    pageWindow: { history },
    window: { scrollTo() {} },
    Date: { now: () => now }, LIVE_SYNC_INTERVAL_MS: 10_000,
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    wait: ms => waitHook ? waitHook(ms) : Promise.resolve(),
    fetch: async (url, options) => {
      if (networkHook) return networkHook(url, options);
      const key = String(url).split('?')[0];
      const snapshot = snapshots.get(key);
      if (snapshot instanceof Error) throw snapshot;
      return { ok: Boolean(snapshot), status: snapshot ? 200 : 404, text: async () => JSON.stringify(await snapshot) };
    },
    playlistSnapshotFromHtml: html => JSON.parse(html),
    discoverSoundCloudClientIdFromBundle: async () => '',
    getMeta: el => ({ ...el.meta }), getLink: el => el.meta?.link || '',
    isLikedTracksPage: () => false,
    playlistBase: value => String(value || '').split(/[?#]/)[0].replace(/\/+$/, ''),
    validPage: () => true,
    isPassiveBrowsePage: value => value.endsWith('/feed'),
    fisherYates: items => items.slice(), spaceDuplicateTitles: items => items.slice(),
    spaceUpcomingDuplicateTitles: () => {},
    buildReshuffledQueue: (indices, current) => current == null ? indices.slice() : [current, ...indices.filter(ti => ti !== current)],
    buildBalancedRound: indices => indices.slice(),
    playAt: async ti => {
      const epoch = state._playbackEpoch;
      played.push(ti);
      if (playHook) await playHook(ti);
      if (state._playbackEpoch !== epoch) return false;
      state._deckTrack = ti;
      return true;
    },
    playerTitle: () => state.meta[state.queue[state.pos]]?.title || '',
    currentSec: () => 0, seekTo: () => {},
    pauseSoundCloudTransport: () => {}, pauseSoundCloud: () => {},
    initializePlaybackVolume: () => {}, refreshUpcomingCrossfadePreparation: () => {},
    badges: () => {}, renderList: () => {}, updateHub: () => {}, showMergeToast: () => {},
    saveLifetimeStats: () => {}, closeOwnPip: () => {}, stopCrossfadeDecks: () => {},
    syncBrowserNowPlaying: () => {}, recordPlaybackDiagnostic: () => {}, resetPlaybackClock: () => {},
    inject: () => {}, bindCurrentPageElements: () => { binds++; },
    sessionStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    progress: () => timing.current / timing.duration,
    paused: () => false, pause: () => {}, playbackTiming: () => ({ ...timing }),
    mkWorker: () => { const worker = { postMessage() {}, terminate() {}, onmessage: null }; workers.push(worker); return worker; },
    refreshPlayBtn: () => {}, settleScheduledCrossfade: () => {}, installBetterFeedPipBridge: () => {},
    syncOwnPipWindow: () => {}, syncBetterFeedPipWindow: () => {}, currentDeckAudio: () => null,
    checkSleepTimerDeadline: () => { deadlineChecks++; return false; }, resumeAudioGraph: async () => true,
    syncPlaybackVolumeFromSoundCloud: () => {}, recoverCurrentDeckStream: async () => false,
    syncCrossfadeVolume: () => {}, processAutoLevel: () => {}, next: async () => {},
  };
  const names = [
    'withDeadline', 'fetchSoundCloudResource', 'invalidatePlaybackSession', 'runPlaybackOperation',
    'normalizeTrackUrl', 'trackId', 'trackAvailable', 'syncTrackPlaybackAccess', 'metaFromSoundCloudTrack',
    'mergeTrackMeta', 'fetchLivePlaylistSnapshot', 'resolveLiveTrackMeta', 'resolvePlaylistSnapshotMetas',
    'currentPageTrackElements', 'loadTracks', 'completePlaylistCollection', 'beginCollectionRequest',
    'collectionRequestCurrent', 'finishCollectionRequest', 'cancelCollectionRequest',
    'insertTracksRandomlyAfterCurrent', 'applyLiveQueueTracks', 'registerLiveQueueSource',
    'reconcileLivePlaylistSnapshot', 'reviveRemovedQueueTrack', 'showLiveSyncResult', 'syncLiveQueue',
    'resetLiveQueueSync', 'finalizeLeavingCurrentTrack', 'recountRoundTotal', 'consumeCurrentQueueTrack',
    'moveSelectedTrackToCurrent', 'removePlayNextOccurrences', 'queueNext', 'prevTrack',
    'saveQueueSessionCache', 'restoreQueueSessionCache', 'remapCachedQueue',
    'start', 'mergeCurrentPage', 'reshuffleCurrentPage', 'onNav', 'stop', 'nativePlaybackAllowed', 'startWatcher',
    'checkForNavigation', 'installNavigationTracking',
  ];
  const api = Function(...Object.keys(dependencies), `
    let navLock = false, lastUrl = location.href, injectRetryTimer = null;
    ${names.map(extract).join('\n')}
    const originalSync = syncLiveQueue;
    syncLiveQueue = options => { const operation = originalSync(options); pendingSync.push(operation); return operation; };
    return { ${names.join(',')}, sync: originalSync };
  `)(...Object.values(dependencies));
  const harness = {
    ...api, a, b, c, state, location, history, played, workers, intervals, timers, storage, snapshots, meta,
    page(url, ids) {
      pages.set(url, ids.map((id, index) => ({ meta: meta(id, url, index + 1) })));
      snapshots.set(url, { complete: true, tracks: ids.map(track) });
    },
    rows(url, rows) { pages.set(url, rows); },
    setSnapshot(url, ids) { snapshots.set(url, { complete: true, tracks: ids.map(track) }); },
    deferWait(hook) { waitHook = hook; }, deferPlay(hook) { playHook = hook; }, network(hook) { networkHook = hook; },
    async flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); },
    async flushSync() { while (pendingSync.length) await Promise.all(pendingSync.splice(0)); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await this.flush();
    },
    queueIds: () => state.queue.slice(state.pos).map(ti => state.meta[ti].soundcloudId),
    bindCount: () => binds, navigationCount: () => navigations, deadlineCheckCount: () => deadlineChecks,
    async endAway() {
      state.suspended = true; mounted = false;
      timing = { ...timing, current: timing.duration, ended: true };
      await state.worker.onmessage({ data: 0 });
      await this.flush();
    },
  };
  return harness;
}

const tests = [];
const test = (name, operation) => tests.push({ name, operation });

test('complete playlist authority deduplicates DOM identities and replaces unrelated rows', async () => {
  for (const ids of [[1, 1], [1, 9]]) {
    const h = createHarness();
    h.page(h.a, [1, 2]);
    h.rows(h.a, ids.map(id => ({ meta: { ...h.meta(id), artist: id === 1 ? 'Artist & Guest' : 'Other' } })));
    await h.start();
    await h.flushSync();
    assert.deepEqual(h.queueIds(), [1, 2]);
    assert.equal(h.state.meta[0].artist, 'Artist & Guest');
    assert.equal(h.state._liveSyncSources.get(h.a).size, 2);
  }
});

test('collection network and body stalls are bounded and leave start reusable', async () => {
  for (const bodyStall of [false, true]) {
    const h = createHarness(); h.page(h.a, [1]);
    h.network(() => bodyStall ? Promise.resolve({ ok: true, status: 200, text: () => new Promise(() => {}) }) : new Promise(() => {}));
    const starting = h.start();
    await h.flush();
    await h.advance(10_001);
    await starting;
    assert.equal(h.state.loading, false);
    assert.equal(h.state.busy, false);
    assert.deepEqual(h.queueIds(), [1]);
    h.stop(); h.network(null);
    await h.start();
    await h.flushSync();
    assert.equal(h.state.active, true);
  }
});

test('one stalled source does not permanently latch live sync or discard a healthy source', async () => {
  const h = createHarness(); h.page(h.a, [1]); h.page(h.b, [2]);
  await h.start(); await h.flushSync();
  h.location.href = h.b; await h.mergeCurrentPage(); await h.flushSync();
  h.setSnapshot(h.b, [2, 3]);
  h.network(url => String(url).startsWith(h.a) ? new Promise(() => {}) : Promise.resolve({
    ok: true, status: 200, text: async () => JSON.stringify(h.snapshots.get(h.b)),
  }));
  const syncing = h.sync({ force: true });
  await h.flush(); await h.advance(10_001); await syncing;
  assert.equal(h.state._liveSyncInFlight, false);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
  h.network(null);
  await h.sync({ force: true });
  assert.equal(h.state._liveSyncInFlight, false);
});

test('merge and replacement discard DOM collected across any intervening route', async () => {
  for (const replace of [false, true]) {
    const h = createHarness(); h.page(h.a, [1]); h.page(h.b, [2]); h.page(h.c, [3]);
    await h.start(); await h.flushSync();
    h.location.href = h.b; h.state.suspended = true;
    const waiting = deferred();
    h.deferWait(ms => ms === 900 ? waiting.promise : Promise.resolve());
    const pending = replace ? h.reshuffleCurrentPage() : h.mergeCurrentPage();
    await h.flush();
    h.location.href = h.c; const away = h.onNav();
    h.location.href = h.b; const back = h.onNav();
    waiting.resolve();
    await Promise.all([pending, away, back]);
    assert.deepEqual(h.queueIds(), [1]);
    assert.equal(h.state._liveSyncSources.has(h.b), false);
    assert.equal(h.state.loading, false);
    assert.equal(h.state.busy, false);
  }
});

test('history route interception cancels away-and-back collection even between URL polls', async () => {
  const h = createHarness(); h.page(h.a, [1]); h.page(h.b, [2]);
  h.installNavigationTracking();
  const waiting = deferred();
  h.deferWait(ms => ms === 900 ? waiting.promise : Promise.resolve());
  const starting = h.start(); await h.flush();
  h.history.pushState(null, '', h.b);
  h.history.replaceState(null, '', h.a);
  waiting.resolve(); await starting; await h.flush();
  assert.equal(h.state.active, false);
  assert.equal(h.state.loading, false);
  assert.deepEqual(h.state.meta, []);
});

test('return-page DOM crawl leaves watchdog installed and abandons stale bindings promptly', async () => {
  const h = createHarness(); h.page(h.a, [1, 2]); h.page(h.b, [3]);
  await h.start(); await h.flushSync();
  const worker = h.state.worker;
  const heartbeat = [...h.intervals.keys()];
  const waiting = deferred();
  h.deferWait(ms => ms === 900 ? waiting.promise : Promise.resolve());
  const returning = h.onNav(); await h.flush();
  assert.equal(h.state.worker, worker);
  const checks = h.deadlineCheckCount();
  await worker.onmessage({ data: 0 });
  assert.equal(h.deadlineCheckCount(), checks + 1);
  assert.deepEqual([...h.intervals.keys()], heartbeat);
  h.location.href = h.b; const leaving = h.onNav();
  assert.equal(h.state.suspended, true);
  h.stop();
  waiting.resolve(); await Promise.all([returning, leaving]);
  assert.equal(h.bindCount(), 0);
  assert.equal(h.state.active, false);
});

test('initial playback is supervised and busy before its asynchronous play attempt resolves', async () => {
  const h = createHarness(); h.page(h.a, [1, 2]);
  const first = deferred(); h.deferPlay(() => first.promise);
  const starting = h.start(); await h.flush();
  assert.equal(h.state.active, true);
  assert.equal(h.state.busy, true);
  assert.equal(typeof h.state.worker?.onmessage, 'function');
  h.stop(); h.deferPlay(null); h.location.href = h.b; h.page(h.b, [3]);
  await h.start(); await h.flushSync();
  first.resolve(); await starting;
  assert.deepEqual(h.queueIds(), [3]);
  assert.equal(h.state.active, true);
  assert.equal(h.state.busy, false);
});

test('automatic suspended return and reload preserve merged union, source watches and Play Next', async () => {
  const h = createHarness(); h.page(h.a, [1, 2]); h.page(h.b, [3, 4]);
  await h.start(); await h.flushSync();
  h.location.href = h.b; await h.mergeCurrentPage(); await h.flushSync();
  const ti3 = h.state.meta.findIndex(meta => meta.soundcloudId === 3);
  const ti4 = h.state.meta.findIndex(meta => meta.soundcloudId === 4);
  h.queueNext(ti3); h.queueNext(ti4);
  await h.endAway();
  assert.equal(h.navigationCount(), 1);
  assert.equal(h.state.active, false);
  const cache = JSON.parse(h.storage.get('tss_queue_cache'));
  assert.deepEqual(cache.meta.map(meta => meta.soundcloudId).sort(), [1, 2, 3, 4]);
  assert.deepEqual(cache.playNext, [ti4]);
  const reload = createHarness();
  reload.page(reload.b, [3, 4]);
  reload.location.href = reload.b;
  reload.storage.set('tss_queue_cache', h.storage.get('tss_queue_cache'));
  await reload.start(); await reload.flushSync();
  assert.deepEqual(reload.queueIds().slice().sort(), [2, 3, 4]);
  assert.deepEqual([...reload.state._liveSyncSources.keys()].sort(), [reload.a, reload.b]);
  assert.deepEqual(reload.state.playNext.map(ti => reload.state.meta[ti].soundcloudId), [4]);
  assert.deepEqual(reload.state.history.map(ti => reload.state.meta[ti].soundcloudId), [1]);
});

test('an emptied return source cannot erase remaining tracks from another cached source', async () => {
  const h = createHarness(); h.page(h.a, [1, 2]); h.page(h.b, [3]);
  await h.start(); await h.flushSync();
  h.location.href = h.b; await h.mergeCurrentPage(); await h.flushSync();
  await h.endAway();
  const reload = createHarness();
  reload.page(reload.b, []);
  reload.location.href = reload.b;
  reload.storage.set('tss_queue_cache', h.storage.get('tss_queue_cache'));
  await reload.start(); await reload.flushSync();
  assert.deepEqual(reload.queueIds(), [2]);
  assert.equal(reload.state.roundPlayed, 1);
  assert.equal(reload.state.roundTotal, 2);
  assert.equal(reload.state._liveSyncSources.get(reload.a).size, 2);
  assert.equal(reload.state._liveSyncSources.get(reload.b).size, 0);
});

test('a completed stop-after-round return removes an older cache instead of restoring a replay', async () => {
  const h = createHarness(); h.page(h.a, [1]);
  await h.start(); await h.flushSync();
  h.state.stopAfterRound = true;
  h.saveQueueSessionCache();
  await h.endAway();
  assert.equal(h.state.active, false);
  assert.equal(h.storage.has('tss_queue_cache'), false);
  assert.equal(h.navigationCount(), 1);
});

test('obsolete collection cleanup cannot release a replacement request loading state', async () => {
  const h = createHarness(); h.page(h.a, [1]); h.page(h.b, [2]);
  const oldCrawl = deferred();
  h.deferWait(ms => ms === 900 ? oldCrawl.promise : Promise.resolve());
  const oldStart = h.start(); await h.flush();
  h.stop();
  const newCrawl = deferred();
  h.location.href = h.b;
  h.deferWait(ms => ms === 900 ? newCrawl.promise : Promise.resolve());
  const newStart = h.start(); await h.flush();
  oldCrawl.resolve(); await oldStart;
  assert.equal(h.state.loading, true);
  assert.equal(h.state.active, false);
  newCrawl.resolve(); await newStart; await h.flushSync();
  assert.deepEqual(h.queueIds(), [2]);
  assert.equal(h.state.loading, false);
});

test('removed upcoming tracks revive once while ordinarily consumed history stays consumed', async () => {
  const h = createHarness(); h.page(h.a, [1, 2, 3]);
  await h.start(); await h.flushSync();
  h.consumeCurrentQueueTrack(); h.state._deckTrack = h.state.queue[h.state.pos];
  h.setSnapshot(h.a, [2]); await h.sync({ force: true });
  assert.deepEqual(h.queueIds(), [2]);
  h.setSnapshot(h.a, [1, 2, 3]); await h.sync({ force: true });
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds(), [2, 3]);
  assert.equal(h.state.roundTotal, 3);
});

test('a removed upcoming track revived during cache restoration plays once and stays consumed on the next reload', async () => {
  const h = createHarness(); h.page(h.a, [1, 2, 3, 4]);
  await h.start(); await h.flushSync();
  h.consumeCurrentQueueTrack(); h.state._deckTrack = h.state.queue[h.state.pos];
  h.setSnapshot(h.a, [1, 2, 4]); await h.sync({ force: true });
  assert.deepEqual(h.queueIds(), [2, 4]);
  h.saveQueueSessionCache();
  const reload = createHarness(); reload.page(reload.a, [1, 2, 3, 4]);
  reload.storage.set('tss_queue_cache', h.storage.get('tss_queue_cache'));
  await reload.start(); await reload.flushSync();
  assert.deepEqual(reload.queueIds().slice().sort(), [2, 3, 4]);
  assert.equal(reload.state.roundTotal, 4);
  const revivedTi = reload.state.meta.findIndex(meta => meta.soundcloudId === 3);
  reload.moveSelectedTrackToCurrent(revivedTi);
  reload.consumeCurrentQueueTrack();
  reload.saveQueueSessionCache();
  const again = createHarness(); again.page(again.a, [1, 2, 3, 4]);
  again.storage.set('tss_queue_cache', reload.storage.get('tss_queue_cache'));
  await again.start(); await again.flushSync();
  assert.deepEqual(again.queueIds(), [4]);
  assert.equal(again.state.roundTotal, 4);
});

test('jumping away finalizes current removal and Back never restores removed history', async () => {
  const h = createHarness(); h.page(h.a, [1, 2, 3]);
  await h.start(); await h.flushSync();
  h.setSnapshot(h.a, [2, 3]); await h.sync({ force: true });
  h.moveSelectedTrackToCurrent(1); h.state._deckTrack = 1;
  assert.equal(h.state.meta[0].unavailable, true);
  await h.prevTrack();
  assert.equal(h.state.queue[h.state.pos], 1);
  assert.equal(h.trackAvailable(0), false);
  h.consumeCurrentQueueTrack();
  h.consumeCurrentQueueTrack();
  assert.deepEqual(h.queueIds(), [2, 3]);
});

test('Back consumes a historical Play Next request without duplicate playback or inflated total', async () => {
  const h = createHarness(); h.page(h.a, [1, 2, 3]);
  await h.start(); await h.flushSync();
  h.consumeCurrentQueueTrack(); h.state._deckTrack = 1;
  h.queueNext(0);
  assert.equal(h.state.roundTotal, 4);
  await h.prevTrack();
  assert.equal(h.state.queue[h.state.pos], 0);
  assert.deepEqual(h.state.playNext, []);
  assert.equal(h.state.roundTotal, 3);
  h.consumeCurrentQueueTrack();
  assert.deepEqual(h.queueIds(), [2, 3]);
});

test('restored totals equal consumed plus surviving scheduled tracks across additions and removals', () => {
  const h = createHarness();
  const cache = { queue: [1, 2], pos: 0, history: [0], playNext: [], priority: {},
    metaKeys: [1, 2, 3].map(id => h.meta(id).link), roundPlayed: 1, roundTotal: 3 };
  const added = h.remapCachedQueue(cache, [1, 2, 3, 4].map(id => h.meta(id)));
  assert.equal(added.roundTotal, 4);
  const removed = h.remapCachedQueue(cache, [1, 2].map(id => h.meta(id)));
  assert.equal(removed.roundTotal, 2);
});

test('merging shared tracks preserves a coherent primary source and playlist position', async () => {
  const h = createHarness(); h.page(h.a, [1, 2]); h.page(h.b, [3, 1]);
  await h.start(); await h.flushSync();
  h.location.href = h.b; await h.mergeCurrentPage(); await h.flushSync();
  const shared = h.state.meta.find(meta => meta.soundcloudId === 1);
  assert.equal(shared.sourcePage, h.a);
  assert.equal(shared.playlistPosition, 1);
});

(async () => {
  for (const { name, operation } of tests) {
    let timer;
    try {
      await Promise.race([
        operation(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 5000); }),
      ]);
      console.log(`PASS ${name}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`${tests.length} queue lifecycle tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });

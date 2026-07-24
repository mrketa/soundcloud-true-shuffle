'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scriptPath = process.env.TSS_SCRIPT
  ? path.resolve(process.env.TSS_SCRIPT)
  : process.argv[2]
    ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'SC Trueshuffle.js');
const source = fs.readFileSync(scriptPath, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist`);

  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract function ${name}`);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const parseTimeText = Function(`return (${extractFunction('parseTimeText')})`)();
const buildReshuffledQueue = Function(
  'fisherYates',
  `return (${extractFunction('buildReshuffledQueue')})`,
)(items => items.slice().reverse());

function createBalancedRoundHarness() {
  const state = { roundStarts: {}, priority: {} };
  const buildBalancedRound = Function(
    'state',
    'fisherYates',
    'weightedShuffle',
    `return (${extractFunction('buildBalancedRound')})`,
  )(
    state,
    items => items.slice().reverse(),
    items => items.slice(),
  );
  return { state, buildBalancedRound };
}

test('time parser supports normal, long and hour-long tracks', () => {
  assert.equal(parseTimeText('2:54'), 174);
  assert.equal(parseTimeText('33:20'), 2000);
  assert.equal(parseTimeText('1:02:03'), 3723);
  assert.equal(parseTimeText(' 0:09 '), 9);
});

test('time parser extracts SoundCloud timeline timestamps from accessibility text', () => {
  assert.equal(parseTimeText('Current time: 45 seconds0:45'), 45);
  assert.equal(parseTimeText('Duration: 3 minutes 22 seconds3:22'), 202);
  assert.equal(parseTimeText('Duration: 1 hour 2 minutes 3 seconds1:02:03'), 3723);
});

test('time parser rejects malformed values', () => {
  assert.equal(parseTimeText(''), 0);
  assert.equal(parseTimeText('unknown'), 0);
  assert.equal(parseTimeText('1:2:3:4'), 0);
});

test('manual re-shuffle keeps the current track and randomizes every other track once', () => {
  const result = buildReshuffledQueue([0, 1, 2, 3], 2);
  assert.deepEqual(result, [2, 3, 1, 0]);
  assert.equal(new Set(result).size, 4);
});

test('new-playlist re-shuffle creates a fresh queue without a pinned track', () => {
  assert.deepEqual(buildReshuffledQueue([0, 1, 2, 3]), [3, 2, 1, 0]);
});

if (source.includes('function normalizeAccentColor(')) {
  const normalizeAccentColor = Function(`return (${extractFunction('normalizeAccentColor')})`)();
  test('dark artwork accents are lifted to a readable minimum brightness', () => {
    const [r, g, b] = normalizeAccentColor(0, 0, 80);
    const perceived = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    assert.ok(perceived >= 0.375);
    assert.deepEqual(normalizeAccentColor(255, 85, 0), [255, 85, 0]);
  });
}

test('four-track automatic rounds balance their starting positions', () => {
  const { state, buildBalancedRound } = createBalancedRoundHarness();
  const starters = [];
  let previous = null;

  for (let round = 0; round < 4; round++) {
    const queue = buildBalancedRound([0, 1, 2, 3], previous);
    assert.equal(queue.length, 4);
    assert.equal(new Set(queue).size, 4);
    if (previous !== null) assert.notEqual(queue[0], previous);
    starters.push(queue[0]);
    previous = queue[0];
  }

  assert.equal(new Set(starters).size, 4);
  assert.deepEqual(Object.values(state.roundStarts).sort(), [1, 1, 1, 1]);
});

test('watcher has no percentage-based early-next trigger', () => {
  const watcher = extractFunction('startWatcher');
  assert.doesNotMatch(watcher, /p\s*>=\s*0\.99/);
  assert.doesNotMatch(watcher, /progress\(\)\s*>=\s*0\.99/);
  assert.match(watcher, /addEventListener\('ended',\s*onMediaEnded,\s*true\)/);
  assert.match(watcher, /removeEventListener\('ended',\s*state\._endedHandler,\s*true\)/);
});

test('natural-end transition is protected against duplicate signals', () => {
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /if \(!state\.active \|\| state\.busy \|\| nearEnd\) return;/);
  assert.match(watcher, /nearEnd = true;/);
  assert.match(watcher, /await next\(true\)/);
});

function createTimeHarness() {
  let now = 100_000;
  let isPaused = false;
  let pauseCalls = 0;
  let stopCalls = 0;
  const display = { textContent: '' };
  const select = { value: '' };
  const state = {
    active: true,
    suspended: false,
    sleepTimer: null,
    _playTimeLastAt: null,
    _playTimeWasAudible: false,
    _playTimeRemainderMs: 0,
    stats: { played: 0, playCounts: {}, elapsed: 0 },
  };
  const document = {
    getElementById(id) {
      if (id === 'tss-hub-sleep-display') return display;
      if (id === 'tss-hub-sleep') return select;
      return null;
    },
  };
  const timedSleepRemaining = Function(
    `return (${extractFunction('timedSleepRemaining')})`,
  )();
  const updateSleepDisplay = Function(
    'state', 'document', 'timedSleepRemaining',
    `return (${extractFunction('updateSleepDisplay')})`,
  )(state, document, timedSleepRemaining);
  const setSleepTimer = Function(
    'state', 'updateSleepDisplay',
    `return (${extractFunction('setSleepTimer')})`,
  )(state, updateSleepDisplay);
  const sleepTimerValue = Function(
    'state',
    `return (${extractFunction('sleepTimerValue')})`,
  )(state);
  const checkSleepTimerDeadline = Function(
    'state', 'timedSleepRemaining', 'updateSleepDisplay', 'document',
    'pause', 'stop', 'updateHub', 'renderList',
    `return (${extractFunction('checkSleepTimerDeadline')})`,
  )(
    state,
    timedSleepRemaining,
    updateSleepDisplay,
    document,
    () => { pauseCalls++; isPaused = true; },
    () => { stopCalls++; state.active = false; },
    () => {},
    () => {},
  );
  const tickPlayTime = Function(
    'state', 'paused', 'checkSleepTimerDeadline',
    `return (${extractFunction('tickPlayTime')})`,
  )(
    state,
    () => isPaused,
    checkSleepTimerDeadline,
  );

  return {
    state,
    display,
    select,
    setSleepTimer: value => setSleepTimer(value, now),
    sleepTimerValue,
    tick: () => tickPlayTime(now),
    checkDeadline: () => checkSleepTimerDeadline(now),
    advance: milliseconds => { now += milliseconds; },
    setPaused: value => { isPaused = value; },
    pauseCalls: () => pauseCalls,
    stopCalls: () => stopCalls,
  };
}

test('time sleep timer follows its deadline across a throttled background gap', () => {
  const h = createTimeHarness();
  h.setSleepTimer('t15');
  assert.equal(h.state.sleepTimer.remaining, 900);
  assert.equal(h.display.textContent, '15m');
  assert.equal(h.sleepTimerValue(), 't15');

  h.tick();
  h.advance(1_000);
  h.tick();
  assert.equal(h.state.sleepTimer.remaining, 899);

  h.advance(599_000);
  h.tick();
  assert.equal(h.state.sleepTimer.remaining, 300);
  assert.equal(h.display.textContent, '5m');

  h.advance(300_000);
  h.tick();
  assert.equal(h.state.sleepTimer, null);
  assert.equal(h.select.value, 'off');
  assert.equal(h.pauseCalls(), 1);
  assert.equal(h.stopCalls(), 1);
  assert.equal(h.checkDeadline(), false);
  assert.equal(h.pauseCalls(), 1);
  assert.equal(h.stopCalls(), 1);
});

test('listening stats use real timestamp deltas without paused, suspended, or duplicate ticks', () => {
  const h = createTimeHarness();
  h.tick();
  h.advance(1_250);
  h.tick();
  assert.equal(h.state.stats.elapsed, 1);

  h.tick();
  assert.equal(h.state.stats.elapsed, 1);

  h.advance(60_000);
  h.tick();
  assert.equal(h.state.stats.elapsed, 61);

  h.setPaused(true);
  h.advance(10_000);
  h.tick();
  assert.equal(h.state.stats.elapsed, 61);
  h.setPaused(false);
  h.advance(10_000);
  h.tick();
  assert.equal(h.state.stats.elapsed, 61);
  h.advance(2_000);
  h.tick();
  assert.equal(h.state.stats.elapsed, 63);

  h.state.suspended = true;
  h.advance(5_000);
  h.tick();
  h.state.suspended = false;
  h.advance(5_000);
  h.tick();
  assert.equal(h.state.stats.elapsed, 63);
});

test('track sleep timer remains transition-count based', () => {
  const h = createTimeHarness();
  h.setSleepTimer('n3');
  assert.equal(h.sleepTimerValue(), 'n3');
  h.tick();
  h.advance(600_000);
  h.tick();
  assert.deepEqual(h.state.sleepTimer, { type: 'tracks', remaining: 3 });
  assert.match(extractFunction('next'), /state\.sleepTimer\.remaining--/);
});

function createWatcherHarness() {
  let now = 100_000;
  let title = 'Track A';
  let timing = { current: 0, duration: 2000, ended: false, source: 'audio' };
  let isPaused = false;
  let pageElementsPresent = true;
  let endedHandler = null;
  let nextCalls = 0;
  let pauseCalls = 0;
  let navigationClicks = 0;
  let deadlineChecks = 0;
  let deck = null;
  let deckPlayCalls = 0;
  const events = [];
  const storage = new Map();

  const state = {
    active: true,
    busy: false,
    loading: false,
    suspended: false,
    manualAction: false,
    lastProgress: 0,
    lastTitle: '',
    worker: null,
    _workerInterval: null,
    _endedHandler: null,
    els: [{}],
    queue: [0, 1, 2],
    pos: 0,
    history: [],
    priority: {},
    playlistUrl: 'https://soundcloud.com/test/source-playlist',
    meta: [
      { link: 'track-a' },
      { link: 'track-b' },
      { link: 'track-c' },
    ],
    playNext: [],
    stopAfterRound: false,
    crossfadeSeconds: 0,
    _crossfading: false,
    _crossfadePending: false,
    roundPlayed: 0,
    roundTotal: 3,
  };
  const worker = {
    onmessage: null,
    terminate() {},
    postMessage() {},
  };
  const documentMock = {
    body: {
      contains: () => pageElementsPresent,
      appendChild(node) { node.parentNode = this; },
    },
    createElement() {
      return {
        href: '',
        parentNode: null,
        click() { navigationClicks++; },
        remove() { this.parentNode = null; },
      };
    },
    addEventListener(type, handler) {
      if (type === 'ended') endedHandler = handler;
    },
    removeEventListener(type, handler) {
      if (type === 'ended' && endedHandler === handler) endedHandler = null;
    },
  };
  const next = async () => {
    nextCalls++;
    events.push('next');
    timing = { current: 0, duration: 180, ended: false, source: 'audio' };
    title = `Track ${String.fromCharCode(65 + nextCalls)}`;
  };
  const pause = () => {
    pauseCalls++;
    events.push('pause');
    isPaused = true;
  };
  const playbackTiming = () => ({ ...timing });
  const progress = () => timing.duration ? timing.current / timing.duration : 0;
  const trackId = meta => meta?.link || '';
  const consumeCurrentQueueTrack = Function(
    'state', 'trackAvailable', 'buildBalancedRound',
    `return (${extractFunction('consumeCurrentQueueTrack')})`,
  )(state, () => true, items => items.slice());
  const sessionStorage = {
    setItem(key, value) { storage.set(key, value); },
    getItem(key) { return storage.get(key) || null; },
    removeItem(key) { storage.delete(key); },
  };

  const factory = Function(
    'state', 'playerTitle', 'progress', 'paused', 'pause', 'wait', 'document', 'next',
    'updateHub', 'refreshPlayBtn', 'playbackTiming', 'mkWorker', 'settleScheduledCrossfade',
    'installBetterFeedPipBridge', 'syncOwnPipWindow', 'syncBetterFeedPipWindow',
    'consumeCurrentQueueTrack', 'sessionStorage', 'trackId', 'currentDeckAudio',
    'checkSleepTimerDeadline', 'resumeAudioGraph', 'Date', 'syncPlaybackVolumeFromSoundCloud', 'recoverCurrentDeckStream',
    'recordPlaybackDiagnostic',
    `return (${extractFunction('startWatcher')})`,
  );
  const startWatcher = factory(
    state,
    () => title,
    progress,
    () => isPaused,
    pause,
    async () => {},
    documentMock,
    next,
    () => {},
    () => {},
    playbackTiming,
    () => worker,
    () => {},
    () => {},
    () => {},
    () => {},
    consumeCurrentQueueTrack,
    sessionStorage,
    trackId,
    () => deck,
    () => { deadlineChecks++; return false; },
    async () => true,
    { now: () => now },
    () => {},
    async activeDeck => {
      activeDeck.currentTime = (Number(activeDeck.currentTime) || timing.current) + 0.01;
      const playAttempt = activeDeck.play();
      if (playAttempt?.catch) playAttempt.catch(() => {});
      return true;
    },
    () => {},
  );
  startWatcher();

  return {
    state,
    worker,
    ended: () => endedHandler?.({ target: { tagName: 'AUDIO' } }),
    setTiming: value => { timing = { ...timing, ...value }; },
    setPaused: value => { isPaused = value; },
    setTitle: value => { title = value; },
    setPageElementsPresent: value => { pageElementsPresent = value; },
    setDeck: overrides => {
      deck = {
        paused: false,
        ended: false,
        seeking: false,
        readyState: 4,
        playbackRate: 1,
        currentTime: timing.current,
        buffered: { length: 1, start: () => 0, end: () => timing.duration },
        async play() { deckPlayCalls++; },
        ...overrides,
      };
      return deck;
    },
    advanceTime: ms => { now += ms; },
    deckPlayCalls: () => deckPlayCalls,
    nextCalls: () => nextCalls,
    pauseCalls: () => pauseCalls,
    navigationClicks: () => navigationClicks,
    deadlineChecks: () => deadlineChecks,
    cachedQueue: () => JSON.parse(storage.get('tss_queue_cache') || 'null'),
    events: () => events.slice(),
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('a long track is not advanced with 30 seconds remaining', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 1970, duration: 2000, ended: false });
  await h.worker.onmessage();
  assert.equal(h.nextCalls(), 0);
  assert.equal(h.state.suspended, false);
  assert.equal(h.deadlineChecks(), 1);
});

test('sleep deadline catch-up runs from worker ticks and lifecycle events', () => {
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /if \(checkSleepTimerDeadline\(\)\) return;/);
  assert.match(source, /visibilitychange[\s\S]*?checkSleepTimerDeadline\(\)/);
  assert.match(source, /addEventListener\('pageshow'[\s\S]*?checkSleepTimerDeadline\(\)/);
  assert.match(source, /state\._workerInterval = setInterval\(tick, 50\)/);
});

test('the native ended event advances exactly once even when signalled twice', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 2000, duration: 2000, ended: true });
  h.ended();
  h.ended();
  await h.flush();
  assert.equal(h.nextCalls(), 1);
});

test('a suspended external end consumes and caches the source queue exactly once before returning', async () => {
  const h = createWatcherHarness();
  h.state.suspended = true;
  h.setPageElementsPresent(false);
  h.setTiming({ current: 2000, duration: 2000, ended: true });

  h.ended();
  h.ended();
  await h.flush();

  assert.equal(h.nextCalls(), 0);
  assert.equal(h.navigationClicks(), 1);
  assert.equal(h.state.active, false);
  assert.deepEqual(h.state.queue, [1, 2]);
  assert.deepEqual(h.state.history, [0]);
  assert.equal(h.state.roundPlayed, 1);
  assert.equal(h.state.roundTotal, 3);
  assert.deepEqual(h.cachedQueue(), {
    queue: [1, 2],
    pos: 0,
    history: [0],
    priority: {},
    playlistUrl: 'https://soundcloud.com/test/source-playlist',
    ts: h.cachedQueue().ts,
    metaKeys: ['track-a', 'track-b', 'track-c'],
    roundPlayed: 1,
    roundTotal: 3,
  });
});

test('restoring a consumed suspended queue does not reinsert played tracks into the round', () => {
  const remapCachedQueue = Function(
    'trackId', 'fisherYates',
    `return (${extractFunction('remapCachedQueue')})`,
  )(
    meta => meta?.link || '',
    items => items.slice().reverse(),
  );
  const restored = remapCachedQueue({
    queue: [1, 2],
    pos: 0,
    history: [0],
    priority: { 1: 1.75 },
    metaKeys: ['track-a', 'track-b', 'track-c'],
    roundPlayed: 1,
    roundTotal: 3,
  }, [
    { link: 'track-c' },
    { link: 'track-a' },
    { link: 'track-b' },
    { link: 'track-new' },
  ]);

  assert.deepEqual(restored.queue, [2, 0, 3]);
  assert.equal(restored.pos, 0);
  assert.deepEqual(restored.history, [1]);
  assert.deepEqual(restored.priority, { 2: 1.75 });
  assert.equal(restored.roundPlayed, 1);
  assert.equal(restored.roundTotal, 3);
  assert.equal(restored.queue.includes(1), false);
  assert.equal(new Set(restored.queue).size, restored.queue.length);
});

test('a suspended end on the last stop-after-round track returns without caching a replay', async () => {
  const h = createWatcherHarness();
  h.state.suspended = true;
  h.state.queue = [0];
  h.state.meta = [{ link: 'track-a' }];
  h.state.roundTotal = 1;
  h.state.stopAfterRound = true;
  h.setPageElementsPresent(false);
  h.setTiming({ current: 2000, duration: 2000, ended: true });

  h.ended();
  await h.flush();

  assert.deepEqual(h.state.queue, []);
  assert.deepEqual(h.state.history, [0]);
  assert.equal(h.state.roundPlayed, 1);
  assert.equal(h.cachedQueue(), null);
  assert.equal(h.navigationClicks(), 1);
});

test('a finished track parked at its endpoint advances without an ended signal', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 2000, duration: 2000, ended: false });
  h.setPaused(true);
  await h.worker.onmessage();
  await h.worker.onmessage();
  assert.equal(h.nextCalls(), 1);
});

test('a paused long track slightly before its endpoint is not advanced', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 1999.9, duration: 2000, ended: false });
  h.setPaused(true);
  await h.worker.onmessage();
  await h.worker.onmessage();
  assert.equal(h.nextCalls(), 0);
});

test('custom deck stall watchdog recovers once before advancing a confirmed stall', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 600, duration: 2000, ended: false, source: 'audio' });
  const deck = h.setDeck({ currentTime: 600 });

  await h.worker.onmessage();
  for (let i = 0; i < 6; i++) {
    h.advanceTime(3000);
    await h.worker.onmessage();
    await Promise.resolve();
  }
  assert.equal(h.deckPlayCalls(), 1);
  assert.equal(h.nextCalls(), 0);
  assert.ok(deck.currentTime > 600);

  for (let i = 0; i < 13; i++) {
    h.advanceTime(3000);
    await h.worker.onmessage();
    await Promise.resolve();
  }
  assert.equal(h.nextCalls(), 1);
});

test('custom deck stall recovery never blocks the background watcher on a pending play promise', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 600, duration: 2000, ended: false, source: 'audio' });
  h.setDeck({
    currentTime: 600,
    play() { return new Promise(() => {}); },
  });

  await h.worker.onmessage();
  for (let i = 0; i < 5; i++) {
    h.advanceTime(3000);
    await h.worker.onmessage();
  }

  assert.equal(h.nextCalls(), 0);
});

test('custom deck stall recovery refreshes the same track URL near the saved position', () => {
  const resolver = extractFunction('resolveCrossfadeStream');
  const recovery = extractFunction('recoverCurrentDeckStream');
  assert.match(resolver, /options\.forceRefresh/);
  assert.match(resolver, /state\._streamCache\.delete\(key\)/);
  assert.match(recovery, /resolveCrossfadeStream\(state\.meta\[ti\], \{ forceRefresh: true \}\)/);
  assert.match(recovery, /const savedTime = Math\.max\(0, Number\(position\) \|\| 0\)/);
  assert.match(recovery, /audio\.currentTime = Math\.min\([\s\S]*savedTime/);
  assert.match(recovery, /cancelCrossfadeForRecovery\(index\)/);
  assert.match(recovery, /await audio\.play\(\)/);
});

test('stall watchdog covers both buffered decoder and depleted network stalls with bounded refresh attempts', () => {
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /deckHasBufferedAhead/);
  assert.match(watcher, /stallKind = bufferedAhead \? 'decoder' : 'network'/);
  assert.doesNotMatch(watcher, /&& deck\.readyState >= 3[\s\S]*&& deckHasBufferedAhead/);
  assert.match(watcher, /recoveryAttempts >= 2/);
  assert.match(watcher, /recoverCurrentDeckStream\(deck, timing\.current/);
  assert.match(watcher, /await advanceAtNaturalEnd\(\)/);
});

test('crossfade recovery cancels scheduled automation without resetting the active deck', () => {
  const cancel = extractFunction('cancelCrossfadeForRecovery');
  assert.match(cancel, /state\._crossfadeToken\+\+/);
  assert.match(cancel, /state\._crossfadeSchedule\?\.resolve\?\.\(false\)/);
  assert.match(cancel, /state\._deckGains\[activeIndex\] = 1/);
  assert.match(cancel, /resetDeck\(audio, index\)/);
  assert.doesNotMatch(cancel, /resetDeck\([^,]+, activeIndex\)/);
});

test('custom deck stall watchdog ignores unsafe states and throttled observation gaps', async () => {
  const cases = [
    { paused: true },
    { seeking: true },
    { readyState: 2 },
    { buffered: { length: 0, start: () => 0, end: () => 0 } },
  ];
  for (const overrides of cases) {
    const h = createWatcherHarness();
    h.setTiming({ current: 600, duration: 2000, ended: false, source: 'audio' });
    h.setDeck({ currentTime: 600, ...overrides });
    await h.worker.onmessage();
    h.advanceTime(40000);
    await h.worker.onmessage();
    assert.equal(h.deckPlayCalls(), 0);
    assert.equal(h.nextCalls(), 0);
  }

  for (const stateOverride of [
    { busy: true },
    { loading: true },
    { suspended: true },
    { _crossfading: true },
    { _crossfadePending: true },
  ]) {
    const h = createWatcherHarness();
    Object.assign(h.state, stateOverride);
    h.setTiming({ current: 600, duration: 2000, ended: false, source: 'audio' });
    h.setDeck({ currentTime: 600 });
    await h.worker.onmessage();
    h.advanceTime(40000);
    await h.worker.onmessage();
    assert.equal(h.deckPlayCalls(), 0);
    assert.equal(h.nextCalls(), 0);
  }

  const throttled = createWatcherHarness();
  throttled.setTiming({ current: 600, duration: 2000, ended: false, source: 'audio' });
  throttled.setDeck({ currentTime: 600 });
  await throttled.worker.onmessage();
  throttled.advanceTime(30000);
  await throttled.worker.onmessage();
  assert.equal(throttled.deckPlayCalls(), 0);
  assert.equal(throttled.nextCalls(), 0);
});

test('an unrelated title change away from the end suspends instead of skipping', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 1000, duration: 2000, ended: false });
  await h.worker.onmessage();
  h.setTitle('External Track');
  await h.worker.onmessage();
  await h.worker.onmessage();
  assert.equal(h.nextCalls(), 0);
  assert.equal(h.pauseCalls(), 0);
  assert.equal(h.state.suspended, true);
});

test('a near-end native successor is paused before the queued track starts', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 1997, duration: 2000, ended: false });
  await h.worker.onmessage();
  h.setTitle('SoundCloud Auto Next');
  await h.worker.onmessage();
  assert.equal(h.pauseCalls(), 1);
  assert.equal(h.nextCalls(), 1);
  assert.deepEqual(h.events(), ['pause', 'next']);
  assert.equal(h.state.suspended, false);
});

test('watcher polls quickly while throttling visual refreshes', () => {
  const worker = extractFunction('mkWorker');
  const watcher = extractFunction('startWatcher');
  assert.match(worker, /setInterval\(\(\) => self\.postMessage\(0\), 50\)/);
  assert.match(watcher, /if \(\+\+uiTicks >= 6\)/);
  assert.match(watcher, /setInterval\(tick, 50\)/);
});

function completeRound({ queue, stopAfterRound, justPlayed, nextRound }) {
  const remaining = queue.filter(ti => ti !== justPlayed);
  if (remaining.length || stopAfterRound) return remaining;

  const regenerated = nextRound.slice();
  if (regenerated[0] === justPlayed && regenerated.length > 1) {
    [regenerated[0], regenerated[1]] = [regenerated[1], regenerated[0]];
  }
  return regenerated;
}

test('unchecked stop-after-round regenerates a full queue without an immediate repeat', () => {
  const result = completeRound({
    queue: [3],
    stopAfterRound: false,
    justPlayed: 3,
    nextRound: [3, 0, 1, 2],
  });
  assert.deepEqual(new Set(result), new Set([0, 1, 2, 3]));
  assert.equal(result.length, 4);
  assert.notEqual(result[0], 3);
});

test('checked stop-after-round leaves the queue exhausted', () => {
  const result = completeRound({
    queue: [3],
    stopAfterRound: true,
    justPlayed: 3,
    nextRound: [0, 1, 2, 3],
  });
  assert.deepEqual(result, []);
});

test('queue search refresh keeps the current query when no filter is passed', () => {
  const renderList = extractFunction('renderList');
  assert.match(renderList, /if \(filter === undefined\)/);
  assert.match(renderList, /getElementById\('tss-search'\)\?\.value/);
});

test('track-row mutations fast-sync only on the active source collection', () => {
  const mutation = extractFunction('mutationChangesPlaylistTracks');
  const schedule = extractFunction('scheduleLiveQueueSync');
  const scheduleFromMutation = extractFunction('scheduleLiveQueueSyncFromMutation');
  const state = {
    active: true,
    suspended: false,
    loading: false,
    busy: false,
    _liveSyncInFlight: false,
    _liveSyncTimer: null,
    playlistUrl: 'https://soundcloud.com/test/sets/source-playlist?ref=clipboard',
  };
  const location = { href: 'https://soundcloud.com/feed' };
  const timers = [];
  const syncCalls = [];
  const createHarness = Function(
    'state', 'location', 'setTimeout', 'clearTimeout', 'syncLiveQueue', 'playlistBase',
    `${mutation}\n${schedule}\n${scheduleFromMutation}\n`
      + 'return { mutationChangesPlaylistTracks, scheduleLiveQueueSyncFromMutation };',
  );
  const harness = createHarness(
    state,
    location,
    callback => { timers.push(callback); return timers.length; },
    () => {},
    options => { syncCalls.push(options); },
    value => value.split(/[?#]/)[0].replace(/\/+$/, ''),
  );
  const trackRow = {
    nodeType: 1,
    matches: selector => selector.includes('.trackList__item'),
    querySelector: () => null,
  };
  const records = [{ addedNodes: [trackRow], removedNodes: [] }];

  assert.match(mutation, /record\.addedNodes, \.\.\.record\.removedNodes/);
  assert.match(schedule, /delay = 250/);
  assert.match(schedule, /state\.loading \|\| state\.busy \|\| state\._liveSyncInFlight/);
  assert.match(schedule, /scheduleLiveQueueSync\(300\)/);
  assert.equal(harness.mutationChangesPlaylistTracks(records), true);

  assert.equal(harness.scheduleLiveQueueSyncFromMutation(records), false);
  assert.equal(timers.length, 0, 'passive-page mutations must not schedule a source fetch');

  location.href = 'https://soundcloud.com/test/sets/source-playlist#tracks';
  assert.equal(harness.scheduleLiveQueueSyncFromMutation(records), true);
  assert.equal(timers.length, 1, 'source-page mutations should schedule a fast sync');
  timers.shift()();
  assert.deepEqual(syncCalls, [{ force: true }]);
});

test('re-shuffle replaces a new playlist and resets hidden weighting', () => {
  const reshuffle = extractFunction('reshuffleCurrentPage');
  const hub = extractFunction('mkHub');
  assert.match(reshuffle, /completePlaylistCollection\(pageUrl, pageEls, snapshotPromise\)/);
  assert.match(reshuffle, /state\.els = collection\.els/);
  assert.match(reshuffle, /state\.meta = collection\.meta/);
  assert.match(reshuffle, /state\.queue = newQueue/);
  assert.match(reshuffle, /state\.priority = \{\}/);
  assert.match(reshuffle, /state\.skipCounts = \{\}/);
  assert.match(reshuffle, /startWatcher\(\)/);
  assert.match(hub, /id="tss-hub-reshuffle"/);
  assert.match(hub, /aria-label="Re-shuffle current playlist"/);
  assert.match(hub, /e\.target\.closest\('button'\)/);
});

if (source.includes('function moveSelectedTrackToCurrent(')) {
test('previous restores the queue position after advancing once', async () => {
  const state = {
    active: true,
    busy: false,
    manualAction: false,
    _manualActionAt: 0,
    queue: [0, 1, 2],
    playNext: [],
    pos: 0,
    history: [],
    meta: [{}, {}, {}],
    stopAfterRound: false,
    roundPlayed: 0,
    roundTotal: 3,
  };
  const consumeCurrentQueueTrack = Function(
    'state', 'trackAvailable', 'buildBalancedRound',
    `return (${extractFunction('consumeCurrentQueueTrack')})`,
  )(state, () => true, items => items.slice());
  const played = [];
  const prevTrack = Function(
    'state', 'currentSec', 'seekTo', 'Date',
    'refreshUpcomingCrossfadePreparation', 'playAt', 'badges', 'renderList',
    `return (${extractFunction('prevTrack').replace(/^function /, 'async function ')})`,
  )(
    state, () => 0, () => {}, Date,
    () => {}, async (ti, countPlay) => played.push([ti, countPlay]), () => {}, () => {},
  );

  consumeCurrentQueueTrack();
  assert.deepEqual(state.queue, [1, 2]);
  assert.deepEqual(state.history, [0]);
  assert.equal(state.roundPlayed, 1);

  await prevTrack();

  assert.deepEqual(state.queue, [0, 1, 2]);
  assert.equal(state.queue[state.pos], 0);
  assert.deepEqual(state.history, []);
  assert.deepEqual(played, [[0, false]]);
  assert.equal(state.roundPlayed, 0);
});

test('jumping to a searched track keeps skipped upcoming tracks in the round', () => {
  const state = {
    queue: [0, 1, 2, 3],
    pos: 0,
    history: [],
    roundPlayed: 0,
    roundTotal: 4,
  };
  const moveSelectedTrackToCurrent = Function(
    'state', 'refreshUpcomingCrossfadePreparation',
    `return (${extractFunction('moveSelectedTrackToCurrent')})`,
  )(state, () => {});

  assert.equal(moveSelectedTrackToCurrent(2), true);
  assert.deepEqual(state.queue, [2, 1, 3]);
  assert.deepEqual(state.history, [0]);
  assert.equal(state.roundPlayed, 1);
  assert.equal(state.roundTotal, 4);
});

test('cross-playlist tracks retain a source page and reload detached DOM entries', () => {
  const meta = extractFunction('getMeta');
  const playAt = extractFunction('playAt');
  const loader = extractFunction('loadTrackSourcePage');
  assert.match(meta, /sourcePage:/);
  assert.match(playAt, /reconnectTrackElement\(idx\)/);
  assert.match(playAt, /await loadTrackSourcePage\(idx\)/);
  assert.match(loader, /bindCurrentPageElements\(pageEls\)/);
  assert.match(loader, /state\._internalNavigation = true/);
});

test('feed playback never falls back to clicking track or profile links', () => {
  const playAt = extractFunction('playAt');
  assert.doesNotMatch(playAt, /\.sc-link-primary/);
  assert.doesNotMatch(playAt, /\.trackItem__trackTitle/);
  assert.match(playAt, /button\[aria-label\*="Play"\]/);
});

test('manual transition guard expires for different tracks with identical titles', () => {
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /Date\.now\(\) - state\._manualActionAt > 3000/);
  assert.match(watcher, /state\.manualAction = false/);
});

test('lifetime stats advance their persisted baseline after saving', () => {
  const save = extractFunction('saveLifetimeStats');
  const render = extractFunction('renderStats');
  assert.match(save, /state\._lifetimeBase =/);
  assert.match(render, /state\._lifetimeBase/);
  assert.match(render, /Math\.max\(0,/);
});

test('navigation queues a follow-up pass and retries delayed hub injection', () => {
  const nav = extractFunction('onNav');
  assert.match(nav, /navPending = true/);
  assert.match(nav, /queueMicrotask\(\(\) => onNav\(\)\)/);
  assert.match(nav, /cancelInternalNavigation\(\)/);
  assert.match(nav, /_internalNavigationTarget/);
  assert.match(source, /!document\.getElementById\('tss-hub'\) && !injectRetryTimer/);
  assert.match(source, /setInterval\(checkForNavigation, 250\)/);
  assert.match(source, /window\.addEventListener\('popstate', checkForNavigation\)/);
});

test('all non-collection SoundCloud routes preserve queue ownership', () => {
  const classify = Function(`
    ${extractFunction('soundCloudPathParts')}
    ${extractFunction('isSoundCloudPage')}
    ${extractFunction('isCollectionPage')}
    ${extractFunction('isPassiveBrowsePage')}
    return { isSoundCloudPage, isCollectionPage, isPassiveBrowsePage };
  `)();
  const nav = extractFunction('onNav');

  for (const url of [
    'https://soundcloud.com/',
    'https://soundcloud.com/feed',
    'https://soundcloud.com/stream?ref=tabs',
    'https://soundcloud.com/you/library',
    'https://soundcloud.com/you/library/sets',
    'https://soundcloud.com/search?q=test',
    'https://soundcloud.com/discover',
    'https://soundcloud.com/charts/top',
    'https://soundcloud.com/example-user',
    'https://soundcloud.com/example-user/example-track',
  ]) {
    assert.equal(classify.isSoundCloudPage(url), true, `${url} should be a SoundCloud page`);
    assert.equal(classify.isCollectionPage(url), false, `${url} should not replace the queue`);
    assert.equal(classify.isPassiveBrowsePage(url), true, `${url} should preserve queue ownership`);
  }

  for (const url of [
    'https://soundcloud.com/user/sets/other',
    'https://soundcloud.com/user/likes',
    'https://soundcloud.com/user/tracks',
    'https://soundcloud.com/user/reposts',
    'https://soundcloud.com/you/likes',
  ]) {
    assert.equal(classify.isCollectionPage(url), true, `${url} should remain mergeable`);
    assert.equal(classify.isPassiveBrowsePage(url), false, `${url} should enter collection navigation`);
  }

  assert.equal(classify.isSoundCloudPage('https://example.com/'), false);
  assert.match(source, /const validPage\s*=\s*\(\)\s*=>\s*isSoundCloudPage\(location\.href\)/);
  assert.match(nav, /if \(isPassiveBrowsePage\(location\.href\)\)/);
  assert.match(nav, /state\.suspended = false;[\s\S]*syncLiveQueue\(\{ force: true \}\)/);
  assert.match(nav, /different valid playlist:[\s\S]*state\.suspended = true;/);
});

test('user navigation cancels an in-flight internal source-page load', () => {
  const loader = extractFunction('loadTrackSourcePage');
  const cancel = extractFunction('cancelInternalNavigation');
  assert.match(loader, /navigationToken = \+\+state\._internalNavigationToken/);
  assert.match(loader, /state\._internalNavigationTarget = sourcePage/);
  assert.match(loader, /navigationToken !== state\._internalNavigationToken/);
  assert.match(loader, /playlistBase\(location\.href\) !== playlistBase\(sourcePage\)/);
  assert.match(cancel, /state\._internalNavigationToken\+\+/);
  assert.match(cancel, /state\._internalNavigation = false/);
});

test('cross-tab playlist changes are polled within ten seconds', () => {
  assert.match(source, /const LIVE_SYNC_INTERVAL_MS = 10_000;/);
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /Date\.now\(\) - state\._liveSyncLastCheck >= LIVE_SYNC_INTERVAL_MS/);
});

test('waveform resolver never guesses from an unrelated latest resource', () => {
  const resolver = extractFunction('resolveWaveformUrl');
  assert.doesNotMatch(resolver, /latestWaveformResource\(/);
  assert.match(resolver, /return null/);
});

test('round labels use stable round counters rather than shrinking queue length', () => {
  const hub = extractFunction('updateHub');
  const list = extractFunction('renderList');
  assert.match(hub, /state\.roundPlayed \+ 1/);
  assert.match(hub, /state\.roundTotal/);
  assert.match(list, /state\.roundPlayed \+ 1/);
  assert.match(list, /state\.roundTotal/);
});
}

test('Better SoundCloud Feed PiP receives custom-deck metadata and millisecond timing', () => {
  const state = {
    active: true,
    _deckTrack: 4,
    meta: [{}, {}, {}, {}, {
      title: 'Deck Track',
      artist: 'Deck Artist',
      artwork: 'https://i1.sndcdn.com/artworks-test-large.jpg',
      link: 'https://soundcloud.com/deck-artist/deck-track',
      artistLink: 'https://soundcloud.com/deck-artist',
      waveform: 'https://wave.sndcdn.com/test.json',
    }],
  };
  const betterFeedPipActive = Function(
    'state', 'currentDeckAudio',
    `return (${extractFunction('betterFeedPipActive')})`,
  )(state, () => ({ paused: false }));
  const betterFeedPipSound = Function(
    'state', 'betterFeedPipActive', 'playbackTiming',
    `return (${extractFunction('betterFeedPipSound')})`,
  )(state, betterFeedPipActive, () => ({ current: 12.5, duration: 203.25 }));

  const sound = betterFeedPipSound();
  assert.equal(sound.id, -5);
  assert.equal(sound.attributes.title, 'Deck Track');
  assert.equal(sound.attributes.publisher_metadata.artist, 'Deck Artist');
  assert.equal(sound.attributes.artwork_url, 'https://i1.sndcdn.com/artworks-test-large.jpg');
  assert.equal(sound.attributes.permalink_url, 'https://soundcloud.com/deck-artist/deck-track');
  assert.equal(sound.attributes.user.permalink_url, 'https://soundcloud.com/deck-artist');
  assert.equal(sound.attributes.waveform_url, 'https://wave.sndcdn.com/test.json');
  assert.equal(sound.player.getPosition(), 12500);
  assert.equal(sound.player.getDuration(), 203250);
});

test('custom deck publishes the track title to Firefox tab and Media Session metadata', () => {
  const state = {
    active: true,
    _deckTrack: 0,
    queue: [0],
    pos: 0,
    meta: [{
      title: 'Firefox Track',
      artist: 'Firefox Artist',
      artwork: 'https://i1.sndcdn.com/artworks-firefox-large.jpg',
    }],
    _tabTitleBeforePlayback: null,
    _tabTitleValue: '',
    _browserMetadataKey: '',
  };
  const document = { title: 'Playlist on SoundCloud' };
  const mediaSession = { metadata: null, playbackState: 'none' };
  function MediaMetadata(init) { Object.assign(this, init); }
  const pageWindow = { navigator: { mediaSession }, MediaMetadata };
  const syncBrowserNowPlaying = Function(
    'state', 'document', 'pageWindow', 'paused',
    `return (${extractFunction('syncBrowserNowPlaying')})`,
  )(state, document, pageWindow, () => false);

  assert.equal(syncBrowserNowPlaying(), true);
  assert.equal(document.title, 'Firefox Track · Firefox Artist');
  assert.equal(mediaSession.metadata.title, 'Firefox Track');
  assert.equal(mediaSession.metadata.artist, 'Firefox Artist');
  assert.equal(mediaSession.metadata.artwork[0].src, state.meta[0].artwork);
  assert.equal(mediaSession.playbackState, 'playing');

  document.title = 'SoundCloud changed this title';
  syncBrowserNowPlaying();
  assert.equal(document.title, 'Firefox Track · Firefox Artist');
});

test('browser tab title is restored when True Shuffle stops', () => {
  const state = {
    active: false,
    _deckTrack: 0,
    queue: [0],
    pos: 0,
    meta: [{ title: 'Finished Track', artist: 'Artist' }],
    _tabTitleBeforePlayback: 'Playlist on SoundCloud',
    _tabTitleValue: 'Finished Track · Artist',
    _browserMetadataKey: 'owned',
  };
  const document = { title: 'Finished Track · Artist' };
  const syncBrowserNowPlaying = Function(
    'state', 'document', 'pageWindow', 'paused',
    `return (${extractFunction('syncBrowserNowPlaying')})`,
  )(state, document, { navigator: {} }, () => true);

  assert.equal(syncBrowserNowPlaying(), false);
  assert.equal(document.title, 'Playlist on SoundCloud');
  assert.equal(state._tabTitleBeforePlayback, null);
  assert.equal(state._browserMetadataKey, '');
});

test('Firefox PiP window title shows the playing track and a clean idle label', () => {
  const ownPipWindowTitle = Function(`return (${extractFunction('ownPipWindowTitle')})`)();
  assert.equal(ownPipWindowTitle({ title: 'Window Track' }, false), 'Playing: Window Track');
  assert.equal(ownPipWindowTitle({ title: 'Window Track' }, true), 'True Shuffle');
  assert.equal(ownPipWindowTitle(null, false), 'True Shuffle');
});

test('PiP scPlayer bridge controls True Shuffle only while its custom deck is active', async () => {
  const calls = [];
  const state = {
    active: true,
    manualAction: false,
    _manualActionAt: 0,
    _deckTrack: 0,
    _pipBridgePlayer: null,
  };
  const nativeSound = { id: 99 };
  const customSound = { id: -1 };
  const player = {
    getCurrentSound: () => nativeSound,
    isPlaying: () => false,
    toggleCurrent: () => calls.push('native-toggle'),
    playNext: () => calls.push('native-next'),
    playPrev: () => calls.push('native-prev'),
    seekCurrentTo: callback => calls.push(['native-seek-to', callback()]),
    seekCurrentBy: callback => calls.push(['native-seek-by', callback()]),
  };
  const deck = { currentTime: 10, duration: 100, paused: false };
  const pageWindow = { scPlayer: player };
  const betterFeedPipActive = () => state.active && Number.isInteger(state._deckTrack);
  const installBetterFeedPipBridge = Function(
    'state', 'pageWindow', 'betterFeedPipActive', 'betterFeedPipSound',
    'toggle', 'next', 'prevTrack', 'currentDeckAudio', 'updateProgressBar', 'updateHub',
    `return (${extractFunction('installBetterFeedPipBridge')})`,
  )(
    state, pageWindow, betterFeedPipActive, () => customSound,
    async () => calls.push('deck-toggle'), async () => calls.push('deck-next'),
    async () => calls.push('deck-prev'), () => deck, () => {}, () => {},
  );

  assert.equal(installBetterFeedPipBridge(), true);
  assert.equal(player.getCurrentSound(), customSound);
  assert.equal(player.isPlaying(), true);
  player.toggleCurrent();
  player.playNext();
  assert.equal(state.manualAction, true);
  assert.ok(state._manualActionAt > 0);
  player.playPrev();
  player.seekCurrentTo(() => 42000);
  player.seekCurrentBy(() => -5000);
  await Promise.resolve();
  assert.equal(deck.currentTime, 37);
  assert.deepEqual(calls, ['deck-toggle', 'deck-next', 'deck-prev']);

  state.active = false;
  assert.equal(player.getCurrentSound(), nativeSound);
  assert.equal(player.isPlaying(), false);
  player.toggleCurrent();
  assert.equal(calls.at(-1), 'native-toggle');
});

test('PiP visual sync repaints Better Feed waveform and time labels from the live deck clock', () => {
  const timeLabels = [{ textContent: '' }, { textContent: '' }];
  const fills = [];
  const context = {
    fillStyle: '',
    clearRect: (...args) => fills.push(['clear', ...args]),
    fillRect: (...args) => fills.push(['fill', context.fillStyle, ...args]),
  };
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 300, height: 30 }),
    getContext: () => context,
  };
  const pipDocument = {
    documentElement: {},
    querySelectorAll: selector => selector === '.pip-time' ? timeLabels : [],
    querySelector: selector => selector === '.pip-waveform' ? canvas : null,
  };
  const pageWindow = {
    documentPictureInPicture: {
      window: {
        document: pipDocument,
        getComputedStyle: () => ({
          getPropertyValue: name => name === '--special-color' ? '#f50' : '#777',
        }),
      },
    },
  };
  const state = {
    _deckTrack: 0,
    meta: [{ title: 'Live track', link: 'https://soundcloud.com/test/live' }],
  };
  const syncBetterFeedPipWindow = Function(
    'state', 'pageWindow', 'documentPipApi', 'betterFeedPipActive', 'playbackTiming',
    'formatPlaybackClock', 'trackId', 'waveformCache', 'DEFAULT_WAVE_HEIGHTS',
    `return (${extractFunction('syncBetterFeedPipWindow')})`,
  )(
    state, pageWindow, () => pageWindow.documentPictureInPicture,
    () => true, () => ({ current: 90, duration: 180 }),
    seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`,
    meta => meta.link, new Map([['https://soundcloud.com/test/live', [25, 50, 75, 100]]]),
    [50, 50, 50, 50],
  );

  assert.equal(syncBetterFeedPipWindow(), true);
  assert.equal(timeLabels[0].textContent, '1:30');
  assert.equal(timeLabels[1].textContent, '3:00');
  assert.equal(canvas.width, 300);
  assert.equal(canvas.height, 30);
  const bars = fills.filter(call => call[0] === 'fill');
  assert.ok(bars.some(call => call[1] === '#f50' && call[2] < 150));
  assert.ok(bars.some(call => call[1] === '#777' && call[2] >= 150));
  assert.equal(bars.filter(call => call[1] === '#f50').length, 50);
});

test('native True Shuffle PiP mirrors the active deck and upcoming queue item', () => {
  const nodes = new Map();
  const node = id => {
    const value = {
      id,
      textContent: '',
      innerHTML: '',
      dataset: {},
      hidden: false,
      src: '',
      attributes: {},
      setAttribute(name, entry) { this.attributes[name] = entry; },
    };
    nodes.set(id, value);
    return value;
  };
  [
    'tss-pip-player', 'tss-pip-title', 'tss-pip-artist', 'tss-pip-position',
    'tss-pip-current', 'tss-pip-remaining', 'tss-pip-artwork',
    'tss-pip-artwork-fallback', 'tss-pip-play', 'tss-pip-up-next-row',
    'tss-pip-next-title', 'tss-pip-next-artist', 'tss-pip-next-number',
    'tss-pip-next-artwork', 'tss-pip-next-fallback', 'tss-pip-next-settings', 'tss-pip-crossfade',
    'tss-pip-crossfade-value', 'tss-pip-auto-level', 'tss-pip-processing', 'tss-pip-waveform',
  ].forEach(node);
  const pipDocument = {
    title: 'True Shuffle',
    documentElement: { style: { setProperty() {} } },
    getElementById: id => nodes.get(id) || null,
  };
  const state = {
    _ownPipWindow: { closed: false, document: pipDocument },
    _deckTrack: 0,
    queue: [0, 1],
    playNext: [],
    pos: 0,
    roundPlayed: 2,
    roundTotal: 10,
    stopAfterRound: false,
    crossfadeSeconds: 8,
    autoLevel: true,
    meta: [
      { title: 'Current', artist: 'Artist A', artwork: 'current.jpg', link: 'current' },
      { title: 'Upcoming', artist: 'Artist B', artwork: 'next.jpg', link: 'next' },
    ],
  };
  const drawn = [];
  const syncOwnPipWindow = Function(
    'state', 'ownPipIsOpen', 'closeOwnPip', 'playbackTiming', 'getComputedStyle',
    'document', 'playerTitle', 'paused', 'SVG', 'trackId', 'waveformCache',
    'DEFAULT_WAVE_HEIGHTS', 'formatPlaybackClock', 'drawOwnPipWaveform', 'renderOwnPipQueue',
    'upcomingTrackIndex', 'ownPipWindowTitle',
    `return (${extractFunction('syncOwnPipWindow')})`,
  )(
    state, () => true, () => {}, () => ({ current: 63, duration: 91 }),
    () => ({ getPropertyValue: () => '#64d8e8' }), { documentElement: {} },
    () => '', () => false, { play: '<play>', pause: '<pause>' }, meta => meta.link,
    new Map(), [50], seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    (...args) => drawn.push(args), () => {},
    () => state.playNext.length ? state.playNext[0] : state.queue[state.pos + 1],
    (meta, isPaused) => meta?.title && !isPaused ? `Playing: ${meta.title}` : 'True Shuffle',
  );

  assert.equal(syncOwnPipWindow(), true);
  assert.equal(pipDocument.title, 'Playing: Current');
  assert.equal(nodes.get('tss-pip-title').textContent, 'Current');
  assert.equal(nodes.get('tss-pip-artist').textContent, 'Artist A');
  assert.equal(nodes.get('tss-pip-position').textContent, '3 / 10');
  assert.equal(nodes.get('tss-pip-current').textContent, '1:03');
  assert.equal(nodes.get('tss-pip-remaining').textContent, '-0:28');
  assert.equal(nodes.get('tss-pip-play').innerHTML, '<pause>');
  assert.equal(nodes.get('tss-pip-next-title').textContent, 'Upcoming');
  assert.equal(nodes.get('tss-pip-next-artist').textContent, 'Artist B');
  assert.equal(nodes.get('tss-pip-next-number').textContent, '4');
  assert.equal(nodes.get('tss-pip-crossfade-value').textContent, '8s fade');
  assert.equal(nodes.get('tss-pip-crossfade').dataset.active, 'true');
  assert.equal(nodes.get('tss-pip-auto-level').dataset.active, 'true');
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0][1].title, 'Current');
});

test('native PiP queue puts play-next requests directly after the current track', () => {
  const state = {
    queue: [4, 1, 2, 3],
    pos: 0,
    playNext: [3, 1, 3],
    meta: [{}, {}, {}, {}, {}],
  };
  const ownPipQueueOrder = Function(
    'state',
    `return (${extractFunction('ownPipQueueOrder')})`,
  )(state);
  assert.deepEqual(ownPipQueueOrder(), [4, 3, 1, 2]);
  assert.equal(new Set(ownPipQueueOrder()).size, 4);
});

test('queueNext rejects the playing track, deduplicates identical requests, and keeps distinct rapid actions', () => {
  const state = {
    _deckTrack: 1,
    queue: [1, 2, 3],
    pos: 0,
    playNext: [],
    history: [],
    roundTotal: 3,
  };
  let refreshes = 0;
  let renders = 0;
  const queueNext = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'renderList',
    `return (${extractFunction('queueNext')})`,
  )(state, () => { refreshes++; }, () => { renders++; });

  assert.equal(queueNext(1), false);
  assert.deepEqual(state.playNext, []);
  assert.equal(queueNext(2), true);
  assert.equal(queueNext(2), false);
  assert.equal(queueNext(3), true);
  assert.deepEqual(state.playNext, [2, 3]);
  assert.equal(refreshes, 2);
  assert.equal(renders, 2);
});

test('queueNext extends the round only when reintroducing a played history track', () => {
  const state = {
    _deckTrack: 2,
    queue: [2, 3, 4],
    pos: 0,
    playNext: [],
    history: [0, 1],
    roundTotal: 5,
  };
  const queueNext = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'renderList',
    `return (${extractFunction('queueNext')})`,
  )(state, () => {}, () => {});

  assert.equal(queueNext(1), true);
  assert.equal(state.roundTotal, 6);
  assert.equal(queueNext(1), false);
  assert.equal(queueNext(2), false);
  assert.equal(queueNext(3), true);
  assert.equal(state.roundTotal, 6);
});

test('jumpTo removes every matching play-next entry before playing now', async () => {
  const state = {
    active: true,
    busy: false,
    manualAction: false,
    suspended: true,
    queue: [0, 1, 2],
    playNext: [2, 1, 2],
    pos: 0,
    history: [],
    roundPlayed: 0,
    roundTotal: 3,
  };
  let refreshes = 0;
  let renders = 0;
  const played = [];
  const removePlayNextOccurrences = Function(
    'state', 'refreshUpcomingCrossfadePreparation',
    `return (${extractFunction('removePlayNextOccurrences')})`,
  )(state, () => { refreshes++; });
  const moveSelectedTrackToCurrent = Function(
    'state', 'refreshUpcomingCrossfadePreparation',
    `return (${extractFunction('moveSelectedTrackToCurrent')})`,
  )(state, () => { refreshes++; });
  const jumpTo = Function(
    'state', 'removePlayNextOccurrences', 'moveSelectedTrackToCurrent',
    'playAt', 'badges', 'renderList',
    `return (${extractFunction('jumpTo').replace(/^function /, 'async function ')})`,
  )(
    state, removePlayNextOccurrences, moveSelectedTrackToCurrent,
    async (ti, countPlay = true) => played.push([ti, countPlay]),
    () => {}, () => { renders++; },
  );

  await jumpTo(-1, 2);

  assert.deepEqual(state.playNext, [1]);
  assert.deepEqual(state.queue, [2, 1]);
  assert.deepEqual(played, [[2, true]]);
  assert.equal(refreshes, 2);
  assert.equal(renders, 1);
});

function createUpcomingRemovalHarness(overrides) {
  const state = {
    _deckTrack: 0,
    queue: [0, 1, 2],
    playNext: [],
    pos: 0,
    roundPlayed: 0,
    roundTotal: 3,
    history: [],
    ...overrides,
  };
  let refreshes = 0;
  let renders = 0;
  let badgeRefreshes = 0;
  const removeTrackFromUpcoming = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'badges', 'renderList',
    `return (${extractFunction('removeTrackFromUpcoming')})`,
  )(
    state,
    () => { refreshes++; },
    () => { badgeRefreshes++; },
    () => { renders++; },
  );
  return { state, removeTrackFromUpcoming, refreshes: () => refreshes, renders: () => renders, badgeRefreshes: () => badgeRefreshes };
}

test('removing a play-next-only track clears every occurrence with one refresh', () => {
  const h = createUpcomingRemovalHarness({ queue: [0, 1], playNext: [7, 7], history: [7], roundTotal: 3 });

  assert.equal(h.removeTrackFromUpcoming(7), true);
  assert.deepEqual(h.state.playNext, []);
  assert.deepEqual(h.state.queue, [0, 1]);
  assert.equal(h.state.roundTotal, 2);
  assert.equal(h.state.pos, 0);
  assert.equal(h.refreshes(), 1);
  assert.equal(h.renders(), 1);
  assert.equal(h.badgeRefreshes(), 0);
});

test('removing a track clears play-next and its future round occurrence together', () => {
  const h = createUpcomingRemovalHarness({ playNext: [2, 2] });

  assert.equal(h.removeTrackFromUpcoming(2), true);
  assert.deepEqual(h.state.playNext, []);
  assert.deepEqual(h.state.queue, [0, 1]);
  assert.equal(h.state.roundTotal, 2);
  assert.equal(h.state.pos, 0);
  assert.equal(h.refreshes(), 1);
  assert.equal(h.renders(), 1);
  assert.equal(h.badgeRefreshes(), 1);
});

test('removing the current track is rejected without mutating either queue', () => {
  const h = createUpcomingRemovalHarness({ playNext: [0, 0] });

  assert.equal(h.removeTrackFromUpcoming(0), false);
  assert.deepEqual(h.state.playNext, [0, 0]);
  assert.deepEqual(h.state.queue, [0, 1, 2]);
  assert.equal(h.state.roundTotal, 3);
  assert.equal(h.state.pos, 0);
  assert.equal(h.refreshes(), 0);
  assert.equal(h.renders(), 0);
});

test('PiP track menu routes play-now and removal through play-next-aware mutations', () => {
  const menu = extractFunction('showOwnPipTrackMenu');
  assert.match(menu, /const pendingNext = state\.playNext\.includes\(ti\)/);
  assert.match(menu, /void jumpTo\(state\.queue\.indexOf\(ti\), ti\)/);
  assert.match(menu, /removeTrackFromUpcoming\(ti\)/);
});

test('native True Shuffle PiP is progressive enhancement with complete controls', () => {
  const apiResolverSource = extractFunction('documentPipApi');
  const open = extractFunction('openOwnPip');
  const mount = extractFunction('mountOwnPipWindow');
  const stop = extractFunction('stop');
  const hub = extractFunction('mkHub');
  const unsupportedResolver = Function('pageWindow', `return (${apiResolverSource})`)({});
  const supportedResolver = Function('pageWindow', `return (${apiResolverSource})`)({
    documentPictureInPicture: { requestWindow() {} },
  });
  const wrappedResolver = Function('pageWindow', `return (${apiResolverSource})`)({
    wrappedJSObject: { documentPictureInPicture: { requestWindow() {} } },
  });
  assert.equal(Boolean(unsupportedResolver()), false);
  assert.equal(Boolean(supportedResolver()), true);
  assert.equal(wrappedResolver()?.requestWindow instanceof Function, true);
  assert.match(apiResolverSource, /wrappedJSObject/);
  assert.match(open, /requestWindow\(\{ width: 390, height: 330 \}\)/);
  assert.match(open, /openVideoPipFallback/);
  assert.match(open, /openInPagePipFallback/);
  assert.match(mount, /tss-pip-waveform/);
  assert.match(mount, /tss-pip-view-toggle/);
  assert.match(mount, /tss-pip-queue-view/);
  assert.match(mount, /tss-pip-stage/);
  assert.match(mount, /tssPipRowIn/);
  assert.match(mount, /overflow-x:hidden/);
  assert.match(mount, /tss-pip-next-settings/);
  assert.match(mount, /renderOwnPipQueue/);
  assert.match(mount, /tss-pip-tab-history/);
  assert.match(mount, /tss-pip-queue-search/);
  assert.match(mount, /tss-pip-like/);
  assert.match(mount, /toggleCurrentTrackLike/);
  assert.match(mount, /showOwnPipSoundMenu/);
  assert.match(extractFunction('renderOwnPipQueue'), /showOwnPipTrackMenu/);
  assert.match(extractFunction('showOwnPipTrackMenu'), /Shuffle priority/);
  assert.match(extractFunction('showOwnPipTrackMenu'), /Remove from queue/);
  assert.match(mount, /state\.manualAction = true/);
  assert.match(mount, /void next\(\)/);
  assert.match(mount, /void prevTrack\(\)/);
  assert.match(mount, /void toggle\(\)/);
  assert.match(stop, /closeOwnPip\(\)/);
  assert.match(hub, /id="tss-hub-pip"/);
});

test('PiP like state follows SoundCloud selected and aria states', () => {
  const soundCloudLikeButtonState = Function(`return (${extractFunction('soundCloudLikeButtonState')})`)();
  const button = (selected, label) => ({
    classList: { contains: name => name === 'sc-button-selected' && selected },
    getAttribute: name => name === 'aria-label' ? label : null,
  });
  assert.equal(soundCloudLikeButtonState(button(false, 'Like')), false);
  assert.equal(soundCloudLikeButtonState(button(true, 'Unlike')), true);
  assert.equal(soundCloudLikeButtonState(button(false, 'Unlike')), true);
});

test('PiP like control uses the native authenticated SoundCloud button', () => {
  const finder = extractFunction('findSoundCloudLikeButton');
  const toggleLike = extractFunction('toggleCurrentTrackLike');
  const syncPip = extractFunction('syncOwnPipWindow');
  assert.match(finder, /\.playbackSoundBadge__like/);
  assert.match(finder, /bound\.querySelector\('\.sc-button-like'\)/);
  assert.match(toggleLike, /button\.click\(\)/);
  assert.match(toggleLike, /state\._likeBusy/);
  assert.match(syncPip, /like\.setAttribute\('aria-pressed'/);
  assert.match(syncPip, /SVG\.heartFilled/);
});

test('PiP fallbacks cover native video and an interactive in-page player', () => {
  const videoSupport = extractFunction('standardVideoPipSupported');
  const video = extractFunction('openVideoPipFallback');
  const inline = extractFunction('openInPagePipFallback');
  const close = extractFunction('closeOwnPip');
  assert.match(videoSupport, /requestPictureInPicture/);
  assert.match(videoSupport, /webkitSetPresentationMode/);
  assert.match(video, /captureStream\(8\)/);
  assert.match(video, /drawVideoPipFrame/);
  assert.match(inline, /resize:both/);
  assert.match(inline, /mountOwnPipWindow/);
  assert.match(inline, /pointermove/);
  assert.match(close, /exitPictureInPicture/);
  assert.match(close, /_ownPipHost/);
});

test('watcher retries the PiP bridge after Better SoundCloud Feed discovers scPlayer', () => {
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /installBetterFeedPipBridge\(\)/);
  assert.match(watcher, /syncOwnPipWindow\(\)/);
  assert.match(watcher, /syncBetterFeedPipWindow\(\)/);
});

test('native playback pause never toggles the transport or touches True Shuffle decks', () => {
  const ownDeck = { paused: false, dataset: { tssCrossfadeDeck: '0' }, pauseCalls: 0, pause() { this.pauseCalls++; } };
  const nativeAudio = { paused: false, dataset: {}, pauseCalls: 0, pause() { this.paused = true; this.pauseCalls++; } };
  const button = {
    title: 'Pause current track',
    clickCalls: 0,
    getAttribute: () => 'Pause current track',
    click() { this.clickCalls++; this.title = 'Play current track'; },
  };
  const state = {
    _decks: [ownDeck],
    _nativeGuardButtonAction: false,
  };
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'audio');
      return [ownDeck, nativeAudio];
    },
    querySelector(selector) {
      assert.equal(selector, '.playControls__play');
      return button;
    },
  };
  const isTrueShuffleAudio = Function(
    'state',
    `return (${extractFunction('isTrueShuffleAudio')})`,
  )(state);
  const pauseSoundCloud = Function(
    'document',
    'isTrueShuffleAudio',
    `return (${extractFunction('pauseSoundCloud')})`,
  )(document, isTrueShuffleAudio);

  pauseSoundCloud();
  pauseSoundCloud();

  assert.equal(ownDeck.pauseCalls, 0);
  assert.equal(nativeAudio.pauseCalls, 1);
  assert.equal(button.clickCalls, 0);
  assert.equal(state._nativeGuardButtonAction, false);
});

test('native playback guard blocks autoplay and manual transport starts outside fallback only', () => {
  const listeners = {};
  const timers = [];
  const microtasks = [];
  const state = {
    active: true,
    queue: [7],
    pos: 0,
    _decks: [],
    _nativePlaybackFallback: null,
    _nativePlaybackGuardInstalled: false,
    _nativeGuardButtonAction: false,
  };
  const document = {
    addEventListener(type, handler, capture) { listeners[type] = { handler, capture }; },
  };
  const nativePlaybackFallbackActive = Function(
    'state', 'clearNativePlaybackFallback',
    `return (${extractFunction('nativePlaybackFallbackActive')})`,
  )(state, () => { state._nativePlaybackFallback = null; });
  let pauseSoundCloudCalls = 0;
  const installNativePlaybackGuard = Function(
    'state',
    'document',
    'isTrueShuffleAudio',
    'nativePlaybackFallbackActive',
    'pauseSoundCloud',
    'queueMicrotask',
    'setTimeout',
    `return (${extractFunction('installNativePlaybackGuard')})`,
  )(
    state,
    document,
    audio => state._decks.includes(audio) || audio.dataset?.tssCrossfadeDeck !== undefined,
    nativePlaybackFallbackActive,
    () => { pauseSoundCloudCalls++; },
    fn => microtasks.push(fn),
    (fn, delay) => timers.push({ fn, delay }),
  );

  installNativePlaybackGuard();
  assert.equal(listeners.click.capture, true);
  assert.equal(listeners.play.capture, true);
  assert.deepEqual(timers.map(timer => timer.delay), [0, 100, 500, 1500, 3000]);

  state.active = false;
  const inactiveClick = {
    target: { closest: () => ({}) },
    prevented: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() {},
  };
  const inactiveAudio = { tagName: 'AUDIO', dataset: {}, pauseCalls: 0, pause() { this.pauseCalls++; } };
  listeners.click.handler(inactiveClick);
  listeners.play.handler({ target: inactiveAudio });
  timers.forEach(timer => timer.fn());
  assert.equal(inactiveClick.prevented, false);
  assert.equal(inactiveAudio.pauseCalls, 0);
  assert.equal(pauseSoundCloudCalls, 0);
  state.active = true;

  const transport = { closest: selector => selector === '.playControls__play' ? transport : null };
  const manualClick = {
    target: transport,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  listeners.click.handler(manualClick);
  assert.equal(manualClick.prevented, true);
  assert.equal(manualClick.stopped, true);
  microtasks.shift()();
  assert.equal(pauseSoundCloudCalls, 1);

  const nativeAudio = { tagName: 'AUDIO', dataset: {}, pauseCalls: 0, pause() { this.pauseCalls++; } };
  listeners.play.handler({ target: nativeAudio });
  assert.equal(nativeAudio.pauseCalls, 1);

  const ownDeck = { tagName: 'AUDIO', dataset: { tssCrossfadeDeck: '1' }, pauseCalls: 0, pause() { this.pauseCalls++; } };
  listeners.play.handler({ target: ownDeck });
  assert.equal(ownDeck.pauseCalls, 0);

  state._nativePlaybackFallback = { trackIndex: 7, expiresAt: Date.now() + 3000 };
  const fallbackClick = {
    target: transport,
    prevented: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() {},
  };
  listeners.click.handler(fallbackClick);
  listeners.play.handler({ target: nativeAudio });
  assert.equal(fallbackClick.prevented, false);
  assert.equal(nativeAudio.pauseCalls, 1);

  state._nativePlaybackFallback = null;
  timers.forEach(timer => timer.fn());
  assert.equal(pauseSoundCloudCalls, 6);

  const guard = extractFunction('installNativePlaybackGuard');
  assert.match(guard, /addEventListener\('click'/);
  assert.match(guard, /addEventListener\('play'/);
  assert.match(guard, /isTrueShuffleAudio\(audio\)/);
  assert.match(guard, /\[0, 100, 500, 1500, 3000\]/);
  assert.match(source, /installNativePlaybackGuard\(\);\s*onNav\(\);/);
});

test('build copies the canonical userscript byte-for-byte without using legacy modules', () => {
  const root = path.resolve(__dirname, '..');
  const buildSource = fs.readFileSync(path.join(root, 'build.py'), 'utf8');
  assert.doesNotMatch(buildSource, /src[/\\\\]|FILES\s*=|HEADER\s*=|FOOTER\s*=/);
  assert.match(buildSource, /SOURCE\s*=\s*ROOT \/ "SC Trueshuffle\.js"/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-build-'));
  const output = path.join(tempDir, 'SC Trueshuffle.user.js');
  try {
    const result = childProcess.spawnSync(
      process.env.PYTHON || 'python',
      [path.join(root, 'build.py'), '--output', output],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(scriptPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('playAt scopes native fallback permission and clears it on the next path or stop', () => {
  const playAt = extractFunction('playAt');
  const stop = extractFunction('stop');
  assert.match(playAt, /if \(!state\.active\) return;\s*clearNativePlaybackFallback\(\);/);
  assert.match(playAt, /beginNativePlaybackFallback\(idx\);\s*btn\.click\(\);/);
  assert.match(playAt, /if \(!btn\) \{\s*clearNativePlaybackFallback\(\);/);
  assert.match(stop, /clearNativePlaybackFallback\(\);/);
});

test('playlist hydration parser exposes the complete stable track id list', () => {
  const playlistSnapshotFromHtml = Function(`return (${extractFunction('playlistSnapshotFromHtml')})`)();
  const payload = [
    { hydratable: 'user', data: { id: 9 } },
    { hydratable: 'playlist', data: {
      id: 44, kind: 'playlist', track_count: 3,
      tracks: [
        { id: 10, title: 'A', permalink_url: 'https://soundcloud.com/a/a' },
        { id: 11, kind: 'track' },
        { id: 12, kind: 'track' },
      ],
    } },
  ];
  const snapshot = playlistSnapshotFromHtml(`<script>window.__sc_hydration = ${JSON.stringify(payload)};</script>`);
  assert.equal(snapshot.id, 44);
  assert.equal(snapshot.trackCount, 3);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.tracks.map(track => track.id), [10, 11, 12]);
  assert.equal(playlistSnapshotFromHtml('<html></html>'), null);
});

test('live tracks are inserted only into the unplayed part of the round', () => {
  const insertTracksRandomlyAfterCurrent = Function(
    `return (${extractFunction('insertTracksRandomlyAfterCurrent')})`,
  )();
  const queue = [0, 1, 2, 3];
  const values = [0, 0.999999];
  insertTracksRandomlyAfterCurrent(queue, 1, [4, 5], () => values.shift());
  assert.deepEqual(queue.slice(0, 2), [0, 1]);
  assert.equal(new Set(queue).size, 6);
  assert.deepEqual([...queue].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.ok(queue.indexOf(4) > 1);
  assert.ok(queue.indexOf(5) > 1);
});

test('complete playlist collection fills tracks SoundCloud did not render in the DOM', async () => {
  const pageUrl = 'https://soundcloud.com/user/sets/list';
  const firstEl = { id: 'first' };
  const getMeta = el => ({ title: 'First', artist: 'A', link: `https://soundcloud.com/a/${el.id}`, sourcePage: pageUrl });
  const trackId = Function(`return (${extractFunction('trackId')})`)();
  const completePlaylistCollection = Function(
    'getMeta', 'fetchLivePlaylistSnapshot', 'resolvePlaylistSnapshotMetas', 'trackId',
    `return (${extractFunction('completePlaylistCollection').replace(/^function /, 'async function ')})`,
  )(
    getMeta, async () => null,
    async () => [
      getMeta(firstEl),
      { title: 'Second', artist: 'B', link: 'https://soundcloud.com/b/second', sourcePage: pageUrl },
      { title: 'Third', artist: 'C', link: 'https://soundcloud.com/c/third', sourcePage: pageUrl },
    ],
    trackId,
  );
  const snapshot = { complete: true, tracks: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const result = await completePlaylistCollection(pageUrl, [firstEl], Promise.resolve(snapshot));
  assert.equal(result.meta.length, 3);
  assert.equal(result.els.length, 3);
  assert.equal(result.els[0], firstEl);
  assert.equal(result.els[1], null);
  assert.equal(result.complete, true);
});

test('playlist metadata is batch-resolved in bounded requests and keeps playlist order', async () => {
  const requests = [];
  const snapshot = { tracks: [...Array(117)].map((_, index) => ({ id: index + 1 })) };
  const resolvePlaylistSnapshotMetas = Function(
    'metaFromSoundCloudTrack', 'discoverSoundCloudClientIdFromBundle', 'fetch', 'URL',
    `return (${extractFunction('resolvePlaylistSnapshotMetas').replace(/^function /, 'async function ')})`,
  )(
    (track, sourcePage, playlistPosition) => track.title
      ? { soundcloudId: track.id, title: track.title, link: `https://soundcloud.com/a/${track.id}`, sourcePage, playlistPosition }
      : null,
    async () => 'client-id',
    async endpoint => {
      const ids = endpoint.searchParams.get('ids').split(',').map(Number);
      requests.push(ids);
      return { ok: true, json: async () => ids.map(id => ({ id, title: `Track ${id}` })) };
    },
    URL,
  );
  const metas = await resolvePlaylistSnapshotMetas(snapshot, 'https://soundcloud.com/user/sets/list');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(batch => batch.length), [50, 50, 17]);
  assert.equal(metas.length, 117);
  assert.equal(metas[0].soundcloudId, 1);
  assert.equal(metas[116].soundcloudId, 117);
  assert.equal(metas[116].playlistPosition, 117);
});

test('metadata-only playlist tracks try the custom player before DOM fallback', () => {
  const playAt = extractFunction('playAt');
  const customAttempt = playAt.indexOf('playWithCrossfadeDeck(idx, countPlay, requestedFade)');
  const reconnectAttempt = playAt.indexOf('reconnectTrackElement(idx)');
  assert.ok(customAttempt >= 0);
  assert.ok(reconnectAttempt > customAttempt);
});

test('live queue application preserves current playback and updates the round once', () => {
  const state = {
    active: true, suspended: false, pos: 0,
    queue: [0, 1], roundTotal: 2,
    meta: [
      { title: 'Current', artist: 'A', link: 'https://soundcloud.com/a/current' },
      { title: 'Later', artist: 'B', link: 'https://soundcloud.com/b/later' },
    ],
    els: [{}, {}],
  };
  const calls = [];
  const trackId = Function(`return (${extractFunction('trackId')})`)();
  const applyLiveQueueTracks = Function(
    'state', 'trackId', 'getMeta', 'insertTracksRandomlyAfterCurrent', 'fisherYates',
    'refreshUpcomingCrossfadePreparation', 'badges', 'renderList', 'updateHub', 'showMergeToast',
    `return (${extractFunction('applyLiveQueueTracks')})`,
  )(
    state, trackId, () => ({}),
    (queue, pos, indices) => queue.splice(pos + 1, 0, ...indices),
    items => items.slice(),
    () => calls.push('prefetch'), () => calls.push('badges'),
    () => calls.push('list'), () => calls.push('hub'), message => calls.push(message),
  );
  const added = applyLiveQueueTracks([
    { soundcloudId: 20, title: 'New A', artist: 'C', link: 'https://soundcloud.com/c/new-a', sourcePage: 'playlist' },
    { soundcloudId: 21, title: 'New B', artist: 'D', link: 'https://soundcloud.com/d/new-b', sourcePage: 'playlist' },
    { soundcloudId: 20, title: 'Duplicate', artist: 'C', link: 'https://soundcloud.com/c/new-a', sourcePage: 'playlist' },
  ]);
  assert.equal(added, 2);
  assert.equal(state.queue[0], 0);
  assert.equal(state.roundTotal, 4);
  assert.equal(state.meta.length, 4);
  assert.equal(new Set(state.queue).size, 4);
  assert.deepEqual(calls.slice(0, 4), ['prefetch', 'badges', 'list', 'hub']);
  assert.equal(calls[4], '2 new tracks added to this round');
});

test('first live snapshot resolves and applies a track added after initial collection', async () => {
  const state = {
    active: true, loading: false, busy: false, suspended: false,
    playlistUrl: 'https://soundcloud.com/user/sets/list',
    _liveSyncKnownIds: new Set(), _liveSyncInFlight: false,
    _liveSyncLastCheck: 0, _liveSyncSource: '',
    meta: [
      { soundcloudId: 1, sourcePage: 'https://soundcloud.com/user/sets/list' },
      { soundcloudId: 2, sourcePage: 'https://soundcloud.com/user/sets/list' },
    ],
  };
  const resolved = [];
  const applied = [];
  const syncLiveQueue = Function(
    'state', 'LIVE_SYNC_INTERVAL_MS', 'fetchLivePlaylistSnapshot', 'resolveLiveTrackMeta',
    'playlistBase', 'location', 'document', 'applyLiveQueueTracks', 'reconcileLivePlaylistSnapshot',
    'badges', 'renderList', 'refreshUpcomingCrossfadePreparation', 'updateHub', 'showLiveSyncResult',
    `return (${extractFunction('syncLiveQueue').replace(/^function /, 'async function ')})`,
  )(
    state, 30_000, async () => ({ complete: true, tracks: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    async track => {
      resolved.push(track.id);
      return { soundcloudId: track.id, title: 'New', link: 'https://soundcloud.com/new/track', sourcePage: state.playlistUrl };
    },
    value => value, { href: state.playlistUrl }, { querySelectorAll: () => [] },
    metas => { applied.push(...metas); state.meta.push(...metas); return metas.length; },
    () => 0, () => {}, () => {}, () => {}, () => {}, () => {},
  );
  assert.equal(await syncLiveQueue({ force: true }), 1);
  assert.deepEqual(resolved, [3]);
  assert.equal(applied.length, 1);
  assert.deepEqual([...state._liveSyncKnownIds], [1, 2, 3]);
  assert.ok(state._liveSyncKnownIds.has(3));
  assert.equal(state._liveSyncInFlight, false);
});

test('unresolved first-snapshot candidates remain retryable', async () => {
  const state = {
    active: true, loading: false, busy: false, suspended: false,
    playlistUrl: 'https://soundcloud.com/user/sets/list',
    _liveSyncKnownIds: new Set(), _liveSyncInFlight: false,
    _liveSyncLastCheck: 0, _liveSyncSource: '',
    meta: [
      { soundcloudId: 1, sourcePage: 'https://soundcloud.com/user/sets/list' },
      { soundcloudId: 2, sourcePage: 'https://soundcloud.com/user/sets/list' },
    ],
  };
  let resolveAttempts = 0;
  const applied = [];
  const syncLiveQueue = Function(
    'state', 'LIVE_SYNC_INTERVAL_MS', 'fetchLivePlaylistSnapshot', 'resolveLiveTrackMeta',
    'playlistBase', 'location', 'document', 'applyLiveQueueTracks', 'reconcileLivePlaylistSnapshot',
    'badges', 'renderList', 'refreshUpcomingCrossfadePreparation', 'updateHub', 'showLiveSyncResult',
    `return (${extractFunction('syncLiveQueue').replace(/^function /, 'async function ')})`,
  )(
    state, 30_000, async () => ({ complete: true, tracks: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    async track => {
      resolveAttempts++;
      return resolveAttempts === 1
        ? null
        : { soundcloudId: track.id, title: 'New', link: 'https://soundcloud.com/new/track', sourcePage: state.playlistUrl };
    },
    value => value, { href: state.playlistUrl }, { querySelectorAll: () => [] },
    metas => { applied.push(...metas); state.meta.push(...metas); return metas.length; },
    () => 0, () => {}, () => {}, () => {}, () => {}, () => {},
  );

  assert.equal(await syncLiveQueue({ force: true }), 0);
  assert.equal(state._liveSyncKnownIds.has(3), false);
  assert.equal(await syncLiveQueue({ force: true }), 1);
  assert.equal(resolveAttempts, 2);
  assert.equal(applied.length, 1);
  assert.equal(state._liveSyncKnownIds.has(3), true);
});

test('live snapshot removes missing tracks only from the upcoming queue', () => {
  const sourcePage = 'https://soundcloud.com/user/sets/list';
  const state = {
    queue: [0, 1, 2, 3], pos: 1, playNext: [2, 3], history: [0],
    roundPlayed: 1, roundTotal: 4, _deckTrack: 1,
    _liveSyncKnownIds: new Set([10, 11, 12, 13]),
    meta: [
      { soundcloudId: 10, link: 'https://soundcloud.com/a/one', sourcePage },
      { soundcloudId: 11, link: 'https://soundcloud.com/a/two', sourcePage },
      { soundcloudId: 12, link: 'https://soundcloud.com/a/three', sourcePage },
      { soundcloudId: 13, link: 'https://soundcloud.com/a/four', sourcePage },
    ],
    els: [{}, {}, {}, {}],
  };
  const playlistBase = value => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const trackId = Function(`return (${extractFunction('trackId')})`)();
  const reconcile = Function(
    'state', 'playlistBase', 'trackId', 'getMeta',
    `return (${extractFunction('reconcileLivePlaylistSnapshot')})`,
  )(state, playlistBase, trackId, () => ({}));

  const removed = reconcile({ tracks: [{ id: 10 }, { id: 11 }, { id: 13 }] }, sourcePage, []);
  assert.equal(removed, 1);
  assert.deepEqual(state.queue, [0, 1, 3]);
  assert.deepEqual(state.playNext, [3]);
  assert.equal(state.roundTotal, 3);
  assert.equal(state.meta[2].unavailable, true);
  assert.equal(state._liveSyncKnownIds.has(12), false);
  assert.equal(state.queue[state.pos], 1);
});

test('live snapshot keeps a removed current track playing until it finishes', () => {
  const sourcePage = 'https://soundcloud.com/user/sets/list';
  const state = {
    queue: [0, 1, 2], pos: 1, playNext: [], history: [0],
    roundPlayed: 1, roundTotal: 3, _deckTrack: 1,
    _liveSyncKnownIds: new Set([10, 11, 12]),
    meta: [
      { soundcloudId: 10, link: 'https://soundcloud.com/a/one', sourcePage },
      { soundcloudId: 11, link: 'https://soundcloud.com/a/two', sourcePage },
      { soundcloudId: 12, link: 'https://soundcloud.com/a/three', sourcePage },
    ],
    els: [{}, {}, {}],
  };
  const playlistBase = value => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const trackId = Function(`return (${extractFunction('trackId')})`)();
  const reconcile = Function(
    'state', 'playlistBase', 'trackId', 'getMeta',
    `return (${extractFunction('reconcileLivePlaylistSnapshot')})`,
  )(state, playlistBase, trackId, () => ({}));

  assert.equal(reconcile({ tracks: [{ id: 10 }, { id: 12 }] }, sourcePage, []), 1);
  assert.equal(state.queue[state.pos], 1);
  assert.equal(state.meta[1].removedFromPlaylist, true);
  assert.equal(state.meta[1].unavailable, undefined);
  assert.equal(state.roundTotal, 3);
});

test('partial live snapshots never remove unseen playlist tracks', () => {
  const sourcePage = 'https://soundcloud.com/user/sets/list';
  const state = {
    queue: [0, 1], pos: 0, playNext: [], history: [],
    roundPlayed: 0, roundTotal: 2, _deckTrack: 0,
    _liveSyncKnownIds: new Set([10, 11]),
    meta: [
      { soundcloudId: 10, link: 'https://soundcloud.com/a/one', sourcePage },
      { soundcloudId: 11, link: 'https://soundcloud.com/a/two', sourcePage },
    ],
    els: [{}, {}],
  };
  const playlistBase = value => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const trackId = Function(`return (${extractFunction('trackId')})`)();
  const reconcile = Function(
    'state', 'playlistBase', 'trackId', 'getMeta',
    `return (${extractFunction('reconcileLivePlaylistSnapshot')})`,
  )(state, playlistBase, trackId, () => ({}));

  assert.equal(reconcile({ complete: false, tracks: [{ id: 10 }] }, sourcePage, []), 0);
  assert.deepEqual(state.queue, [0, 1]);
  assert.equal(state._liveSyncKnownIds.has(11), true);
  assert.equal(state.meta[1].unavailable, undefined);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    }
  }
  console.log('\nAll True Shuffle regression tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

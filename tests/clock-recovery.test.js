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
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createClock() {
  let now = 100000;
  let nextId = 0;
  const jobs = new Map();
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const install = (callback, delay, repeat = false) => {
    const id = ++nextId;
    jobs.set(id, { callback, at: now + Math.max(1, delay || 0), delay: Math.max(1, delay || 0), repeat });
    return id;
  };
  const fire = async id => {
    const job = jobs.get(id);
    if (!job) return;
    if (job.repeat) job.at = now + job.delay;
    else jobs.delete(id);
    job.callback();
    await flush();
  };
  return {
    now: () => now,
    setTimeout: (callback, delay) => install(callback, delay),
    clearTimeout: id => jobs.delete(id),
    setInterval: (callback, delay) => install(callback, delay, true),
    clearInterval: id => jobs.delete(id),
    flush,
    async advance(ms) {
      const target = now + ms;
      await flush();
      while (true) {
        const due = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at);
        await fire(due[0]);
      }
      now = target;
      await flush();
    },
    async jump(ms) {
      now += ms;
      const due = [...jobs].filter(([, job]) => job.at <= now).map(([id]) => id);
      for (const id of due) await fire(id);
      await flush();
    },
    intervals: () => [...jobs.values()].filter(job => job.repeat).length,
  };
}

function createHarness(options = {}) {
  const clock = createClock();
  const events = [];
  const workers = [];
  const revoked = [];
  const counts = { resolves: 0, activeRequests: 0, peakRequests: 0, next: 0, sleepChecks: 0, resume: 0 };
  const graphResume = options.resume;
  const makeAudio = index => {
    const listeners = new Map();
    let src = `original-${index}`;
    const audio = {
      tagName: 'AUDIO', currentTime: options.current ?? 60, duration: 180,
      readyState: 4, networkState: 1, paused: false, ended: false, seeking: false,
      playbackRate: 1, preload: 'auto', volume: 1, playCalls: 0,
      buffered: { length: 1, start: () => 0, end: () => 180 },
      get src() { return src; },
      set src(value) { src = value; this.currentTime = 0; this.readyState = 0; },
      get currentSrc() { return src; },
      pause() { this.paused = true; },
      load() {
        this.paused = true;
        if (options.readiness !== 'fail' && options.readiness !== 'hold') {
          this.readyState = 4;
          this.emit('canplay');
        }
      },
      play() {
        this.playCalls++;
        if (options.play) return options.play(this);
        this.paused = false;
        return Promise.resolve();
      },
      removeAttribute(name) { if (name === 'src') src = ''; },
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
      listenerCount: () => [...listeners.values()].reduce((n, entries) => n + entries.length, 0),
    };
    return audio;
  };
  const decks = [makeAudio(0), makeAudio(1)];
  const audioContext = options.graph === false ? null : {
    state: 'running', currentTime: 0,
    resume() {
      counts.resume++;
      if (graphResume) return graphResume(this);
      this.state = 'running';
      return Promise.resolve();
    },
    suspend() { this.state = 'suspended'; return Promise.resolve(); },
  };
  const param = () => ({
    value: 1,
    cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime() { if (options.automationError) throw new Error('automation failed'); },
  });
  const state = {
    active: true, busy: false, loading: false, suspended: false, manualAction: false,
    _playbackEpoch: 1, _playbackAbort: new AbortController(), _collectionEpoch: 1,
    _playbackRequest: null, _userPaused: false, _pendingPlaybackTrack: null,
    _decks: decks, _deckIndex: 0, _deckTrack: 0, _nativeTrack: null,
    _deckTracks: [0, 1], _deckPrepareTokens: [0, 0], _deckGains: [1, 0],
    _deckPrepareAbort: [null, null], _deckPlayTokens: [0, 0],
    _deckAudioGraphs: audioContext ? decks.map(() => ({ mixGain: { gain: param() } })) : [],
    _audioContext: audioContext, _audioGraphFailed: false,
    _crossfadeToken: 1, _crossfadePrefetchToken: 0, _crossfadeSchedule: null,
    _crossfading: false, _crossfadePausedByUser: false, _crossfadePending: false,
    crossfadeCurve: 'clean', crossfadeSeconds: options.crossfadeSeconds ?? 0,
    _streamCache: new Map(), playNext: [], queue: [0, 1, 2], pos: 0,
    meta: [{ link: 'track-a' }, { link: 'track-b' }, { link: 'track-c' }],
    history: [], priority: {}, els: [{}], stopAfterRound: false,
    worker: null, _workerInterval: null, _endedHandler: null,
    roundPlayed: 0, roundTotal: 3, lastTitle: 'A', lastProgress: 0,
    playlistUrl: 'https://soundcloud.com/example/set',
  };
  const document = {
    body: { contains: () => true },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
  };
  class Worker {
    constructor() {
      if (options.workerThrows) throw new Error('worker denied');
      this.terminated = false;
      workers.push(this);
    }
    postMessage() {
      if (options.workerSilent) return;
      clock.setTimeout(() => this.onmessage?.({ data: 'ready' }), 1);
      this.interval = clock.setInterval(() => this.onmessage?.({ data: 0 }), 50);
    }
    terminate() { this.terminated = true; clock.clearInterval(this.interval); }
    fail() { this.onerror?.({ preventDefault() {} }); }
  }
  const context = vm.createContext({
    state, document, Worker, Blob, URL: { createObjectURL: () => 'blob:clock', revokeObjectURL: url => revoked.push(url) },
    AbortController, DOMException, Float32Array, console,
    Date: { now: clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    currentDeckAudio: () => Number.isInteger(state._deckTrack) ? state._decks[state._deckIndex] : null,
    playerTitle: () => state.meta[state._deckTrack]?.link || 'A',
    playbackTiming: () => {
      const deck = state._decks[state._deckIndex];
      return { current: deck.currentTime, duration: deck.duration, ended: deck.ended, source: 'audio' };
    },
    progress: () => decks[state._deckIndex].currentTime / decks[state._deckIndex].duration,
    paused: () => decks[state._deckIndex].paused,
    wait: ms => new Promise(resolve => clock.setTimeout(resolve, ms)),
    next: async () => { counts.next++; state.active = false; },
    resolveCrossfadeStream: async (_meta, { signal }) => {
      counts.resolves++;
      counts.activeRequests++;
      counts.peakRequests = Math.max(counts.peakRequests, counts.activeRequests);
      let released = false;
      const release = () => { if (!released) { released = true; counts.activeRequests--; } };
      signal.addEventListener('abort', release, { once: true });
      try {
        return options.resolve ? await options.resolve(signal) : `fresh-${counts.resolves}`;
      } finally { release(); signal.removeEventListener('abort', release); }
    },
    ensureAutoLevelAudioGraph: () => Boolean(audioContext),
    resetDeck: (audio, index) => { audio.pause(); state._deckTracks[index] = null; },
    recordPlaybackDiagnostic: (name, details) => events.push({ name, details }),
    playbackDiagnosticSnapshot: reason => ({ reason }),
    setCrossfadeStatus: status => { state.status = status; },
    syncCrossfadeVolume: () => { if (options.volumeError) throw new Error('volume failed'); },
    checkSleepTimerDeadline: () => { counts.sleepChecks++; return false; },
    upcomingCrossfadeDeckReady: () => false,
    prefetchUpcomingCrossfadeTrack: async () => {},
    refreshPlayBtn() {}, updateHub() {}, installBetterFeedPipBridge() {},
    syncOwnPipWindow() {}, syncBetterFeedPipWindow() {}, syncPlaybackVolumeFromSoundCloud() {}, processAutoLevel() {},
    syncLiveQueue: async () => {}, LIVE_SYNC_INTERVAL_MS: 60000,
    consumeCurrentQueueTrack() {}, saveQueueSessionCache: () => true,
    pauseSoundCloud() {}, pauseSoundCloudTransport() {},
    runPlaybackOperation: async (_label, operation) => operation(), playAt: async () => true,
  });
  const names = [
    'withDeadline', 'invalidatePlaybackSession', 'waitForDeck', 'playDeckWithDeadline',
    'resumeAudioGraph', 'suspendAudioGraph', 'cancelCrossfadeForRecovery', 'recoverCurrentDeckStream',
    'pause', 'toggle', 'crossfadeGains', 'setAudioParamImmediately', 'scheduleAudioParamCurve',
    'waitForCrossfadeSchedule', 'settleScheduledCrossfade', 'animateDeckCrossfadeFallback', 'animateDeckCrossfade',
    'mkWorker', 'nativePlaybackAllowed', 'startWatcher',
  ];
  vm.runInContext(names.map(extractFunction).join('\n\n'), context);
  const restart = () => {
    state._watcherCleanup?.();
    state.active = false;
    context.invalidatePlaybackSession();
    state._crossfadeToken++;
    state._deckPrepareTokens = state._deckPrepareTokens.map(value => value + 1);
    state.active = true;
    state._userPaused = false;
    state._deckIndex = 0;
    state._deckTrack = 2;
    state._deckTracks[0] = 2;
    decks[0].src = 'new-session';
    decks[0].currentTime = 23;
    decks[0].paused = false;
    state._deckGains = [0.75, 0.25];
    state.status = 'new-session';
  };
  return { context, state, decks, clock, events, workers, revoked, counts, restart };
}

for (const failure of ['readiness', 'play']) {
  test(`watcher retries real ${failure} failure after reload pauses the deck, then advances`, async () => {
    const h = createHarness(failure === 'readiness'
      ? { readiness: 'fail' }
      : { play: () => Promise.reject(new Error('media rejected')) });
    h.context.startWatcher();
    await h.clock.advance(60000);
    assert.equal(h.counts.resolves, 2);
    assert.equal(h.counts.peakRequests, 1);
    assert.equal(h.counts.next, 1);
    assert.equal(h.events.filter(event => event.name === 'recovery-exhausted').length, 1);
    h.state._watcherCleanup?.();
  });
}

for (const stage of ['resolve', 'resume', 'play']) {
  test(`full recovery terminates a never-settling ${stage} and never overlaps attempts`, async () => {
    const held = deferred();
    const options = stage === 'resolve' ? { resolve: () => held.promise }
      : stage === 'resume' ? { resume: () => held.promise } : { play: () => held.promise };
    const h = createHarness(options);
    if (stage === 'resume') h.state._audioContext.state = 'suspended';
    h.context.startWatcher();
    await h.clock.advance(90000);
    assert.equal(h.counts.resolves, 2);
    assert.equal(h.counts.next, 1);
    assert.equal(h.counts.peakRequests, 1);
    assert.equal(h.counts.activeRequests, 0);
    h.state._watcherCleanup?.();
  });
}

for (const scenario of [
  { current: 0.5, crossfadeSeconds: 0 },
  { current: 177, crossfadeSeconds: 12 },
  { current: 179, crossfadeSeconds: 0 },
  { current: 177, crossfadeSeconds: 12, finalRound: true },
  { current: 177, crossfadeSeconds: 12, sleepFinal: true },
]) {
  test(`frozen playback is recoverable at ${scenario.current}s, fade ${scenario.crossfadeSeconds}, final ${Boolean(scenario.finalRound || scenario.sleepFinal)}`, async () => {
    const h = createHarness({ ...scenario, readiness: 'fail' });
    if (scenario.finalRound) { h.state.stopAfterRound = true; h.state.queue = [0]; }
    if (scenario.sleepFinal) h.state.sleepTimer = { type: 'tracks', remaining: 1 };
    h.context.startWatcher();
    await h.clock.advance(60000);
    assert.equal(h.counts.resolves, 2);
    assert.equal(h.counts.next, 1);
    h.state._watcherCleanup?.();
  });
}

test('repeated five-second observation gaps accumulate frozen progress, but moving audio is harmless', async () => {
  const frozen = createHarness({ readiness: 'fail' });
  frozen.context.startWatcher();
  for (let i = 0; i < 18; i++) await frozen.clock.jump(5000);
  assert.equal(frozen.counts.next, 1);
  assert.equal(frozen.counts.resolves, 2);
  frozen.state._watcherCleanup?.();

  const moving = createHarness();
  moving.context.startWatcher();
  for (let i = 0; i < 18; i++) {
    moving.decks[0].currentTime += 1;
    await moving.clock.jump(5000);
  }
  assert.equal(moving.counts.resolves, 0);
  assert.equal(moving.counts.next, 0);
  moving.state._watcherCleanup?.();
});

test('intentional pause during a real recovery cannot replay or exhaust the user-paused queue', async () => {
  const held = deferred();
  const h = createHarness({ resolve: () => held.promise });
  h.context.startWatcher();
  await h.clock.advance(17000);
  assert.equal(h.counts.resolves, 1);
  h.context.pause();
  held.resolve('fresh-paused');
  await h.clock.advance(90000);
  assert.equal(h.state._userPaused, true);
  assert.equal(h.decks[0].paused, true);
  assert.equal(h.decks[0].playCalls, 0);
  assert.equal(h.counts.resolves, 1);
  assert.equal(h.counts.next, 0);
  h.state._watcherCleanup?.();
});

for (const stage of ['readiness', 'resume', 'play']) {
  test(`old recovery at ${stage} cannot seek, play, or change gains after stop/restart`, async () => {
    const held = deferred();
    const options = stage === 'readiness' ? { readiness: 'hold' }
      : stage === 'resume' ? { resume: () => held.promise } : { play: () => held.promise };
    const h = createHarness(options);
    if (stage === 'resume') h.state._audioContext.state = 'suspended';
    const recovery = h.context.recoverCurrentDeckStream(h.decks[0], 60, 'test', 1);
    await h.clock.flush();
    h.restart();
    const playsAtRestart = h.decks[0].playCalls;
    if (stage === 'readiness') { h.decks[0].readyState = 4; h.decks[0].emit('canplay'); }
    else held.resolve();
    await h.clock.advance(20000);
    assert.equal(await recovery, null);
    assert.equal(h.decks[0].src, 'new-session');
    assert.equal(h.decks[0].currentTime, 23);
    assert.equal(h.decks[0].paused, false);
    assert.equal(h.decks[0].playCalls, playsAtRestart);
    assert.deepEqual(h.state._deckGains, [0.75, 0.25]);
    assert.equal(h.state.status, 'new-session');
    assert.equal(h.decks[0].listenerCount(), 0);
  });
}

test('frozen scheduled fade resumes output even while incoming media reports playing', async () => {
  const h = createHarness({ crossfadeSeconds: 3 });
  h.state._deckIndex = 1;
  h.state._deckTrack = 1;
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  await h.clock.flush();
  h.state._audioContext.state = 'suspended';
  await h.clock.advance(3000);
  assert.equal(await fade, true);
  assert.equal(h.counts.resume, 1);
  assert.equal(h.decks[1].playCalls, 0);
  assert.equal(h.decks[0].paused, true);
  assert.deepEqual(h.state._deckGains, [0, 1]);
});

test('failed handoff output resume is failure rather than ready, and mixing clears', async () => {
  const h = createHarness({ crossfadeSeconds: 3, resume: () => new Promise(() => {}) });
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  await h.clock.flush();
  h.state._audioContext.state = 'suspended';
  await h.clock.advance(20000);
  assert.equal(await fade, false);
  assert.equal(h.state._crossfading, false);
  assert.equal(h.state._crossfadeSchedule, null);
  assert.notEqual(h.state.status, 'ready');
});

test('old handoff resume cannot clear a newer schedule or pause reused decks', async () => {
  const held = deferred();
  const h = createHarness({ resume: () => held.promise });
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  await h.clock.flush();
  h.state._audioContext.state = 'suspended';
  await h.clock.advance(2700);
  assert.equal(h.counts.resume, 1);
  h.restart();
  const newer = { token: h.state._crossfadeToken };
  h.state._crossfadeSchedule = newer;
  h.state._crossfading = true;
  held.resolve();
  await h.clock.flush();
  assert.equal(await fade, null);
  assert.equal(h.state._crossfadeSchedule, newer);
  assert.equal(h.state._crossfading, true);
  assert.equal(h.decks[0].paused, false);
  assert.deepEqual(h.state._deckGains, [0.75, 0.25]);
});

test('central pause persists through scheduled settlement and fallback pause time does not expire a fade', async () => {
  const scheduled = createHarness({ crossfadeSeconds: 3 });
  const scheduledFade = scheduled.context.animateDeckCrossfade(scheduled.decks[0], scheduled.decks[1], 3, 1);
  await scheduled.clock.flush();
  scheduled.context.pause();
  await scheduled.clock.advance(30000);
  scheduled.context.settleScheduledCrossfade();
  assert.equal(scheduled.decks[1].playCalls, 0);
  assert.equal(scheduled.state._crossfading, true);
  assert.equal(scheduled.state._userPaused, true);
  scheduled.restart();
  assert.equal(await scheduledFade, null);

  const h = createHarness({ graph: false, crossfadeSeconds: 3 });
  h.state._deckIndex = 1;
  h.state._deckTrack = 1;
  h.decks[1].currentTime = 0;
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  let completed = false;
  fade.then(() => { completed = true; });
  h.context.pause();
  await h.clock.advance(30000);
  assert.equal(completed, false);
  await h.context.toggle();
  h.decks[1].currentTime = 1;
  await h.clock.advance(100);
  assert.equal(completed, false);
  h.decks[1].currentTime = 3;
  await h.clock.advance(100);
  assert.equal(await fade, true);
});

for (const fault of ['automationError', 'volumeError']) {
  test(`${fault} releases current mixing ownership without retaining a schedule`, async () => {
    const h = createHarness({ [fault]: true });
    const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 0.25, 1);
    await h.clock.flush();
    h.state._audioContext.currentTime = 1;
    await h.clock.advance(100);
    assert.equal(await fade, false);
    assert.equal(h.state._crossfading, false);
    assert.equal(h.state._crossfadeSchedule, null);
  });
}

for (const phase of ['startup', 'runtime', 'silent']) {
  test(`${phase} Worker failure installs exactly one fallback and cleanup stops supervision`, async () => {
    const h = createHarness({ workerSilent: phase === 'silent' });
    h.context.startWatcher();
    const worker = h.workers[0];
    if (phase === 'runtime') await h.clock.advance(1000);
    if (phase === 'silent') await h.clock.advance(6500);
    else {
      const fail = worker.onerror;
      worker.fail();
      fail?.({ preventDefault() {} });
    }
    const checks = h.counts.sleepChecks;
    await h.clock.advance(1000);
    assert.equal(worker.terminated, true);
    assert.equal(h.state.worker, null);
    assert.equal(h.clock.intervals(), 1);
    assert.ok(h.counts.sleepChecks > checks);
    h.state._watcherCleanup();
    const stoppedChecks = h.counts.sleepChecks;
    await h.clock.advance(10000);
    assert.equal(h.clock.intervals(), 0);
    assert.equal(h.counts.sleepChecks, stoppedChecks);
  });
}

test('Worker constructor failure still releases its blob URL', () => {
  const h = createHarness({ workerThrows: true });
  assert.equal(h.context.mkWorker(), null);
  assert.deepEqual(h.revoked, ['blob:clock']);
});

test('paused or seeking audio never exhausts a queue even at the endpoint', async () => {
  for (const mode of ['paused', 'seeking', 'user']) {
    const h = createHarness({ current: mode === 'seeking' ? 180 : 60 });
    if (mode === 'paused') h.decks[0].paused = true;
    if (mode === 'seeking') { h.decks[0].seeking = true; h.decks[0].paused = true; }
    if (mode === 'user') h.context.pause();
    h.context.startWatcher();
    await h.clock.advance(60000);
    assert.equal(h.counts.resolves, 0);
    assert.equal(h.counts.next, 0);
    h.state._watcherCleanup?.();
  }
});

test('successful reload without real playback progress still has a finite recovery budget', async () => {
  const h = createHarness();
  h.context.startWatcher();
  await h.clock.advance(60000);
  assert.equal(h.counts.resolves, 2);
  assert.equal(h.counts.next, 1);
  assert.equal(h.events.filter(event => event.name === 'recovery-success').length, 2);
  h.state._watcherCleanup?.();
});

test('pending graph resume before schedule creation settles and releases mixing', async () => {
  const h = createHarness({ resume: () => new Promise(() => {}) });
  h.state._audioContext.state = 'suspended';
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  await h.clock.advance(15000);
  assert.equal(await fade, false);
  assert.equal(h.state._crossfadeSchedule, null);
  assert.equal(h.state._crossfading, false);
  assert.notEqual(h.state.status, 'ready');
});

test('failed incoming replay during a hard handoff is not successful playback', async () => {
  const h = createHarness({ play: () => Promise.reject(new Error('replay rejected')) });
  h.decks[1].paused = true;
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  await h.clock.advance(4000);
  assert.equal(await fade, false);
  assert.equal(h.decks[1].playCalls, 1);
  assert.equal(h.state._crossfading, false);
  assert.notEqual(h.state.status, 'ready');
});

test('fallback observes completed media before a delayed wall-clock timeout', async () => {
  const h = createHarness({ graph: false });
  h.decks[1].currentTime = 0;
  const fade = h.context.animateDeckCrossfade(h.decks[0], h.decks[1], 3, 1);
  h.decks[1].currentTime = 3;
  await h.clock.jump(10000);
  assert.equal(await fade, true);
  assert.deepEqual(h.state._deckGains, [0, 1]);
});

test('merging the current track during a real paused reload preserves recovery ownership', async () => {
  const h = createHarness({ readiness: 'hold' });
  h.state.meta[0].sourcePage = h.state.playlistUrl;
  h.context.document.getElementById = () => null;
  Object.assign(h.context, {
    location: { href: h.state.playlistUrl },
    playlistBase: url => String(url).split(/[?#]/)[0],
    fetchLivePlaylistSnapshot: async () => null,
    loadTracks: async () => [],
    completePlaylistCollection: async () => ({
      meta: [{ link: 'track-a', sourcePage: h.state.playlistUrl, artwork: 'new-art' }],
      els: [null], complete: true,
    }),
    reviveRemovedQueueTrack() {}, registerLiveQueueSource() {},
    fisherYates: items => items, spaceUpcomingDuplicateTitles() {},
    recountRoundTotal() {}, refreshUpcomingCrossfadePreparation() {},
    badges() {}, renderList() {}, showMergeToast() {},
  });
  vm.runInContext([
    'trackId', 'mergeTrackMeta', 'beginCollectionRequest', 'collectionRequestCurrent',
    'finishCollectionRequest', 'cancelCollectionRequest', 'mergeCurrentPage',
  ].map(extractFunction).join('\n\n'), h.context);
  h.context.startWatcher();
  await h.clock.advance(17000);
  assert.equal(h.counts.resolves, 1);
  assert.equal(h.decks[0].paused, true);
  await h.context.mergeCurrentPage();
  h.decks[0].readyState = 4;
  h.decks[0].emit('canplay');
  await h.clock.advance(100);
  assert.equal(h.decks[0].paused, false);
  assert.equal(h.decks[0].currentTime, 60);
  assert.equal(h.events.filter(event => event.name === 'recovery-success').length, 1);
  for (let i = 0; i < 20; i++) {
    h.decks[0].currentTime += 1;
    await h.clock.advance(1000);
  }
  assert.equal(h.counts.resolves, 1);
  assert.equal(h.counts.next, 0);
  h.state._watcherCleanup?.();
});

for (const stage of ['stream resolution', 'readiness without duration']) {
  test(`Previous during pending ${stage} recovers at the requested beginning, not the old saved position`, async () => {
    const held = deferred();
    const h = createHarness(stage === 'stream resolution'
      ? { resolve: () => held.promise }
      : { readiness: 'hold' });
    Object.assign(h.context, {
      currentSec: () => h.decks[0].currentTime,
      updateProgressBar() {},
      trackAvailable: () => true,
    });
    vm.runInContext(['seekTo', 'prevTrack'].map(extractFunction).join('\n\n'), h.context);
    h.context.startWatcher();
    await h.clock.advance(17000);
    assert.equal(h.counts.resolves, 1);
    if (stage === 'readiness without duration') h.decks[0].duration = NaN;
    await h.context.prevTrack();
    if (stage === 'stream resolution') held.resolve('fresh-after-previous');
    else {
      h.decks[0].duration = 180;
      h.decks[0].readyState = 4;
      h.decks[0].emit('canplay');
    }
    await h.clock.advance(100);
    assert.equal(h.decks[0].currentTime, 0);
    assert.equal(h.decks[0].paused, false);
    assert.equal(h.events.filter(event => event.name === 'recovery-success').length, 1);
    assert.equal(h.counts.next, 0);
    h.state._watcherCleanup?.();
  });
}

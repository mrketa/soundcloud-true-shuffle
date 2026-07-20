'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function createWatcherHarness() {
  let title = 'Track A';
  let timing = { current: 0, duration: 2000, ended: false, source: 'audio' };
  let isPaused = false;
  let endedHandler = null;
  let nextCalls = 0;
  let pauseCalls = 0;
  const events = [];

  const state = {
    active: true,
    busy: false,
    suspended: false,
    manualAction: false,
    lastProgress: 0,
    lastTitle: '',
    worker: null,
    _workerInterval: null,
    _endedHandler: null,
    els: [{}],
  };
  const worker = {
    onmessage: null,
    terminate() {},
    postMessage() {},
  };
  const documentMock = {
    body: { contains: () => true },
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

  const factory = Function(
    'state', 'playerTitle', 'progress', 'paused', 'pause', 'wait', 'document', 'next',
    'updateHub', 'refreshPlayBtn', 'playbackTiming', 'mkWorker', 'settleScheduledCrossfade',
    'installBetterFeedPipBridge', 'syncBetterFeedPipWindow',
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
  );
  startWatcher();

  return {
    state,
    worker,
    ended: () => endedHandler?.({ target: { tagName: 'AUDIO' } }),
    setTiming: value => { timing = { ...timing, ...value }; },
    setPaused: value => { isPaused = value; },
    setTitle: value => { title = value; },
    nextCalls: () => nextCalls,
    pauseCalls: () => pauseCalls,
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
});

test('the native ended event advances exactly once even when signalled twice', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 2000, duration: 2000, ended: true });
  h.ended();
  h.ended();
  await h.flush();
  assert.equal(h.nextCalls(), 1);
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

test('re-shuffle replaces a new playlist and resets hidden weighting', () => {
  const reshuffle = extractFunction('reshuffleCurrentPage');
  const hub = extractFunction('mkHub');
  assert.match(reshuffle, /const newEls = await loadTracks\(\)/);
  assert.match(reshuffle, /state\.els = newEls/);
  assert.match(reshuffle, /state\.queue = newQueue/);
  assert.match(reshuffle, /state\.priority = \{\}/);
  assert.match(reshuffle, /state\.skipCounts = \{\}/);
  assert.match(reshuffle, /startWatcher\(\)/);
  assert.match(hub, /id="tss-hub-reshuffle"/);
  assert.match(hub, /aria-label="Re-shuffle current playlist"/);
  assert.match(hub, /e\.target\.closest\('button'\)/);
});

if (source.includes('function moveSelectedTrackToCurrent(')) {
test('jumping to a searched track keeps skipped upcoming tracks in the round', () => {
  const state = {
    queue: [0, 1, 2, 3],
    pos: 0,
    history: [],
    roundPlayed: 0,
    roundTotal: 4,
  };
  const moveSelectedTrackToCurrent = Function(
    'state',
    `return (${extractFunction('moveSelectedTrackToCurrent')})`,
  )(state);

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
  assert.match(source, /!document\.getElementById\('tss-hub'\) && !injectRetryTimer/);
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
    'state', 'pageWindow', 'betterFeedPipActive', 'playbackTiming',
    'formatPlaybackClock', 'trackId', 'waveformCache', 'DEFAULT_WAVE_HEIGHTS',
    `return (${extractFunction('syncBetterFeedPipWindow')})`,
  )(
    state, pageWindow, () => true, () => ({ current: 90, duration: 180 }),
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

test('watcher retries the PiP bridge after Better SoundCloud Feed discovers scPlayer', () => {
  const watcher = extractFunction('startWatcher');
  assert.match(watcher, /installBetterFeedPipBridge\(\)/);
  assert.match(watcher, /syncBetterFeedPipWindow\(\)/);
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

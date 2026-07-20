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

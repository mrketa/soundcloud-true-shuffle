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

  const brace = source.indexOf('{', source.indexOf(') {', start));
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract function ${name}`);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function queueTransitionDependencies(state) {
  const dependencies = { state };
  for (const name of ['finalizeLeavingCurrentTrack', 'recountRoundTotal']) {
    dependencies[name] = Function('state', `return (${extractFunction(name)})`)(state);
  }
  return dependencies;
}

const parseTimeText = Function(`return (${extractFunction('parseTimeText')})`)();
const trackSpacingKey = Function(`return (${extractFunction('trackSpacingKey')})`)();
const spaceDuplicateTitles = Function(
  'trackSpacingKey',
  `return (${extractFunction('spaceDuplicateTitles')})`,
)(trackSpacingKey);
const buildReshuffledQueue = Function(
  'state', 'fisherYates', 'spaceDuplicateTitles',
  `return (${extractFunction('buildReshuffledQueue')})`,
)(
  { meta: [] },
  items => items.slice().reverse(),
  items => items,
);

function createBalancedRoundHarness() {
  const state = { roundStarts: {}, priority: {}, meta: [] };
  const buildBalancedRound = Function(
    'state',
    'fisherYates',
    'weightedShuffle',
    'spaceDuplicateTitles',
    `return (${extractFunction('buildBalancedRound')})`,
  )(
    state,
    items => items.slice().reverse(),
    items => items.slice(),
    items => items,
  );
  return { state, buildBalancedRound };
}

function createTrackMetadataHarness(fetchTrack = async () => ({ ok: false })) {
  const syncTrackPlaybackAccess = Function(`return (${extractFunction('syncTrackPlaybackAccess')})`)();
  const metaFromSoundCloudTrack = Function(
    'syncTrackPlaybackAccess', `return (${extractFunction('metaFromSoundCloudTrack')})`,
  )(syncTrackPlaybackAccess);
  const mergeTrackMeta = Function(`return (${extractFunction('mergeTrackMeta')})`)();
  const fetchSoundCloudResource = async (url, format = 'json') => {
    const response = await fetchTrack(url);
    return { ok: response.ok, status: response.status, data: response.ok ? await response[format]() : null };
  };
  const normalizeTrackUrl = Function('URL', 'location', `return (${extractFunction('normalizeTrackUrl')})`)(
    URL, { origin: 'https://soundcloud.com' },
  );
  const resolveLiveTrackMeta = Function(
    'metaFromSoundCloudTrack', 'mergeTrackMeta', 'discoverSoundCloudClientIdFromBundle', 'fetchSoundCloudResource',
    `return (${extractFunction('resolveLiveTrackMeta').replace(/^function /, 'async function ')})`,
  )(metaFromSoundCloudTrack, mergeTrackMeta, async () => 'client-id', fetchSoundCloudResource);
  const resolvePlaylistSnapshotMetas = Function(
    'metaFromSoundCloudTrack', 'mergeTrackMeta', 'normalizeTrackUrl', 'discoverSoundCloudClientIdFromBundle', 'fetchSoundCloudResource', 'URL',
    `return (${extractFunction('resolvePlaylistSnapshotMetas').replace(/^function /, 'async function ')})`,
  )(metaFromSoundCloudTrack, mergeTrackMeta, normalizeTrackUrl, async () => 'client-id', fetchSoundCloudResource, URL);
  return { metaFromSoundCloudTrack, resolveLiveTrackMeta, resolvePlaylistSnapshotMetas };
}

test('SoundCloud publisher bylines take precedence over uploader names and preserve collaborators', () => {
  const { metaFromSoundCloudTrack } = createTrackMetadataHarness();
  const track = {
    id: 1, title: 'Collaboration', permalink_url: 'https://soundcloud.com/label/collaboration',
    publisher_metadata: { artist: 'Artist A & Artist B' },
    user: { username: 'Upload Account', permalink_url: 'https://soundcloud.com/label' },
  };
  const meta = metaFromSoundCloudTrack(track, 'https://soundcloud.com/label/sets/list');
  assert.equal(meta.artist, 'Artist A & Artist B');
  assert.equal(meta.artistLink, 'https://soundcloud.com/label');
  assert.equal(metaFromSoundCloudTrack({ ...track, publisher_metadata: { artist: ' ' } }).artist, 'Upload Account');
  assert.equal(metaFromSoundCloudTrack({ ...track, publisher_metadata: null, user: null }).artist, '—');
});

test('DOM bylines retain complete contributor text, deduplicate names and only then fall back to uploader text', () => {
  const byline = (text, href) => ({ textContent: text, getAttribute: name => name === 'href' ? href : null });
  let nodes = [byline('Artist A & Artist B', '/label')];
  const uploader = byline('Upload Account', '/uploader');
  const el = {
    querySelectorAll: () => nodes,
    querySelector: selector => {
      if (selector === '.trackItem__username, .soundTitle__username') return nodes[0] || null;
      if (selector === '.sc-link-secondary' || selector === 'a.sc-link-secondary') return uploader;
      return null;
    },
  };
  const getArtistLink = Function(`return (${extractFunction('getArtistLink')})`)();
  const getMeta = Function(
    'artwork', 'getLink', 'getArtistLink', 'waveformUrl', 'soundCloudLikeButtonState', 'location',
    `return (${extractFunction('getMeta')})`,
  )(() => null, () => 'https://soundcloud.com/label/track', getArtistLink, () => null, () => null,
    { href: 'https://soundcloud.com/label/sets/list' });
  assert.equal(getMeta(el).artist, 'Artist A & Artist B');
  assert.equal(getMeta(el).artistLink, 'https://soundcloud.com/label');
  nodes = [byline(' Artist A ', '/a'), byline('Artist B', '/b'), byline('Artist A', '/a')];
  assert.equal(getMeta(el).artist, 'Artist A, Artist B');
  nodes = [];
  assert.equal(getMeta(el).artist, 'Upload Account');
  assert.equal(getMeta(el).artistLink, 'https://soundcloud.com/uploader');
});

test('incomplete live artist metadata is recovered while API failures retain usable hydration', async () => {
  const track = {
    id: 7, title: 'Hydrated title', permalink_url: 'https://soundcloud.com/label/track',
    artwork_url: 'https://i1.sndcdn.com/artworks-track-large.jpg',
  };
  let requests = 0;
  const { resolveLiveTrackMeta } = createTrackMetadataHarness(async () => {
    requests++;
    return { ok: true, json: async () => ({ ...track, publisher_metadata: { artist: 'Artist A & Artist B' } }) };
  });
  const recovered = await resolveLiveTrackMeta(track, 'https://soundcloud.com/label/sets/list', 3);
  assert.equal(recovered.artist, 'Artist A & Artist B');
  assert.equal(recovered.title, 'Hydrated title');
  await resolveLiveTrackMeta({ ...track, user: { username: 'Solo Artist' } });
  assert.equal(requests, 1);
  const failed = createTrackMetadataHarness(async () => { throw new Error('offline'); });
  const retained = await failed.resolveLiveTrackMeta(track);
  assert.equal(retained.title, 'Hydrated title');
  assert.equal(retained.link, track.permalink_url);
  assert.equal(retained.artist, '—');
});

test('playlist artist recovery batches only missing names and preserves richer DOM and hydration values', async () => {
  const track = id => ({ id, title: `Track ${id}`, permalink_url: `https://soundcloud.com/label/track-${id}` });
  const requests = [];
  const { resolvePlaylistSnapshotMetas } = createTrackMetadataHarness(async endpoint => {
    const ids = endpoint.searchParams.get('ids').split(',').map(Number);
    requests.push(ids);
    return { ok: true, json: async () => ids.slice().reverse().map(id => ({
      ...track(id), publisher_metadata: { artist: `Recovered ${id}` },
    })) };
  });
  const metas = await resolvePlaylistSnapshotMetas({ tracks: [
    { ...track(1), publisher_metadata: { artist: 'Artist A & Artist B' }, user: { username: 'Label' } },
    track(2),
    track(3),
    { id: 4 },
  ] }, 'https://soundcloud.com/label/sets/list', [
    { title: 'DOM title', artist: 'Artist C, Artist D', link: `${track(3).permalink_url}?in=label/sets/list`, liked: false },
  ]);
  assert.deepEqual(requests, [[2, 4]]);
  assert.deepEqual(metas.map(meta => meta.artist), ['Artist A & Artist B', 'Recovered 2', 'Artist C, Artist D', 'Recovered 4']);
  assert.deepEqual(metas.map(meta => meta.soundcloudId), [1, 2, 3, 4]);
  assert.equal(metas[2].title, 'DOM title');
  assert.equal(metas[2].liked, false);
  assert.equal(metas[3].playlistPosition, 4);
  const failed = createTrackMetadataHarness();
  const retained = await failed.resolvePlaylistSnapshotMetas({ tracks: [track(2), { id: 4 }] });
  assert.deepEqual(retained.map(meta => [meta.title, meta.artist]), [['Track 2', '—']]);
});

test('only an explicit complete empty playlist is safe to reconcile as empty', () => {
  const playlistSnapshotFromHtml = Function(`return (${extractFunction('playlistSnapshotFromHtml')})`)();
  const snapshot = data => playlistSnapshotFromHtml(`<script>window.__sc_hydration = ${JSON.stringify([
    { hydratable: 'playlist', data: { id: 44, kind: 'playlist', ...data } },
  ])};</script>`);
  assert.deepEqual(snapshot({ tracks: [], track_count: 0 }), { id: 44, trackCount: 0, complete: true, tracks: [] });
  assert.equal(snapshot({ tracks: [] }), null);
  assert.equal(snapshot({ track_count: 0 }), null);
  assert.equal(snapshot({ tracks: [], track_count: 3 }), null);
});

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

test('matching titles are separated without dropping or duplicating tracks', () => {
  const meta = [
    { title: 'Station Ident' },
    { title: '  STATION   ident  ' },
    { title: 'Weather' },
    { title: 'weather' },
    { title: 'Song A' },
  ];
  const queue = [0, 1, 2, 3, 4];

  assert.equal(spaceDuplicateTitles(queue, meta), queue);
  assert.deepEqual(queue, [0, 2, 1, 3, 4]);
  assert.deepEqual([...queue].sort(), [0, 1, 2, 3, 4]);
});

test('the hidden bumper marker groups renamed station IDs together', () => {
  const meta = [
    { title: '[TSS-BUMPER] 24.7 Jam Radio' },
    { title: 'Song A' },
    { title: '[tss-bumper] ABox FM Summer Ident' },
    { title: 'Song B' },
  ];
  const queue = [0, 2, 1, 3];

  spaceDuplicateTitles(queue, meta);
  assert.deepEqual(queue, [0, 1, 2, 3]);
});

test('marked bumpers stay evenly distributed across the full merged queue', () => {
  const bumperCount = 107;
  const musicCount = 193;
  const meta = [
    ...Array.from({ length: bumperCount }, (_, index) => ({ title: `[TSS-BUMPER] Ident ${index}` })),
    ...Array.from({ length: musicCount }, (_, index) => ({ title: `Song ${index}` })),
  ];
  const queue = Array.from({ length: meta.length }, (_, index) => index);

  spaceDuplicateTitles(queue, meta);

  const bumperPositions = queue
    .map((ti, position) => trackSpacingKey(ti, meta) === '\u0000group:tss-bumper' ? position : -1)
    .filter(position => position >= 0);
  const bumperFreeRuns = [
    bumperPositions[0],
    ...bumperPositions.slice(1).map((position, index) => position - bumperPositions[index] - 1),
    queue.length - bumperPositions.at(-1) - 1,
  ];

  assert.equal(bumperPositions.length, bumperCount);
  assert.equal(new Set(queue).size, bumperCount + musicCount);
  assert.ok(bumperPositions.every((position, index) => index === 0 || position - bumperPositions[index - 1] > 1));
  assert.ok(Math.max(...bumperFreeRuns) <= 2, `unexpected bumper-free run: ${Math.max(...bumperFreeRuns)}`);
});

test('identical unmarked bumpers span the full queue instead of leaving a music-only tail', () => {
  const bumperCount = 28;
  const musicCount = 79;
  const meta = [
    ...Array.from({ length: bumperCount }, () => ({ title: '24.7 Jam Radio' })),
    ...Array.from({ length: musicCount }, (_, index) => ({ title: `Jam ${index + 1}` })),
  ];
  const queue = Array.from({ length: bumperCount + musicCount }, (_, index) => index);

  spaceDuplicateTitles(queue, meta);

  const bumperPositions = queue
    .map((ti, position) => trackSpacingKey(ti, meta) === '24.7 jam radio' ? position : -1)
    .filter(position => position >= 0);
  const bumperFreeRuns = [
    bumperPositions[0],
    ...bumperPositions.slice(1).map((position, index) => position - bumperPositions[index] - 1),
    queue.length - bumperPositions.at(-1) - 1,
  ];

  assert.equal(queue.length, bumperCount + musicCount);
  assert.equal(new Set(queue).size, queue.length);
  assert.equal(bumperPositions.length, bumperCount);
  assert.ok(Math.max(...bumperFreeRuns) <= Math.ceil(musicCount / (bumperCount + 1)));
});

test('matching-title spacing respects the previous-round boundary', () => {
  const meta = [
    { title: 'New Station Name' },
    { title: 'Song A' },
    { title: ' new   station name ' },
    { title: 'Song B' },
  ];
  const queue = [2, 1, 3];

  spaceDuplicateTitles(queue, meta, 0);
  assert.deepEqual(queue, [1, 2, 3]);
});

test('automatic rounds separate matching titles across rounds', () => {
  const state = {
    roundStarts: {},
    priority: {},
    meta: [
      { title: 'Any Future Bumper Name' },
      { title: 'Song A' },
      { title: 'Any Future Bumper Name' },
      { title: 'Song B' },
    ],
  };
  const buildBalancedRound = Function(
    'state', 'fisherYates', 'weightedShuffle', 'spaceDuplicateTitles',
    `return (${extractFunction('buildBalancedRound')})`,
  )(state, items => items.slice(), items => items.slice(), spaceDuplicateTitles);

  assert.deepEqual(buildBalancedRound([2, 1, 3], 0), [1, 2, 3]);
  assert.equal(state.roundStarts[1], 1);
  assert.equal(state.roundStarts[2], undefined);
});

test('an impossible matching-title layout is left intact', () => {
  const meta = [
    { title: 'Renamed Bumper' },
    { title: 'Song A' },
    { title: 'Renamed Bumper' },
    { title: 'Renamed Bumper' },
  ];
  const queue = [0, 2, 3, 1];

  spaceDuplicateTitles(queue, meta);
  assert.deepEqual(queue, [0, 2, 3, 1]);
});

test('liked-song grid cards join the existing collection pipeline', () => {
  const legacy = { id: 'legacy' };
  const card = { id: 'grid-card' };
  const control = { closest: selector => selector === '.sound' ? card : null };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('.trackList__item')) return [legacy];
      if (selector.includes('.sc-button-more')) return [control];
      return [];
    },
  };
  const currentPageTrackElements = Function(
    'document', 'isLikedTracksPage', 'getLink', 'normalizeTrackUrl',
    `return (${extractFunction('currentPageTrackElements')})`,
  )(document, () => true, element => element === card ? '/artist/track' : null, value => value);

  assert.deepEqual(currentPageTrackElements(), [legacy, card]);
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
    _playbackEpoch: 0, _playbackAbort: new AbortController(), _userPaused: false,
    _decks: [], _deckPrepareTokens: [],
    _liveSyncSources: new Map([['https://soundcloud.com/test/source-playlist', new Set([0, 1, 2])]]),
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
    'state', 'trackAvailable', 'buildBalancedRound', 'finalizeLeavingCurrentTrack', 'recountRoundTotal',
    `return (${extractFunction('consumeCurrentQueueTrack')})`,
  )(state, () => true, items => items.slice(), queueTransitionDependencies(state).finalizeLeavingCurrentTrack, queueTransitionDependencies(state).recountRoundTotal);
  const sessionStorage = {
    setItem(key, value) { storage.set(key, value); },
    getItem(key) { return storage.get(key) || null; },
    removeItem(key) { storage.delete(key); },
  };
  const saveQueueSessionCache = Function('state', 'sessionStorage', 'trackId', 'Date',
    `return (${extractFunction('saveQueueSessionCache')})`)(state, sessionStorage, trackId, { now: () => now });

  const nativePlaybackAllowed = Function(
    'state', `return (${extractFunction('nativePlaybackAllowed')})`,
  )(state);
  const factory = Function(
    'state', 'playerTitle', 'progress', 'paused', 'pause', 'wait', 'document', 'next',
    'updateHub', 'refreshPlayBtn', 'playbackTiming', 'mkWorker', 'settleScheduledCrossfade',
    'installBetterFeedPipBridge', 'syncOwnPipWindow', 'syncBetterFeedPipWindow',
    'consumeCurrentQueueTrack', 'sessionStorage', 'trackId', 'currentDeckAudio',
    'checkSleepTimerDeadline', 'resumeAudioGraph', 'Date', 'syncPlaybackVolumeFromSoundCloud', 'recoverCurrentDeckStream',
    'syncCrossfadeVolume', 'processAutoLevel', 'recordPlaybackDiagnostic',
    'saveQueueSessionCache', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'pauseSoundCloud', 'nativePlaybackAllowed',
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
    () => {},
    () => {},
    saveQueueSessionCache, () => 1, () => {}, () => 1, () => {},
    pause, nativePlaybackAllowed,
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
      state._decks = [deck];
      state._deckPrepareTokens = [0];
      state._deckTrack = state.queue[state.pos];
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

test('custom deck title changes never suspend a track that is still current in the queue', async () => {
  const h = createWatcherHarness();
  h.state._deckTrack = h.state.queue[h.state.pos];
  h.setTitle('Track B');

  await h.worker.onmessage();
  await h.worker.onmessage();

  assert.equal(h.state.suspended, false);
  assert.equal(h.state.lastTitle, 'Track B');
});

test('a long track is not advanced with 30 seconds remaining', async () => {
  const h = createWatcherHarness();
  h.setTiming({ current: 1970, duration: 2000, ended: false });
  await h.worker.onmessage();
  assert.equal(h.nextCalls(), 0);
  assert.equal(h.state.suspended, false);
  assert.equal(h.deadlineChecks(), 1);
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
    meta: h.state.meta,
    sources: [['https://soundcloud.com/test/source-playlist', [0, 1, 2]]],
    playNext: [],
  });
});

test('restoring a consumed suspended queue does not reinsert played tracks into the round', () => {
  const remapCachedQueue = Function(
    'trackId', 'fisherYates', 'spaceDuplicateTitles',
    `return (${extractFunction('remapCachedQueue')})`,
  )(
    meta => meta?.link || '',
    items => items.slice().reverse(),
    spaceDuplicateTitles,
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
  assert.equal(restored.roundTotal, 4);
  assert.equal(restored.queue.includes(1), false);
  assert.equal(new Set(restored.queue).size, restored.queue.length);
});

test('cached queue spacing never moves tracks across a nonzero current position', () => {
  const remapCachedQueue = Function(
    'trackId', 'fisherYates', 'spaceDuplicateTitles',
    `return (${extractFunction('remapCachedQueue')})`,
  )(
    meta => meta?.link || '',
    items => items.slice(),
    spaceDuplicateTitles,
  );
  const meta = [
    { link: 'a-1', title: 'A' },
    { link: 'a-2', title: 'A' },
    { link: 'b-1', title: 'B' },
    { link: 'b-2', title: 'B' },
    { link: 'c-1', title: 'C' },
  ];
  const restored = remapCachedQueue({
    queue: [0, 1, 2, 3, 4],
    pos: 2,
    history: [],
    priority: {},
    metaKeys: meta.map(item => item.link),
    roundPlayed: 2,
    roundTotal: 5,
  }, meta);

  assert.deepEqual(restored.queue, [0, 1, 2, 4, 3]);
  assert.equal(restored.pos, 2);
  assert.deepEqual(restored.queue.slice(0, restored.pos + 1), [0, 1, 2]);
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


test('custom deck stall watchdog respects unsafe states and healthy progress across throttled gaps', async () => {
  const cases = [
    { paused: true },
    { seeking: true },
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
    { _userPaused: true },
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
  const progressingDeck = throttled.setDeck({ currentTime: 600 });
  await throttled.worker.onmessage();
  throttled.advanceTime(30000);
  throttled.setTiming({ current: 630 });
  progressingDeck.currentTime = 630;
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

test('closed sidebar defers queue DOM rebuilds until it is opened', () => {
  const renderList = extractFunction('renderList');
  assert.match(renderList, /if \(!state\.sidebarOpen\) \{\s*state\._sidebarDirty = true;\s*return;/);

  const state = { sidebarOpen: false, _sidebarDirty: true };
  const sidebar = { dataset: {} };
  const hub = { dataset: {} };
  const document = {
    getElementById(id) {
      if (id === 'tss-sidebar') return sidebar;
      if (id === 'tss-hub') return hub;
      return null;
    },
  };
  let renders = 0;
  let syncs = 0;
  let hubUpdates = 0;
  const toggleSidebar = Function(
    'state', 'document', 'renderList', 'syncSidebarToHub', 'updateHub',
    `return (${extractFunction('toggleSidebar')})`,
  )(
    state,
    document,
    () => { renders++; state._sidebarDirty = false; },
    () => { syncs++; },
    () => { hubUpdates++; },
  );

  toggleSidebar();
  assert.equal(state.sidebarOpen, true);
  assert.equal(sidebar.dataset.open, 'true');
  assert.equal(renders, 1);
  assert.equal(syncs, 1);

  toggleSidebar();
  assert.equal(state.sidebarOpen, false);
  assert.equal(sidebar.dataset.open, 'false');
  assert.equal(renders, 1);
  assert.equal(syncs, 1);
  assert.equal(hubUpdates, 2);
});

test('track-row mutations fast-sync on every registered source and defer while loading', () => {
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
    _liveSyncSources: new Map([
      ['https://soundcloud.com/test/sets/source-playlist', new Set()],
      ['https://soundcloud.com/test/sets/merged-playlist', new Set()],
    ]),
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

  assert.equal(harness.mutationChangesPlaylistTracks(records), true);

  assert.equal(harness.scheduleLiveQueueSyncFromMutation(records), false);
  assert.equal(timers.length, 0, 'passive-page mutations must not schedule a source fetch');

  location.href = 'https://soundcloud.com/test/sets/source-playlist#tracks';
  assert.equal(harness.scheduleLiveQueueSyncFromMutation(records), true);
  assert.equal(timers.length, 1, 'source-page mutations should schedule a fast sync');
  timers.shift()();
  assert.deepEqual(syncCalls, [{ force: true }]);

  location.href = 'https://soundcloud.com/test/sets/merged-playlist?ref=clipboard';
  state.loading = true;
  assert.equal(harness.scheduleLiveQueueSyncFromMutation([{ addedNodes: [], removedNodes: [trackRow] }]), true);
  timers.shift()();
  assert.equal(syncCalls.length, 1, 'loading must defer the scheduled fetch');
  state.loading = false;
  timers.shift()();
  assert.deepEqual(syncCalls, [{ force: true }, { force: true }]);

  location.href = 'https://soundcloud.com/test/sets/unregistered';
  assert.equal(harness.scheduleLiveQueueSyncFromMutation(records), false);
  assert.equal(timers.length, 0);
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
    _playbackEpoch: 0, _playbackAbort: new AbortController(), _userPaused: false,
  };
  const consumeCurrentQueueTrack = Function(
    'state', 'trackAvailable', 'buildBalancedRound', 'finalizeLeavingCurrentTrack', 'recountRoundTotal',
    `return (${extractFunction('consumeCurrentQueueTrack')})`,
  )(state, () => true, items => items.slice(), queueTransitionDependencies(state).finalizeLeavingCurrentTrack, queueTransitionDependencies(state).recountRoundTotal);
  const played = [];
  const prevTrack = Function(
    'state', 'currentSec', 'seekTo', 'Date',
    'refreshUpcomingCrossfadePreparation', 'playAt', 'badges', 'renderList',
    'trackAvailable', 'removePlayNextOccurrences', 'finalizeLeavingCurrentTrack', 'recountRoundTotal', 'runPlaybackOperation',
    `return (${extractFunction('prevTrack').replace(/^function /, 'async function ')})`,
  )(
    state, () => 0, () => {}, Date,
    () => {}, async (ti, countPlay) => played.push([ti, countPlay]), () => {}, () => {},
    () => true, () => false, queueTransitionDependencies(state).finalizeLeavingCurrentTrack,
    queueTransitionDependencies(state).recountRoundTotal, async (_label, operation) => operation(() => true),
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
    meta: [{}, {}, {}, {}], playNext: [],
  };
  const moveSelectedTrackToCurrent = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'finalizeLeavingCurrentTrack', 'recountRoundTotal',
    `return (${extractFunction('moveSelectedTrackToCurrent')})`,
  )(state, () => {}, queueTransitionDependencies(state).finalizeLeavingCurrentTrack, queueTransitionDependencies(state).recountRoundTotal);

  assert.equal(moveSelectedTrackToCurrent(2), true);
  assert.deepEqual(state.queue, [2, 1, 3]);
  assert.deepEqual(state.history, [0]);
  assert.equal(state.roundPlayed, 1);
  assert.equal(state.roundTotal, 4);
});



test('all non-collection SoundCloud routes preserve queue ownership', () => {
  const classify = Function(`
    ${extractFunction('soundCloudPathParts')}
    ${extractFunction('isSoundCloudPage')}
    ${extractFunction('isCollectionPage')}
    ${extractFunction('isPassiveBrowsePage')}
    return { isSoundCloudPage, isCollectionPage, isPassiveBrowsePage };
  `)();

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
    'tss-pip-player', 'tss-pip-title', 'tss-pip-title-text', 'tss-pip-artist',
    'tss-pip-position', 'tss-pip-current', 'tss-pip-remaining', 'tss-pip-artwork',
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
    'upcomingTrackIndex', 'ownPipWindowTitle', 'ownPipArtworkSource', 'syncOwnPipMarquee',
    `return (${extractFunction('syncOwnPipWindow')})`,
  )(
    state, () => true, () => {}, () => ({ current: 63, duration: 91 }),
    () => ({ getPropertyValue: () => '#64d8e8' }), { documentElement: {} },
    () => '', () => false, { play: '<play>', pause: '<pause>' }, meta => meta.link,
    new Map(), [50], seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    (...args) => drawn.push(args), () => {},
    () => state.playNext.length ? state.playNext[0] : state.queue[state.pos + 1],
    (meta, isPaused) => meta?.title && !isPaused ? `Playing: ${meta.title}` : 'True Shuffle',
    url => url || '', () => {},
  );

  assert.equal(syncOwnPipWindow(), true);
  assert.equal(pipDocument.title, 'Playing: Current');
  assert.equal(nodes.get('tss-pip-title-text').textContent, 'Current');
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

test('PiP artwork toggle preserves compact, full-picture and focus layouts', () => {
  const nodes = new Map();
  const node = id => {
    const value = {
      id,
      dataset: {},
      attributes: {},
      title: '',
      setAttribute(name, entry) { this.attributes[name] = entry; },
    };
    nodes.set(id, value);
    return value;
  };
  node('tss-pip-player');
  node('tss-pip-artwork-toggle');
  const pipDocument = { getElementById: id => nodes.get(id) || null };
  const stored = [];
  const state = {
    pipArtworkMode: 'compact',
    _ownPipMode: null,
    _ownPipWindow: { document: pipDocument },
    _ownPipHost: null,
  };
  const ownPipDimensions = Function(
    'state',
    `return (${extractFunction('ownPipDimensions')})`,
  )(state);
  const nextOwnPipArtworkMode = Function(
    'state',
    `return (${extractFunction('nextOwnPipArtworkMode')})`,
  )(state);
  const setOwnPipArtworkMode = Function(
    'state', 'safeStorage', 'ownPipDimensions', 'nextOwnPipArtworkMode',
    `return (${extractFunction('setOwnPipArtworkMode')})`,
  )(state, { setItem: (key, value) => stored.push([key, value]) }, ownPipDimensions, nextOwnPipArtworkMode);
  const ownPipArtworkSource = Function(
    'state',
    `return (${extractFunction('ownPipArtworkSource')})`,
  )(state);

  assert.equal(nextOwnPipArtworkMode(), 'full');
  assert.equal(setOwnPipArtworkMode('full', pipDocument), 'full');
  assert.equal(state.pipArtworkMode, 'full');
  assert.equal(nodes.get('tss-pip-player').dataset.artworkMode, 'full');
  assert.equal(nodes.get('tss-pip-artwork-toggle').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('tss-pip-artwork-toggle').attributes['aria-label'], 'Use focus artwork layout');
  assert.deepEqual(stored.at(-1), ['tss_pip_artwork_mode', 'full']);
  assert.equal(
    ownPipArtworkSource('https://i1.sndcdn.com/artworks-test-t200x200.jpg'),
    'https://i1.sndcdn.com/artworks-test-t500x500.jpg',
  );
  assert.deepEqual(ownPipDimensions(), { width: 420, height: 660 });

  assert.equal(nextOwnPipArtworkMode(), 'focus');
  assert.equal(setOwnPipArtworkMode('focus', pipDocument), 'focus');
  assert.equal(nodes.get('tss-pip-player').dataset.artworkMode, 'focus');
  assert.deepEqual(ownPipDimensions(), { width: 380, height: 460 });
  assert.equal(nodes.get('tss-pip-artwork-toggle').attributes['aria-label'], 'Use compact artwork layout');
  assert.equal(
    ownPipArtworkSource('https://i1.sndcdn.com/artworks-test-t200x200.jpg'),
    'https://i1.sndcdn.com/artworks-test-t500x500.jpg',
  );

  assert.equal(nextOwnPipArtworkMode(), 'compact');
  assert.equal(setOwnPipArtworkMode('compact', pipDocument), 'compact');
  assert.equal(nodes.get('tss-pip-player').dataset.artworkMode, 'compact');
  assert.deepEqual(ownPipDimensions(), { width: 440, height: 360 });
  assert.equal(nodes.get('tss-pip-artwork-toggle').attributes['aria-pressed'], 'false');
  assert.equal(nodes.get('tss-pip-artwork-toggle').attributes['aria-label'], 'Use full artwork layout');
  assert.equal(
    ownPipArtworkSource('https://i1.sndcdn.com/artworks-test-t200x200.jpg'),
    'https://i1.sndcdn.com/artworks-test-t200x200.jpg',
  );
  assert.match(source, /\[data-artwork-mode="focus"\][^{]*\.tss-pip-header/);
  assert.match(source, /\[data-artwork-mode="focus"\][^{]*\.tss-pip-wave[^}]*display:none/);
  assert.match(source, /\[data-artwork-mode="focus"\][^{]*\.tss-pip-track-copy[^}]*order:-1[^}]*align-items:center[^}]*text-align:center/);
  assert.match(source, /\[data-artwork-mode="focus"\][^{]*\.tss-pip-title[^}]*text-align:center/);
});

test('PiP marquee activates only when the full title overflows its viewport', () => {
  const properties = {};
  const viewport = {
    clientWidth: 120,
    dataset: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const text = {
    textContent: 'A deliberately long track title',
    scrollWidth: 260,
    style: { setProperty(name, value) { properties[name] = value; } },
  };
  const syncOwnPipMarquee = Function(
    `return (${extractFunction('syncOwnPipMarquee')})`,
  )();

  assert.equal(syncOwnPipMarquee(viewport, text), true);
  assert.equal(viewport.dataset.overflow, 'true');
  assert.equal(viewport.attributes['aria-label'], text.textContent);
  assert.equal(properties['--tss-pip-marquee-distance'], '-140px');
  assert.match(source, /@media\(prefers-reduced-motion:reduce\)[^{]*\{[^}]*\.tss-pip-title-text/);

  text.scrollWidth = 118;
  assert.equal(syncOwnPipMarquee(viewport, text), false);
  assert.equal(viewport.dataset.overflow, 'false');
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
    roundPlayed: 0,
  };
  let refreshes = 0;
  let renders = 0;
  const queueNext = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'renderList', 'trackAvailable', 'recountRoundTotal',
    `return (${extractFunction('queueNext')})`,
  )(state, () => { refreshes++; }, () => { renders++; }, () => true, queueTransitionDependencies(state).recountRoundTotal);

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
    roundPlayed: 2,
  };
  const queueNext = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'renderList', 'trackAvailable', 'recountRoundTotal',
    `return (${extractFunction('queueNext')})`,
  )(state, () => {}, () => {}, () => true, queueTransitionDependencies(state).recountRoundTotal);

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
    meta: [{}, {}, {}], _playbackEpoch: 0, _userPaused: false,
  };
  let refreshes = 0;
  let renders = 0;
  const played = [];
  const removePlayNextOccurrences = Function(
    'state', 'refreshUpcomingCrossfadePreparation',
    `return (${extractFunction('removePlayNextOccurrences')})`,
  )(state, () => { refreshes++; });
  const moveSelectedTrackToCurrent = Function(
    'state', 'refreshUpcomingCrossfadePreparation', 'finalizeLeavingCurrentTrack', 'recountRoundTotal',
    `return (${extractFunction('moveSelectedTrackToCurrent')})`,
  )(state, () => { refreshes++; }, queueTransitionDependencies(state).finalizeLeavingCurrentTrack, queueTransitionDependencies(state).recountRoundTotal);
  const jumpTo = Function(
    'state', 'removePlayNextOccurrences', 'moveSelectedTrackToCurrent',
    'playAt', 'badges', 'renderList',
    'trackAvailable', 'runPlaybackOperation', 'recountRoundTotal',
    `return (${extractFunction('jumpTo').replace(/^function /, 'async function ')})`,
  )(
    state, removePlayNextOccurrences, moveSelectedTrackToCurrent,
    async (ti, countPlay = true) => played.push([ti, countPlay]),
    () => {}, () => { renders++; },
    () => true, async (_label, operation) => operation(() => true), queueTransitionDependencies(state).recountRoundTotal,
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


test('native PiP API resolver supports direct and wrapped browser capabilities', () => {
  const apiResolverSource = extractFunction('documentPipApi');
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

test('native SoundCloud transport is paused through its own stateful control', () => {
  const button = {
    title: 'Pause current track',
    clickCalls: 0,
    getAttribute() { return this.title; },
    click() { this.clickCalls++; this.title = 'Play current track'; },
  };
  const state = { _nativeGuardButtonAction: false };
  const document = { querySelector: () => button };
  const soundCloudPaused = Function(
    'document',
    `return (${extractFunction('soundCloudPaused')})`,
  )(document);
  const pauseSoundCloudTransport = Function(
    'state', 'document', 'soundCloudPaused',
    `return (${extractFunction('pauseSoundCloudTransport')})`,
  )(state, document, soundCloudPaused);

  assert.equal(pauseSoundCloudTransport(), true);
  assert.equal(button.clickCalls, 1);
  assert.equal(state._nativeGuardButtonAction, false);
  assert.equal(pauseSoundCloudTransport(), false);
  assert.equal(button.clickCalls, 1);
});

function createNativePlaybackHarness(overrides = {}) {
  const listeners = {};
  const timers = [];
  const microtasks = [];
  const ownDeck = {
    tagName: 'AUDIO', dataset: { tssCrossfadeDeck: '0' }, paused: false,
    pause() { this.paused = true; },
  };
  const nativeAudio = {
    tagName: 'AUDIO', dataset: {}, paused: false,
    pause() { this.paused = true; },
  };
  const state = {
    active: false, loading: false, suspended: false, busy: false,
    queue: [7], pos: 0, _decks: [ownDeck], _nativeTrack: null,
    _nativePlaybackGuardInstalled: false, _nativeGuardButtonAction: false,
    _playbackEpoch: 0, _playbackAbort: new AbortController(), _userPaused: false,
    ...overrides,
  };
  let transportPaused = false;
  const button = {
    clickCalls: 0,
    get title() { return transportPaused ? 'Play current track' : 'Pause current track'; },
    getAttribute() { return this.title; },
    closest(selector) { return selector === '.playControls__play' ? this : null; },
    click() {
      this.clickCalls++;
      const event = clickEvent(this);
      listeners.click?.(event);
      if (!event.prevented) {
        transportPaused = !transportPaused;
        nativeAudio.paused = transportPaused;
      }
    },
  };
  function clickEvent(target = button) {
    return {
      target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
  }
  const document = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector: () => button,
    querySelectorAll: () => [ownDeck, nativeAudio],
  };
  const dependencies = {
    state, document,
    queueMicrotask: fn => microtasks.push(fn),
    setTimeout: fn => timers.push(fn),
  };
  for (const name of [
    'nativePlaybackAllowed', 'isTrueShuffleAudio', 'soundCloudPaused',
    'pauseSoundCloud', 'pauseSoundCloudTransport', 'installNativePlaybackGuard',
  ]) {
    dependencies[name] = Function(
      ...Object.keys(dependencies), `return (${extractFunction(name)})`,
    )(...Object.values(dependencies));
  }
  dependencies.installNativePlaybackGuard();
  return {
    state, nativeAudio, ownDeck, button, listeners, clickEvent, dependencies,
    startNative() { nativeAudio.paused = false; transportPaused = false; },
    flush() {
      while (microtasks.length || timers.length) {
        while (microtasks.length) microtasks.shift()();
        if (timers.length) timers.shift()();
      }
    },
  };
}

test('native playback stays paused outside the current authorized fallback', () => {
  const scenarios = [
    ['idle initial page', {}],
    ['loading playlist', { loading: true }],
    ['active custom playback', { active: true }],
    ['stale fallback track', { active: true, _nativeTrack: 6 }],
    ['fallback with no current queue track', { active: true, _nativeTrack: 7, queue: [] }],
    ['user-paused fallback', { active: true, _nativeTrack: 7, _userPaused: true }],
    ['suspended fallback', { active: true, _nativeTrack: 7, suspended: true }],
    ['stopped session with stale fallback', { active: false, suspended: true, _nativeTrack: 7 }],
    ['loading during custom playback', { active: true, loading: true }],
  ];
  for (const [label, state] of scenarios) {
    const harness = createNativePlaybackHarness(state);
    harness.flush();
    assert.equal(harness.nativeAudio.paused, true, `${label}: restored native audio is paused`);
    assert.equal(harness.dependencies.soundCloudPaused(), true, `${label}: native transport is paused`);

    const click = harness.clickEvent();
    harness.listeners.click(click);
    assert.equal(click.prevented, true, `${label}: native transport cannot restart playback`);
    assert.equal(click.stopped, true, `${label}: SoundCloud does not receive the blocked click`);

    harness.startNative();
    harness.listeners.play({ target: harness.nativeAudio });
    assert.equal(harness.nativeAudio.paused, true, `${label}: native play is paused synchronously`);
    harness.flush();
    assert.equal(harness.dependencies.soundCloudPaused(), true, `${label}: native transport is reconciled`);
    assert.equal(harness.ownDeck.paused, false, `${label}: custom deck remains untouched`);
  }
});

test('native guard leaves custom deck events and ordinary navigation untouched', () => {
  const harness = createNativePlaybackHarness({ active: true });
  harness.flush();
  harness.listeners.play({ target: harness.ownDeck });
  const routeClick = harness.clickEvent({ closest: () => null });
  harness.listeners.click(routeClick);
  harness.flush();
  assert.equal(harness.ownDeck.paused, false);
  assert.equal(routeClick.prevented, false);
  assert.equal(routeClick.stopped, false);
});

test('current native fallback survives collection but pause, Stop, or queue replacement revokes it', () => {
  const harness = createNativePlaybackHarness({ active: true, loading: true, _nativeTrack: 7 });
  harness.listeners.play({ target: harness.nativeAudio });
  const click = harness.clickEvent();
  harness.listeners.click(click);
  harness.flush();
  assert.equal(harness.nativeAudio.paused, false);
  assert.equal(harness.dependencies.soundCloudPaused(), false);
  assert.equal(click.prevented, false);
  assert.equal(click.stopped, false);

  for (const change of [
    { _userPaused: true },
    { _userPaused: false, active: false, suspended: true },
    { active: true, suspended: false, queue: [8] },
  ]) {
    Object.assign(harness.state, change);
    harness.startNative();
    harness.listeners.play({ target: harness.nativeAudio });
    harness.flush();
    assert.equal(harness.nativeAudio.paused, true);
    assert.equal(harness.dependencies.soundCloudPaused(), true);
    assert.equal(harness.ownDeck.paused, false);
  }
});

test('deferred native cleanup cannot pause a fallback authorized after a blocked event', () => {
  for (const type of ['play', 'click']) {
    const harness = createNativePlaybackHarness();
    harness.flush();
    harness.startNative();
    harness.listeners[type](type === 'play'
      ? { target: harness.nativeAudio }
      : harness.clickEvent());
    Object.assign(harness.state, { active: true, _nativeTrack: 7 });
    harness.startNative();
    harness.flush();
    assert.equal(harness.nativeAudio.paused, false, `${type}: newly authorized audio keeps playing`);
    assert.equal(harness.dependencies.soundCloudPaused(), false, `${type}: transport remains playing`);
  }
});

test('True Shuffle transport retries custom playback but cannot start idle native playback', async () => {
  const harness = createNativePlaybackHarness({ active: true });
  const { state, button, dependencies } = harness;
  harness.flush();
  const playCalls = [];
  Object.assign(dependencies, {
    currentDeckAudio: () => null,
    playAt: async (trackIndex, countPlay) => { playCalls.push([trackIndex, countPlay]); },
    refreshPlayBtn: () => {},
    runPlaybackOperation: async (_label, operation) => operation(() => true),
    paused: () => harness.nativeAudio.paused,
  });
  dependencies.pause = Function(
    ...Object.keys(dependencies), `return (${extractFunction('pause')})`,
  )(...Object.values(dependencies));
  const toggle = Function(
    ...Object.keys(dependencies),
    `return (${extractFunction('toggle').replace(/^function /, 'async function ')})`,
  )(...Object.values(dependencies));

  await toggle();
  assert.deepEqual(playCalls, [[7, false]]);
  assert.equal(harness.nativeAudio.paused, true);

  state.active = false;
  const clicksBeforeIdle = button.clickCalls;
  await toggle();
  assert.equal(button.clickCalls, clicksBeforeIdle);
  assert.equal(harness.nativeAudio.paused, true);
  assert.deepEqual(playCalls, [[7, false]], 'idle controls do not restart the retained queue');

  Object.assign(state, { active: true, _nativeTrack: 7, _userPaused: true });
  await toggle();
  assert.equal(harness.nativeAudio.paused, false, 'explicit resume starts the authorized fallback');
  assert.equal(state._userPaused, false);
  assert.deepEqual(playCalls, [[7, false]], 'authorized fallback is not replaced by a custom retry');

  await toggle();
  assert.equal(harness.nativeAudio.paused, true, 'explicit pause stops the authorized fallback');
  assert.equal(state._userPaused, true);
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
    'spaceUpcomingDuplicateTitles',
    `return (${extractFunction('insertTracksRandomlyAfterCurrent')})`,
  )(items => items);
  const queue = [0, 1, 2, 3];
  const values = [0, 0.999999];
  insertTracksRandomlyAfterCurrent(queue, 1, [4, 5], () => values.shift());
  assert.deepEqual(queue.slice(0, 2), [0, 1]);
  assert.equal(new Set(queue).size, 6);
  assert.deepEqual([...queue].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.ok(queue.indexOf(4) > 1);
  assert.ok(queue.indexOf(5) > 1);
});

function createPlaylistCollectionHarness(resolveSnapshotMetas) {
  const normalizeTrackUrl = Function('URL', 'location', `return (${extractFunction('normalizeTrackUrl')})`)(
    URL, { origin: 'https://soundcloud.com' },
  );
  const mergeTrackMeta = Function(`return (${extractFunction('mergeTrackMeta')})`)();
  return Function(
    'getMeta', 'fetchLivePlaylistSnapshot', 'resolvePlaylistSnapshotMetas', 'normalizeTrackUrl', 'mergeTrackMeta',
    `return (${extractFunction('completePlaylistCollection').replace(/^function /, 'async function ')})`,
  )(el => el.meta, async () => null, resolveSnapshotMetas, normalizeTrackUrl, mergeTrackMeta);
}

test('complete playlist collection fills tracks SoundCloud did not render in the DOM', async () => {
  const pageUrl = 'https://soundcloud.com/user/sets/list';
  const firstEl = { meta: {
    title: 'First', artist: 'A', link: 'https://soundcloud.com/a/first', sourcePage: pageUrl,
  } };
  const completePlaylistCollection = createPlaylistCollectionHarness(async () => [
    firstEl.meta,
    { title: 'Second', artist: 'B', link: 'https://soundcloud.com/b/second', sourcePage: pageUrl },
    { title: 'Third', artist: 'C', link: 'https://soundcloud.com/c/third', sourcePage: pageUrl },
  ]);
  const snapshot = { complete: true, tracks: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const result = await completePlaylistCollection(pageUrl, [firstEl], Promise.resolve(snapshot));
  assert.equal(result.meta.length, 3);
  assert.equal(result.els.length, 3);
  assert.equal(result.els[0], firstEl);
  assert.equal(result.els[1], null);
  assert.equal(result.complete, true);
});

test('complete playlist identities replace unmatched DOM rows while preserving richer matching bylines', async () => {
  const pageUrl = 'https://soundcloud.com/user/sets/list';
  const pageEls = [
    { meta: { title: 'Second', artist: 'Beta, Guest', link: 'https://soundcloud.com/b/second?in=user/sets/list', liked: false, artwork: 'dom-art' } },
    { meta: { title: 'First', artist: '—', link: 'https://soundcloud.com/a/first/', artistLink: null, waveform: null } },
    { meta: { title: 'Unmatched', artist: '—', link: 'https://soundcloud.com/c/unmatched' } },
  ];
  const completePlaylistCollection = createPlaylistCollectionHarness(async () => [
    { title: 'First API title', artist: 'Alpha', link: 'https://soundcloud.com/a/first', artistLink: 'https://soundcloud.com/a', waveform: 'first-wave' },
    { title: 'Second API title', artist: 'Beta', link: 'https://soundcloud.com/b/second', liked: true, artwork: 'api-art' },
    { title: 'Different track', artist: 'Not Unmatched', link: 'https://soundcloud.com/d/different' },
  ]);
  const result = await completePlaylistCollection(pageUrl, pageEls, Promise.resolve({
    complete: true, tracks: [{ id: 1 }, { id: 2 }, { id: 4 }],
  }));
  assert.deepEqual(result.els, [pageEls[1], pageEls[0], null]);
  assert.deepEqual(result.meta.map(meta => [meta.title, meta.artist]), [
    ['First', 'Alpha'], ['Second', 'Beta, Guest'], ['Different track', 'Not Unmatched'],
  ]);
  assert.equal(result.meta[1].liked, false);
  assert.equal(result.meta[1].artwork, 'dom-art');
  assert.equal(result.meta[0].artistLink, 'https://soundcloud.com/a');
  assert.equal(result.meta[0].waveform, 'first-wave');
  assert.equal(result.complete, true);
});

test('partially resolved playlists retain rendered tracks and recovered names without claiming completion', async () => {
  const pageUrl = 'https://soundcloud.com/user/sets/list';
  const pageEls = [{ meta: { title: 'First', artist: '—', link: 'https://soundcloud.com/a/first' } }];
  const completePlaylistCollection = createPlaylistCollectionHarness(async () => [
    { title: 'First', artist: 'Alpha', link: 'https://soundcloud.com/a/first' },
  ]);
  const result = await completePlaylistCollection(pageUrl, pageEls, Promise.resolve({
    complete: true, tracks: [{ id: 1 }, { id: 2 }],
  }));
  assert.deepEqual(result.els, pageEls);
  assert.deepEqual(result.meta.map(meta => [meta.title, meta.artist]), [['First', 'Alpha']]);
  assert.equal(result.complete, false);
});

test('playlist metadata is batch-resolved in bounded requests and keeps playlist order', async () => {
  const requests = [];
  const snapshot = { tracks: [...Array(117)].map((_, index) => ({ id: index + 1 })) };
  const { resolvePlaylistSnapshotMetas } = createTrackMetadataHarness(async endpoint => {
    const ids = endpoint.searchParams.get('ids').split(',').map(Number);
    requests.push(ids);
    return { ok: true, json: async () => ids.map(id => ({
      id, title: `Track ${id}`, permalink_url: `https://soundcloud.com/a/${id}`, user: { username: 'Artist' },
    })) };
  });
  const metas = await resolvePlaylistSnapshotMetas(snapshot, 'https://soundcloud.com/user/sets/list');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(batch => batch.length), [50, 50, 17]);
  assert.equal(metas.length, 117);
  assert.equal(metas[0].soundcloudId, 1);
  assert.equal(metas[116].soundcloudId, 117);
  assert.equal(metas[116].playlistPosition, 117);
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
  const trackId = Function(`return (${extractFunction('trackId')})`)();
  const applyLiveQueueTracks = Function(
    'state', 'trackId', 'getMeta', 'insertTracksRandomlyAfterCurrent', 'fisherYates',
    'refreshUpcomingCrossfadePreparation', 'badges', 'renderList', 'updateHub', 'showMergeToast',
    `return (${extractFunction('applyLiveQueueTracks')})`,
  )(
    state, trackId, () => ({}),
    (queue, pos, indices) => queue.splice(pos + 1, 0, ...indices),
    items => items.slice(),
    () => {}, () => {}, () => {}, () => {}, () => {},
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
});

function createLiveSyncHarness() {
  const music = 'https://soundcloud.com/user/sets/music';
  const bumpers = 'https://soundcloud.com/user/sets/bumpers';
  const replacement = 'https://soundcloud.com/user/sets/replacement';
  const state = {
    active: false, loading: false, busy: false, suspended: false,
    playlistUrl: '', queue: [], meta: [], els: [], pos: 0, playNext: [], history: [],
    roundPlayed: 0, roundTotal: 0, priority: {}, skipCounts: {}, roundStarts: {},
    _liveSyncSources: new Map(), _liveSyncInFlight: false, _liveSyncLastCheck: 0,
    _liveSyncTimer: null, _deckTrack: null, _nativeTrack: null,
    _playbackEpoch: 0, _playbackAbort: new AbortController(), _collectionEpoch: 0, _userPaused: false,
  };
  const location = { href: music };
  const collections = new Map();
  const snapshots = new Map();
  const requests = [];
  const syncTasks = [];
  let now = 100_000;
  let resolver = null;
  const playlistBase = value => value.split(/[?#]/)[0].replace(/\/+$/, '');
  const meta = (id, sourcePage) => ({
    soundcloudId: id, title: `Track ${id}`, artist: 'Artist',
    link: `https://soundcloud.com/artist/track-${id}`, sourcePage,
  });
  const snapshot = (ids, complete = true) => ({ complete, tracks: ids.map(id => ({ id })) });
  const document = { getElementById: () => null, querySelectorAll: () => [], removeEventListener: () => {} };
  const dependencies = {
    state, location, document, playlistBase, syncTasks,
    AbortController,
    currentPageTrackElements: () => [],
    runPlaybackOperation: async (_label, operation) => {
      const epoch = state._playbackEpoch;
      state.busy = true;
      try { return await operation(() => state.active && state._playbackEpoch === epoch); }
      finally { if (state._playbackEpoch === epoch) state.busy = false; }
    },
    Date: { now: () => now }, LIVE_SYNC_INTERVAL_MS: 10_000,
    fetchLivePlaylistSnapshot: async sourcePage => {
      requests.push(sourcePage);
      const value = snapshots.get(sourcePage) || null;
      if (value instanceof Error) throw value;
      return value;
    },
    resolveLiveTrackMeta: async (track, sourcePage) => resolver
      ? resolver(track, sourcePage) : meta(track.id, sourcePage),
    loadTracks: async () => (collections.get(playlistBase(location.href)) || []).map(item => ({ meta: { ...item } })),
    completePlaylistCollection: async (sourcePage, els, snapshotPromise) => {
      await snapshotPromise;
      return { els, meta: els.map(el => el.meta), complete: true };
    },
    getMeta: el => el.meta,
    fisherYates: items => items.slice(),
    spaceUpcomingDuplicateTitles: () => {},
    buildReshuffledQueue: (indices, current) => current == null
      ? indices.slice() : [current, ...indices.filter(ti => ti !== current)],
    playAt: async ti => { state._deckTrack = ti; },
    startWatcher: () => { state._workerInterval = 1; },
    validPage: () => true,
    playerTitle: () => '',
    sessionStorage: { getItem: () => null },
    pauseSoundCloudTransport: () => {}, pauseSoundCloud: () => {},
    initializePlaybackVolume: () => {}, refreshUpcomingCrossfadePreparation: () => {},
    badges: () => {}, renderList: () => {}, updateHub: () => {},
    showMergeToast: () => {}, saveLifetimeStats: () => {},
    clearTimeout: () => {}, clearInterval: () => {},
    closeOwnPip: () => {}, stopCrossfadeDecks: () => {}, syncBrowserNowPlaying: () => {},
    recordPlaybackDiagnostic: () => {}, resetPlaybackClock: () => {},
    wait: async () => {}, inject: () => {}, bindCurrentPageElements: () => {},
    isPassiveBrowsePage: url => url.endsWith('/feed'),
  };
  const asynchronous = new Set(['syncLiveQueue', 'start', 'mergeCurrentPage', 'reshuffleCurrentPage', 'onNav']);
  const functions = [
    'trackId', 'trackAvailable', 'insertTracksRandomlyAfterCurrent', 'applyLiveQueueTracks',
    'registerLiveQueueSource', 'reconcileLivePlaylistSnapshot', 'showLiveSyncResult',
    'resetLiveQueueSync', 'syncLiveQueue', 'start', 'stop', 'mergeCurrentPage',
    'reshuffleCurrentPage', 'onNav',
    'invalidatePlaybackSession', 'beginCollectionRequest', 'collectionRequestCurrent', 'finishCollectionRequest',
    'cancelCollectionRequest', 'mergeTrackMeta', 'reviveRemovedQueueTrack', 'recountRoundTotal',
  ].map(name => asynchronous.has(name)
    ? extractFunction(name).replace(/^function /, 'async function ')
    : extractFunction(name)).join('\n');
  const api = Function(...Object.keys(dependencies), `
    let navLock = false;
    ${functions}
    const runSync = syncLiveQueue;
    syncLiveQueue = options => {
      const pending = runSync(options);
      syncTasks.push(pending);
      return pending;
    };
    return { start, stop, mergeCurrentPage, reshuffleCurrentPage, onNav, sync: runSync };
  `)(...Object.values(dependencies));
  return {
    ...api, state, location, music, bumpers, replacement, requests, snapshots, meta, snapshot,
    collection(sourcePage, ids) {
      collections.set(sourcePage, ids.map(id => meta(id, sourcePage)));
      snapshots.set(sourcePage, snapshot(ids));
    },
    resolveWith(value) { resolver = value; },
    advance(milliseconds) { now += milliseconds; },
    queueIds: () => state.queue.map(ti => state.meta[ti].soundcloudId),
    async flush() {
      while (syncTasks.length) await Promise.all(syncTasks.splice(0));
    },
    async merge(sourcePage) {
      location.href = sourcePage;
      state.suspended = true;
      await api.mergeCurrentPage();
      await this.flush();
    },
  };
}

function deferredLiveSync() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('first live snapshot adds tracks missed during initial collection without replaying the current track', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1, 2]);
  h.snapshots.set(h.music, h.snapshot([1, 2, 3]));
  await h.start();
  await h.flush();
  assert.equal(h.queueIds()[h.state.pos], 1);
  assert.deepEqual(h.queueIds().slice(1).sort(), [2, 3]);
  assert.equal(h.state.roundTotal, 3);
  assert.equal(await h.sync({ force: true }), 0);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
});

test('unresolved snapshot candidates remain retryable without duplicate queue entries', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1]);
  h.snapshots.set(h.music, h.snapshot([1, 2]));
  let attempts = 0;
  h.resolveWith((track, sourcePage) => ++attempts === 1 ? null : h.meta(track.id, sourcePage));
  await h.start();
  await h.flush();
  assert.deepEqual(h.queueIds(), [1]);
  assert.equal(await h.sync({ force: true }), 1);
  assert.deepEqual(h.queueIds(), [1, 2]);
  assert.equal(await h.sync({ force: true }), 0);
  assert.deepEqual(h.queueIds(), [1, 2]);
});

test('music then merge bumpers keeps polling both sources and appends each addition once', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1, 2]);
  h.collection(h.bumpers, [2, 3]);
  await h.start();
  await h.flush();
  await h.merge(h.bumpers);
  h.requests.length = 0;
  h.snapshots.set(h.music, h.snapshot([1, 2, 4]));
  h.snapshots.set(h.bumpers, h.snapshot([2, 3, 5]));
  assert.equal(await h.sync(), 0, 'the existing interval still throttles polling');
  assert.deepEqual(h.requests, []);
  h.advance(10_000);
  assert.equal(await h.sync(), 2);
  assert.deepEqual(h.requests.slice().sort(), [h.music, h.bumpers].sort());
  assert.equal(h.queueIds()[h.state.pos], 1);
  assert.deepEqual(h.queueIds().slice(1).sort(), [2, 3, 4, 5]);
  assert.deepEqual(h.state.history, []);
  assert.equal(h.state.roundTotal, 5);
  assert.equal(await h.sync({ force: true }), 0);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3, 4, 5]);
});

test('duplicate-only and complete-empty merges register sources and resume automatic updates', async () => {
  for (const initialBumpers of [[1, 2], []]) {
    const h = createLiveSyncHarness();
    h.collection(h.music, [1, 2]);
    h.collection(h.bumpers, initialBumpers);
    await h.start();
    await h.flush();
    await h.merge(h.bumpers);
    h.snapshots.set(h.bumpers, h.snapshot([...initialBumpers, 3]));
    h.advance(10_000);
    assert.equal(await h.sync(), 1);
    assert.equal(h.state.suspended, false);
    assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
    assert.equal(h.queueIds()[h.state.pos], 1);
  }
});

test('shared tracks survive until their final source removes them from upcoming', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1, 2]);
  h.collection(h.bumpers, [2, 3]);
  await h.start();
  await h.flush();
  await h.merge(h.bumpers);
  h.snapshots.set(h.music, h.snapshot([1]));
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
  h.snapshots.set(h.bumpers, h.snapshot([]));
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds(), [1]);
  assert.equal(h.state.roundTotal, 1);
  assert.equal(h.state.meta.find(meta => meta.soundcloudId === 2).unavailable, true);
});

test('membership moves between playlists in one poll without removing the track', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1, 2]);
  h.collection(h.bumpers, [3]);
  await h.start();
  await h.flush();
  await h.merge(h.bumpers);
  h.snapshots.set(h.music, h.snapshot([1]));
  h.snapshots.set(h.bumpers, h.snapshot([2, 3]));
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
  assert.equal(h.state.roundTotal, 3);
});

test('failed hydration in one source does not hide a usable shared track in another', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1]);
  h.collection(h.bumpers, [2]);
  await h.start();
  await h.flush();
  await h.merge(h.bumpers);
  h.resolveWith((track, sourcePage) => track.title ? h.meta(track.id, sourcePage) : null);
  h.snapshots.set(h.music, h.snapshot([1, 3]));
  h.snapshots.set(h.bumpers, { complete: true, tracks: [{ id: 2 }, { id: 3, title: 'Shared' }] });
  assert.equal(await h.sync({ force: true }), 1);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
  h.snapshots.set(h.bumpers, h.snapshot([2]));
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3]);
});

test('failed and partial sources retain tracks while another playlist updates', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1, 2]);
  h.collection(h.bumpers, [3]);
  await h.start();
  await h.flush();
  await h.merge(h.bumpers);
  h.snapshots.set(h.music, new Error('playlist fetch failed'));
  h.snapshots.set(h.bumpers, h.snapshot([3, 4]));
  assert.equal(await h.sync({ force: true }), 1);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3, 4]);
  h.snapshots.set(h.music, h.snapshot([1], false));
  h.snapshots.set(h.bumpers, h.snapshot([3, 4, 5]));
  assert.equal(await h.sync({ force: true }), 1);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3, 4, 5]);
  h.snapshots.set(h.music, h.snapshot([1], true));
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds().slice().sort(), [1, 3, 4, 5]);
});

test('live removals preserve history and current playback while removing upcoming and play-next entries', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [10, 11, 12, 13]);
  await h.start();
  await h.flush();
  h.state.queue = [0, 1, 2, 3];
  h.state.pos = 1;
  h.state._deckTrack = 1;
  h.state.history = [0];
  h.state.playNext = [2, 3];
  h.state.roundPlayed = 1;
  h.snapshots.set(h.music, h.snapshot([13]));
  await h.sync({ force: true });
  assert.deepEqual(h.queueIds(), [10, 11, 13]);
  assert.deepEqual(h.state.history, [0]);
  assert.deepEqual(h.state.playNext, [3]);
  assert.equal(h.queueIds()[h.state.pos], 11);
  assert.equal(h.state.meta[1].unavailable, undefined);
  assert.equal(h.state.roundTotal, 3);
});

test('re-shuffling retains merged watches while replacement and stop reset them', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1, 2]);
  h.collection(h.bumpers, [3]);
  h.collection(h.replacement, [10]);
  await h.start();
  await h.flush();
  await h.merge(h.bumpers);
  h.location.href = h.music;
  await h.onNav();
  await h.flush();
  assert.equal(h.state.suspended, false);
  await h.reshuffleCurrentPage();
  h.snapshots.set(h.music, h.snapshot([1, 2, 4]));
  h.snapshots.set(h.bumpers, h.snapshot([3, 5]));
  assert.equal(await h.sync({ force: true }), 2);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 3, 4, 5]);
  h.location.href = h.replacement;
  await h.onNav();
  assert.equal(h.state.suspended, true);
  await h.reshuffleCurrentPage();
  h.requests.length = 0;
  h.snapshots.set(h.replacement, h.snapshot([10, 11]));
  assert.equal(await h.sync({ force: true }), 1);
  assert.deepEqual(h.requests, [h.replacement]);
  assert.deepEqual(h.queueIds(), [10, 11]);
  h.stop();
  h.location.href = h.music;
  await h.start();
  await h.flush();
  h.requests.length = 0;
  await h.sync({ force: true });
  assert.deepEqual(h.requests, [h.music]);
  assert.deepEqual(h.queueIds().slice().sort(), [1, 2, 4]);
});

test('old snapshots cannot alter a restarted queue or release its newer pending sync', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1]);
  h.collection(h.replacement, [10]);
  await h.start();
  await h.flush();
  const oldSnapshot = deferredLiveSync();
  h.snapshots.set(h.music, oldSnapshot.promise);
  const oldSync = h.sync({ force: true });
  h.stop();
  h.location.href = h.replacement;
  await h.start();
  await h.flush();
  const newSnapshot = deferredLiveSync();
  h.snapshots.set(h.replacement, newSnapshot.promise);
  const newSync = h.sync({ force: true });
  oldSnapshot.resolve(h.snapshot([1, 99]));
  await oldSync;
  const requestsBefore = h.requests.length;
  assert.equal(await h.sync({ force: true }), 0);
  assert.equal(h.requests.length, requestsBefore, 'the newer pending sync still prevents a second fetch');
  newSnapshot.resolve(h.snapshot([10, 11]));
  await newSync;
  assert.deepEqual(h.queueIds(), [10, 11]);
});

test('old in-flight metadata cannot enter a restarted queue', async () => {
  const h = createLiveSyncHarness();
  h.collection(h.music, [1]);
  h.collection(h.replacement, [10]);
  await h.start();
  await h.flush();
  const hydration = deferredLiveSync();
  const entered = deferredLiveSync();
  h.resolveWith(() => { entered.resolve(); return hydration.promise; });
  h.snapshots.set(h.music, h.snapshot([1, 99]));
  const oldSync = h.sync({ force: true });
  await entered.promise;
  h.stop();
  h.location.href = h.replacement;
  await h.start();
  await h.flush();
  hydration.resolve(h.meta(99, h.music));
  await oldSync;
  assert.deepEqual(h.queueIds(), [10]);
  h.resolveWith(null);
  h.snapshots.set(h.replacement, h.snapshot([10, 11]));
  assert.equal(await h.sync({ force: true }), 1);
  assert.deepEqual(h.queueIds(), [10, 11]);
});

(async () => {
  for (const { name, fn } of tests) {
    let timer;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 5000); }),
      ]);
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  console.log('\nAll True Shuffle regression tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

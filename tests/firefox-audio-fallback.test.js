const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('custom deck playback never imports a Firefox native-media volume fallback', () => {
  const sync = extractFunction('syncPlaybackVolumeFromSoundCloud');
  assert.match(sync, /if \(currentDeckAudio\(\)\) return;/);

  const state = { _playbackVolumeInitialized: true, _lastSoundCloudVolume: 0.2, playbackVolume: 0.8 };
  let nativeReads = 0;
  const run = Function(
    'state', 'currentDeckAudio', 'initializePlaybackVolume', 'soundCloudVolume',
    'localStorage', 'syncCrossfadeVolume', 'syncPlaybackVolumeControls',
    `${sync}; syncPlaybackVolumeFromSoundCloud();`,
  );
  run(
    state, () => ({ paused: false }), () => true, () => { nativeReads++; return 0.2; },
    { setItem() {} }, () => {}, () => {},
  );
  assert.equal(nativeReads, 0);
  assert.equal(state.playbackVolume, 0.8);
});

test('native playback fallback permission is track-scoped, deck-safe, and one-shot', () => {
  const begin = extractFunction('beginNativePlaybackFallback');
  const active = extractFunction('nativePlaybackFallbackActive');
  assert.match(begin, /expiresAt/);
  assert.match(active, /Date\.now\(\)\s*<\s*fallback\.expiresAt/);
  assert.match(active, /trackIndex/);

  let now = 1000;
  const state = { queue: [7], pos: 0, _decks: [], _nativePlaybackFallback: null };
  const clear = () => { state._nativePlaybackFallback = null; };
  const beginFallback = Function('state', 'Date', `return (${begin})`)(state, { now: () => now });
  const fallbackActive = Function(
    'state', 'Date', 'clearNativePlaybackFallback', `return (${active})`,
  )(state, { now: () => now }, clear);

  beginFallback(7);
  assert.equal(fallbackActive(), true);
  assert.equal(fallbackActive({ tagName: 'AUDIO' }), true);
  assert.equal(state._nativePlaybackFallback, null);

  beginFallback(7);
  state._decks = [{ paused: false, ended: false }];
  assert.equal(fallbackActive({ tagName: 'AUDIO' }), false);
  assert.equal(state._nativePlaybackFallback, null);

  state._decks = [];
  beginFallback(7);
  state.queue[0] = 8;
  assert.equal(fallbackActive(), false);
  assert.equal(state._nativePlaybackFallback, null);

  state.queue[0] = 7;
  beginFallback(7);
  now = 4000;
  assert.equal(fallbackActive(), false);
  assert.equal(state._nativePlaybackFallback, null);
});

test('waveform hydration requires exact track identity and never reuses a title match', () => {
  const resolver = extractFunction('hydrationWaveformUrl');
  assert.doesNotMatch(resolver, /titleMatch|candidateTitle|candidateArtist/);
  assert.match(resolver, /candidateUrl === wantedUrl/);

  const hydrationWaveformUrl = Function(
    'pageWindow', 'normalizeTrackUrl', `return (${resolver})`,
  )(
    { __sc_hydration: [{ title: 'Same title', user: { username: 'Same artist' }, permalink_url: 'https://soundcloud.com/other/track', waveform_url: 'wrong' }] },
    value => String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase(),
  );
  assert.equal(hydrationWaveformUrl({ title: 'Same title', artist: 'Same artist', link: 'https://soundcloud.com/wanted/track' }), null);
});

test('missing Firefox hydration resolves the exact waveform through the track API', () => {
  const resolver = extractFunction('resolveWaveformUrl');
  assert.match(resolver, /api-v2\.soundcloud\.com\/resolve\?url=/);
  assert.match(resolver, /candidateUrl === wantedUrl/);
  assert.match(resolver, /meta\.waveform = resolved/);
  assert.doesNotMatch(resolver, /performance\.getEntriesByType|titleMatch/);
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error.stack || error);
  }
}

if (failures) {
  console.error(`\n${failures} Firefox audio fallback regression test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll Firefox audio fallback regression tests passed.');
}

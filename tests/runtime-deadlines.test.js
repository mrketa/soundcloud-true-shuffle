'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.env.TSS_SCRIPT || path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const bodyStart = source.indexOf(') {', start);
  assert.notEqual(bodyStart, -1, `Missing body for ${name}`);
  const brace = source.indexOf('{', bodyStart);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

function harness(fetch = async () => { throw new Error('Unexpected fetch'); }) {
  const timers = new Map();
  let timerId = 0;
  const withDeadline = Function('setTimeout', 'clearTimeout', `return (${extractFunction('withDeadline')})`)(
    callback => { timers.set(++timerId, callback); return timerId; },
    id => timers.delete(id),
  );
  const fetchSoundCloudResource = Function('withDeadline', 'fetch', `return (${extractFunction('fetchSoundCloudResource')})`)(withDeadline, fetch);
  return {
    withDeadline,
    fetchSoundCloudResource,
    expire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
  };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('a never-settling request times out and aborts its network operation', async () => {
  let requestSignal;
  const h = harness((_url, options) => { requestSignal = options.signal; return new Promise(() => {}); });
  const request = h.fetchSoundCloudResource('https://api-v2.soundcloud.com/tracks/1');
  const rejected = assert.rejects(request, error => error.name === 'TimeoutError');
  h.expire();
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('response-body consumption remains covered after headers arrive', async () => {
  let requestSignal;
  let bodyStarted = false;
  const h = harness(async (_url, options) => {
    requestSignal = options.signal;
    return { ok: true, status: 200, text() { bodyStarted = true; return new Promise(() => {}); } };
  });
  const request = h.fetchSoundCloudResource('https://soundcloud.com/user/sets/music', 'text');
  await Promise.resolve();
  assert.equal(bodyStarted, true);
  const rejected = assert.rejects(request, error => error.name === 'TimeoutError');
  h.expire();
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('session cancellation settles ignored aborts without poisoning a new request', async () => {
  let completeOld;
  let oldSignal;
  const h = harness();
  const session = new AbortController();
  const old = h.withDeadline(signal => {
    oldSignal = signal;
    return new Promise(resolve => { completeOld = resolve; });
  }, 10000, session.signal);
  const rejected = assert.rejects(old, error => error.name === 'AbortError');
  session.abort();
  await rejected;
  assert.equal(oldSignal.aborted, true);
  completeOld('stale result');
  assert.equal(await h.withDeadline(() => 'new session'), 'new session');
});

test('already-cancelled work cannot start and successful work is never aborted later', async () => {
  const h = harness();
  const cancelled = new AbortController();
  cancelled.abort();
  let starts = 0;
  await assert.rejects(h.withDeadline(() => { starts++; }, 10000, cancelled.signal), error => error.name === 'AbortError');
  assert.equal(starts, 0);
  const session = new AbortController();
  let completedSignal;
  assert.equal(await h.withDeadline(signal => { completedSignal = signal; return 42; }, 10000, session.signal), 42);
  session.abort();
  h.expire();
  assert.equal(completedSignal.aborted, false);
});

test('HTTP failure does not consume an error body and the next request can succeed', async () => {
  let count = 0;
  const h = harness(async () => ++count === 1
    ? { ok: false, status: 403, json() { throw new Error('Do not parse this error body'); } }
    : { ok: true, status: 200, json: async () => ({ id: 7 }) });
  assert.deepEqual(await h.fetchSoundCloudResource('https://api-v2.soundcloud.com/tracks/7'), { ok: false, status: 403, data: null });
  assert.deepEqual(await h.fetchSoundCloudResource('https://api-v2.soundcloud.com/tracks/7'), { ok: true, status: 200, data: { id: 7 } });
});

(async () => {
  for (const { name, run } of tests) {
    let timer;
    try {
      await Promise.race([
        run(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Test did not settle: ${name}`)), 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    console.log(`ok - ${name}`);
  }
  console.log('\nAll runtime deadline regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

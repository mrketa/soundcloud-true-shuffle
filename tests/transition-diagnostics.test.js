'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(process.env.TSS_SCRIPT
  ? path.resolve(process.env.TSS_SCRIPT)
  : path.resolve(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');
const installedVersion = source.match(/^\/\/\s*@version\s+(\S+)/m)?.[1];
const transitionTest = source.includes('function recordTransitionDiagnostic(') ? test : test.skip;
const pairedAutomation = source.includes('function schedulePairedCrossfade(');
const pairedTest = pairedAutomation ? test : test.skip;
const timingTest = source.includes('function crossfadeAutomationTiming(') ? pairedTest : test.skip;
const compactReports = source.includes('function compactPlaybackReport(');
const compactReportTest = compactReports ? transitionTest : test.skip;

function extract(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = text.indexOf('\n}', start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return text.slice(text.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start, end + 2);
}

// Reuse the existing playback/clock models without registering their test cases.
function fixtureFactory(filename, names) {
  const fixture = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  return Function('source', 'assert', 'vm',
    `${names.map(name => extract(fixture, name)).join('\n')}\nreturn createHarness;`)(source, assert, vm);
}
const playbackHarness = fixtureFactory('low-spec-playback.test.js',
  ['extractFunction', 'deferred', 'flush', 'observe', 'createClock', 'createHarness']);
const watcherHarness = fixtureFactory('clock-recovery.test.js', ['extractFunction', 'createClock', 'createHarness']);

function installDiagnostics(context, now) {
  const constants = [
    'DIAGNOSTIC_NUMBER_FIELDS', 'DIAGNOSTIC_BOOLEAN_FIELDS', 'DIAGNOSTIC_STRING_FIELDS',
    'DIAGNOSTIC_NESTED_FIELDS', 'PLAYBACK_DIAGNOSTIC_FAULTS',
  ].map(name => {
    const match = source.match(new RegExp(`const ${name} = new Set\\([\\s\\S]*?\\n\\]\\);`));
    assert.ok(match, `missing ${name}`);
    return match[0];
  });
  constants.push(source.match(/const DIAGNOSTIC_SAFE_LABELS = \{[\s\S]*?\n\};/)[0]);
  context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  };
  context.performance = { now };
  const helpers = [
    'safeDiagnosticVersion', 'safeDiagnosticString', 'sanitizeDiagnosticRecord', 'sanitizePlaybackDiagnostics',
    'playbackErrorName', 'hlsDiagnosticCode', 'recordPlaybackDiagnostic', 'recordTransitionDiagnostic',
    'observeTransitionMedia', 'observeTransitionHls',
  ];
  if (source.includes('function playbackDiagnosticContext(')) {
    helpers.push('playbackDiagnosticHostWindow', 'diagnosticDeckStreamKind');
  }
  for (const name of ['playbackDiagnosticContext',
    'capturePlaybackDiagnosticIncident', 'compactPlaybackReport']) {
    if (source.includes(`function ${name}(`)) helpers.push(name);
  }
  vm.runInContext(constants.join('\n') + '\n' + helpers.map(name => extract(source, name)).join('\n'), context);
  context.state._transitionDiagnostics = true;
  context.state._playbackDiagnostics = [];
  context.state._playbackDiagnosticFault = false;
  context.state._playbackDiagnosticIncident = null;
}

async function scheduledFade(t, options = {}) {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  await h.context.prefetchUpcomingCrossfadeTrack();
  const incoming = h.state._decks[1];
  if (options.baselineTime) {
    let mediaTime = options.baselineTime;
    Object.defineProperty(incoming, 'currentTime', {
      get: () => mediaTime,
      set: value => { mediaTime = value === 0 ? options.baselineTime : value; },
    });
  }
  const play = incoming.play;
  incoming.play = function () {
    const result = play.call(this);
    this.currentTime += options.playAdvance || 0;
    return result;
  };
  let submittedCost = 0;
  const sampledAudioClock = h.clock.now() / 1000;
  Object.defineProperty(h.state._audioContext, 'currentTime', {
    get: () => options.cachedClock ? sampledAudioClock : h.clock.now() / 1000 + submittedCost / 1000,
  });
  h.context.performance = { now: () => h.clock.now() + submittedCost };
  const callsPerDeck = pairedAutomation
    ? h.context.crossfadeAutomationPlan(h.state.crossfadeCurve).times.length + 1 : 130;
  for (const [index, cost] of [options.outgoingCostMs || 0, options.incomingCostMs || 0].entries()) {
    const gain = h.state._deckAudioGraphs[index].mixGain.gain;
    for (const name of ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']) {
      const original = gain[name];
      gain[name] = function (...args) {
        original.apply(this, args);
        submittedCost += cost / callsPerDeck;
      };
    }
  }
  if (options.diagnostics === false) h.state._transitionDiagnostics = false;
  h.state.pos = 1;
  const completion = h.context.playWithCrossfadeDeck(1, true, 2);
  await h.clock.advance(0);
  assert.ok(h.state._crossfadeSchedule, 'the real handoff has submitted both gain ramps');
  return Object.assign(h, {
    incoming, completion, schedule: h.state._crossfadeSchedule,
    progress: () => h.state._playbackDiagnostics.filter(event => event.event === 'incoming-clock-progress'),
    scheduled: () => h.state._playbackDiagnostics.find(event => event.event === 'fade-scheduled'),
  });
}

function reportHarness() {
  let now = 100000;
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById: id => elements.get(id) || null,
    createElement() {
      const children = new Map();
      return {
        dataset: {}, hidden: false, isConnected: true,
        setAttribute(name, value) { this[name] = value; },
        focus() { document.activeElement = this; },
        remove() { this.isConnected = false; elements.delete(this.id); },
        querySelector(selector) { return children.get(selector.slice(1)) || null; },
        set innerHTML(value) {
          for (const match of value.matchAll(/id="([^"]+)"/g)) {
            const child = document.createElement();
            child.id = match[1]; children.set(child.id, child);
          }
        },
      };
    },
    body: { appendChild(element) { elements.set(element.id, element); } },
  };
  const button = document.createElement();
  button.id = 'tss-playback-debug';
  document.body.appendChild(button);
  document.activeElement = button;
  const state = {
    active: false, _playbackEpoch: 1, _playbackRequest: { operationId: 7 },
    _decks: [], _deckTracks: [], _deckGains: [], _deckAudioGraphs: [],
    _deckIndex: -1, _deckTrack: null, queue: [], meta: [],
  };
  let copied = '';
  const context = vm.createContext({
    state, document, console: { info() {} }, SVG: { close: '' },
    navigator: { userAgent: 'Mozilla/5.0 Firefox/142.0', platform: 'Win32',
      clipboard: { async writeText(value) { copied = value; } } },
    GM_info: { scriptHandler: 'Tampermonkey', scriptHandlerVersion: '5.5.1',
      script: { version: installedVersion } },
    showPlaybackReportHelp() {},
  });
  installDiagnostics(context, () => now);
  vm.runInContext(['playbackDiagnosticHostWindow', 'playbackDiagnosticPageKind',
    'playbackDiagnosticEnvironment', 'playbackDiagnosticCapabilities', 'diagnosticDeckStreamKind',
    'updatePlaybackDiagnosticButton', 'playbackDiagnosticSnapshot', 'showPlaybackDiagnostics']
    .map(name => extract(source, name)).join('\n'), context);
  return { context, state, document, button, copied: () => copied, advance: ms => { now += ms; } };
}

transitionTest('manual report exports the entire bounded private ring, preserves fault status, and stays usable after Clear', async () => {
  const h = reportHarness();
  h.context.updatePlaybackDiagnosticButton();
  assert.equal(h.button.hidden, compactReports, 'compact-report headers are fault-only');
  assert.equal(h.button.dataset.status, 'none');
  const sentinel = 'PRIVATE_SENTINEL';
  for (let index = 0; index < 95; index++) {
    h.context.recordTransitionDiagnostic('preparation-result', {
      trackIndex: index, ready: true, elapsedMs: index,
      title: sentinel, artist: sentinel, reason: sentinel, operation: sentinel,
      url: `https://soundcloud.com/${sentinel}?token=${sentinel}`,
      error: sentinel, currentTime: Infinity, duration: NaN,
    });
    h.advance(10);
  }
  assert.equal(h.context.recordTransitionDiagnostic(sentinel, {}), null);
  const snapshot = h.context.playbackDiagnosticSnapshot();
  assert.equal(snapshot.state.transitionDiagnosticsEnabled, true);
  assert.equal(snapshot.state.diagnosticsEnabled, false);
  assert.equal(h.state._playbackDiagnostics.length, 80);
  assert.equal(snapshot.diagnostics.length, 80, 'nested report sanitization must also retain 80');
  assert.equal(snapshot.diagnostics[0].trackIndex, 15);
  assert.equal(snapshot.diagnostics.at(-1).trackIndex, 94);
  assert.equal(snapshot.scriptVersion, installedVersion);
  assert.equal(snapshot.environment.scriptVersion, installedVersion);
  assert.equal(snapshot.environment.managerVersion, '5.5.1');
  assert.equal(snapshot.diagnostics.at(-1).monotonicMs, 940);
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  assert.equal('currentTime' in snapshot.diagnostics[0], false);
  assert.equal(h.state._playbackDiagnosticFault, false, 'observations are not automatic gap alerts');
  h.context.showPlaybackDiagnostics();
  let overlay = h.document.getElementById('tss-debug-overlay');
  await overlay.querySelector('#tss-debug-copy').onclick({ currentTarget: overlay.querySelector('#tss-debug-copy') });
  if (compactReports) {
    assert.equal(h.copied(), h.context.compactPlaybackReport(snapshot));
    assert.ok(h.copied().length <= 1800);
    const details = overlay.querySelector('#tss-debug-details');
    const fullText = overlay.querySelector('#tss-debug-full-report');
    assert.equal(Boolean(fullText.textContent), false, 'verbose JSON is not the default report');
    details.open = true;
    details.ontoggle();
    const fullCopy = overlay.querySelector('#tss-debug-copy-full');
    await fullCopy.onclick({ currentTarget: fullCopy });
    assert.equal(JSON.parse(h.copied()).diagnostics.length, 80, 'explicit full copy preserves the bounded ring');
    assert.equal(fullText.textContent, h.copied());
  } else {
    assert.equal(JSON.parse(h.copied()).diagnostics.length, 80);
  }
  assert.equal(h.copied().includes(sentinel), false);
  h.context.recordPlaybackDiagnostic('recovery-failed', { reason: 'media-error' });
  assert.equal(h.button.dataset.status, 'current');
  h.context.recordTransitionDiagnostic('media-playing', { readyState: 4 });
  assert.equal(h.button.dataset.status, 'current', 'observations cannot clear a real fault');
  overlay.querySelector('#tss-debug-clear').onclick();
  assert.equal(h.state._playbackDiagnostics.length, 0);
  assert.equal(h.state._playbackDiagnosticFault, false);
  assert.equal(h.button.hidden, compactReports);
  assert.equal(h.button.dataset.status, 'none');
  h.context.showPlaybackDiagnostics();
  overlay = h.document.getElementById('tss-debug-overlay');
  if (compactReports) {
    assert.equal(h.state._playbackDiagnosticIncident, null);
    assert.equal(overlay.querySelector('#tss-debug-report').textContent,
      h.context.compactPlaybackReport(h.context.playbackDiagnosticSnapshot('user-opened-report')));
  } else {
    assert.equal(JSON.parse(overlay.querySelector('#tss-debug-report').textContent).diagnostics.length, 0);
  }
  delete h.state._transitionDiagnostics;
  h.context.updatePlaybackDiagnosticButton();
  assert.equal(h.button.hidden, true, 'older extracted states keep fault-only visibility');
  assert.equal(h.context.recordTransitionDiagnostic('preparation-start', { trackIndex: 1 }), null);
  assert.equal(h.state._playbackDiagnostics.length, 0);
});

transitionTest('report versions are sanitized at the public boundary without leaking malformed metadata', () => {
  const h = reportHarness();
  const versions = [
    ['6.2.9', '6.2.9'], ['1.7.3-beta.1', '1.7.3-beta.1'],
    ['', 'unknown'], ['6.2', 'unknown'], ['6.2.9.15.1', 'unknown'],
    ['1000.2.9', 'unknown'], ['6.2.9/private-secret', 'unknown'],
  ];
  if (source.includes('function soundCloudInteger(')) {
    versions.push(
      ['6.2.9.15', '6.2.9.15'],
      ['6.2.9.15-rc.1', '6.2.9.15-rc.1'],
      [`6.2.9-${'x'.repeat(59)}`, 'unknown'],
    );
  }
  for (const [value, expected] of versions) {
    h.context.GM_info.script.version = value;
    const report = h.context.playbackDiagnosticSnapshot();
    assert.equal(report.scriptVersion, expected);
    assert.equal(report.environment.scriptVersion, expected);
    assert.equal(report.environment.managerVersion, '5.5.1');
    assert.equal(JSON.stringify(report).includes('private-secret'), false);
  }
  delete h.context.GM_info;
  const missing = h.context.playbackDiagnosticSnapshot();
  assert.equal(missing.scriptVersion, 'unknown');
  assert.equal(missing.environment.scriptVersion, 'unknown');
});

function assertCompactText(report) {
  assert.equal(typeof report, 'string');
  assert.ok(report.length > 0 && report.length <= 1800, `compact report has ${report.length} characters`);
  assert.ok(report.split('\n').every(line => line === line.trimEnd()), 'lines are complete, without padding');
  assert.doesNotMatch(report, /(?:undefined|NaN|Infinity|\[object Object\])/);
  assert.doesNotMatch(report, /(?:\.\.\.|…)\s*$/, 'the report must not be a sliced fragment');
  assert.doesNotMatch(report.trimStart(), /^(?:\{|\[)/, 'the default report is readable text, not serialized data');
}

compactReportTest('compact report keeps readable environment and fault identity ahead of repetitive observations', () => {
  const h = reportHarness();
  for (let index = 0; index < 50; index++) {
    h.context.recordTransitionDiagnostic('preparation-result', { ready: true, trackIndex: index });
    h.advance(1);
  }
  assert.equal(h.state._playbackDiagnosticIncident, null, 'routine observations never create an incident');
  h.context.recordPlaybackDiagnostic('recovery-failed', {
    reason: 'media-error', errorName: 'NetworkError', mediaErrorCode: 3,
    failureStage: 'media-wait', failureReason: 'media-error', elapsedMs: 4321,
  });
  for (let index = 0; index < 90; index++) {
    h.context.recordTransitionDiagnostic('media-playing', { readyState: 4 });
    h.advance(1);
  }
  const report = h.context.compactPlaybackReport(h.context.playbackDiagnosticSnapshot());
  assertCompactText(report);
  assert.ok(report.split('\n').length >= 3, 'environment and failure are readable without an external decoder');
  for (const value of [installedVersion, 'firefox', '142', 'windows', 'tampermonkey', '5.5.1',
    'recovery-failed', 'NetworkError', 'media-error']) {
    assert.ok(report.toLowerCase().includes(value.toLowerCase()), `missing useful diagnostic value ${value}`);
  }
  for (const routine of ['preparation-result', 'media-playing']) {
    assert.ok(report.split(routine).length - 1 <= 1, `${routine} must not consume the report through repetition`);
    if (report.includes(routine)) {
      assert.ok(report.indexOf('recovery-failed') < report.indexOf(routine), 'routine noise must follow the cause');
    }
  }
});

compactReportTest('compact scheduling evidence belongs to the fault-time token and preserves subsecond and same-timestamp observations', () => {
  const h = reportHarness();
  const original = [57.125, 38.25, 18.875];
  const later = [876.125, 654.25, 221.875];
  const metrics = values => ({
    sampledSchedulingLeadMs: values[0],
    schedulingSubmissionMs: values[1],
    estimatedSchedulingLeadMs: values[2],
  });
  h.state._crossfadeSchedule = { token: 19, outgoingIndex: 0, incomingIndex: 1,
    startTime: 10, endTime: 14, duration: 4 };
  h.context.recordTransitionDiagnostic('media-waiting', { readyState: 2 });
  h.advance(125);
  h.context.recordTransitionDiagnostic('fade-scheduled', { crossfadeToken: 19, ...metrics(original) });
  h.advance(75);
  h.context.recordTransitionDiagnostic('media-stalled', { readyState: 2 });
  h.advance(75);
  h.context.recordPlaybackDiagnostic('crossfade-handoff-failed', { reason: 'media-error', mediaErrorCode: 3 });
  h.advance(90);
  h.state._crossfadeSchedule = { token: 20, outgoingIndex: 1, incomingIndex: 0,
    startTime: 20, endTime: 24, duration: 4 };
  h.context.recordTransitionDiagnostic('fade-scheduled', { crossfadeToken: 20, ...metrics(later) });
  h.advance(910);
  h.context.recordTransitionDiagnostic('fade-scheduled', { crossfadeToken: 19, ...metrics(later) });
  const snapshot = h.context.playbackDiagnosticSnapshot();
  assert.equal(snapshot.incident.schedule.token, 19);
  assert.equal(snapshot.schedule.token, 20);
  const report = h.context.compactPlaybackReport(snapshot);
  assertCompactText(report);
  for (const value of original) {
    assert.ok(report.includes(String(value)), `missing fault-time scheduling evidence ${value}`);
  }
  for (const value of later) {
    assert.equal(report.includes(String(value)), false, `later scheduling evidence ${value} must not describe the fault`);
  }
  const waiting = report.split('\n').find(line => line.includes('media-waiting'));
  const stalled = report.split('\n').find(line => line.includes('media-stalled'));
  const scheduled = report.split('\n').filter(line => line.includes('fade-scheduled'));
  assert.ok(waiting && /-275\s*ms\b/.test(waiting), 'the earliest retained observation remains subsecond');
  assert.ok(scheduled.some(line => /-150\s*ms\b/.test(line)),
    'the matching pre-fault fade survives a later event with the same event/detail/status key');
  assert.ok(stalled && /-75\s*ms\b/.test(stalled), 'stalled retains its distinct signed 75ms lead over the fault');
  assert.ok(scheduled.some(line => /\+1000\s*ms\b/.test(line)),
    'later same-key evidence remains separate from the causal pre-fault fade');
  for (const schedule of [undefined, { ...snapshot.incident.schedule, token: 99 }]) {
    const unmatched = h.context.compactPlaybackReport({
      ...snapshot, incident: { ...snapshot.incident, schedule },
    });
    assertCompactText(unmatched);
    for (const value of [...original, ...later]) {
      assert.equal(unmatched.includes(String(value)), false,
        `scheduling metric ${value} requires a matching captured schedule`);
    }
  }
  const sameTime = reportHarness();
  const before = sameTime.context.recordPlaybackDiagnostic('hls-manifest-parsed', { elapsedMs: 125 });
  const fault = sameTime.context.recordPlaybackDiagnostic('crossfade-handoff-failed', { reason: 'media-error' });
  const after = sameTime.context.recordPlaybackDiagnostic('hls-fragment-buffered', { elapsedMs: 150 });
  assert.equal(before.at, fault.at);
  assert.equal(after.at, fault.at, 'this boundary depends on record order, not advancing the wall clock');
  const sameTimeSnapshot = sameTime.context.playbackDiagnosticSnapshot();
  assert.equal(sameTimeSnapshot.incident.fault.event, 'crossfade-handoff-failed');
  const sameTimeReport = sameTime.context.compactPlaybackReport(sameTimeSnapshot);
  assertCompactText(sameTimeReport);
  assert.equal(sameTimeReport.split('hls-manifest-parsed').length - 1, 1,
    'same-millisecond prior evidence must not be repeated as an after-fault observation');
  assert.equal(sameTimeReport.split('hls-fragment-buffered').length - 1, 1,
    'the real post-fault observation sharing its timestamp remains in the report');
  assert.ok(sameTimeReport.includes('crossfade-handoff-failed'), 'same-time observations do not obscure the latest fault');
});

compactReportTest('dense allowed records and extreme or malformed values stay within the complete plain-text boundary', () => {
  const h = reportHarness();
  const dense = {};
  for (const key of vm.runInContext('Array.from(DIAGNOSTIC_STRING_FIELDS)', h.context)) {
    const value = h.context.safeDiagnosticString(key, 'x'.repeat(64));
    if (value) dense[key] = value;
  }
  const numbers = vm.runInContext('Array.from(DIAGNOSTIC_NUMBER_FIELDS)', h.context);
  const extremes = [1e9, -1e9, 999999999.999, Number.MAX_VALUE, Number.MIN_VALUE, Infinity, -Infinity, NaN];
  numbers.forEach((key, index) => { dense[key] = extremes[index % extremes.length]; });
  const fault = {
    ...dense, at: new Date(100000).toISOString(), event: 'recovery-failed',
    errorName: 'NetworkError', reason: 'media-error', failureReason: 'media-error',
    readyState: 2, mediaErrorCode: 3, elapsedMs: 4321,
  };
  const snapshot = {
    scriptVersion: installedVersion,
    environment: { browser: 'firefox', browserMajorVersion: 142, platform: 'windows',
      manager: 'tampermonkey', managerVersion: '5.5.1', scriptVersion: installedVersion },
    state: dense, audioContext: dense, schedule: dense, decks: [dense, dense],
    incident: { fault, state: dense, audioContext: dense, schedule: dense, decks: [dense, dense],
      diagnostics: Array.from({ length: 12 }, () => ({ ...dense, at: fault.at, event: 'media-playing' })) },
    diagnostics: Array.from({ length: 80 }, () => ({ ...fault })),
  };
  const report = h.context.compactPlaybackReport(snapshot);
  assertCompactText(report);
  for (const value of ['recovery-failed', 'NetworkError', 'media-error', installedVersion, 'firefox', 'tampermonkey']) {
    assert.ok(report.includes(value), `dense records must not crowd out ${value}`);
  }
  for (const malformed of [undefined, null, false, 42, '', [], {},
    { environment: [], state: 'invalid', decks: {}, diagnostics: [null, false, [], { event: {} }] },
    { incident: { fault: null, diagnostics: 'invalid', decks: [null, 'invalid'] },
      diagnostics: [null, {}, { event: 'recovery-failed', at: 'not-a-date', elapsedMs: Infinity }] },
  ]) {
    assertCompactText(h.context.compactPlaybackReport(malformed));
  }
});

compactReportTest('canonical error names survive legacy exception aliases in either property order', () => {
  const exception = 'PRIVATE_EXCEPTION_SENTINEL at https://media.example/private?token=PRIVATE_TOKEN_SENTINEL';
  for (const details of [
    { errorName: 'NetworkError', error: exception },
    { error: exception, errorName: 'NetworkError' },
  ]) {
    const h = reportHarness();
    const entry = h.context.recordPlaybackDiagnostic('recovery-failed', details);
    assert.equal(entry.errorName, 'NetworkError');
    const snapshot = h.context.playbackDiagnosticSnapshot();
    assert.equal(snapshot.incident.fault.errorName, 'NetworkError');
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_'), false);
    const report = h.context.compactPlaybackReport(snapshot);
    assertCompactText(report);
    assert.ok(report.includes('NetworkError'));
    assert.equal(report.includes('PRIVATE_'), false);
  }
});

compactReportTest('raw compact snapshots cannot export private metadata, credentials, URLs or exception strings', () => {
  const h = reportHarness();
  const title = 'PRIVATE_TITLE_SENTINEL';
  const account = 'PRIVATE_ACCOUNT_SENTINEL';
  const credential = 'PRIVATE_CREDENTIAL_SENTINEL';
  const exception = 'PRIVATE_EXCEPTION_SENTINEL';
  const url = `https://soundcloud.com/${account}/${title}?client_id=${credential}&oauth_token=${credential}`;
  const unsafe = {
    title, artist: account, account, username: account, url, src: url, currentSrc: url,
    authorization: credential, token: credential, query: credential,
    reason: url, failureReason: url, operation: url, errorName: exception, error: exception,
    message: `Failed to fetch ${url}`, stack: `Error: ${exception}\n at ${url}`,
  };
  const at = new Date(100000).toISOString();
  const raw = {
    ...unsafe, scriptVersion: url,
    environment: { ...unsafe, scriptVersion: url, managerVersion: url, browser: url, platform: account },
    state: unsafe, audioContext: unsafe, schedule: unsafe, decks: [unsafe, unsafe],
    incident: { ...unsafe, fault: { ...unsafe, at, event: 'recovery-failed', mediaErrorCode: 3 },
      state: unsafe, audioContext: unsafe, schedule: unsafe, decks: [unsafe, unsafe],
      diagnostics: [{ ...unsafe, at, event: 'media-playing' }] },
    diagnostics: [{ ...unsafe, at, event: 'recovery-failed' }, { ...unsafe, at, event: title }],
  };
  const report = h.context.compactPlaybackReport(raw);
  assertCompactText(report);
  assert.ok(report.includes('recovery-failed'), 'privacy filtering must not erase the real fault');
  for (const secret of [title, account, credential, exception, 'soundcloud.com', 'client_id', 'oauth_token']) {
    assert.equal(report.includes(secret), false, `raw boundary leaked ${secret}`);
  }
});

compactReportTest('fault-time state and bounded prior context survive Stop-like reset and ring rollover until the latest fault replaces them', () => {
  const h = reportHarness();
  const secret = 'PRIVATE_INCIDENT_SENTINEL';
  const url = `https://media.example/${secret}?token=${secret}`;
  const audio = {
    src: url, currentSrc: url, title: secret, paused: false, ended: false, seeking: false,
    currentTime: 246.75, duration: 300, readyState: 2, networkState: 2,
    error: { code: 3, message: secret }, playbackRate: 1,
    buffered: { length: 1, start: () => 240, end: () => 251.25 },
  };
  Object.assign(h.state, {
    active: true, loading: true, _deckIndex: 0, _deckTrack: 7, _deckTracks: [7],
    _decks: [audio], _deckGains: [0.8], queue: [7, 8], pos: 0,
    _audioContext: { state: 'suspended', currentTime: 913.25, sampleRate: 48000 },
    _crossfadeSchedule: { token: 19, startTime: 910.125, endTime: 914.125, duration: 4,
      outgoingIndex: 0, incomingIndex: 1, lastClockValue: 913.25, lastIncomingTime: 246.75 },
  });
  h.document.visibilityState = 'hidden';
  h.context.navigator.onLine = false;
  for (let index = 0; index < 25; index++) {
    h.context.recordTransitionDiagnostic('preparation-result', { trackIndex: index, elapsedMs: index });
    h.advance(1);
  }
  h.context.recordPlaybackDiagnostic('recovery-failed', {
    reason: 'media-error', errorName: 'NetworkError', mediaErrorCode: 3, elapsedMs: 4321,
    title: secret, url, error: `Failed fetching ${url}`,
  });
  const captured = JSON.parse(JSON.stringify(h.state._playbackDiagnosticIncident));
  assert.equal(captured.fault.event, 'recovery-failed');
  assert.equal(captured.state.active, true);
  assert.equal(captured.state.loading, true);
  assert.equal(captured.state.visible, false);
  assert.equal(captured.state.onLine, false);
  assert.equal(captured.audioContext.contextState, 'suspended');
  assert.equal(captured.audioContext.currentTime, 913.25);
  assert.equal(captured.schedule.startTime, 910.125);
  assert.equal(captured.decks[0].readyState, 2);
  assert.equal(captured.decks[0].errorCode, 3);
  assert.equal(captured.decks[0].currentTime, 246.75);
  assert.equal(captured.decks[0].bufferedAhead, 4.5);
  assert.equal(captured.diagnostics.length, 12);
  assert.deepEqual(captured.diagnostics.map(entry => entry.trackIndex), Array.from({ length: 12 }, (_, index) => index + 13));
  audio.readyState = 0;
  audio.error.code = 0;
  audio.currentTime = 0;
  h.state._audioContext.state = 'closed';
  Object.assign(h.state, { active: false, loading: false, _decks: [], _deckTracks: [], _deckIndex: -1,
    _deckTrack: null, _crossfadeSchedule: null, _audioContext: null });
  h.document.visibilityState = 'visible';
  h.context.navigator.onLine = true;
  for (let index = 0; index < 100; index++) {
    h.context.recordTransitionDiagnostic('media-playing', { readyState: 4, trackIndex: index });
    h.advance(1);
  }
  assert.equal(h.state._playbackDiagnostics.length, 80);
  assert.equal(h.state._playbackDiagnostics.some(entry => entry.event === 'recovery-failed'), false);
  const snapshot = h.context.playbackDiagnosticSnapshot();
  assert.equal(snapshot.state.active, false);
  assert.equal(snapshot.environment.visible, true);
  assert.equal(snapshot.environment.onLine, true);
  assert.equal(snapshot.state.visible, true);
  assert.equal(snapshot.state.onLine, true);
  assert.equal(snapshot.incident.state.visible, false, 'later foreground state does not rewrite the fault');
  assert.equal(snapshot.incident.state.onLine, false, 'later connectivity does not rewrite the fault');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.incident)), captured, 'full sanitized exports retain the fault, not later reset state');
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(JSON.stringify(snapshot).includes('media.example'), false);
  const report = h.context.compactPlaybackReport(snapshot);
  assertCompactText(report);
  for (const fact of ['visible', 'onLine']) {
    const changedIncident = {
      ...snapshot,
      incident: { ...snapshot.incident, state: { ...snapshot.incident.state, [fact]: true } },
    };
    assert.notEqual(report, h.context.compactPlaybackReport(changedIncident),
      `compact output must use fault-time ${fact}, not the now-true current state`);
  }
  for (const value of ['recovery-failed', 'media-error', 'suspended', '246.75', '913.25', '910.125', '4321']) {
    assert.ok(report.includes(value), `Stop and rollover must preserve fault-time value ${value}`);
  }
  const deckLine = report.split('\n').find(line => line.includes('246.75'));
  assert.ok(deckLine && /\b2\b/.test(deckLine) && /\b3\b/.test(deckLine) && deckLine.includes('4.5'),
    'the fault-time deck retains readiness, media error and buffered-ahead evidence');
  h.context.recordPlaybackDiagnostic('playback-operation-failed', { errorName: 'NotAllowedError', reason: 'play-rejected' });
  const replacement = h.context.playbackDiagnosticSnapshot().incident;
  assert.equal(replacement.fault.event, 'playback-operation-failed');
  assert.equal(replacement.fault.errorName, 'NotAllowedError');
  assert.equal(replacement.state.active, false);
  assert.equal(replacement.state.visible, true);
  assert.equal(replacement.state.onLine, true);
  assert.ok(replacement.diagnostics.length <= 12);
  assert.equal(replacement.diagnostics.some(entry => entry.event === 'recovery-failed'), false);
  assert.equal(JSON.stringify(replacement).includes('246.75'), false, 'only the latest incident is retained');
  const latest = h.context.compactPlaybackReport(h.context.playbackDiagnosticSnapshot());
  assert.ok(latest.includes('playback-operation-failed'));
  assert.ok(latest.includes('NotAllowedError'));
  assert.equal(latest.includes('recovery-failed'), false);
});

transitionTest('shared speculative preparation records lookup/readiness timing, exact promotion, schedule and completion in order', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  const preparing = h.context.prefetchUpcomingCrossfadeTrack();
  await preparing;
  const readyPlayer = h.players[0];
  const preparedToken = h.state._deckPreparations[1].token;
  const result = h.state._playbackDiagnostics.find(event => event.event === 'preparation-result');
  assert.equal(result.ready, true);
  assert.equal(result.token, preparedToken);
  h.state.pos = 1;
  const played = h.context.playWithCrossfadeDeck(1, true, 2);
  await h.clock.advance(2400);
  assert.equal(await played, true);
  assert.equal(h.state._deckHlsPlayers[1], readyPlayer, 'reuse does not reload the player');
  const events = h.state._playbackDiagnostics.filter(event => event.trackIndex === 1
    || event.incomingIndex === 1).map(event => event.event);
  const ordered = ['preparation-start', 'streams-resolved', 'hls-load', 'hls-manifest', 'hls-attached',
    'hls-first-fragment-loaded', 'hls-first-fragment-buffered', 'preparation-result', 'transition-requested', 'preparation-promoted',
    'preparation-reused', 'fade-trigger', 'fade-scheduled', 'fade-completed'];
  let cursor = -1;
  for (const event of ordered) {
    const next = events.indexOf(event, cursor + 1);
    assert.ok(next > cursor, `${event} follows ${ordered[ordered.indexOf(event) - 1] || 'start'}: ${events}`);
    cursor = next;
  }
  assert.equal(h.state._playbackDiagnosticFault, false);
  const retained = h.state._playbackDiagnostics.length;
  h.context.stopCrossfadeDecks();
  assert.ok(h.state._playbackDiagnostics.length >= retained, 'Stop preserves reports');
});

transitionTest('fade scheduling distinguishes sampled lead from monotonic submission cost', async t => {
  const early = await scheduledFade(t);
  const sampledLead = pairedAutomation ? 'sampledSchedulingLeadMs' : 'schedulingLeadMs';
  assert.equal(early.scheduled()[sampledLead], pairedAutomation ? 128 : 15);
  const late = await scheduledFade(t, { outgoingCostMs: 10, incomingCostMs: 20 });
  assert.equal(late.scheduled()[sampledLead], pairedAutomation ? 98 : -15);
  if (pairedAutomation) {
    assert.equal(late.scheduled().schedulingSubmissionMs, 30);
    assert.equal(late.scheduled().estimatedSchedulingLeadMs, 98);
    assert.equal(Object.hasOwn(late.scheduled(), 'schedulingLeadMs'), false);
  }
  assert.equal(late.scheduled().progressAlreadyAtSchedule, false);
  assert.equal(late.progress().length, 0, 'an advancing audio clock alone is not incoming media progress');
  await early.clock.advance(2400);
  await late.clock.advance(2400);
  assert.equal(await early.completion, true);
  assert.equal(await late.completion, true);
  assert.equal(early.progress().length, 0);
  assert.equal(late.progress().length, 0);
});

transitionTest('incoming first progress is observed once on the existing poll with signed audio-clock timing', async t => {
  const h = await scheduledFade(t, { baselineTime: 4 });
  assert.equal(h.scheduled().incomingBaselineTime, 4);
  assert.equal(h.scheduled().incomingScheduledTime, 4);
  h.incoming.emit('playing');
  await h.clock.advance(160);
  assert.equal(h.progress().length, 0, 'playing and successful play() are not media-clock advancement');
  h.incoming.currentTime = 4.025;
  await h.clock.advance(80);
  assert.equal(h.progress().length, 1);
  const event = h.progress()[0];
  assert.equal(event.progressAlreadyAtSchedule, false);
  assert.equal(event.observationElapsedMs, 240);
  assert.equal(event.audioClockFromFadeStartMs, pairedAutomation ? 112 : 225);
  assert.equal(event.incomingBaselineTime, 4);
  assert.equal(event.incomingScheduledTime, 4);
  assert.equal(event.incomingCurrentTime, 4.025);
  assert.equal(event.incomingAdvanceMs, 25);
  assert.equal(event.token, h.state._deckPrepareTokens[1]);
  assert.equal(event.crossfadeToken, h.schedule.token);
  h.incoming.currentTime = 5;
  await h.clock.advance(2400);
  assert.equal(await h.completion, true);
  assert.equal(h.progress().length, 1, 'later movement and completion never duplicate the first sample');
  assert.equal(h.state._playbackDiagnosticFault, false);
});

transitionTest('media already advanced before scheduling is not mislabeled as delayed startup', async t => {
  const h = await scheduledFade(t, { baselineTime: 4, playAdvance: 0.125 });
  assert.equal(h.scheduled().incomingBaselineTime, 4);
  assert.equal(h.scheduled().incomingScheduledTime, 4.125);
  assert.equal(h.scheduled().progressAlreadyAtSchedule, true);
  assert.equal(h.progress().length, 1);
  const event = h.progress()[0];
  assert.equal(event.progressAlreadyAtSchedule, true, 'first advancement preceded the post-submission sample');
  assert.equal(event.observationElapsedMs, 0, 'zero means observed already running, not zero startup latency');
  assert.equal(event.audioClockFromFadeStartMs, pairedAutomation ? -128 : -15, 'the first sample can precede fade start');
  assert.equal(event.incomingAdvanceMs, 125);
  await h.clock.advance(2400);
  assert.equal(await h.completion, true);
  assert.equal(h.progress().length, 1);
});

transitionTest('pause, seek, rewind, reset and cancelled ownership invalidate pending progress observations', async t => {
  const cases = [
    ['user pause and resume between polls', h => {
      h.context.suspendAudioGraph = async () => true;
      vm.runInContext(extract(source, 'pause'), h.context);
      h.context.pause();
      h.state._userPaused = false;
      h.state._crossfadePausedByUser = false;
      h.incoming.paused = false;
    }],
    ['paused incoming', h => { h.incoming.paused = true; }],
    ['seeking incoming', h => { h.incoming.seeking = true; }],
    ['backward media clock', h => { h.incoming.currentTime = 3; }],
    ['deck reset', h => { h.context.resetDeck(h.incoming, 1); }],
    ['outgoing deck reset', h => { h.context.resetDeck(h.state._decks[0], 0); }],
    ['changed outgoing preparation token', h => { h.state._deckPrepareTokens[0]++; }],
    ['changed preparation token', h => { h.state._deckPrepareTokens[1]++; }],
    ['changed foreground request', h => { h.state._playbackRequest = {}; }],
    ['cancelled crossfade token', h => { h.state._crossfadeToken++; }],
    ['aborted playback', h => { h.state._playbackAbort.abort(); }],
    ['stopped playback', h => { h.context.stopCrossfadeDecks(); }],
  ];
  for (const [name, invalidate] of cases) {
    await t.test(name, async child => {
      const h = await scheduledFade(child, { baselineTime: 4 });
      invalidate(h);
      await h.clock.advance(80);
      h.incoming.paused = false;
      h.incoming.seeking = false;
      h.incoming.currentTime = 4.2;
      await h.clock.advance(160);
      assert.equal(h.progress().length, 0, 'later movement must not revive a stale first-progress sample');
    });
  }
});

transitionTest('a backward reset before scheduling cannot become a later startup-progress report', async t => {
  const h = await scheduledFade(t, { baselineTime: 4, playAdvance: -1 });
  assert.equal(h.scheduled().incomingBaselineTime, 4);
  assert.equal(h.scheduled().incomingScheduledTime, 3);
  assert.equal(Object.hasOwn(h.schedule, 'incomingClockObservation'), false);
  h.incoming.currentTime = 4.2;
  await h.clock.advance(2400);
  assert.equal(await h.completion, true);
  assert.equal(h.progress().length, 0);
});

transitionTest('unsupported monotonic or sampled audio clocks omit measurements without breaking the fade', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  await h.context.prefetchUpcomingCrossfadeTrack();
  h.context.performance = undefined;
  const incoming = h.state._decks[1];
  incoming.paused = false;
  incoming.currentTime = 0.125;
  let unavailable = false;
  Object.defineProperty(h.state._audioContext, 'currentTime', {
    get: () => unavailable ? NaN : h.clock.now() / 1000,
  });
  const gain = h.state._deckAudioGraphs[1].mixGain.gain;
  const rampCount = pairedAutomation ? h.context.crossfadeAutomationPlan(h.state.crossfadeCurve).times.length - 1 : 128;
  let ramps = 0;
  gain.linearRampToValueAtTime = () => { if (++ramps === rampCount) unavailable = true; };
  const completion = h.context.animateDeckCrossfade(h.state._decks[0], incoming, 2, h.state._crossfadeToken, null, 0);
  await h.clock.advance(0);
  const scheduled = h.state._playbackDiagnostics.find(event => event.event === 'fade-scheduled');
  const progress = h.state._playbackDiagnostics.find(event => event.event === 'incoming-clock-progress');
  assert.ok(scheduled);
  assert.ok(progress);
  assert.equal(Object.hasOwn(scheduled, pairedAutomation ? 'sampledSchedulingLeadMs' : 'schedulingLeadMs'), false);
  assert.equal(Object.hasOwn(progress, 'audioClockFromFadeStartMs'), false);
  assert.equal(Object.hasOwn(progress, 'observationElapsedMs'), false);
  assert.equal(progress.progressAlreadyAtSchedule, true);
  assert.equal(progress.incomingAdvanceMs, 125);
  unavailable = false;
  await h.clock.advance(2400);
  assert.equal(await completion, true);
});

transitionTest('transition diagnostics disabled creates neither clock observation nor clock events', async t => {
  const h = await scheduledFade(t, { diagnostics: false, playAdvance: 0.1 });
  assert.equal(Object.hasOwn(h.schedule, 'incomingClockObservation'), false);
  assert.equal(h.scheduled(), undefined);
  h.incoming.currentTime = 1;
  await h.clock.advance(2400);
  assert.equal(await h.completion, true);
  assert.equal(h.progress().length, 0);
});

transitionTest('new measurements survive report export only as bounded finite numeric and boolean fields', () => {
  const h = reportHarness();
  const fields = {
    ...(pairedAutomation
      ? { sampledSchedulingLeadMs: -3.25, estimatedSchedulingLeadMs: -5, schedulingSubmissionMs: 30 }
      : { schedulingLeadMs: -3.25 }),
    observationElapsedMs: 80, audioClockFromFadeStartMs: -15,
    incomingBaselineTime: 4, incomingScheduledTime: 4.1, incomingCurrentTime: 4.2, incomingAdvanceMs: 200,
    progressAlreadyAtSchedule: true,
  };
  h.context.recordTransitionDiagnostic('incoming-clock-progress', {
    ...fields, title: 'SECRET', url: 'https://private.example/SECRET',
    audio: { currentSrc: 'SECRET' }, scheduledAt: 'SECRET',
  });
  const event = h.context.playbackDiagnosticSnapshot().diagnostics[0];
  for (const [key, value] of Object.entries(fields)) assert.equal(event[key], value);
  assert.equal(JSON.stringify(event).includes('SECRET'), false);
  h.context.recordTransitionDiagnostic('incoming-clock-progress', {
    schedulingLeadMs: Infinity, sampledSchedulingLeadMs: Infinity, estimatedSchedulingLeadMs: NaN,
    schedulingSubmissionMs: Infinity, observationElapsedMs: NaN, audioClockFromFadeStartMs: 1e10,
    incomingBaselineTime: 'SECRET', incomingScheduledTime: {}, incomingAdvanceMs: '12',
    progressAlreadyAtSchedule: 'true',
  });
  const invalid = h.context.playbackDiagnosticSnapshot().diagnostics[1];
  for (const key of Object.keys(fields)) assert.equal(Object.hasOwn(invalid, key), false);
});

transitionTest('detached HLS preflight emits only its first fragment, adopts without reloading, and bounds repetitive errors', async t => {
  const h = playbackHarness(t, { autoBuffer: true, duration: 4 });
  installDiagnostics(h.context, h.clock.now);
  h.state.pos = 1;
  const played = h.context.playWithCrossfadeDeck(1, true, 2);
  await h.clock.advance(10);
  const preflight = h.players.find(player => player.url.includes('/2/'));
  assert.ok(preflight && !preflight.media);
  preflight.buffer();
  preflight.buffer();
  await h.clock.advance(2400);
  assert.equal(await played, true);
  assert.equal(h.state._deckHlsPlayers[0], preflight);
  preflight.buffer();
  const observations = () => h.state._playbackDiagnostics.filter(event => event.trackIndex === 2);
  const first = observations().filter(event => event.event === 'hls-first-fragment-loaded');
  assert.equal(first.length, 1);
  assert.equal(first[0].detached, true);
  const buffered = observations().filter(event => event.event === 'hls-first-fragment-buffered');
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0].detached, false, 'MSE buffering follows adoption, not detached download');
  assert.equal(observations().filter(event => event.event === 'hls-adopted').length, 1);
  assert.equal(preflight.sources.length, 1);
  const type = h.context.pageWindow.Hls.Events.ERROR;
  for (let index = 0; index < 30; index++) preflight.emit(type, {
    type: 'networkError', details: 'bufferStalledError', fatal: false,
    response: { code: 503, url: 'https://private.example/SECRET?token=SECRET' }, error: new Error('SECRET'),
  });
  assert.equal(observations().filter(event => event.event === 'hls-error').length, 1);
  for (let index = 0; index < 12; index++) {
    await h.clock.advance(1000);
    preflight.emit(type, { type: 'networkError', details: 'bufferStalledError', fatal: false });
  }
  assert.equal(observations().filter(event => event.event === 'hls-error').length, 8);
  assert.equal(JSON.stringify(observations()).includes('SECRET'), false);
  assert.equal(h.state._playbackDiagnosticFault, false);
});

transitionTest('pending preparation promotion and cancellation correlate the original token without duplicate HLS loads', async t => {
  const h = playbackHarness(t);
  installDiagnostics(h.context, h.clock.now);
  const speculative = h.context.prefetchUpcomingCrossfadeTrack();
  await h.clock.advance(1);
  const token = h.state._deckPreparations[1].token;
  const promoted = h.context.prepareCrossfadeDeck(1, 1, {
    signal: h.state._playbackAbort.signal, foreground: true, isCurrent: () => true,
  });
  const promotion = h.state._playbackDiagnostics.find(event => event.event === 'preparation-promoted');
  assert.equal(promotion.token, token);
  assert.equal(h.players.length, 1);
  h.context.stopCrossfadeDecks();
  assert.equal(await promoted, null);
  await speculative;
  const cancelled = h.state._playbackDiagnostics.find(event => event.event === 'preparation-cancelled');
  assert.equal(cancelled.token, token);
  assert.equal(cancelled.ready, false);
});

transitionTest('media waiting/stalled bursts are bounded and observation listeners do not accumulate on deck reuse', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  h.context.ensureCrossfadeDecks();
  const audio = h.state._decks[0];
  for (let index = 0; index < 100; index++) {
    h.context.ensureCrossfadeDecks();
    audio.emit('waiting'); audio.emit('stalled');
  }
  assert.equal(audio.listenerCount(), 3);
  assert.equal(h.state._playbackDiagnostics.filter(event => event.event.startsWith('media-')).length, 2);
  await h.clock.advance(1000);
  audio.emit('stalled');
  await h.clock.advance(250);
  audio.emit('playing');
  assert.deepEqual(Array.from(h.state._playbackDiagnostics, event => event.event),
    ['media-waiting', 'media-stalled', 'media-stalled', 'media-playing']);
  assert.equal(h.state._playbackDiagnosticFault, false);
});

transitionTest('existing watcher ticks record only conspicuous rate-limited delays with context, not audible-gap faults', async t => {
  const h = watcherHarness({ crossfadeSeconds: 5 });
  installDiagnostics(h.context, h.clock.now);
  h.context.document.visibilityState = 'hidden';
  t.after(() => { h.state.active = false; h.state._watcherCleanup?.(); });
  h.context.startWatcher();
  await h.clock.advance(100);
  assert.equal(h.state._playbackDiagnostics.length, 0, 'normal 50ms ticks do not log');
  h.state.busy = true;
  h.state._userPaused = true;
  h.state._crossfading = true;
  await h.clock.jump(400);
  const delay = h.state._playbackDiagnostics.find(event => event.event === 'watcher-delay');
  assert.ok(delay.delayMs > 250);
  assert.equal(delay.visible, false);
  assert.equal(delay.busy, true);
  assert.equal(delay.userPaused, true);
  assert.equal(delay.crossfading, true);
  assert.equal(delay.readyState, 4);
  await h.clock.jump(400);
  assert.equal(h.state._playbackDiagnostics.length, 1, 'at most one delay per second');
  h.context.document.visibilityState = 'visible';
  await h.clock.jump(700);
  assert.equal(h.state._playbackDiagnostics.length, 2);
  assert.equal(h.state._playbackDiagnostics.at(-1).visible, true);
  assert.equal(h.state._playbackDiagnosticFault, false);
});

transitionTest('fade window is observed once while standby is not ready, then natural-end fallback remains explicit', async t => {
  const h = watcherHarness({ crossfadeSeconds: 5, current: 176 });
  installDiagnostics(h.context, h.clock.now);
  t.after(() => { h.state.active = false; h.state._watcherCleanup?.(); });
  h.context.startWatcher();
  await h.clock.advance(250);
  const windows = h.state._playbackDiagnostics.filter(event => event.event === 'fade-window');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].ready, false);
  assert.equal(windows[0].remainingMs, 4000);
  assert.equal(h.state._playbackDiagnostics.some(event => event.event === 'fade-trigger'), false);
  h.decks[0].ended = true;
  await h.clock.advance(50);
  assert.equal(h.state._playbackDiagnostics.at(-1).event, 'natural-end');
  assert.equal(h.counts.next, 1);
  assert.equal(h.state._playbackDiagnosticFault, false);
});

transitionTest('lookup completion and media readiness expose separate monotonic elapsed times', async t => {
  let resolveLookup;
  const lookup = new Promise(resolve => { resolveLookup = resolve; });
  const h = playbackHarness(t, { resolve: () => lookup });
  installDiagnostics(h.context, h.clock.now);
  const prepared = h.context.prepareCrossfadeDeck(1, 1);
  await h.clock.advance(350);
  assert.equal(h.state._playbackDiagnostics.some(event => event.event === 'streams-resolved'), false);
  resolveLookup(['https://media.example/private/playlist.m3u8?token=PRIVATE']);
  await h.clock.advance(10);
  const streams = h.state._playbackDiagnostics.find(event => event.event === 'streams-resolved');
  assert.equal(streams.elapsedMs, 350);
  assert.equal(streams.streamCandidateCount, 1);
  assert.equal(h.state._playbackDiagnostics.some(event => event.event === 'preparation-result'), false);
  await h.clock.advance(650);
  h.players[0].buffer();
  assert.equal(await prepared, h.state._decks[1]);
  const result = h.state._playbackDiagnostics.find(event => event.event === 'preparation-result');
  assert.equal(result.elapsedMs, 1010);
  assert.equal(result.ready, true);
  assert.equal(result.token, streams.token);
  assert.equal(result.playbackEpoch, streams.playbackEpoch);
  assert.equal(JSON.stringify(h.state._playbackDiagnostics).includes('PRIVATE'), false);
});

transitionTest('a paused outgoing deck records a no-mix handoff without scheduling a fade', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  h.state._decks[0].paused = true;
  h.state.pos = 1;
  assert.equal(await h.context.playWithCrossfadeDeck(1, true, 2), true);
  const noMix = h.state._playbackDiagnostics.find(event => event.event === 'transition-no-mix');
  assert.equal(noMix.trackIndex, 1);
  assert.equal(noMix.outgoingPaused, true);
  assert.equal(noMix.crossfadeDuration, 2);
  assert.equal(h.state._playbackDiagnostics.some(event => event.event === 'fade-scheduled'), false);
  assert.equal(h.state._decks[1].paused, false);
  assert.equal(h.state._playbackDiagnosticFault, false);
});

pairedTest('paired automation interpolates the configured curves within bounded error and native load', t => {
  const h = playbackHarness(t, { autoBuffer: true });
  for (const [curve, knots, maxCalls] of [['clean', 2, 6], ['smooth', 49, 100], ['dj', 51, 104]]) {
    const plan = h.context.crossfadeAutomationPlan(curve);
    assert.equal(plan.times.length, knots);
    assert.equal(plan.outgoing[0], 1);
    assert.equal(plan.incoming[0], 0);
    assert.equal(plan.outgoing.at(-1), 0);
    assert.equal(plan.incoming.at(-1), 1);
    assert.equal(new Set(plan.times).size, knots);
    if (curve === 'dj') {
      assert.ok(plan.times.includes(.5 - .5 / 1.35));
      assert.ok(plan.times.includes(.5 + .5 / 1.35));
    }
    let segment = 0;
    for (let sample = 0; sample <= 20000; sample++) {
      const time = sample / 20000;
      while (segment < knots - 2 && time > plan.times[segment + 1]) segment++;
      const phase = (time - plan.times[segment]) / (plan.times[segment + 1] - plan.times[segment]);
      const outgoing = plan.outgoing[segment] + phase * (plan.outgoing[segment + 1] - plan.outgoing[segment]);
      const incoming = plan.incoming[segment] + phase * (plan.incoming[segment + 1] - plan.incoming[segment]);
      const ideal = h.context.crossfadeGains(time, curve);
      assert.ok(Math.abs(outgoing - ideal[0]) <= .00051, `${curve} outgoing sample ${sample}`);
      assert.ok(Math.abs(incoming - ideal[1]) <= .00051, `${curve} incoming sample ${sample}`);
      assert.ok(outgoing + incoming <= 1 + 1e-12);
    }
    const calls = [];
    const param = deck => ({
      cancelScheduledValues: time => calls.push([deck, 'cancel', time]),
      setValueAtTime: (value, time) => calls.push([deck, 'set', value, time]),
      linearRampToValueAtTime: (value, time) => calls.push([deck, 'ramp', value, time]),
    });
    h.context.schedulePairedCrossfade(param(0), param(1), plan, 10, 2);
    assert.ok(calls.length <= maxCalls);
    assert.deepEqual(calls.slice(0, 4), [[0, 'cancel', 0], [1, 'cancel', 0], [0, 'set', 1, 10], [1, 'set', 0, 10]]);
    for (let index = 4; index < calls.length; index += 2) {
      assert.equal(calls[index][0], 0);
      assert.equal(calls[index + 1][0], 1);
      assert.equal(calls[index][3], calls[index + 1][3], 'paired ramp knots share the exact same time');
      assert.ok(calls[index][3] > (index === 4 ? 10 : calls[index - 2][3]));
    }
    assert.deepEqual(calls.slice(-2), [[0, 'ramp', 0, 12], [1, 'ramp', 1, 12]]);
  }
});

timingTest('cached same-task clocks expose native submission cost rather than a misleading positive raw lead', async t => {
  const h = await scheduledFade(t, { cachedClock: true, outgoingCostMs: 45, incomingCostMs: 45 });
  assert.equal(h.scheduled().sampledSchedulingLeadMs, 128);
  assert.equal(h.scheduled().schedulingSubmissionMs, 90);
  assert.equal(h.scheduled().estimatedSchedulingLeadMs, 38);
  h.schedule.resolve(true);
  assert.equal(await h.completion, true);
});

timingTest('timing compensates monotonic work, stays finite and positive, and never extends the requested end', t => {
  const h = playbackHarness(t, { autoBuffer: true });
  const context = { currentTime: 10, state: 'running' };
  for (const duration of [5, .6, .25, .0001]) {
    for (const elapsed of [0, duration / 4, duration * .99]) {
      const timing = h.context.crossfadeAutomationTiming(context, 10, 1000, duration, 1000 + elapsed * 1000);
      assert.ok(timing);
      assert.ok(Math.abs(timing.endTime - (10 + duration)) < 1e-12);
      assert.ok(Math.abs(timing.estimatedNow - (10 + elapsed)) < 1e-12);
      assert.ok(timing.startTime > timing.estimatedNow);
      assert.ok(timing.duration > 0 && Number.isFinite(timing.duration));
      assert.ok(Math.abs(timing.startTime + timing.duration - timing.endTime) < 1e-12);
    }
  }
  const tiny = h.context.crossfadeAutomationTiming(context, 10, 1000, .25, 1000);
  assert.equal(tiny.lead, .125);
  assert.equal(tiny.duration, .125, 'quarter-second total windows intentionally shorten the active ramp');
  const backwards = h.context.crossfadeAutomationTiming(context, 10, 1000, 5, 500);
  assert.equal(backwards.estimatedNow, 10, 'a backward monotonic reading cannot move the anchor backward');
  context.currentTime = 10.2;
  assert.equal(h.context.crossfadeAutomationTiming(context, 10, 1000, 5, 1100).estimatedNow, 10.2);
  context.currentTime = 10;
  context.state = 'suspended';
  assert.equal(h.context.crossfadeAutomationTiming(context, 10, 1000, 5, 9000).estimatedNow, 10);
  context.state = 'running';
  assert.equal(h.context.crossfadeAutomationTiming(context, 10, 1000, .25, 1300), null);
});

timingTest('real animation charges pre-schedule work and consumed media against outgoing and half-incoming windows', async t => {
  for (const window of [5, .6, .25]) {
    await t.test(`${window}s window`, async child => {
      const h = playbackHarness(child, { autoBuffer: true });
      installDiagnostics(h.context, h.clock.now);
      await h.context.prefetchUpcomingCrossfadeTrack();
      const outgoing = h.state._decks[0], incoming = h.state._decks[1];
      outgoing.duration = 120;
      outgoing.currentTime = 120 - window;
      incoming.duration = window * 2;
      incoming.currentTime = 0;
      incoming.paused = false;
      const anchor = h.state._audioContext.currentTime;
      let work = 0;
      h.context.performance = { now: () => h.clock.now() + work };
      h.context.setCrossfadeStatus = status => { if (status === 'mixing') work += 40; };
      let nativeCalls = 0;
      for (const graph of h.state._deckAudioGraphs) {
        const gain = graph.mixGain.gain;
        for (const method of ['cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']) {
          const original = gain[method];
          gain[method] = function (...args) {
            original.apply(this, args);
            nativeCalls++;
            work += .8;
            if (method === 'linearRampToValueAtTime') {
              assert.ok(args[1] > anchor + work / 1000, 'each ramp knot stays ahead of the native submission clock estimate');
            }
          };
        }
      }
      const result = h.context.animateDeckCrossfade(outgoing, incoming, window, h.state._crossfadeToken);
      await h.clock.advance(0);
      const schedule = h.state._crossfadeSchedule;
      assert.ok(schedule);
      assert.ok(Math.abs(schedule.endTime - anchor - window) < 1e-10);
      assert.ok(schedule.startTime >= anchor + .04);
      assert.ok(schedule.duration > 0 && schedule.duration < window);
      assert.ok(nativeCalls <= 104, 'the real animation has bounded native submission load');
      assert.ok(h.state._playbackDiagnostics.find(event => event.event === 'fade-scheduled').estimatedSchedulingLeadMs > 0);
      schedule.resolve(true);
      assert.equal(await result, true);
    });
  }
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  await h.context.prefetchUpcomingCrossfadeTrack();
  h.state._decks[0].currentTime = 119.7;
  h.state._decks[1].duration = 1.2;
  h.state._decks[1].currentTime = .1;
  h.state._decks[1].paused = false;
  const anchor = h.state._audioContext.currentTime;
  const result = h.context.animateDeckCrossfade(h.state._decks[0], h.state._decks[1], 5, h.state._crossfadeToken);
  await h.clock.advance(0);
  assert.ok(Math.abs(h.state._crossfadeSchedule.endTime - anchor - .3) < 1e-10, 'fresh outgoing remaining limits stale requested fades');
  h.state._crossfadeSchedule.resolve(true);
  assert.equal(await result, true);
  h.state._decks[0].paused = false;
  h.state._decks[0].currentTime = 0;
  const incomingLimited = h.context.animateDeckCrossfade(h.state._decks[0], h.state._decks[1], 5, h.state._crossfadeToken);
  await h.clock.advance(0);
  assert.ok(Math.abs(h.state._crossfadeSchedule.endTime - anchor - .5) < 1e-10, 'incoming playback consumption is deducted from its half-duration budget');
  h.state._crossfadeSchedule.resolve(true);
  assert.equal(await incomingLimited, true);
});

timingTest('exhausted overlap uses existing handoff recovery without discarding the playing incoming track', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  await h.context.prefetchUpcomingCrossfadeTrack();
  let work = 0;
  h.context.performance = { now: () => h.clock.now() + work };
  h.context.setCrossfadeStatus = status => { if (status === 'mixing') work += 500; };
  h.state.pos = 1;
  assert.equal(await h.context.playWithCrossfadeDeck(1, true, .25), true);
  assert.equal(h.state._deckTrack, 1);
  assert.equal(h.state._decks[1].paused, false);
  assert.equal(h.state._decks[0].paused, true);
  assert.equal(h.state._crossfadeSchedule, null);
  assert.deepEqual(h.played, [1]);
  assert.equal(h.state._playbackDiagnostics.some(event => event.event === 'fade-scheduled'), false);
  assert.ok(h.state._playbackDiagnostics.some(event => event.event === 'fade-fallback' && event.recoveredSchedule));
});

timingTest('pending resume never commits automation after abort, stop, pause, or ownership replacement', async t => {
  for (const [name, invalidate] of [
    ['abort', h => h.state._playbackAbort.abort()],
    ['stop', h => h.context.stopCrossfadeDecks()],
    ['pause', h => { h.state._userPaused = true; }],
    ['replace context', h => { h.state._audioContext = { currentTime: 0, state: 'running' }; }],
    ['replace request', h => { h.state._playbackRequest = {}; }],
  ]) {
    await t.test(name, async child => {
      const h = playbackHarness(child, { autoBuffer: true });
      installDiagnostics(h.context, h.clock.now);
      await h.context.prefetchUpcomingCrossfadeTrack();
      let resume;
      h.context.resumeAudioGraph = () => new Promise(resolve => { resume = resolve; });
      h.state._decks[1].paused = false;
      const result = h.context.animateDeckCrossfade(h.state._decks[0], h.state._decks[1], 2, h.state._crossfadeToken);
      invalidate(h);
      resume(true);
      assert.equal(await result, null);
      assert.equal(h.state._crossfadeSchedule, null);
      assert.equal(h.state._playbackDiagnostics.some(event => event.event === 'fade-scheduled'), false);
    });
  }
});

timingTest('a pause and resume while graph resume is pending reanchors without charging suspended wall time', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  await h.context.prefetchUpcomingCrossfadeTrack();
  let resume;
  let wall = 0;
  let audioClock = h.state._audioContext.currentTime;
  const initialAudioClock = audioClock;
  Object.defineProperty(h.state._audioContext, 'currentTime', { get: () => audioClock });
  h.context.performance = { now: () => h.clock.now() + wall };
  h.context.resumeAudioGraph = () => new Promise(resolve => { resume = resolve; });
  h.context.suspendAudioGraph = async () => true;
  vm.runInContext(extract(source, 'pause'), h.context);
  h.state._decks[1].paused = false;
  const result = h.context.animateDeckCrossfade(h.state._decks[0], h.state._decks[1], .6, h.state._crossfadeToken);
  h.context.pause();
  audioClock += .1;
  wall += 5000;
  h.state._userPaused = false;
  h.state._crossfadePausedByUser = false;
  h.state._decks.forEach(deck => { deck.paused = false; });
  resume(true);
  await h.clock.advance(0);
  const schedule = h.state._crossfadeSchedule;
  assert.ok(schedule, 'the resumed fade still has its valid audio-clock window');
  assert.ok(Math.abs(schedule.endTime - initialAudioClock - .6) < 1e-10, 'running audio consumed before pause does not extend the original end');
  schedule.resolve(true);
  assert.equal(await result, true);
});

timingTest('initially suspended contexts start timing from successful resume, not paused wall time', async t => {
  const h = playbackHarness(t, { autoBuffer: true });
  installDiagnostics(h.context, h.clock.now);
  await h.context.prefetchUpcomingCrossfadeTrack();
  const context = h.state._audioContext;
  const audioClock = context.currentTime;
  Object.defineProperty(context, 'currentTime', { get: () => audioClock });
  context.state = 'suspended';
  let resume;
  let work = 0;
  h.context.performance = { now: () => h.clock.now() + work };
  h.context.resumeAudioGraph = () => new Promise(resolve => { resume = resolve; });
  h.state._decks[1].paused = false;
  const result = h.context.animateDeckCrossfade(h.state._decks[0], h.state._decks[1], .25, h.state._crossfadeToken);
  work += 5000;
  context.state = 'running';
  resume(true);
  await h.clock.advance(0);
  assert.ok(h.state._crossfadeSchedule);
  assert.ok(Math.abs(h.state._crossfadeSchedule.endTime - audioClock - .25) < 1e-10);
  h.state._crossfadeSchedule.resolve(true);
  assert.equal(await result, true);
});

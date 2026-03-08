// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      3.0.0
// @description  Replaces SoundCloud's broken shuffle with a real one. Loads all tracks, shuffles them properly using Fisher-Yates, and works in background tabs.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const state = {
    active: false,
    autoRepeat: true,
    shuffledQueue: [],
    currentQueuePos: 0,
    trackEls: [],
    worker: null,
    transitioning: false,
    lastTrackTitle: '',
  };

  // Web Worker runs in its own thread — unaffected by background tab throttling
  function createWorker() {
    const code = `
      let interval = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (interval) clearInterval(interval);
          interval = setInterval(() => self.postMessage('tick'), 800);
        } else if (e.data === 'stop') {
          if (interval) clearInterval(interval);
          interval = null;
        }
      };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  }

  // Fisher-Yates shuffle
  function shuffle(array) {
    const a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function getPlayerTitle() {
    const sels = [
      '.playbackSoundBadge__titleLink',
      '.playbackSoundBadge a[title]',
      '.playerTrackName',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el.textContent.trim();
    }
    return '';
  }

  function getTimePassed() {
    const el = document.querySelector('.playbackTimeline__timePassed');
    return el ? el.textContent.trim() : '';
  }

  function getDuration() {
    const el = document.querySelector('.playbackTimeline__duration');
    return el ? el.textContent.trim() : '';
  }

  // Scroll to bottom repeatedly to force-load all lazy tracks
  async function loadAllTracks(statusEl) {
    let lastCount = 0;
    let stableRounds = 0;

    while (stableRounds < 3) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
      const tracks = document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item');
      const count = tracks.length;
      if (statusEl) statusEl.textContent = `⏳ Loading tracks… (${count} found)`;
      if (count === lastCount) stableRounds++;
      else { stableRounds = 0; lastCount = count; }
    }

    window.scrollTo(0, 0);
    await sleep(400);
    return Array.from(document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item'));
  }

  async function playTrackAtIndex(idx) {
    const el = state.trackEls[idx];
    if (!el) return;

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(300);

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(150);

    const btn = el.querySelector([
      'button.sc-button-play',
      '.playButton',
      'button[title*="Play"]',
      '.trackItem__coverArt',
      '.sound__coverArt',
    ].join(', '));

    if (btn) {
      btn.click();
    } else {
      const title = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
      if (title) title.click();
    }

    const before = state.lastTrackTitle;
    let waited = 0;
    while (waited < 4000) {
      await sleep(300);
      waited += 300;
      const current = getPlayerTitle();
      if (current && current !== before) break;
    }

    state.lastTrackTitle = getPlayerTitle();
  }

  async function playNext(statusEl) {
    if (state.transitioning) return;
    state.transitioning = true;

    state.currentQueuePos++;

    if (state.currentQueuePos >= state.shuffledQueue.length) {
      if (!state.autoRepeat) {
        stopShuffle();
        if (statusEl) statusEl.textContent = '✅ All tracks played.';
        const btn = document.getElementById('tss-btn');
        if (btn) btn.textContent = '🔀 True Shuffle';
        state.transitioning = false;
        return;
      }
      state.shuffledQueue = shuffle(state.shuffledQueue);
      state.currentQueuePos = 0;
      if (statusEl) statusEl.textContent = '🔁 New round…';
    }

    const nextIdx = state.shuffledQueue[state.currentQueuePos];
    await playTrackAtIndex(nextIdx);
    updateBadges();

    const pos = state.currentQueuePos + 1;
    const total = state.shuffledQueue.length;
    if (statusEl) statusEl.textContent = `▶ ${pos} / ${total}`;

    state.transitioning = false;
  }

  function startWatcher(statusEl) {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }

    state.lastTrackTitle = getPlayerTitle();
    let lastTitle = state.lastTrackTitle;
    let endTicks = 0;
    let titleChangeTicks = 0;

    const worker = createWorker();
    state.worker = worker;

    worker.onmessage = async () => {
      if (!state.active || state.transitioning) return;

      const currentTitle = getPlayerTitle();
      const timePassed = getTimePassed();
      const duration = getDuration();

      // SoundCloud switched track on its own — override with our queue
      if (currentTitle && lastTitle && currentTitle !== lastTitle) {
        titleChangeTicks++;
        if (titleChangeTicks >= 2) {
          titleChangeTicks = 0;
          lastTitle = currentTitle;
          await playNext(statusEl);
          lastTitle = getPlayerTitle();
        }
        return;
      } else {
        titleChangeTicks = 0;
      }

      // Track finished (position == duration)
      if (duration && timePassed && duration === timePassed && duration !== '0:00') {
        endTicks++;
        if (endTicks >= 2) {
          endTicks = 0;
          await playNext(statusEl);
          lastTitle = getPlayerTitle();
        }
      } else {
        endTicks = 0;
      }

      if (currentTitle) lastTitle = currentTitle;
    };

    worker.postMessage('start');
  }

  async function doShuffle(btn, statusEl) {
    if (state.active) {
      stopShuffle();
      btn.textContent = '🔀 True Shuffle';
      if (statusEl) statusEl.textContent = '';
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Loading…';

    const trackEls = await loadAllTracks(statusEl);
    const total = trackEls.length;

    if (total === 0) {
      if (statusEl) statusEl.textContent = '❌ No tracks found';
      btn.textContent = '🔀 True Shuffle';
      btn.disabled = false;
      return;
    }

    state.trackEls = trackEls;
    state.shuffledQueue = shuffle(Array.from({ length: total }, (_, i) => i));
    state.currentQueuePos = 0;
    state.active = true;
    state.transitioning = false;

    btn.textContent = '⏹ Stop Shuffle';
    btn.disabled = false;

    await playTrackAtIndex(state.shuffledQueue[0]);
    updateBadges();
    if (statusEl) statusEl.textContent = `▶ 1 / ${total}`;

    startWatcher(statusEl);
  }

  function stopShuffle() {
    state.active = false;
    state.transitioning = false;
    if (state.worker) {
      state.worker.postMessage('stop');
      state.worker.terminate();
      state.worker = null;
    }
    document.querySelectorAll('.tss-badge').forEach(b => b.remove());
  }

  function updateBadges() {
    document.querySelectorAll('.tss-badge').forEach(b => b.remove());

    state.shuffledQueue.forEach((trackIdx, queuePos) => {
      const el = state.trackEls[trackIdx];
      if (!el) return;

      const badge = document.createElement('span');
      badge.className = 'tss-badge';
      const isCurrent = queuePos === state.currentQueuePos;
      badge.style.cssText = `
        display:inline-block;
        background:${isCurrent ? '#f50' : '#2a2a2a'};
        color:${isCurrent ? '#fff' : '#888'};
        border-radius:3px;font-size:10px;
        padding:1px 5px;margin-right:5px;
        font-weight:bold;vertical-align:middle;
        border:1px solid ${isCurrent ? '#f50' : '#444'};
      `;
      badge.textContent = isCurrent ? `▶ ${queuePos + 1}` : `${queuePos + 1}`;

      const titleEl = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
      if (titleEl && !el.querySelector('.tss-badge')) {
        titleEl.parentNode.insertBefore(badge, titleEl);
      }
    });
  }

  function createUI() {
    const wrapper = document.createElement('div');
    wrapper.id = 'tss-wrapper';
    wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap;';

    const btn = document.createElement('button');
    btn.id = 'tss-btn';
    btn.textContent = '🔀 True Shuffle';
    btn.style.cssText = `
      background:#f50;color:#fff;border:none;border-radius:4px;
      padding:6px 14px;font-size:13px;font-weight:bold;cursor:pointer;transition:background 0.2s;
    `;
    btn.onmouseenter = () => { if (!btn.disabled) btn.style.background = '#e64a00'; };
    btn.onmouseleave = () => { if (!btn.disabled) btn.style.background = '#f50'; };

    const repeatLabel = document.createElement('label');
    repeatLabel.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;color:#ccc;cursor:pointer;user-select:none;';
    const repeatCheckbox = document.createElement('input');
    repeatCheckbox.type = 'checkbox';
    repeatCheckbox.checked = state.autoRepeat;
    repeatCheckbox.style.accentColor = '#f50';
    repeatCheckbox.onchange = () => { state.autoRepeat = repeatCheckbox.checked; };
    repeatLabel.appendChild(repeatCheckbox);
    repeatLabel.appendChild(document.createTextNode('Auto-Repeat'));

    const statusEl = document.createElement('span');
    statusEl.id = 'tss-status';
    statusEl.style.cssText = 'font-size:12px;color:#999;';

    btn.onclick = () => doShuffle(btn, statusEl);
    wrapper.appendChild(btn);
    wrapper.appendChild(repeatLabel);
    wrapper.appendChild(statusEl);
    return wrapper;
  }

  async function injectButton() {
    if (document.getElementById('tss-wrapper')) return;

    const selectors = [
      '.sc-list-actions', '.listenEngagement__actions', '.trackList__tracksActions',
      '.userMain__content .sc-button-toolbar', '.soundActions', '.playlist__controls',
      '.userBadge__info', '.playlist__trackList', '.soundList', '.trackList',
    ];

    let container = null;
    for (const sel of selectors) {
      container = document.querySelector(sel);
      if (container) break;
    }
    if (!container) return;
    container.prepend(createUI());
  }

  let lastUrl = location.href;

  function isValidPage() {
    return /soundcloud\.com\/[^/]+\/(sets\/|likes|tracks|reposts)/.test(location.href);
  }

  async function onNavigate() {
    if (state.active) stopShuffle();
    await sleep(1500);
    if (isValidPage()) injectButton();
  }

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }).observe(document, { subtree: true, childList: true });

  onNavigate();

})();

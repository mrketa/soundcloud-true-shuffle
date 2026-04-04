// ── Mini player ───────────────────────────────────────────────────────────────

// Build the floating mini-player widget and attach all its event handlers.
function mkMiniPlayer() {
  if (document.getElementById('tss-mini')) return;

  const mini = document.createElement('div');
  mini.id = 'tss-mini';
  mini.style.cssText = `
    position:fixed; bottom:60px; right:20px;
    width:220px; min-width:220px; max-width:400px;
    background:#111; border:1px solid #222; border-radius:10px;
    padding:10px 12px; z-index:99996;
    font-family:-apple-system,sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,0.7);
    display:flex; flex-direction:column; gap:8px;
    overflow:hidden; cursor:default;
  `;

  mini.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;">
      <div id="tss-mini-art" style="width:40px;height:40px;border-radius:6px;background:#1a1a1a;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:18px;color:#333;">♪</div>
      <div style="overflow:hidden;flex:1;display:flex;flex-direction:column;gap:3px;">
        <div id="tss-mini-title"  style="color:#fff;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">—</div>
        <div id="tss-mini-artist" style="color:#555;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">—</div>
      </div>
      <span id="tss-mini-close" style="color:#444;cursor:pointer;font-size:16px;flex-shrink:0;align-self:flex-start;line-height:1;">×</span>
    </div>
    <div id="tss-mini-extra" style="display:none;flex-direction:column;gap:4px;border-top:1px solid #1a1a1a;padding-top:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="color:#555;font-size:10px;flex-shrink:0;">next up</span>
        <span id="tss-mini-nextup" style="color:#bbb;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;text-align:right;min-width:0;">—</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#555;font-size:10px;">queue</span>
        <span id="tss-mini-queuepos" style="color:#bbb;font-size:10px;">—</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;">
      <button id="tss-mini-prev"  style="background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;">⏮</button>
      <button id="tss-mini-play"  style="background:#f50;border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:13px;">⏸</button>
      <button id="tss-mini-next"  style="background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;">⏭</button>
      <button id="tss-mini-stats" style="background:none;border:none;color:#555;font-size:12px;cursor:pointer;padding:2px 4px;" title="stats">📊</button>
    </div>
    <div id="tss-mini-seekbar" style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;cursor:pointer;" title="click to seek">
      <div id="tss-mini-progress" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
    </div>
    <div id="tss-mini-rzl" style="position:absolute;bottom:0;left:0;width:14px;height:14px;cursor:sw-resize;display:flex;align-items:flex-end;justify-content:flex-start;padding:2px;opacity:0.4;font-size:9px;color:#666;">◤</div>
    <div id="tss-mini-rzr" style="position:absolute;bottom:0;right:0;width:14px;height:14px;cursor:se-resize;display:flex;align-items:flex-end;justify-content:flex-end;padding:2px;opacity:0.4;font-size:9px;color:#666;">◥</div>
  `;

  document.body.appendChild(mini);

  const st = () => document.getElementById('tss-status');

  document.getElementById('tss-mini-play').onclick  = toggle;
  document.getElementById('tss-mini-next').onclick  = () => { state.manualAction = true; next(st()); };
  document.getElementById('tss-mini-prev').onclick  = () => prevTrack(st());
  document.getElementById('tss-mini-stats').onclick = showStats;

  document.getElementById('tss-mini-seekbar').onclick = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  };

  // Collapse to a small tab when closed.
  document.getElementById('tss-mini-close').onclick = () => {
    mini.style.display = 'none';
    let tab = document.getElementById('tss-mini-tab');
    if (!tab) {
      tab = document.createElement('div');
      tab.id = 'tss-mini-tab';
      tab.style.cssText = `
        position:fixed; bottom:60px; right:20px;
        background:#111; border:1px solid #222; border-radius:8px;
        padding:6px 10px; z-index:99996;
        font-family:-apple-system,sans-serif;
        display:flex; align-items:center; gap:8px;
        cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.6);
      `;
      tab.innerHTML = `
        <span style="font-size:13px;">🔀</span>
        <span id="tss-mini-tab-title" style="color:#ccc;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">—</span>
      `;
      tab.onclick = () => { mini.style.display = 'flex'; tab.style.display = 'none'; updateMiniPlayer(); };
      document.body.appendChild(tab);
    }
    const m = state.meta[state.queue?.[state.pos]];
    const t = document.getElementById('tss-mini-tab-title');
    if (t && m) t.textContent = m.title;
    tab.style.display = 'flex';
  };

  // Drag — only on the player body, not on buttons or resize handles.
  mini.onmousedown = e => {
    const ignore = ['BUTTON', 'SPAN', 'INPUT'];
    if (ignore.includes(e.target.tagName)) return;
    if (e.target.id === 'tss-mini-rzl' || e.target.id === 'tss-mini-rzr') return;

    e.preventDefault();
    const rect    = mini.getBoundingClientRect();
    let curLeft   = rect.left;
    let curTop    = rect.top;
    mini.style.left   = curLeft + 'px';
    mini.style.top    = curTop  + 'px';
    mini.style.right  = 'auto';
    mini.style.bottom = 'auto';
    // If the user drags manually, clear the auto-shifted flag.
    delete mini.dataset.autoShifted;

    const startX = e.clientX, startY = e.clientY;
    const move = ev => {
      curLeft = Math.max(0, Math.min(window.innerWidth  - mini.offsetWidth,  rect.left + (ev.clientX - startX)));
      curTop  = Math.max(0, Math.min(window.innerHeight - mini.offsetHeight, rect.top  + (ev.clientY - startY)));
      mini.style.left = curLeft + 'px';
      mini.style.top  = curTop  + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup',   up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };

  // Resize handles — change width only, never position.
  const addResize = (handleId, growLeft) => {
    const handle = document.getElementById(handleId);
    if (!handle) return;
    handle.onmousedown = e => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startW = mini.offsetWidth;
      const move = ev => {
        const delta = growLeft ? (startX - ev.clientX) : (ev.clientX - startX);
        const newW  = Math.max(220, Math.min(400, startW + delta));
        mini.style.width = newW + 'px';
        const extra = document.getElementById('tss-mini-extra');
        if (extra) extra.style.display = newW > 280 ? 'flex' : 'none';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup',   up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup',   up);
    };
  };

  addResize('tss-mini-rzl', true);
  addResize('tss-mini-rzr', false);
}

// Sync mini-player display with current playback state.
function updateMiniPlayer() {
  const mini = document.getElementById('tss-mini');

  // If the player is hidden, just update the collapsed tab title.
  if (!mini || mini.style.display === 'none') {
    const tab = document.getElementById('tss-mini-tab');
    const m   = state.meta[state.queue?.[state.pos]];
    const t   = document.getElementById('tss-mini-tab-title');
    if (tab && tab.style.display !== 'none' && m && t) t.textContent = m.title;
    return;
  }

  const el = id => document.getElementById(id);

  if (state.suspended) {
    // An external (non-queue) track is playing.  Show what SC is actually
    // playing and indicate where the queue will resume.
    const extTitle = playerTitle() || '—';
    const nextTi   = state.queue[state.pos];
    const nextM    = nextTi !== undefined ? state.meta[nextTi] : null;

    if (el('tss-mini-title'))    el('tss-mini-title').textContent    = extTitle;
    if (el('tss-mini-artist'))   el('tss-mini-artist').textContent   = '↩ not in queue';
    if (el('tss-mini-play'))     el('tss-mini-play').textContent     = paused() ? '▶' : '⏸';
    if (el('tss-mini-nextup'))   el('tss-mini-nextup').textContent   = nextM ? `${nextM.artist} — ${nextM.title}` : '—';
    if (el('tss-mini-queuepos')) el('tss-mini-queuepos').textContent = `resume at ${state.stats.played + 1} / ${state.queue.length}`;

    // Show artwork from SC's player bar (the external track's artwork).
    const extArtwork = playerArtwork();
    const art = el('tss-mini-art');
    if (art) {
      if (extArtwork && art.dataset.src !== extArtwork) {
        art.dataset.src = extArtwork;
        art.innerHTML   = '';
        const img = document.createElement('img');
        img.src           = extArtwork;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        img.onerror       = () => { art.innerHTML = '♪'; };
        art.appendChild(img);
      } else if (!extArtwork && art.dataset.src) {
        delete art.dataset.src;
        art.innerHTML = '♪';
      }
    }
    return;
  }

  // Normal mode: use playerTitle() as source of truth so the display stays
  // in sync with what SoundCloud is actually playing, not just our state.
  const currentTitle = playerTitle();
  const m = state.meta[state.queue?.[state.pos]];

  if (el('tss-mini-title'))  el('tss-mini-title').textContent  = currentTitle || m?.title  || '—';
  if (el('tss-mini-artist')) el('tss-mini-artist').textContent = m?.artist || '—';
  if (el('tss-mini-play'))   el('tss-mini-play').textContent   = paused() ? '▶' : '⏸';

  // Update artwork only when it changes to avoid thrashing the DOM.
  const art = el('tss-mini-art');
  if (art && m?.artwork && art.dataset.src !== m.artwork) {
    art.dataset.src = m.artwork;
    art.innerHTML   = '';
    const img = document.createElement('img');
    img.src           = m.artwork;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.onerror       = () => { art.innerHTML = '♪'; };
    art.appendChild(img);
  }

  const nextTi = state.queue[state.pos + 1];
  const nextM  = nextTi !== undefined ? state.meta[nextTi] : null;
  if (el('tss-mini-nextup'))   el('tss-mini-nextup').textContent   = nextM ? `${nextM.artist} — ${nextM.title}` : 'end of queue';
  if (el('tss-mini-queuepos')) el('tss-mini-queuepos').textContent = `${state.stats.played} / ${state.queue.length}`;
}

// Shift the mini-player left when the sidebar opens so they don't overlap;
// restore its anchored position when the sidebar closes.
// Uses data-autoShifted to distinguish auto-moved elements from user-dragged ones.
function shiftMiniPlayer(sidebarOpen) {
  const mini = document.getElementById('tss-mini');
  const tab  = document.getElementById('tss-mini-tab');

  [mini, tab].forEach(el => {
    if (!el || el.style.display === 'none') return;

    if (sidebarOpen) {
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth - 308) {
        el.dataset.autoShifted = '1';
        el.style.left   = (window.innerWidth - 320 - el.offsetWidth) + 'px';
        el.style.top    = rect.top + 'px';
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
      }
    } else if (el.dataset.autoShifted) {
      // Only restore elements we auto-shifted, not ones the user dragged.
      delete el.dataset.autoShifted;
      el.style.left   = '';
      el.style.top    = '';
      el.style.right  = '20px';
      el.style.bottom = '60px';
    }
  });
}

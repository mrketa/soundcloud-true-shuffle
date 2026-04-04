// Hub — central floating panel. Draggable, collapsible sections.
// Remove: delete file, remove mkHub() from inject.js, remove updateHub() call sites.

function mkHub() {
  if (document.getElementById('tss-hub')) return;

  if (!document.getElementById('tss-hub-style')) {
    const s = document.createElement('style');
    s.id = 'tss-hub-style';
    s.textContent = `
      .tss-hub-sh {
        display:flex; align-items:center; justify-content:space-between;
        padding:6px 12px; cursor:pointer;
        font-size:9px; color:#444;
        text-transform:uppercase; letter-spacing:0.07em;
        border-bottom:1px solid #1a1a1a;
      }
      .tss-hub-sh:hover { background:rgba(255,255,255,0.02); }
      .tss-hub-arr { font-size:9px; color:#333; transition:transform 0.15s; }
      .tss-hub-sec { border-top:1px solid #1a1a1a; }
      #tss-hub-start { transition:background 0.2s, color 0.2s, border-color 0.2s; }
      #tss-hub-start[data-active="true"] {
        background:#f50 !important; color:#fff !important; border-color:transparent !important;
      }
      #tss-hub-start[data-active="true"]:hover { background:#e64a00 !important; }
      #tss-hub-start:not([data-active="true"]):not([data-loading="true"]):hover {
        background:rgba(255,85,0,0.1) !important; border-color:#f50 !important;
      }
      #tss-hub-start[data-loading="true"] {
        color:#555 !important; border-color:#1e1e1e !important;
        cursor:not-allowed !important;
        animation:tss-pulse 1.2s ease-in-out infinite;
      }
      #tss-hub-qico {
        font-size:10px; color:#555; cursor:pointer;
        padding:2px 7px; border-radius:3px;
        background:#1a1a1a; border:1px solid #2a2a2a;
        transition:color 0.15s, background 0.15s, border-color 0.15s;
        line-height:1.6; flex-shrink:0;
      }
      #tss-hub-qico:hover { color:#bbb; border-color:#444; }
      #tss-hub-qico[data-open="true"] {
        color:#f50; background:rgba(255,85,0,0.08); border-color:rgba(255,85,0,0.35);
      }
    `;
    document.head.appendChild(s);
  }

  const hub = document.createElement('div');
  hub.id = 'tss-hub';
  hub.style.cssText = `
    position:fixed; bottom:60px; left:20px; width:230px;
    background:#111; border:1px solid #222; border-radius:10px;
    z-index:99994; font-family:-apple-system,sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,0.7);
    overflow:hidden; -webkit-user-select:none; user-select:none;
  `;

  hub.innerHTML = `
    <div id="tss-hub-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#0d0d0d;cursor:move;">
      <span style="color:#f50;font-size:12px;font-weight:700;letter-spacing:0.02em;">♫ True Shuffle</span>
      <span id="tss-hub-col" style="color:#555;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;" title="collapse">−</span>
    </div>

    <div id="tss-hub-body">

      <div id="tss-hub-s-np" class="tss-hub-sec" style="display:none;">
        <div class="tss-hub-sh" data-body="tss-hub-s-np-b">
          <span>now playing</span><span class="tss-hub-arr">▾</span>
        </div>
        <div id="tss-hub-s-np-b" style="padding:10px 12px 12px;">
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
            <div id="tss-hub-art" style="width:40px;height:40px;border-radius:5px;background:#1a1a1a;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:18px;color:#333;">♪</div>
            <div style="overflow:hidden;flex:1;min-width:0;">
              <div id="tss-hub-title" style="color:#fff;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;">—</div>
              <div id="tss-hub-artist" style="color:#555;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;line-height:1.4;">—</div>
            </div>
          </div>
          <div id="tss-hub-seekbar" style="height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;cursor:pointer;" title="seek">
            <div id="tss-hub-prog" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
          </div>
        </div>
      </div>

      <div id="tss-hub-s-ctrl" class="tss-hub-sec" style="display:none;">
        <div class="tss-hub-sh" data-body="tss-hub-s-ctrl-b">
          <span>controls</span><span class="tss-hub-arr">▾</span>
        </div>
        <div id="tss-hub-s-ctrl-b" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 12px 12px;">
          <button id="tss-hub-prev"  style="background:#1a1a1a;border:none;color:#aaa;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:13px;">⏮</button>
          <button id="tss-hub-play"  style="background:#f50;border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer;font-size:16px;">⏸</button>
          <button id="tss-hub-next"  style="background:#1a1a1a;border:none;color:#aaa;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:13px;">⏭</button>
          <button id="tss-hub-stats" style="background:none;border:none;color:#555;cursor:pointer;font-size:13px;padding:4px;" title="session stats">📊</button>
        </div>
      </div>

      <div id="tss-hub-s-queue" class="tss-hub-sec" style="display:none;">
        <div class="tss-hub-sh" data-body="tss-hub-s-queue-b">
          <span>queue</span>
          <div style="display:flex;align-items:center;gap:4px;">
            <span id="tss-hub-qico" data-open="false" title="toggle queue panel">→</span>
            <span class="tss-hub-arr">▾</span>
          </div>
        </div>
        <div id="tss-hub-s-queue-b" style="padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#555;font-size:10px;">played</span>
            <span id="tss-hub-qpos" style="color:#bbb;font-size:10px;">—</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="color:#555;font-size:10px;flex-shrink:0;">next</span>
            <span id="tss-hub-nextup" style="color:#bbb;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;text-align:right;min-width:0;">—</span>
          </div>
        </div>
      </div>

      <div id="tss-hub-s-shuffle" class="tss-hub-sec">
        <div class="tss-hub-sh" data-body="tss-hub-s-shuffle-b">
          <span>shuffle</span><span class="tss-hub-arr">▾</span>
        </div>
        <div id="tss-hub-s-shuffle-b" style="padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;">
          <button id="tss-hub-start" data-active="false" data-loading="false" style="
            background:#111; color:#f50;
            border:1px solid rgba(255,85,0,0.35); border-radius:6px;
            padding:7px 10px; font-size:11px; font-weight:600;
            font-family:-apple-system,sans-serif; cursor:pointer; width:100%;
          ">True Shuffle</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:10px;color:#555;cursor:pointer;">
            <input id="tss-hub-repeat" type="checkbox" style="accent-color:#f50;">
            repeat
          </label>
        </div>
      </div>

    </div>
  `;

  document.body.appendChild(hub);

  document.getElementById('tss-hub-play').onclick  = toggle;
  document.getElementById('tss-hub-prev').onclick  = () => prevTrack();
  document.getElementById('tss-hub-next').onclick  = () => { state.manualAction = true; next(); };
  document.getElementById('tss-hub-stats').onclick = showStats;
  document.getElementById('tss-hub-seekbar').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  };

  document.getElementById('tss-hub-qico').onclick = e => { e.stopPropagation(); toggleSidebar(); };

  const hubRepeat = document.getElementById('tss-hub-repeat');
  hubRepeat.checked  = state.autoRepeat;
  hubRepeat.onchange = () => { state.autoRepeat = hubRepeat.checked; };

  document.getElementById('tss-hub-start').onclick = () => { if (!state.loading) start(); };

  const colBtn  = document.getElementById('tss-hub-col');
  const hubBody = document.getElementById('tss-hub-body');
  colBtn.onclick = () => {
    const open            = hubBody.style.display !== 'none';
    hubBody.style.display = open ? 'none' : '';
    colBtn.textContent    = open ? '+' : '−';
  };

  hub.querySelectorAll('.tss-hub-sh').forEach(sh => {
    sh.onclick = () => {
      const b   = document.getElementById(sh.dataset.body);
      const arr = sh.querySelector('.tss-hub-arr');
      if (!b) return;
      const open = b.style.display !== 'none';
      b.style.display              = open ? 'none' : '';
      if (arr) arr.style.transform = open ? 'rotate(-90deg)' : '';
    };
  });

  const hubHdr = document.getElementById('tss-hub-hdr');
  hubHdr.onmousedown = e => {
    if (e.target.id === 'tss-hub-col') return;
    e.preventDefault();
    const rect = hub.getBoundingClientRect();
    hub.style.left   = rect.left + 'px';
    hub.style.top    = rect.top  + 'px';
    hub.style.bottom = 'auto';
    hub.style.right  = 'auto';
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    const move = ev => {
      hub.style.left = Math.max(0, Math.min(window.innerWidth  - hub.offsetWidth,  ev.clientX - ox)) + 'px';
      hub.style.top  = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, ev.clientY - oy)) + 'px';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };

  updateHub();
}

function updateHub() {
  if (!document.getElementById('tss-hub')) return;

  const active  = state.active;
  const loading = state.loading;

  ['tss-hub-s-np', 'tss-hub-s-ctrl', 'tss-hub-s-queue'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = active ? '' : 'none';
  });

  const startBtn = document.getElementById('tss-hub-start');
  if (startBtn) {
    if (loading) {
      startBtn.textContent     = '⏳ loading…';
      startBtn.dataset.active  = 'false';
      startBtn.dataset.loading = 'true';
    } else if (active) {
      startBtn.textContent     = '⏹ Stop Shuffle';
      startBtn.dataset.active  = 'true';
      startBtn.dataset.loading = 'false';
    } else {
      startBtn.textContent     = 'True Shuffle';
      startBtn.dataset.active  = 'false';
      startBtn.dataset.loading = 'false';
    }
  }

  const cb = document.getElementById('tss-hub-repeat');
  if (cb && cb.checked !== state.autoRepeat) cb.checked = state.autoRepeat;

  const qi = document.getElementById('tss-hub-qico');
  if (qi) {
    qi.dataset.open = state.sidebarOpen ? 'true' : 'false';
    qi.textContent  = state.sidebarOpen ? '←' : '→';
    qi.title        = state.sidebarOpen ? 'close queue panel' : 'open queue panel';
  }

  if (!active) {
    const prog = document.getElementById('tss-hub-prog');
    if (prog) prog.style.width = '0%';
    return;
  }

  const pb = document.getElementById('tss-hub-play');
  if (pb) pb.textContent = paused() ? '▶' : '⏸';

  if (state.suspended) {
    const tEl = document.getElementById('tss-hub-title');
    const aEl = document.getElementById('tss-hub-artist');
    if (tEl) tEl.textContent = playerTitle() || '—';
    if (aEl) aEl.textContent = '↩ not in queue';
    const art = document.getElementById('tss-hub-art');
    if (art && art.dataset.src) { delete art.dataset.src; art.innerHTML = '♪'; }
    return;
  }

  const m   = state.meta[state.queue?.[state.pos]];
  const tEl = document.getElementById('tss-hub-title');
  const aEl = document.getElementById('tss-hub-artist');
  if (tEl) tEl.textContent = playerTitle() || m?.title  || '—';
  if (aEl) aEl.textContent = m?.artist || '—';

  const art = document.getElementById('tss-hub-art');
  if (art) {
    if (m?.artwork && art.dataset.src !== m.artwork) {
      art.dataset.src = m.artwork;
      art.innerHTML   = '';
      const img = document.createElement('img');
      img.src           = m.artwork;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror       = () => { art.innerHTML = '♪'; };
      art.appendChild(img);
    } else if (!m?.artwork && art.dataset.src) {
      delete art.dataset.src;
      art.innerHTML = '♪';
    }
  }

  const prog = document.getElementById('tss-hub-prog');
  if (prog) prog.style.width = `${Math.min(100, progress() * 100).toFixed(1)}%`;

  const nextTi = state.queue[state.pos + 1];
  const nextM  = nextTi !== undefined ? state.meta[nextTi] : null;
  const qpos   = document.getElementById('tss-hub-qpos');
  const nextup = document.getElementById('tss-hub-nextup');
  if (qpos)   qpos.textContent   = `${state.stats.played} / ${state.queue.length}`;
  if (nextup) nextup.textContent = nextM ? nextM.title : 'end of queue';
}

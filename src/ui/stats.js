function tickPlayTime() {
  if (state.active && !state.suspended && !paused()) {
    state.stats.elapsed = (state.stats.elapsed || 0) + 1;
  }
}
setInterval(tickPlayTime, 1000);

function renderStats() {
  const overlay = document.getElementById('tss-stats-overlay');
  if (!overlay) return;

  const elapsed  = state.stats.elapsed || 0;
  const h        = Math.floor(elapsed / 3600);
  const m        = Math.floor((elapsed % 3600) / 60);
  const s        = elapsed % 60;
  const duration = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const top = Object.entries(state.stats.playCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const tp = overlay.querySelector('#tss-stats-played');
  const tt = overlay.querySelector('#tss-stats-time');
  if (tp) tp.textContent = state.stats.played;
  if (tt) tt.textContent = duration;

  const list = overlay.querySelector('#tss-stats-toplist');
  if (!list) return;

  list.innerHTML = top.map(([ti, count]) => {
    const meta  = state.meta[+ti] || {};
    const w     = state.priority[+ti] ?? 1.0;
    const label = w <= 0.25 ? '🔻 low' : w >= 2.0 ? '🔺 high' : '▪ normal';
    const col   = w <= 0.25 ? '#f50'   : w >= 2.0 ? '#4caf50' : '#555';
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid #1a1a1a;">
        <span style="color:#bbb;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${esc(meta.title || '—')}</span>
        <span style="color:#f50;font-size:11px;flex-shrink:0;">${count}×</span>
        <button data-ti="${ti}" style="background:#1a1a1a;border:1px solid #333;color:${col};border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;flex-shrink:0;white-space:nowrap;">${label}</button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-ti]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const ti  = +btn.getAttribute('data-ti');
      const cur = state.priority[ti] ?? 1.0;
      let next, label, col;
      if      (cur >= 2.0) { next = 1.0;  label = '▪ normal'; col = '#555';    }
      else if (cur >= 1.0) { next = 0.25; label = '🔻 low';   col = '#f50';    }
      else                 { next = 2.0;  label = '🔺 high';  col = '#4caf50'; }
      state.priority[ti] = next;
      btn.textContent    = label;
      btn.style.color    = col;
    };
  });
}
setInterval(renderStats, 1000);

function showStats() {
  const existing = document.getElementById('tss-stats-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'tss-stats-overlay';
  overlay.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:#111; border:1px solid #2a2a2a; border-radius:10px;
    padding:0; z-index:999999; font-family:-apple-system,sans-serif;
    min-width:280px; box-shadow:0 8px 40px rgba(0,0,0,0.8);
    cursor:default; -webkit-user-select:none; user-select:none;
  `;

  overlay.innerHTML = `
    <div id="tss-stats-header" style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 10px;cursor:move;border-bottom:1px solid #1a1a1a;">
      <span style="color:#fff;font-size:14px;font-weight:600;">session stats</span>
      <span id="tss-stats-close" style="color:#555;cursor:pointer;font-size:18px;line-height:1;">×</span>
    </div>
    <div style="padding:14px 18px 18px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div style="background:#1a1a1a;border-radius:6px;padding:12px;">
          <div style="color:#555;font-size:10px;margin-bottom:4px;">tracks played</div>
          <div id="tss-stats-played" style="color:#fff;font-size:22px;font-weight:700;">0</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:12px;">
          <div style="color:#555;font-size:10px;margin-bottom:4px;">session time</div>
          <div id="tss-stats-time" style="color:#fff;font-size:22px;font-weight:700;">0s</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">most played</span>
        <span style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Prio</span>
      </div>
      <div id="tss-stats-toplist"></div>
      <button id="tss-stats-reset" style="margin-top:14px;width:100%;background:#1a1a1a;border:1px solid #2a2a2a;color:#666;border-radius:5px;padding:6px;cursor:pointer;font-size:11px;">reset stats</button>
    </div>
  `;

  document.body.appendChild(overlay);
  renderStats();

  document.getElementById('tss-stats-close').onclick = () => overlay.remove();
  document.getElementById('tss-stats-reset').onclick = () => {
    state.stats       = { played: 0, playCounts: {}, elapsed: 0 };
    state._savedStats = null;
    renderStats();
  };

  const header = document.getElementById('tss-stats-header');
  header.onmousedown = e => {
    if (e.target.id === 'tss-stats-close') return;
    e.preventDefault();
    const rect  = overlay.getBoundingClientRect();
    overlay.style.transform = 'none';
    overlay.style.left = rect.left + 'px';
    overlay.style.top  = rect.top  + 'px';
    const startX = e.clientX, startY = e.clientY;
    const origL  = rect.left,  origT  = rect.top;
    const move = ev => {
      overlay.style.left = Math.max(0, Math.min(window.innerWidth  - overlay.offsetWidth,  origL + (ev.clientX - startX))) + 'px';
      overlay.style.top  = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, origT + (ev.clientY - startY))) + 'px';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };
}

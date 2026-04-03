// ── Sidebar ───────────────────────────────────────────────────────────────────

// Build the slide-in queue panel and its persistent edge tab.
function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

  // Edge tab — always visible, click to open/close.
  const tab = document.createElement('div');
  tab.id = 'tss-sidebar-tab';
  tab.textContent = '🔀';
  tab.style.cssText = `
    position:fixed; right:0; top:50%; transform:translateY(-50%);
    background:#f50; color:#fff;
    width:28px; height:60px;
    display:flex; align-items:center; justify-content:center;
    border-radius:6px 0 0 6px;
    cursor:pointer; z-index:99998; font-size:16px;
    box-shadow:-2px 0 8px rgba(0,0,0,0.4); transition:right 0.25s;
  `;
  tab.onmouseenter = () => { tab.style.background = '#e64a00'; };
  tab.onmouseleave = () => { tab.style.background = '#f50'; };
  tab.onclick = toggleSidebar;

  // Sidebar panel.
  const sidebar = document.createElement('div');
  sidebar.id = 'tss-sidebar';
  sidebar.style.cssText = `
    position:fixed; right:-320px; top:0;
    width:300px; height:calc(100vh - 50px);
    background:#0d0d0d; border-left:1px solid #1a1a1a;
    z-index:99997; display:flex; flex-direction:column;
    transition:right 0.25s; font-family:-apple-system,sans-serif;
    box-shadow:-4px 0 20px rgba(0,0,0,0.7);
  `;

  sidebar.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid #1a1a1a;flex-shrink:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#fff;font-size:13px;font-weight:600;">🔀 queue</span>
        <div style="display:flex;gap:10px;align-items:center;">
          <span id="tss-stats-btn" style="color:#555;font-size:13px;cursor:pointer;" title="session stats">📊</span>
          <span id="tss-sidebar-count" style="color:#555;font-size:11px;"></span>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:10px;">
        <button id="tss-ctrl-prev" style="background:#1a1a1a;border:none;color:#ccc;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:14px;">⏮</button>
        <button id="tss-ctrl-play" style="background:#f50;border:none;color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:16px;">⏸</button>
        <button id="tss-ctrl-next" style="background:#1a1a1a;border:none;color:#ccc;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:14px;">⏭</button>
      </div>
      <div id="tss-sidebar-seekbar" style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;cursor:pointer;margin-bottom:8px;" title="click to seek">
        <div id="tss-progress-inner" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
      </div>
      <input id="tss-search" placeholder="search queue…"
        style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;color:#ccc;font-size:12px;padding:5px 8px;outline:none;" />
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:4px 0;scrollbar-width:thin;scrollbar-color:#222 transparent;"></div>
  `;

  document.body.appendChild(tab);
  document.body.appendChild(sidebar);

  const st = () => document.getElementById('tss-status');

  document.getElementById('tss-ctrl-play').onclick = toggle;
  document.getElementById('tss-ctrl-next').onclick = () => { state.manualAction = true; next(st()); };
  document.getElementById('tss-ctrl-prev').onclick = () => prevTrack(st());
  document.getElementById('tss-stats-btn').onclick = showStats;

  document.getElementById('tss-sidebar-seekbar').onclick = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  };

  document.getElementById('tss-search').oninput = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick  = e => e.stopPropagation();
}

// Toggle the sidebar open/closed and move the mini-player out of the way.
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  const t = document.getElementById('tss-sidebar-tab');
  if (s) s.style.right = state.sidebarOpen ? '0'      : '-320px';
  if (t) t.style.right = state.sidebarOpen ? '300px'  : '0';
  shiftMiniPlayer(state.sidebarOpen);
}

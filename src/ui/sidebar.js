// Slide-in queue panel — toggled via the hub. No playback controls here.

function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

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
    <div style="padding:12px 14px 10px;border-bottom:1px solid #1a1a1a;flex-shrink:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#fff;font-size:13px;font-weight:600;">queue</span>
        <div style="display:flex;gap:10px;align-items:center;">
          <span id="tss-stats-btn" style="color:#555;font-size:13px;cursor:pointer;" title="session stats">📊</span>
          <span id="tss-sidebar-count" style="color:#555;font-size:11px;"></span>
        </div>
      </div>
      <input id="tss-search" placeholder="search queue…"
        style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;color:#ccc;font-size:12px;padding:5px 8px;outline:none;" />
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:4px 0;scrollbar-width:thin;scrollbar-color:#222 transparent;"></div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById('tss-stats-btn').onclick = showStats;
  document.getElementById('tss-search').oninput = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick  = e => e.stopPropagation();
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  if (s) s.style.right = state.sidebarOpen ? '0' : '-320px';
  updateHub();
}

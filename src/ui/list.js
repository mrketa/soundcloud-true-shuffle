// ── Queue list renderer ───────────────────────────────────────────────────────

// Render the queue inside the sidebar list, optionally filtered by `filter`.
function renderList(filter = '') {
  const list  = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;

  list.innerHTML = '';

  if (!state.active || !state.queue.length) {
    list.innerHTML = `<div style="color:#444;font-size:12px;padding:24px 16px;text-align:center;">start shuffle to see queue</div>`;
    if (count) count.textContent = '';
    return;
  }

  const q = filter.toLowerCase();
  if (count) count.textContent = `${state.stats.played} / ${state.queue.length}`;

  // Suspended banner — shown when an external track is playing.
  if (state.suspended && !q) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:6px 12px;font-size:10px;color:#f50;background:rgba(255,85,0,0.07);border-bottom:1px solid #1a1a1a;';
    banner.textContent = '↩ external track playing — queue will resume after';
    list.appendChild(banner);
  }

  // "Play next" section — shown above the queue when there are pending tracks.
  if (state.playNext.length && !q) {
    const header = document.createElement('div');
    header.style.cssText = 'padding:4px 12px 2px;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.05em;';
    header.textContent = `play next (${state.playNext.length})`;
    list.appendChild(header);

    state.playNext.forEach((ti, i) => {
      const m   = state.meta[ti] || { title: '—', artist: '—', artwork: null };
      const row = mkRow(m, -1, ti, false, false);
      row.style.opacity    = '0.7';
      row.style.borderLeft = '3px solid #333';
      // Right-click a playNext item to remove it.
      row.oncontextmenu = e => { e.preventDefault(); state.playNext.splice(i, 1); renderList(); };
      list.appendChild(row);
    });

    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:#1a1a1a;margin:4px 0;';
    list.appendChild(divider);
  }

  // Main queue rows.
  state.queue.forEach((ti, qi) => {
    const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
    if (q && !m.title.toLowerCase().includes(q) && !m.artist.toLowerCase().includes(q)) return;

    const cur  = qi === state.pos;
    const past = qi <  state.pos;
    const row  = mkRow(m, qi, ti, cur, past);

    // Drag-to-reorder.
    row.draggable   = true;
    row.ondragstart = e => {
      state.dragSrc = qi;
      e.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '0.4';
    };
    row.ondragend   = () => { row.style.opacity = past ? '0.3' : '1'; };
    row.ondragover  = e => { e.preventDefault(); row.style.background = 'rgba(255,85,0,0.08)'; };
    row.ondragleave = () => { row.style.background = cur ? 'rgba(255,85,0,0.1)' : 'transparent'; };
    row.ondrop = e => {
      e.preventDefault();
      if (state.dragSrc === null || state.dragSrc === qi) return;
      const src     = state.dragSrc;
      const [moved] = state.queue.splice(src, 1);
      state.queue.splice(qi, 0, moved);
      if      (state.pos === src)                          state.pos = qi;
      else if (src < state.pos && qi >= state.pos)         state.pos--;
      else if (src > state.pos && qi <= state.pos)         state.pos++;
      state.dragSrc = null;
      badges();
      renderList(filter);
    };

    row.onclick       = () => jumpTo(qi, ti, document.getElementById('tss-status'));
    row.oncontextmenu = e => showCtxMenu(e, qi, ti);
    list.appendChild(row);
  });

  // Auto-scroll the current track into view (when not searching).
  if (!q) {
    const offset = state.playNext.length ? state.playNext.length + 2 : 0;
    list.children[state.pos + offset]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  refreshPlayBtn();
}

// Build a single queue row element.
function mkRow(m, qi, ti, cur, past) {
  const row = document.createElement('div');
  row.style.cssText = `
    display:flex; align-items:center; gap:10px; padding:7px 12px;
    cursor:pointer;
    background:${cur ? 'rgba(255,85,0,0.1)' : 'transparent'};
    border-left:3px solid ${cur ? '#f50' : 'transparent'};
    transition:background 0.15s;
    opacity:${past ? '0.3' : '1'};
    user-select:none;
  `;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.03)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

  // Artwork thumbnail.
  const art = document.createElement('div');
  art.style.cssText = 'width:38px;height:38px;border-radius:4px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;';
  if (m.artwork) {
    const img = document.createElement('img');
    img.src           = m.artwork;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.onerror       = () => { art.innerHTML = '<span style="font-size:16px;color:#333;">♪</span>'; };
    art.appendChild(img);
  } else {
    art.innerHTML = '<span style="font-size:16px;color:#333;">♪</span>';
  }

  // Position number / playing indicator.
  const num = document.createElement('div');
  num.style.cssText = `font-size:10px;color:${cur ? '#f50' : '#444'};font-weight:${cur ? '700' : '400'};min-width:18px;text-align:center;flex-shrink:0;`;
  const displayNum  = qi >= 0 ? state.stats.played + (qi - state.pos) : '↑';
  num.textContent   = cur ? '▶' : displayNum;

  // Title + artist text block — esc() prevents XSS from track metadata.
  const txt = document.createElement('div');
  txt.style.cssText = 'overflow:hidden;flex:1;';
  txt.innerHTML = `
    <div style="font-size:12px;color:${cur ? '#fff' : '#bbb'};font-weight:${cur ? '600' : '400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.title)}</div>
    <div style="font-size:11px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(m.artist)}</div>
  `;

  row.append(art, num, txt);
  return row;
}

// ── Context menu ──────────────────────────────────────────────────────────────
// Right-click a queue row to get quick track actions.

function showCtxMenu(e, qi, ti) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('tss-ctx')?.remove();

  const m    = state.meta[ti] || {};
  const menu = document.createElement('div');
  menu.id = 'tss-ctx';
  menu.style.cssText = `
    position:fixed;
    left:${e.clientX}px;
    top:${Math.min(e.clientY, window.innerHeight - 180)}px;
    background:#1a1a1a; border:1px solid #333; border-radius:5px;
    z-index:999999; font-size:12px; font-family:-apple-system,sans-serif;
    overflow:hidden; min-width:170px;
  `;

  const items = [
    {
      label:    '⏭ play next',
      action:   () => queueNext(ti),
    },
    {
      label:    '↑ move up',
      disabled: qi <= 0,
      action:   () => {
        if (qi <= 0) return;
        [state.queue[qi], state.queue[qi - 1]] = [state.queue[qi - 1], state.queue[qi]];
        if      (state.pos === qi)     state.pos--;
        else if (state.pos === qi - 1) state.pos++;
        badges();
        renderList();
      },
    },
    {
      label:    '↓ move down',
      disabled: qi >= state.queue.length - 1,
      action:   () => {
        if (qi >= state.queue.length - 1) return;
        [state.queue[qi], state.queue[qi + 1]] = [state.queue[qi + 1], state.queue[qi]];
        if      (state.pos === qi)     state.pos++;
        else if (state.pos === qi + 1) state.pos--;
        badges();
        renderList();
      },
    },
    {
      label:  '🔗 copy link',
      action: () => { if (m.link) navigator.clipboard.writeText(m.link).catch(() => {}); },
    },
    {
      label:    '✕ remove',
      disabled: qi === state.pos,
      action:   () => removeFromQueue(qi),
    },
  ];

  items.forEach(({ label, action, disabled }) => {
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = `
      padding:8px 14px;
      cursor:${disabled ? 'not-allowed' : 'pointer'};
      color:${disabled ? '#444' : '#ccc'};
      transition:background 0.1s;
    `;
    if (!disabled) {
      item.onmouseenter = () => { item.style.background = '#2a2a2a'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      item.onclick      = () => { action(); menu.remove(); };
    }
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  // Dismiss on the next click anywhere.
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

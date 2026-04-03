// ── Main UI injection ─────────────────────────────────────────────────────────

// Build the top-level control strip: shuffle button, repeat checkbox, status.
function mkUI() {
  const wrap = document.createElement('div');
  wrap.id = 'tss-wrapper';
  wrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap;';

  const btn = document.createElement('button');
  btn.id = 'tss-btn';
  btn.textContent = state.active ? '⏹ Stop' : '🔀 True Shuffle';
  btn.style.cssText = `
    background:#f50; color:#fff; border:none; border-radius:4px;
    padding:6px 14px; font-size:13px; font-weight:bold;
    cursor:pointer; transition:background 0.2s;
  `;
  btn.onmouseenter = () => { if (!btn.disabled) btn.style.background = '#e64a00'; };
  btn.onmouseleave = () => { if (!btn.disabled) btn.style.background = '#f50'; };

  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;color:#ccc;cursor:pointer;user-select:none;';
  const cb = document.createElement('input');
  cb.type         = 'checkbox';
  cb.checked      = state.autoRepeat;
  cb.style.accentColor = '#f50';
  cb.onchange     = () => { state.autoRepeat = cb.checked; };
  label.append(cb, document.createTextNode('repeat'));

  const status = document.createElement('span');
  status.id = 'tss-status';
  status.style.cssText = 'font-size:12px;color:#999;';

  btn.onclick = () => start(btn, status);
  wrap.append(btn, label, status);
  return wrap;
}

// Find a suitable container in the SoundCloud DOM and prepend the UI into it.
async function inject() {
  if (document.getElementById('tss-wrapper')) return;

  const sels = [
    '.sc-list-actions',
    '.listenEngagement__actions',
    '.trackList__tracksActions',
    '.userMain__content .sc-button-toolbar',
    '.soundActions',
    '.playlist__controls',
    '.userBadge__info',
    '.playlist__trackList',
    '.soundList',
    '.trackList',
  ];
  const container = sels.reduce((found, s) => found || document.querySelector(s), null);
  if (!container) return;

  container.prepend(mkUI());
  mkSidebar();
}

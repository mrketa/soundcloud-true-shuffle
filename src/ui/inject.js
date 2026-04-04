// ── Main UI injection ─────────────────────────────────────────────────────────

function mkUI() {
  // Inject button styles once. All state changes are driven by data-state and
  // :disabled so no inline style overrides are needed anywhere else.
  if (!document.getElementById('tss-style')) {
    const s = document.createElement('style');
    s.id = 'tss-style';
    s.textContent = `
      #tss-btn {
        background: #111;
        color: #f50;
        border: 1px solid rgba(255,85,0,0.35);
        border-radius: 8px;
        padding: 8px 18px;
        font-size: 13px;
        font-weight: 600;
        font-family: -apple-system,sans-serif;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        letter-spacing: 0.01em;
        outline: none;
      }
      #tss-btn:not(:disabled):not([data-state="active"]):hover {
        background: rgba(255,85,0,0.1);
        border-color: #f50;
        box-shadow: 0 0 16px rgba(255,85,0,0.2);
      }
      #tss-btn[data-state="active"] {
        background: #f50;
        color: #fff;
        border-color: transparent;
        box-shadow: 0 2px 14px rgba(255,85,0,0.4), 0 0 0 1px rgba(255,85,0,0.15);
      }
      #tss-btn[data-state="active"]:not(:disabled):hover {
        background: #e64a00;
        box-shadow: 0 2px 18px rgba(255,85,0,0.5);
      }
      #tss-btn:disabled {
        color: #3a3a3a;
        border-color: #1e1e1e;
        background: #111;
        cursor: not-allowed;
        box-shadow: none;
        animation: tss-pulse 1.2s ease-in-out infinite;
      }
      @keyframes tss-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.4; }
      }
    `;
    document.head.appendChild(s);
  }

  const wrap = document.createElement('div');
  wrap.id = 'tss-wrapper';
  wrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap;';

  const btn = document.createElement('button');
  btn.id            = 'tss-btn';
  btn.textContent   = state.active ? '⏹ Stop' : '🔀 True Shuffle';
  btn.dataset.state = state.active ? 'active'  : 'idle';

  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;color:#555;cursor:pointer;user-select:none;font-family:-apple-system,sans-serif;';
  const cb = document.createElement('input');
  cb.type          = 'checkbox';
  cb.checked       = state.autoRepeat;
  cb.style.accentColor = '#f50';
  cb.onchange      = () => { state.autoRepeat = cb.checked; };
  label.append(cb, document.createTextNode('repeat'));

  const status = document.createElement('span');
  status.id = 'tss-status';
  status.style.cssText = 'font-size:12px;color:#555;font-family:-apple-system,sans-serif;';

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

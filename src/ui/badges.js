// ── Queue badges ──────────────────────────────────────────────────────────────
// Small numbered chips injected next to each track title in the native
// SoundCloud list, showing the upcoming queue order.

function badges() {
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());

  state.queue.forEach((ti, qi) => {
    const el = state.els[ti];
    if (!el || el.querySelector('.tss-badge')) return;

    const cur = qi === state.pos;
    const b   = document.createElement('span');
    b.className  = 'tss-badge';
    b.style.cssText = [
      `display:inline-block`,
      `background:${cur ? '#f50' : '#2a2a2a'}`,
      `color:${cur ? '#fff' : '#888'}`,
      `border:1px solid ${cur ? '#f50' : '#444'}`,
      `border-radius:3px`,
      `font-size:10px`,
      `font-weight:bold`,
      `padding:1px 5px`,
      `margin-right:5px`,
      `vertical-align:middle`,
    ].join(';');
    b.textContent = cur ? `▶ ${qi + 1}` : `${qi + 1}`;

    const t = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    if (t) t.parentNode.insertBefore(b, t);
  });
}

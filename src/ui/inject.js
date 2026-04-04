// ── Main UI injection ─────────────────────────────────────────────────────────
// Injects the hub and sidebar into the page on valid playlist pages.
// The old inject-button UI has been removed — the hub is the sole control point.

// Find a suitable container in the SoundCloud DOM and attach the hub + sidebar.
async function inject() {
  if (document.getElementById('tss-hub')) return;

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

  mkSidebar();
  mkHub();
}

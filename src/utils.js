function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function playerTitle() {
  for (const s of ['.playbackSoundBadge__titleLink', '.playbackSoundBadge a[title]', '.playerTrackName']) {
    const el = document.querySelector(s);
    if (!el) continue;
    // SC's textContent includes an accessibility prefix we don't want
    const t = (el.getAttribute('title') || el.textContent)
      .trim()
      .replace(/^current\s+track:\s*/i, '');
    if (t) return t;
  }
  return '';
}

function progress() {
  const passed = document.querySelector('.playbackTimeline__timePassed');
  const total  = document.querySelector('.playbackTimeline__duration');
  if (!passed || !total) return 0;
  const toSec = el => {
    const m = el.textContent.match(/(\d+):(\d{2})$/);
    return m ? +m[1] * 60 + +m[2] : 0;
  };
  const d = toSec(total);
  return d ? toSec(passed) / d : 0;
}

function currentSec() {
  const el = document.querySelector('.playbackTimeline__timePassed');
  if (!el) return 0;
  const m = el.textContent.match(/(\d+):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

function paused() {
  const btn = document.querySelector('.playControls__play');
  if (!btn) return false;
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  return label.startsWith('play') || (btn.title || '').toLowerCase().startsWith('play');
}

function pause() {
  const b = document.querySelector('.playControls__play');
  if (b && !paused()) b.click();
}

function toggle() {
  document.querySelector('.playControls__play')?.click();
  setTimeout(refreshPlayBtn, 150);
}

function seekTo(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  const bar = document.querySelector('.playControls .playbackTimeline__progressWrapper');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const x    = rect.left + rect.width * ratio;
  const y    = rect.top  + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  bar.dispatchEvent(new MouseEvent('mousedown', opts));
  bar.dispatchEvent(new MouseEvent('mousemove', opts));
  bar.dispatchEvent(new MouseEvent('mouseup',   opts));
}

function refreshPlayBtn() {
  const p = document.getElementById('tss-hub-play');
  if (p) p.textContent = paused() ? '▶' : '⏸';
}

function updateProgressBar() {
  const p = document.getElementById('tss-hub-prog');
  if (p) p.style.width = `${Math.min(100, progress() * 100).toFixed(1)}%`;
}

function artwork(el) {
  const span = el.querySelector('span.image__full, span.sc-artwork');
  if (span?.style.backgroundImage) {
    const m = span.style.backgroundImage.match(/url\(["']?(https?:[^"')]+)["']?\)/);
    if (m) return m[1].replace(/-t\d+x\d+/, '-t200x200');
  }
  const img = el.querySelector('img[src*="sndcdn"]');
  if (img?.src) return img.src.replace(/-t\d+x\d+/, '-t200x200');
  return null;
}

function getLink(el) {
  const a = el.querySelector('.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary');
  if (!a) return null;
  const href = a.getAttribute('href');
  if (!href) return null;
  return href.startsWith('http') ? href : 'https://soundcloud.com' + href;
}

// Stable identity for a track across page reloads — prefers permalink URL.
function trackId(m) {
  if (!m) return null;
  if (m.link) return m.link;
  const t = m.title, a = m.artist;
  if ((t && t !== '—') || (a && a !== '—')) return `${t}|||${a}`;
  return null;
}

function getMeta(el) {
  return {
    title:   el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist:  el.querySelector('.trackItem__username, .soundTitle__username, .sc-link-secondary')?.textContent.trim() || '—',
    artwork: artwork(el),
    link:    getLink(el),
  };
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

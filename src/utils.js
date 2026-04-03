// ── Utilities ────────────────────────────────────────────────────────────────

// Fisher-Yates in-place shuffle — returns a new array.
function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ── DOM helpers ───────────────────────────────────────────────────────────────

// Returns the title currently shown in SoundCloud's playback bar.
// Prefers the `title` attribute over textContent — SC's textContent includes
// an accessibility prefix ("Current track: …") that we don't want to display.
function playerTitle() {
  for (const s of ['.playbackSoundBadge__titleLink', '.playbackSoundBadge a[title]', '.playerTrackName']) {
    const el = document.querySelector(s);
    if (!el) continue;
    const t = (el.getAttribute('title') || el.textContent)
      .trim()
      .replace(/^current\s+track:\s*/i, '');
    if (t) return t;
  }
  return '';
}

// Returns the artwork URL currently shown in SoundCloud's playback bar.
// Used in suspended mode to display the artwork of an externally-playing track.
function playerArtwork() {
  for (const sel of [
    '.playbackSoundBadge__avatar',
    '.playbackSoundBadge__coverArt',
    '.playbackSoundBadge',
  ]) {
    const container = document.querySelector(sel);
    if (!container) continue;
    // background-image on a span (SC's standard artwork rendering)
    const span = container.querySelector('span[style*="background-image"], .sc-artwork[style*="background-image"]');
    if (span?.style.backgroundImage) {
      const m = span.style.backgroundImage.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (m) return m[1].replace(/-t\d+x\d+/, '-t200x200');
    }
    // fallback: img tag
    const img = container.querySelector('img[src]');
    if (img?.src) return img.src.replace(/-t\d+x\d+/, '-t200x200');
  }
  return null;
}

// Returns current playback progress as a ratio 0–1, or 0 if unavailable.
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

// Returns how many seconds into the current track the playhead is.
function currentSec() {
  const el = document.querySelector('.playbackTimeline__timePassed');
  if (!el) return 0;
  const m = el.textContent.match(/(\d+):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

// True when the native player is paused (or the play button shows "Play").
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

// Seek to a ratio (0–1) by simulating mouse events on SC's progress bar.
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

// Sync the play/pause icon on both the sidebar and mini-player controls.
function refreshPlayBtn() {
  const isPaused = paused();
  const s = document.getElementById('tss-ctrl-play');
  const m = document.getElementById('tss-mini-play');
  if (s) s.textContent = isPaused ? '▶' : '⏸';
  if (m) m.textContent = isPaused ? '▶' : '⏸';
}

// Sync the progress bar width on both the sidebar and mini-player.
function updateProgressBar() {
  const p = `${Math.min(100, progress() * 100).toFixed(1)}%`;
  const s = document.getElementById('tss-progress-inner');
  const m = document.getElementById('tss-mini-progress');
  if (s) s.style.width = p;
  if (m) m.style.width = p;
}

// ── Track metadata extraction ─────────────────────────────────────────────────

// Resolves the best-available artwork URL from a track list element.
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

// Returns the canonical SoundCloud URL for a track element.
// Covers both trackList (sets/likes) and soundList (profile pages) layouts.
function getLink(el) {
  const a = el.querySelector(
    '.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary'
  );
  if (!a) return null;
  const href = a.getAttribute('href');
  if (!href) return null;
  return href.startsWith('http') ? href : 'https://soundcloud.com' + href;
}

// Stable identity string for a track, used to survive page reloads.
// Prefers the permalink URL (a href attribute, always set by React immediately)
// over the display text which can vary by render state / truncation / locale.
function trackId(m) {
  if (!m) return null;
  if (m.link) return m.link;                          // best: unique, stable
  const t = m.title, a = m.artist;
  if ((t && t !== '—') || (a && a !== '—')) return `${t}|||${a}`;
  return null;
}

// Extracts { title, artist, artwork, link } from a track list DOM element.
function getMeta(el) {
  return {
    title:   el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist:  el.querySelector('.trackItem__username, .soundTitle__username, .sc-link-secondary')?.textContent.trim() || '—',
    artwork: artwork(el),
    link:    getLink(el),
  };
}

// ── Security helper ───────────────────────────────────────────────────────────

// Escapes a string for safe insertion into innerHTML.
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Web Worker factory ────────────────────────────────────────────────────────
// Fires a message every 300 ms so the watcher can poll playback state even
// when the tab is in the background.

function mkWorker() {
  const src = `
    let t = null;
    self.onmessage = e => {
      if (e.data === 'start') {
        clearInterval(t);
        t = setInterval(() => self.postMessage(0), 300);
      } else {
        clearInterval(t);
        t = null;
      }
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  const w   = new Worker(url);
  URL.revokeObjectURL(url); // Worker holds its own internal reference; safe to revoke immediately
  return w;
}

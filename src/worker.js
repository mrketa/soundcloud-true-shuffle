// Fires a message every 300 ms so the watcher polls even in background tabs.
function mkWorker() {
  try {
    const src = `
      let t = null;
      self.onmessage = e => {
        if (e.data === 'start') { clearInterval(t); t = setInterval(() => self.postMessage(0), 300); }
        else                    { clearInterval(t); t = null; }
      };
    `;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const w   = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  } catch (_) {
    return null; // CSP blocked — caller falls back to setInterval
  }
}

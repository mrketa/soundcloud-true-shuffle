<div align="center">

<img src="https://img.shields.io/badge/SoundCloud-True%20Shuffle-ff5500?style=for-the-badge&logo=soundcloud&logoColor=white" alt="SoundCloud True Shuffle">

<br/>
<br/>

> **SoundCloud's shuffle is broken. This fixes it.**

<br/>

![Version](https://img.shields.io/badge/version-6.1.3-ff5500?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-orange?style=flat-square)
![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-install-brightgreen?style=flat-square&logo=tampermonkey)
![Works in background](https://img.shields.io/badge/background%20tab-✓-ff5500?style=flat-square)

</div>

---

## The problem

SoundCloud's built-in shuffle only randomizes the **first ~20 tracks** that happen to be loaded on the page. If your playlist has 100+ songs, you'll hear the same ones over and over. On top of that, the player breaks when the tab is in the background — so if you're gaming or doing anything else, it just stops.

## What this does

- **Loads your entire playlist** before doing anything — no tracks get skipped
- **Fisher-Yates shuffle** — genuinely random, not fake random
- **Web Worker** — runs in a separate thread, completely unaffected by background tab throttling
- **Round-based shuffle** — every track plays once before a fresh round is generated
- **Modern floating player** — artwork, real waveform, queue, history, stats and sleep timer
- **Two-deck audio engine** — True Shuffle now handles playback directly, with SoundCloud retained as a fallback
- **DJ-style crossfade** — adjustable duration and Smooth, Clean or DJ transition curves
- **5-band equalizer** — built-in presets, a visual editor and persistent custom presets
- **Auto Level** — evens out large volume differences between tracks and remembers learned levels
- Works on playlists, likes, tracks, reposts and the SoundCloud Feed

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click **[Install from Greasy Fork](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle)**
3. Done

> Works on Chrome, Brave, Firefox, Edge and Safari

## Usage

Navigate to a supported SoundCloud playlist, library page or Feed. The floating **True Shuffle** player appears in the lower-left corner.

- Click **True Shuffle** to load every available track and begin a shuffled round.
- Click the shuffle icon in the header to re-shuffle the loaded playlist without reloading the page.
- Open the queue icon to search, reorder, merge playlists or view listening history.
- Use the EQ button for presets or a custom five-band curve. Custom presets stay saved through userscript storage.
- Adjust the global output level from the player and enable Auto Level if tracks vary heavily in loudness.
- Open the Crossfade panel to choose a duration and transition style.
- Enable **Stop after this round** if playback should end after every track has played once.

## How it works

```
1. Scroll to bottom of page repeatedly until all tracks are loaded
2. Collect all track elements
3. Fisher-Yates shuffle → build a queue
4. Resolve the selected track and play it through True Shuffle's two-deck audio engine
5. Apply output level, Auto Level, equalizer and optional crossfade
6. Use the background-safe Web Worker and audio clock to coordinate track changes
7. Fall back to SoundCloud playback if a direct stream cannot be resolved
8. When the round is exhausted → generate a new balanced round
```

## Browser support

| Browser | Works |
|---------|-------|
| Chrome / Brave | ✅ |
| Firefox | ✅ |
| Edge | ✅ |
| Safari | ✅ |
| Opera | ✅ |

## License

MIT

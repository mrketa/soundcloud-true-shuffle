<div align="center">

<img src="https://img.shields.io/badge/SoundCloud-True%20Shuffle-ff5500?style=for-the-badge&logo=soundcloud&logoColor=white" alt="SoundCloud True Shuffle">

<br/>
<br/>

> **SoundCloud's shuffle is broken. This fixes it.**

<br/>

![Version](https://img.shields.io/badge/version-5.1.0-ff5500?style=flat-square)
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
- Enable **Stop after this round** if playback should end after every track has played once.

## How it works

```
1. Scroll to bottom of page repeatedly until all tracks are loaded
2. Collect all track elements
3. Fisher-Yates shuffle → build a queue
4. Play the first track and start the background-safe Web Worker
5. Detect natural track endings from the audio element and guarded player-state fallbacks
6. Play next in queue → repeat
7. When the round is exhausted → generate a new balanced round
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

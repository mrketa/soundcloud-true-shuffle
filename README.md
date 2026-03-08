<div align="center">

<img src="https://img.shields.io/badge/SoundCloud-True%20Shuffle-ff5500?style=for-the-badge&logo=soundcloud&logoColor=white" alt="SoundCloud True Shuffle">

<br/>
<br/>

> **SoundCloud's shuffle is broken. This fixes it.**

<br/>

![Version](https://img.shields.io/badge/version-3.0.0-ff5500?style=flat-square)
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
- **Auto-Repeat** — reshuffles and starts a new round when all tracks have played
- Works on playlists, likes, tracks and reposts pages

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click **[Install from Greasy Fork](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle)**
3. Done

> Works on Chrome, Brave, Firefox, Edge and Safari

## Usage

Navigate to any SoundCloud playlist or your likes page. The **🔀 True Shuffle** button will appear at the top of the track list.

```
🔀 True Shuffle    ☑ Auto-Repeat    ▶ 12 / 87
```

Click it once to start, click **⏹ Stop Shuffle** to stop.

## How it works

```
1. Scroll to bottom of page repeatedly until all tracks are loaded
2. Collect all track elements
3. Fisher-Yates shuffle → build a queue
4. Play first track, start Web Worker (800ms tick, background-safe)
5. Worker detects track end via two methods:
   - Title change in player bar (SC switched on its own → we override)
   - timePassed === duration (track finished naturally)
6. Play next in queue → repeat
7. When queue is exhausted → reshuffle → new round
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

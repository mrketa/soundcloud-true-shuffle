#!/usr/bin/env python3
"""
Build script for SoundCloud True Shuffle.

Usage:
    python build.py

Output:
    dist/SC Trueshuffle.user.js  — ready-to-install Tampermonkey userscript

The source files are plain JavaScript (no import/export syntax) concatenated
in dependency order inside a single IIFE so every function is in shared scope.
"""

import os
import textwrap

# ── Userscript header ─────────────────────────────────────────────────────────

HEADER = """\
// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      4.1.0
// @description  Fixes SoundCloud's broken shuffle. Loads all tracks, actually random, works in background tabs.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';
"""

FOOTER = "\n})();\n"

# ── Source files in strict dependency order ───────────────────────────────────
# Each file may freely call functions defined in any earlier file because they
# all land in the same IIFE scope after concatenation.

FILES = [
    "src/state.js",          # shared state object — no deps
    "src/utils.js",          # pure helpers — no project deps
    "src/worker.js",         # worker factory — no project deps
    "src/playback.js",       # core playback logic — uses state, utils, worker + UI fns (defined later, called at runtime only)
    "src/watcher.js",        # background poller — uses state, utils, playback, UI fns
    "src/ui/badges.js",      # DOM badge chips — uses state
    "src/ui/stats.js",       # stats overlay — uses state, utils (esc)
    "src/ui/hub.js",         # central floating hub — uses state, utils, playback, stats, sidebar
    "src/ui/sidebar.js",     # slide-in queue panel — uses state, utils, playback, miniPlayer
    "src/ui/list.js",        # queue list renderer — uses state, utils, playback, badges
    "src/ui/contextMenu.js", # right-click menu — uses state, playback, list
    "src/ui/inject.js",      # top-level UI injection — uses state, playback, sidebar
    "src/nav.js",            # SPA navigation watcher — uses state, playback, inject
]

# ── Build ─────────────────────────────────────────────────────────────────────

def build():
    root   = os.path.dirname(os.path.abspath(__file__))
    chunks = [HEADER]

    for rel in FILES:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing source file: {rel}")
        with open(path, encoding="utf-8") as f:
            src = f.read().strip()
        # Visually separate each module in the output for easier debugging.
        chunks.append(f"\n// {'─' * 2} {rel} {'─' * max(0, 74 - len(rel))}\n\n{src}\n")

    chunks.append(FOOTER)
    output = "".join(chunks)

    out_dir  = os.path.join(root, "dist")
    out_path = os.path.join(out_dir, "SC Trueshuffle.user.js")
    os.makedirs(out_dir, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(output)

    lines = output.count("\n")
    size  = len(output.encode("utf-8"))
    print(f"Built {os.path.relpath(out_path, root)}  ({lines} lines, {size // 1024} KB)")

if __name__ == "__main__":
    build()

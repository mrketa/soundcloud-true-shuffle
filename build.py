#!/usr/bin/env python3
"""Build the canonical release or a standalone temporary diagnostic userscript."""

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "SC Trueshuffle.js"
DEFAULT_OUTPUT = ROOT / "dist" / "SC Trueshuffle.user.js"
DIAGNOSTIC_OUTPUT = ROOT / "dist" / "SC Trueshuffle Diagnostic.user.js"


def replace_once(source_bytes, original, replacement):
    if source_bytes.count(original) != 1:
        raise ValueError(f"expected one build marker: {original!r}")
    return source_bytes.replace(original, replacement, 1)


def diagnostic_source(source_bytes):
    replacements = (
        (
            b"// @name         SoundCloud True Shuffle",
            b"// @name         SoundCloud True Shuffle (Temporary Diagnostic)",
        ),
        (
            b"// @version      6.2.4",
            b"// @version      6.2.6",
        ),
        (
            b"// @description  True full-playlist shuffle with a two-deck player, DJ crossfade, equalizer, Auto Level, queue and background playback.",
            b"// @description  Temporary diagnostic copy; disable the stable script while diagnosing playback.",
        ),
    )
    for original, replacement in replacements:
        source_bytes = replace_once(source_bytes, original, replacement)
    return source_bytes


def build(output_path=None, diagnostic=False):
    if output_path is None:
        output_path = DIAGNOSTIC_OUTPUT if diagnostic else DEFAULT_OUTPUT
    output_path = Path(output_path)
    source_bytes = SOURCE.read_bytes()
    if diagnostic:
        source_bytes = diagnostic_source(source_bytes)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(source_bytes)
    label = "diagnostic " if diagnostic else ""
    print(
        f"Built {label}{output_path} "
        f"({source_bytes.count(bytes([10]))} lines, {len(source_bytes) // 1024} KB)"
    )
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="output path (defaults to the canonical dist file, or the diagnostic dist file with --diagnostic)",
    )
    parser.add_argument(
        "--diagnostic",
        action="store_true",
        help="build a temporary standalone diagnostic userscript",
    )
    args = parser.parse_args()
    build(args.output, diagnostic=args.diagnostic)

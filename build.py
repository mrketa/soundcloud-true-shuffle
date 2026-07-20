#!/usr/bin/env python3
"""Copy the canonical userscript to its release output without rewriting it."""

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "SC Trueshuffle.js"
DEFAULT_OUTPUT = ROOT / "dist" / "SC Trueshuffle.user.js"


def build(output_path=DEFAULT_OUTPUT):
    output_path = Path(output_path)
    source_bytes = SOURCE.read_bytes()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(source_bytes)
    print(
        f"Built {output_path} "
        f"({source_bytes.count(bytes([10]))} lines, {len(source_bytes) // 1024} KB)"
    )
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="output path (defaults to dist/SC Trueshuffle.user.js)",
    )
    args = parser.parse_args()
    build(args.output)

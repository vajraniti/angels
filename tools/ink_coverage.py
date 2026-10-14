#!/usr/bin/env python3
"""Share of a screenshot that is ink: pixels darker than mid-grey (luma < 128).

The brief asks for white to dominate; the first screen is kept at or below about
22 % ink at 1440 x 900 and 390 x 844.

  python3 tools/ink_coverage.py shot.png [more.png ...] [--fold WIDTHxHEIGHT]

With --fold only the top WIDTH x HEIGHT CSS pixels are measured (the screenshot's
device pixel ratio is inferred from its width).
"""

import argparse
import sys

import numpy as np
from PIL import Image


def coverage(path: str, fold: tuple[int, int] | None) -> float:
    with Image.open(path) as im:
        a = np.asarray(im.convert("L"))
    if fold:
        dpr = a.shape[1] / fold[0]
        a = a[: round(fold[1] * dpr), : round(fold[0] * dpr)]
    return float((a < 128).mean())


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("files", nargs="+")
    p.add_argument("--fold", help="measure only the top WxH CSS pixels, e.g. 390x844")
    args = p.parse_args()
    fold = None
    if args.fold:
        try:
            w, h = (int(v) for v in args.fold.lower().split("x"))
        except ValueError:
            p.error(f"--fold must look like 1440x900, got {args.fold!r}")
        fold = (w, h)
    for f in args.files:
        try:
            print(f"{coverage(f, fold) * 100:6.2f} %  {f}")
        except OSError as err:
            print(f"ink_coverage: cannot read {f}: {err}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

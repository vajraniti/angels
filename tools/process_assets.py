#!/usr/bin/env python3
"""Turn the public-domain scans in design/material/ into the site's assets/.

Every asset is rendered at the exact pixel size it is shown at (1x) and at twice
that (2x, for high-density screens), so the browser never rescales a 1-bit line
tint: scaled line engravings turn into moire (brief, section 4.3). The page sets
each <img> to the 1x size in CSS pixels and lets srcset pick the file.

  python3 tools/process_assets.py            writes assets/*.png
  python3 tools/process_assets.py --check    exits 1 if assets/ is out of date

Recipes (brief 4.3): grayscale -> Lanczos resize to display size -> levels so the
paper goes to white -> threshold (line work) or keep tone (Fludd's etched plate).
1-bit files are RGBA: ink is opaque #111, paper is fully transparent, so the scan
lies on the page's own paper with no rectangle around it.

Requires Pillow and NumPy (python3 -m pip install pillow numpy).
"""

from __future__ import annotations

import argparse
import io
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MATERIAL = ROOT / "design" / "material"
ASSETS = ROOT / "assets"
INK = 0x11  # --ink, #111111


def load_gray(name: str) -> Image.Image:
    path = MATERIAL / name
    try:
        return Image.open(path).convert("L")
    except OSError as err:
        raise SystemExit(f"process_assets: cannot read scan {path}: {err}") from err


def resize(img: Image.Image, width: int) -> Image.Image:
    height = round(img.height * width / img.width)
    return img.resize((width, height), Image.Resampling.LANCZOS)


def levels(a: np.ndarray, black: float, white: float, gamma: float = 1.0) -> np.ndarray:
    """Map [black, white] to [0, 1]; values past white become paper."""
    v = np.clip((a.astype(np.float32) - black) / (white - black), 0.0, 1.0)
    return v**gamma if gamma != 1.0 else v


def one_bit_rgba(ink_mask: np.ndarray) -> Image.Image:
    """Opaque #111 where ink_mask is True, transparent elsewhere."""
    h, w = ink_mask.shape
    rgba = np.zeros((h, w, 4), np.uint8)
    rgba[..., 0:3] = INK
    rgba[..., 3] = np.where(ink_mask, 255, 0)
    return Image.fromarray(rgba, "RGBA")


def radial_threshold(
    shape: tuple[int, int], cx: float, cy: float, r0: float, r1: float, t_in: float, t_out: float, up: float = 1.0
):
    """Threshold that falls from t_in inside r0 to t_out beyond r1 (ink is a < threshold).

    Thin lines vanish first as the threshold falls, thick ones last, so the picture
    thins out at its edge the way a worn block prints, without a grey gradient.
    `up` > 1 pulls the edge in above the centre (distances upward count more)."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dy = yy - cy
    d = np.hypot(xx - cx, np.where(dy < 0, dy * up, dy))
    f = np.clip((d - r0) / (r1 - r0), 0.0, 1.0)
    return t_in + (t_out - t_in) * f


# --------------------------------------------------------------------- recipes


def bickham_cherubs(width: int) -> Image.Image:
    """George Bickham, The Universal Penman (1741), putti with the banderole
    'Delectando monemus'. The scan is already 1-bit; the engraved 'London' line
    below the wreath is cropped off because it would read as a place name."""
    src = load_gray("13_bickham_cherubs_wreath.png").crop((40, 0, 1250, 1108))
    # A light blur before the downscale keeps the stipple from aliasing into
    # clumps; the threshold then restores hard 1-bit edges.
    src = src.filter(ImageFilter.GaussianBlur(radius=src.width / width * 0.5))
    a = np.asarray(resize(src, width))
    return one_bit_rgba(a < 135)


def durer_sun(width: int) -> Image.Image:
    """Albrecht Duerer, St John devouring the book (1498, Rijksmuseum, CC0): the sun
    with a face, the alchemists' sign for gold. The surrounding sky hatching is
    thinned out by a rising threshold so only the face, halo and rays carry."""
    src = load_gray("11_durer_mighty_angel_rainbow.jpg")
    cx, cy, r = 819, 860, 400
    src = src.crop((cx - r, cy - r, cx + r, cy + r))
    img = resize(src, width)
    a = levels(np.asarray(img), 45, 205) * 255.0
    s = width / (2 * r)
    # Face and halo sit at the crop centre, slightly above it.
    thr = radial_threshold(a.shape, width / 2, width / 2 - 30 * s, 190 * s, 330 * s, 132.0, -1.0, up=1.35)
    return one_bit_rgba(a < thr)


def fludd_darkness(width: int) -> Image.Image:
    """Robert Fludd, Utriusque Cosmi (1617), the Great Darkness: an etched black
    square with 'Et sic in infinitum' on four sides. It is a tone, not a line tint,
    so it keeps its greys; levels push the plate's paper to pure white so that
    mix-blend-mode: multiply leaves the page's paper untouched."""
    src = load_gray("19_fludd_great_darkness.jpg").crop((70, 58, 1862, 1862))
    img = resize(src, width)
    v = levels(np.asarray(img), 24, 168, 1.05)
    gray = (INK + (255 - INK) * v).round().astype(np.uint8)
    # 24 grey levels are plenty for an etching and roughly halve the PNG.
    step = 255 / 23
    gray = (np.round((gray.astype(np.float32) - INK) / step) * step + INK).clip(INK, 255).astype(np.uint8)
    gray[v >= 0.995] = 255
    return Image.fromarray(gray, "L")


@dataclass(frozen=True)
class Asset:
    name: str
    width: int  # CSS pixels the page shows it at
    make: Callable[[int], Image.Image]


ASSET_LIST = [
    Asset("bickham-cherubs", 156, bickham_cherubs),
    Asset("durer-sun", 400, durer_sun),
    Asset("durer-sun-sm", 216, durer_sun),
    Asset("fludd-darkness", 400, fludd_darkness),
    Asset("fludd-darkness-sm", 216, fludd_darkness),
]


def same_pixels(path: Path, data: bytes) -> bool:
    if not path.is_file():
        return False
    with Image.open(path) as a, Image.open(io.BytesIO(data)) as b:
        return a.mode == b.mode and a.size == b.size and a.tobytes() == b.tobytes()


def encode(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build() -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for asset in ASSET_LIST:
        for scale, suffix in ((1, ""), (2, "@2x")):
            img = asset.make(asset.width * scale)
            out[f"{asset.name}{suffix}.png"] = encode(img)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if assets/ differs from a fresh build")
    args = parser.parse_args()

    files = build()
    if args.check:
        # Pixels, not bytes: PNG encoders differ between zlib builds.
        stale = [name for name, data in files.items() if not same_pixels(ASSETS / name, data)]
        if stale:
            print("process_assets: out of date: " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"process_assets: {len(files)} assets up to date")
        return 0

    ASSETS.mkdir(exist_ok=True)
    for name, data in files.items():
        (ASSETS / name).write_bytes(data)
        with Image.open(io.BytesIO(data)) as im:
            print(f"  assets/{name:28s} {im.width:4d} x {im.height:<4d} {len(data) / 1024:7.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

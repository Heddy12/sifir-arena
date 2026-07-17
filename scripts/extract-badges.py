"""Extract the 5x3 achievement sheet into transparent game-ready PNG icons."""

from collections import deque
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageFilter


BADGES = [
    "first-victory", "ten-wins", "fifty-wins", "hundred-battles", "hot-streak",
    "perfect-battle", "sprint-star", "times-master", "arena-champion", "streak-legend",
    "sprint-legend", "card-master", "table-specialist", "bot-breaker", "rank-climber",
]
CENTERS_X = [292, 532, 774, 1022, 1280]
CENTERS_Y = [246, 480, 710]
CROP_SIZE = 244


def polynomial_features(x, y):
    return np.column_stack([
        np.ones_like(x), x, y, x * x, x * y, y * y,
        x ** 3, x * x * y, x * y * y, y ** 3,
    ])


def largest_component(mask):
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best = []
    for start_y, start_x in zip(*np.where(mask & ~seen)):
        if seen[start_y, start_x]:
            continue
        queue = deque([(start_y, start_x)])
        seen[start_y, start_x] = True
        component = []
        while queue:
            y, x = queue.popleft()
            component.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        if len(component) > len(best):
            best = component
    result = np.zeros_like(mask, dtype=bool)
    for y, x in best:
        result[y, x] = True
    return result


def fill_holes(mask):
    height, width = mask.shape
    outside = np.zeros_like(mask, dtype=bool)
    queue = deque()
    for x in range(width):
        queue.extend([(0, x), (height - 1, x)])
    for y in range(height):
        queue.extend([(y, 0), (y, width - 1)])
    while queue:
        y, x = queue.popleft()
        if not (0 <= y < height and 0 <= x < width) or mask[y, x] or outside[y, x]:
            continue
        outside[y, x] = True
        queue.extend(((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)))
    return ~outside


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: extract-badges.py SOURCE.png OUTPUT_DIR")
    source_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)

    source = Image.open(source_path).convert("RGB")
    pixels = np.asarray(source, dtype=np.float32)
    height, width = pixels.shape[:2]

    badge_index = 0
    for center_y in CENTERS_Y:
        for center_x in CENTERS_X:
            left, top = center_x - CROP_SIZE // 2, center_y - CROP_SIZE // 2
            rgb = pixels[top:top + CROP_SIZE, left:left + CROP_SIZE]
            local_y, local_x = np.mgrid[0:CROP_SIZE, 0:CROP_SIZE]
            fx = local_x.ravel().astype(np.float32) / (CROP_SIZE - 1) * 2 - 1
            fy = local_y.ravel().astype(np.float32) / (CROP_SIZE - 1) * 2 - 1
            features = polynomial_features(fx, fy)

            # Each cell has a smooth but slightly different generated gradient.
            # Learn it from its border, repeatedly discarding foreground outliers.
            border = ((local_x < 22) | (local_x >= CROP_SIZE - 22) |
                      (local_y < 22) | (local_y >= CROP_SIZE - 22)).ravel()
            sample_features = features[border]
            sample_colors = rgb.reshape(-1, 3)[border]
            keep = np.ones(len(sample_colors), dtype=bool)
            for _ in range(4):
                coefficients = np.linalg.lstsq(sample_features[keep], sample_colors[keep], rcond=None)[0]
                residual = np.sqrt(np.mean((sample_colors - sample_features @ coefficients) ** 2, axis=1))
                keep = residual <= min(22, np.percentile(residual, 62))
            backdrop = (features @ coefficients).reshape(rgb.shape)
            difference = np.sqrt(np.mean((rgb - backdrop) ** 2, axis=2))

            rough = Image.fromarray((difference > 24).astype(np.uint8) * 255)
            rough = rough.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(5))
            component = largest_component(np.asarray(rough) > 0)
            solid = fill_holes(component)
            alpha = Image.fromarray(solid.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(1.1))

            icon = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
            icon.putalpha(alpha)
            icon = icon.resize((256, 256), Image.Resampling.LANCZOS)
            icon.save(output_dir / (BADGES[badge_index] + ".png"), optimize=True)
            badge_index += 1


if __name__ == "__main__":
    main()

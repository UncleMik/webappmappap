"""Remove baked neutral backgrounds from the approved pink weekly illustrations."""
import argparse
import io
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
destination = root / 'Фронт/assets/baby-weeks'
preview = Image.new('RGB', (1400, 1200), '#fff0ee')

for week in range(1, 43):
    original = Image.open(args.source / f'week-{week:02}.png').convert('RGB')
    rgb = np.asarray(original).astype(float)
    # White and grey checker cells are neutral; the artwork is pink/peach.
    chroma = np.maximum(rgb[:, :, 0] - rgb[:, :, 1], rgb[:, :, 0] - rgb[:, :, 2])
    corners = [chroma[:32, :32], chroma[:32, -32:], chroma[-32:, :32], chroma[-32:, -32:]]
    matte_chroma = float(np.median(np.concatenate([c.ravel() for c in corners])))
    alpha = np.clip((chroma - matte_chroma - 3) / (65 - matte_chroma), 0, 1)
    # Unmatte soft pink edges so the original white does not become a halo.
    neutral = np.maximum(rgb[:, :, 0], rgb[:, :, 1])
    color = np.clip(
        (rgb - neutral[:, :, None] * (1 - alpha[:, :, None]))
        / np.maximum(alpha[:, :, None], .001), 0, 255,
    )
    result = Image.fromarray(np.dstack([color, alpha * 255]).astype('uint8'))
    result = result.resize((400, 400), Image.Resampling.LANCZOS)
    path = destination / f'week-{week:02}.webp'
    encoded = io.BytesIO()
    result.save(encoded, format='WEBP', quality=90, method=4)
    for attempt in range(5):
        try:
            path.write_bytes(encoded.getvalue())
            break
        except OSError:
            if attempt == 4:
                raise
            time.sleep(.3)
    with Image.open(io.BytesIO(path.read_bytes())) as webp:
        saved = webp.convert('RGBA')
    assert saved.getextrema()[3][0] == 0, path
    thumb = saved.resize((200, 200), Image.Resampling.LANCZOS)
    x, y = ((week - 1) % 7) * 200, ((week - 1) // 7) * 200
    preview.paste(thumb, (x, y), thumb)
    ImageDraw.Draw(preview).text((x + 5, y + 5), str(week), fill='#333333')

preview_path = root / 'output/background-trial/all-weeks.jpg'
preview_path.parent.mkdir(parents=True, exist_ok=True)
preview.save(preview_path)
print('Prepared and verified 42 transparent WebP illustrations.')

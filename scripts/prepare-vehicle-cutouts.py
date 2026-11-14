"""Derive homepage transparency from the locally recorded studio photographs."""

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage


ROOT = Path(__file__).resolve().parents[1]
ARTWORK = ROOT / "apps/web/public/images/vehicles"
MANIFEST = ARTWORK / "manifest.json"


def silhouette(reference, session):
    pixels = np.asarray(reference).astype(float)
    background = np.median(pixels[:100], axis=(0, 1))
    coarse = np.asarray(remove(reference, session=session, only_mask=True)) > 128
    candidate = ndimage.binary_dilation(coarse, iterations=6)
    candidate &= np.max(np.abs(pixels - background), axis=2) > 6
    labels, _ = ndimage.label(candidate)
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    body = ndimage.binary_fill_holes(labels == np.argmax(sizes))
    inner = ndimage.binary_erosion(body, iterations=2)
    nearest = ndimage.distance_transform_edt(
        ~inner, return_distances=False, return_indices=True
    )
    foreground = pixels[nearest[0], nearest[1]]
    alpha = np.clip(
        np.mean((background - pixels) / np.maximum(background - foreground, 10), axis=2),
        0,
        1,
    )
    alpha[inner] = 1
    alpha[~body] = 0
    rows = np.where(body)[0]
    floor = int(rows.min() + 0.75 * (rows.max() - rows.min()))
    return alpha, background, floor


def cutout(source, silhouette_data, session):
    alpha, background, floor = silhouette_data
    alpha = alpha.copy()
    pixels = np.asarray(source).astype(float)
    near_background = np.max(np.abs(pixels - background), axis=2) < 4
    near_background[floor:] = np.max(np.abs(pixels[floor:] - background), axis=2) < 10
    seeds = np.zeros(alpha.shape, dtype=bool)
    seeds[0] = seeds[-1] = True
    seeds[:, 0] = seeds[:, -1] = True
    outside = ndimage.binary_propagation(seeds, mask=near_background)

    # Paint reflections change the boundary between the sill and its ground shadow.
    source_mask = np.asarray(remove(source, session=session, only_mask=True)) > 128
    lower_mask = ndimage.binary_erosion(source_mask, iterations=1).astype(float)
    alpha[floor:] = ndimage.gaussian_filter(lower_mask, sigma=0.6)[floor:]
    alpha[outside] = 0
    foreground = np.clip(
        (pixels - background * (1 - alpha[..., None]))
        / np.maximum(alpha[..., None], 0.001),
        0,
        255,
    )
    foreground[alpha == 1] = pixels[alpha == 1]

    shadow = np.clip(1 - np.mean(pixels / background, axis=2), 0, 1)
    shadow[:floor] = 0
    shadow[shadow < 0.025] = 0
    combined = alpha + (1 - alpha) * shadow
    rgb = foreground * alpha[..., None] / np.maximum(combined[..., None], 0.001)
    rgba = np.dstack([rgb, combined * 255]).round().astype("uint8")
    return Image.fromarray(rgba)


def main():
    manifest = json.loads(MANIFEST.read_text())
    session = new_session("u2net")
    silhouettes = {}
    derived = []
    sources = [
        asset for asset in manifest["assets"]
        if asset["kind"] == "studio" and asset["view"] == "side"
    ]
    for asset in sources:
        source_path = ARTWORK / asset["file"]
        reference_path = source_path.with_name(f"space-{asset['cladding']}-side.jpg")
        if reference_path not in silhouettes:
            reference = Image.open(reference_path).convert("RGB")
            silhouettes[reference_path] = silhouette(reference, session)
        result = cutout(
            Image.open(source_path).convert("RGB"), silhouettes[reference_path], session
        )
        destination = source_path.with_name(source_path.stem + "-cutout.webp")
        result.save(destination, lossless=True, method=6)
        content = destination.read_bytes()
        derived.append({
            **asset,
            "file": str(destination.relative_to(ARTWORK)),
            "kind": "derived-cutout",
            "derivedFrom": asset["file"],
            "segmentationReference": str(reference_path.relative_to(ARTWORK)),
            "method": "Local U2Net silhouette, source RGB foreground, reconstructed ground shadow; lossless WebP",
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        })
        print(destination.relative_to(ARTWORK), flush=True)
    manifest["assets"] = [
        asset for asset in manifest["assets"] if asset["kind"] != "derived-cutout"
    ] + derived
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()

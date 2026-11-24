"""Prepare front portraits from the catalog on macOS with Vision and ImageMagick."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "apps/web/public/images/vehicles"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def prepare(work):
    manifest_path = ART / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assets = [a for a in manifest["assets"] if a["kind"] != "carplay-portrait"]
    fronts = [a for a in assets if a["kind"] == "studio" and a["view"] == "front"]
    helper = work / "silhouette"
    run("swiftc", ROOT / "scripts/front-silhouette.swift", "-o", helper)
    for asset in fronts:
        source = ART / asset["file"]
        reference = source.with_name(f"space-{asset['cladding']}-front.jpg")
        mask = work / (asset["model"] + "-" + asset["variant"] + "-" + asset["cladding"] + ".png")
        approved = (asset["model"], asset["variant"]) == ("polestar-2", "long-dual")
        if not mask.exists():
            if approved:
                html = (ROOT / "docs/design/carplay/preview.html").read_text()
                svg = html.split('<svg class="defs"', 1)[1].split("</svg>", 1)[0]
                outline = ElementTree.fromstring("<svg" + svg + "</svg>").find(".//path").attrib["d"]
                run("magick", "-size", "1440x810", "xc:black", "-fill", "white",
                    "-draw", f"path '{outline}'", mask)
            else:
                run(helper, reference, mask)
        dest = source.with_name(source.stem + "-portrait.webp")
        run("magick", source, mask, "-alpha", "off", "-compose", "CopyOpacity",
            "-composite", "-trim", "+repage", "-resize", "640x400>", "-quality", "91", dest)
        width, height = map(int, run("magick", "identify", "-format", "%w %h", dest).split())
        contents = dest.read_bytes()
        assets.append({**asset, "kind": "carplay-portrait", "file": dest.relative_to(ART).as_posix(),
                       "width": width, "height": height, "derivedFrom": asset["file"],
                       "segmentationReference": "docs/design/carplay/preview.html#front-mask" if approved
                       else reference.relative_to(ART).as_posix(), "bytes": len(contents),
                       "sha256": hashlib.sha256(contents).hexdigest()})
    manifest["assets"] = assets
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        prepare(Path(directory))

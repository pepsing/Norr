# Polestar vehicle artwork

Downloaded from Polestar on 2026-11-12. The library contains 176 official images, totaling 10,929,214 bytes. Every image is stored locally. The preview loads the selected image on demand.

## Coverage

| Model | Paints | Powertrain and exterior configurations | Images |
| --- | --- | --- | --- |
| Polestar 2 MY2027 | Snow, Vapour, Dune, Midnight, Storm, Space | Standard range Single motor, Long range Single motor, Long range Dual motor, Dual motor with Pro, Dual motor with Performance | 60 studio images and 6 transparent overview images |
| Polestar 4 coupé MY2027 | Snow, Magnesium, Electron, Storm, Space | Rear motor, Dual motor, Rear motor with 21-inch Sport wheels, Dual motor with 21-inch Sport wheels, Dual motor with Performance | 100 studio images and 10 transparent overview images |

The studio collection covers 80 combinations with a side view and a front three-quarter view for each. Polestar 4 includes both black and body-coloured lower claddings. Body-coloured cladding renders include the Prime pack required by the official configurator. Pro and Sport labels identify exterior packages or wheel choices within a powertrain version.

The six Polestar 2 transparent images depict the Performance exterior. Polestar 4 transparent images follow the overview page's wheel and trim presentation. Use the studio images when exact powertrain, wheel and cladding matching matters.

The catalogue follows the UK MY2027 overview and configuration data. Dune appears in the Polestar 2 overview and image renderer, although the live UK ordering picker did not list it on retrieval. Ordering availability varies by market. Historical paints, earlier body details and other model years require additional source assets.

## Sources and provenance

- [Polestar 2 configuration](https://www.polestar.com/uk/configure/polestar-2/)
- [Polestar 2 overview](https://www.polestar.com/uk/polestar-2/)
- [Polestar 4 coupé configuration](https://www.polestar.com/uk/configure/polestar-4-coupe/)
- [Polestar 4 coupé overview](https://www.polestar.com/uk/polestar-4-models/polestar-4-coupe/)

`manifest.json` records the original source URL, paint code, model, variant, cladding, view, dimensions, byte count and SHA-256 digest for each file. Studio URLs use the official renderer's engine, paint, wheel and package codes. All 176 files have distinct digests and verified dimensions. No synthesized paint colours are used in the vehicle images. Picker swatches are approximate UI colours.

Polestar retains rights to its imagery. Publication and redistribution permission remain unverified. The current collection serves the local design preview.

## Reuse

`src/vehicle-catalog.ts` defines model, version, colour and cladding choices. `VehicleArtwork` resolves local image paths. `VehicleAppearancePicker` is shared by connection and garage editing. Native clients can consume the JSON manifest and bundle the same files.

Studio files use JPEG at 1440 × 810. Transparent overview files use PNG at 1600 × 1200. The studio stage keeps its light background in both interface themes to preserve the paint render's original appearance.

Example path pattern follows `polestar-2/long-dual/snow-black-side.jpg` and `polestar-4/dual-performance/electron-body-front.jpg`.

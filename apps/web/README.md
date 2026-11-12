# Norr 北行 interface preview

Runnable React + TypeScript + Vite design for the cross-platform rebuild. The second round extends the Polestar-inspired first design across the main product workflows.

The browser entry shows this simulated preview. Inside Tauri, `src/main.tsx` selects `src/native/NativeApp.tsx`, which calls the shared Rust core through Tauri IPC on macOS, Windows, Android and iOS and reuses the typography, styles, vehicle artwork and modal components. Current implementation and verification status are documented in [development progress](../../docs/PROGRESS.md) and [the native application README](../native/README.md).

Verified with Node.js 22.12.0. Run commands from the repository root.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. `npm run build` checks TypeScript and builds the frontend.

## Design coverage

| Area | Implemented preview |
| --- | --- |
| Garage and connection | Brand and region selection, simulated international authorization, Chinese SMS validation with visible demo code, vehicle discovery, model/version/paint/cladding selection, per-vehicle selection and removal |
| Vehicle overview | Charge, range, lock and climate state, temperature, recent charging and detail navigation |
| Vehicle details | Body openings, tyres, location with privacy handling, health, service, diagnostics, software, specifications, capability inspection and handover export |
| Controls | Lock and climate dialogs, windows, tailgate, horn/lights, air cleaning, supported Volvo engine operation, software installation, departure schedules and named departure routines |
| Command outcomes | Sending, accepted, delivered, service-completed and independently confirmed states; separate readback evidence; manual retry for requests not sent; restore prior settings through a new command within 30 seconds |
| Charging | Target and current limit, session readings and power chart, recurring schedules, editable saved locations, fixed-price estimates and sample hourly-price optimization |
| History | Charging and trip summaries, selectable chart values, date filters, search, sorting, trip hiding/restoration, detail dialogs, consumption breakdown, CSV exports and mileage report |
| Costs | Charging costs and manual fuel entries for the Volvo hybrid example |
| Preferences | Appearance, distance and temperature units, refresh preference, accounts, notification preview and compact charging panel |
| Privacy and data | Screenshot privacy, JSON backup and validated restore, current-vehicle history erasure, account/vehicle removal and handover export |
| States | First-load feedback, empty garage, filtered-empty history, offline snapshot, failed connection, missing/unsupported capabilities, account permission denial, readback mismatch/unavailability and schedule-read provenance |

The selected brand, region and model seed an explicit demo capability profile in `src/capabilities.ts`. Controls require both account permission and an explicit capability flag. A missing flag, `false`, an unfinished adapter and permission denial have distinct explanations. Settings can preview the missing, unsupported and permission-denied cases.

Chinese Polestar 2 examples expose the core controls and climate/charging schedules described in the updated [stack research](../../docs/research/web-pwa-native-stack-2026-11-12.md). Charging-location writes remain unavailable, and Chinese Polestar 4 capabilities remain unchecked while that adapter is unverified. Volvo examples expose hybrid and engine flows and show a vehicle-image placeholder. These are demonstration profiles; integration must supply actual account permissions and per-vehicle capabilities.

## Data and integration

All readings, sessions, trips, authorization and commands are simulated. The header and relevant flows identify this. Chinese login uses the displayed code `123456`. Phone entry only demonstrates form validation.

`src/vehicle.ts` holds the base display model. `src/workspace.tsx` owns the preview garage, settings, schedules, locations and command lifecycle. `src/pages/` holds the reusable page components. The shared `EnergyPanel`, `Modal`, schedule editor, chart and data-row components keep behavior consistent across pages.

Service progress and vehicle evidence are separate. Accepted, delivered and service-completed commands remain unconfirmed until an independent simulated reading matches the requested fields. Mismatched or unavailable readings stay visible with their observation time. Such commands are not automatically retried. Restoring prior settings sends a new simulated command and records its outcome. A command-specific reading does not update the timestamp of the complete vehicle snapshot.

Schedule lists distinguish unrequested, failed, cached, partial and complete reads. Only a complete successful empty read confirms that no plans exist. Partial charging reads retain the existing records and pending deletions until both global and location lists are complete. New or edited schedules show acceptance with field-level confirmation still pending. Climate deletion performs a simulated complete-list read; failed reads retain the pending row. Schedule state is scoped by vehicle and schedule kind.

The browser stores demo state under `hisingen-design-workspace-v2`. Theme preference uses `hisingen-preview-theme`. Backups restore validated data in one state update. Pending receipts restored after interruption become uncertain, allowing the user to inspect the outcome. Legacy success receipts without matching readback evidence become service-completed. Legacy vehicles receive demo capability profiles only when both capability and permission fields are absent; explicitly empty capability maps remain empty. Samples use dates relative to the day the preview is opened.

The native entry now uses the local Rust core for authorization, dispatch, sampling and persistence. Platform adapters provide credential storage, notifications and file access, with desktop tray/menu bar and startup integration. Android and iOS collection runs while the application is in the foreground. Physical-device verification is recorded per platform in [development progress](../../docs/PROGRESS.md). The browser preview continues to simulate these workflows and saves relevant preferences locally. This round uses Simplified Chinese.

## Visual direction

ENERGY 2 / RHYTHM 2 / MOTION 1 follows the Polestar research. Archivo Regular approximates the neutral sans-serif character. Neutral surfaces, straight geometry, regular-weight headings, sparse warm accents and the vehicle silhouette carry the identity. Energy receives the strongest contrast. Controls use operational rows, history uses numeric summaries and selectable charts, and connection uses a staged form.

Lucide's thin vehicle and utility outlines identify actions. Shadows distinguish dialogs and the compact charging overlay. Chart colors use the established text/accent palette with separated bars, labeled values and keyboard-operable selection. Theme and spacing tokens live in `src/styles.css`.

The default example is a Snow Polestar 2 Long range Dual motor. The local MY2027 library contains 176 official images across Polestar 2 and Polestar 4 coupé, 10 powertrain/exterior configurations, six and five paint choices respectively, and two studio views. Polestar 4 also supports black and body-coloured lower claddings. The studio stage keeps a light background in both themes to preserve the original paint appearance. [Asset coverage and provenance](public/images/vehicles/README.md)

The first legacy default example migrates from Polestar 4 to Polestar 2 when loading existing preview state. Vehicle IDs, readings and associated records are preserved. Other vehicles keep their models. Legacy backup imports retain their saved model and receive a default appearance. New backups validate their appearance against the local catalogue. The garage editor changes the local demonstration configuration.

Archivo uses its packaged font license. [Visual research](../../docs/research/polestar-visual-direction-2026-11-12.md)

## Verification

The second-round checks cover the production build, China and Volvo connection flows, invalid SMS code handling, per-vehicle capability gates, command success/failure/retry/verification/undo, schedule editing, location editing, optimization plan creation, history filters and detail dialogs, trip hiding/restoration, fuel entry, unit conversion, notifications, backup export, history erasure, restore and reload persistence.

Responsive browser checks cover the five main destinations and their subpages at 320 and 768 pixels, vehicle-detail sections at 320 pixels, and visual review at 390 and 1440 pixels. Browser viewport simulation is the current device evidence.

- Hard Gate PASS. Main and detail views pass the checked narrow layouts after fixing the trip filter checkbox. Forms have visible labels, constrained input and recovery feedback. Keyboard focus, Escape dismissal and reduced-motion styles are present. The existing light and dark token pairs retain minimum text contrast of 4.65 and 5.66 to 1.
- Purpose Gate PASS. Vehicle, control, charging, history and setup layouts follow their respective tasks. Typography, icon, accent and elevation purposes are recorded above.
- Liveliness PASS. Vehicle imagery, large readings and varied page compositions preserve ENERGY 2 / RHYTHM 2 / MOTION 1 across the expanded workflows.
- Craftsmanship PASS. Type checking and production build pass. Core additions have browser click-through evidence, including persisted state and recovery paths.

### Vehicle artwork update

The artwork update passed the production build and regression checks for 80 catalogue combinations, migration idempotence, legacy backup import, retained vehicle IDs and schedules, and rejection of invalid appearance data. All 176 image files passed SHA-256 and dimension checks.

Browser verification covered all paint and version choices, both views, both Polestar 4 claddings, cancellation, keyboard paint selection, Escape dismissal, save/reload persistence, the updated vehicle specification rows and adding/removing a configured test vehicle. The original three-vehicle garage remains available. The preview finishes on the Snow Polestar 2 overview. Current browser error logs are empty.

- Hard Gate PASS. The picker and connection flow fit the checked 320, 390, 768 and 1440 pixel viewports. Keyboard selection and Escape work. The light studio stage's muted text contrast is 5.15 to 1. Light and dark modes have been inspected.
- Purpose Gate PASS. Paint swatches select named paints. Version and cladding controls map to distinct local official images. The light studio background preserves the source photography in both themes.
- Liveliness PASS. ENERGY 2 / RHYTHM 2 / MOTION 1 continues through the vehicle image, high-contrast energy readings and restrained selection feedback.
- Craftsmanship PASS. Build, image verification and all 80 configuration round trips pass. Screenshots are in `docs/preview/polestar-2-overview.jpg` and `docs/preview/polestar-4-appearance.jpg` from the repository root.

### Updated stack research alignment

The preview follows the updated November 12 research for China P2/P4 capability boundaries, command confirmation and schedule provenance. Verification covers capability and account isolation, missing versus false flags, legacy backup migration, malformed-field rejection and receipt-evidence migration. Browser checks cover accepted commands followed by matching readback, mismatched and unavailable readbacks, restoring prior settings as a new command, climate schedule add/edit/delete, partial charging reads retaining pending deletion, complete empty reads and reload persistence. A separate China P2 demo vehicle was added for these flows; existing examples were retained.

- Hard Gate PASS. The new settings, command history and schedule states fit the checked 320-pixel viewport. Disabled controls explain missing capability or permission. Service acceptance never asserts confirmed execution.
- Purpose Gate PASS. Timestamps identify the reading being shown. Full-list status determines whether an empty schedule list is authoritative. Native integration progress is confined to the relevant connection and about views.
- Liveliness PASS. ENERGY 2 / RHYTHM 2 / MOTION 1 retains the existing Polestar typography, action hierarchy and restrained row layouts. No decorative assets or effects were added.
- Craftsmanship PASS. Type checking, production build and targeted data checks pass. Browser verification covers the changed state transitions and persistence; the result remains a local simulation. Screenshots are in `docs/preview/china-p2-controls.jpg` and `docs/preview/china-p2-command-states.jpg` from the repository root.

import AppIntents
import Foundation

@available(iOS 16.0, *)
struct NorrShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetVehicleEnergyInformationIntent(),
            phrases: [
                "Check \(\.$information) with \(.applicationName)",
                "Check energy information with \(.applicationName)",
            ],
            shortTitle: "电量与充电",
            systemImageName: "battery.75percent"
        )
        AppShortcut(
            intent: GetVehicleLockStateIntent(),
            phrases: ["Check vehicle lock with \(.applicationName)"],
            shortTitle: "门锁状态",
            systemImageName: "lock"
        )
        AppShortcut(
            intent: ControlVehicleLockIntent(),
            phrases: [
                "\(\.$operation) with \(.applicationName)",
                "Control door locks with \(.applicationName)",
            ],
            shortTitle: "门锁控制",
            systemImageName: "lock.fill"
        )
        AppShortcut(
            intent: ControlVehicleWindowsIntent(),
            phrases: [
                "\(\.$operation) the windows with \(.applicationName)",
                "Control the windows with \(.applicationName)",
            ],
            shortTitle: "车窗控制",
            systemImageName: "window.vertical.closed"
        )
        AppShortcut(
            intent: ControlVehicleTailgateIntent(),
            phrases: [
                "\(\.$operation) the trunk with \(.applicationName)",
                "Control the trunk with \(.applicationName)",
            ],
            shortTitle: "后备箱控制",
            systemImageName: "car.fill"
        )
        AppShortcut(
            intent: ControlVehicleClimateIntent(),
            phrases: [
                "\(\.$operation) air conditioning with \(.applicationName)",
                "Control air conditioning with \(.applicationName)",
            ],
            shortTitle: "空调控制",
            systemImageName: "fan.fill"
        )
    }
}

@objc final class NorrSiriRegistration: NSObject {
    @objc static func refreshShortcuts() {
        if #available(iOS 16.0, *) {
            NorrShortcuts.updateAppShortcutParameters()
        }
    }
}

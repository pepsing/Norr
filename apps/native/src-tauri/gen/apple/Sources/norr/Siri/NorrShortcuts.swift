import AppIntents
import Foundation

@available(iOS 16.0, *)
struct NorrShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetVehicleEnergyIntent(),
            phrases: ["Check vehicle battery with \(.applicationName)"],
            shortTitle: "车辆电量",
            systemImageName: "battery.75percent"
        )
        AppShortcut(
            intent: GetVehicleLockStateIntent(),
            phrases: ["Check vehicle lock with \(.applicationName)"],
            shortTitle: "门锁状态",
            systemImageName: "lock"
        )
        AppShortcut(
            intent: LockVehicleIntent(),
            phrases: ["Lock my car with \(.applicationName)"],
            shortTitle: "锁车",
            systemImageName: "lock.fill"
        )
        AppShortcut(
            intent: StartVehicleClimateIntent(),
            phrases: ["Start car climate with \(.applicationName)"],
            shortTitle: "开启空调",
            systemImageName: "fan.fill"
        )
        AppShortcut(
            intent: StopVehicleClimateIntent(),
            phrases: ["Stop car climate with \(.applicationName)"],
            shortTitle: "关闭空调",
            systemImageName: "fan"
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

import Foundation

struct WatchWidgetSnapshot: Codable {
  var model: String
  var batteryPercent: Double?
  var rangeKm: Double?
  var updatedAt: Date?
  var isDemo: Bool = false
    var freshnessPending: Bool? = nil
}

enum WatchWidgetCache {
  static let group = "group.app.norr.watch"
  private static let key = "vehicleSnapshot"

  private static var defaults: UserDefaults? {
    let remapped = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String]
    return UserDefaults(suiteName: remapped?.first(where: { $0.contains(group) }) ?? group)
  }

  static func save(_ snapshot: WatchWidgetSnapshot) throws {
    guard let defaults else { throw CocoaError(.fileWriteNoPermission) }
    defaults.set(try JSONEncoder().encode(snapshot), forKey: key)
  }

  static func read() -> WatchWidgetSnapshot? {
    guard let data = defaults?.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(WatchWidgetSnapshot.self, from: data)
  }

  static func clear() throws {
    guard let defaults else { throw CocoaError(.fileWriteNoPermission) }
    defaults.removeObject(forKey: key)
  }
}

import Foundation

public enum WidgetStorage {
  private static let lock = NSLock()
  public static let groupIdentifier = "group.app.norr.widgets"

  public static func directory() -> URL? {
    directory(info: Bundle.main.infoDictionary ?? [:]) {
      FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)
    }
  }

  public static func directory(info: [String: Any], container: (String) -> URL?) -> URL? {
    guard let configured = info["ALTAppGroups"] else {
      return container(groupIdentifier)
    }
    // AltStore writes each bundle's provisioned groups after adding the signing team suffix.
    guard let groups = configured as? [String] else { return nil }
    let matches = Set(groups.filter {
      $0 == groupIdentifier || $0.hasPrefix(groupIdentifier + ".")
    })
    guard matches.count == 1, let identifier = matches.first else { return nil }
    return container(identifier)
  }

  public static func clear(in directory: URL) throws {
    lock.lock()
    defer { lock.unlock() }
    do { try FileManager.default.removeItem(at: directory.appendingPathComponent("vehicle.json")) }
    catch CocoaError.fileNoSuchFile {}
  }

  public static func write(_ bytes: Data, to directory: URL) throws {
    lock.lock()
    defer { lock.unlock() }
    let path = directory.appendingPathComponent("vehicle.json")
    if let next = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
       let data = next["data"] as? [String: Any],
       let oldBytes = try? Data(contentsOf: path),
       let old = try? JSONSerialization.jsonObject(with: oldBytes) as? [String: Any],
       var previous = old["data"] as? [String: Any],
       let account = data["accountScope"] as? String, account == previous["accountScope"] as? String,
       data["vin"] as? String == previous["vin"] as? String,
       (previous["observedAt"] as? Double ?? 0) > (data["observedAt"] as? Double ?? 0) {
      // A newer Siri reading can arrive before the settings screen publishes its artwork.
      var merged = next
      previous["artwork"] = data["artwork"]
      merged["data"] = previous
      try JSONSerialization.data(withJSONObject: merged).write(to: path, options: .atomic)
      return
    }
    try bytes.write(to: path, options: .atomic)
  }

  public static func applyReadback(_ values: [String: Any], in directory: URL) throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let path = directory.appendingPathComponent("vehicle.json")
    guard let bytes = try? Data(contentsOf: path),
          var record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          var data = record["data"] as? [String: Any],
          let account = values["accountScope"] as? String, !account.isEmpty,
          account == data["accountScope"] as? String,
          let vin = values["vin"] as? String, vin == data["vin"] as? String,
          let observedAt = (values["observedAt"] as? NSNumber)?.doubleValue, observedAt.isFinite, observedAt > 0,
          observedAt >= (data["observedAt"] as? Double ?? 0) else { return false }
    for key in ["model", "batteryPercent", "rangeKm", "locked", "climate", "charging", "updatedAt", "freshnessPending", "observedAt"] {
      if let value = values[key] { data[key] = value }
    }
    record["data"] = data
    try JSONSerialization.data(withJSONObject: record).write(to: path, options: .atomic)
    return true
  }
}

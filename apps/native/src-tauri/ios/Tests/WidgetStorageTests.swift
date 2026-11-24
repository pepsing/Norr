import Foundation

@main
struct WidgetStorageTests {
  static func main() throws {
    let base = WidgetStorage.groupIdentifier
    let resigned = base + ".TESTTEAM01"
    let originalURL = URL(fileURLWithPath: "/original")
    let resignedURL = URL(fileURLWithPath: "/resigned")
    let containers = [base: originalURL, resigned: resignedURL]
    func resolve(_ info: [String: Any]) -> URL? {
      WidgetStorage.directory(info: info) { containers[$0] }
    }
    precondition(resolve([:]) == originalURL)
    precondition(resolve(["ALTAppGroups": [resigned]]) == resignedURL)
    precondition(resolve(["ALTAppGroups": ["group.other", resigned]]) == resignedURL)
    precondition(resolve(["ALTAppGroups": [resigned, resigned]]) == resignedURL)
    precondition(resolve(["ALTAppGroups": [base]]) == originalURL)
    for invalid: Any in [[], ["group.other"], [base + "-other"], [base, resigned], "invalid", [base + ".UNAUTHORIZED"]] {
      precondition(resolve(["ALTAppGroups": invalid]) == nil)
    }
    precondition(WidgetStorage.directory(info: [:]) { _ in nil } == nil)

    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let info: [String: Any] = ["ALTAppGroups": [resigned]]
    let app = WidgetStorage.directory(info: info) { $0 == resigned ? root : nil }!
    let widget = WidgetStorage.directory(info: info) { $0 == resigned ? root : nil }!
    let bytes = Data("{\"batteryPercent\":30}".utf8)
    try bytes.write(to: app.appendingPathComponent("vehicle.json"), options: .atomic)
    let readback = try Data(contentsOf: widget.appendingPathComponent("vehicle.json"))
    precondition(readback == bytes)
    let record: [String: Any] = ["data": ["vin": "fixture-vin", "accountScope": "fixture-account", "observedAt": 100,
        "batteryPercent": 42, "locked": true, "artwork": "fixture.jpg"], "imageName": "fixture.jpg"]
    try WidgetStorage.write(JSONSerialization.data(withJSONObject: record), to: root)
    var values: [String: Any] = ["vin": "fixture-vin", "accountScope": "fixture-account", "observedAt": 200, "locked": false]
    func checkReadback(_ values: [String: Any], _ expected: Bool) throws {
      let applied = try WidgetStorage.applyReadback(values, in: root)
      precondition(applied == expected)
    }
    try checkReadback(values, true)
    func stored() throws -> [String: Any] {
      try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("vehicle.json"))) as! [String: Any]
    }
    var saved = try stored()
    precondition((saved["data"] as! [String: Any])["locked"] as? Bool == false)
    precondition((saved["data"] as! [String: Any])["batteryPercent"] as? Int == 42)
    precondition(saved["imageName"] as? String == "fixture.jpg")
    try WidgetStorage.write(JSONSerialization.data(withJSONObject: record), to: root)
    saved = try stored()
    precondition((saved["data"] as! [String: Any])["locked"] as? Bool == false)
    for replacement in [["vin": "other-vin"], ["accountScope": "other-account"], ["accountScope": ""]] {
      var changed = values
      replacement.forEach { changed[$0.key] = $0.value }
      try checkReadback(changed, false)
    }
    values["observedAt"] = 99
    try checkReadback(values, false)
    let image = root.appendingPathComponent("fixture.jpg")
    try Data([1, 2, 3]).write(to: image)
    try WidgetStorage.clear(in: root)
    try WidgetStorage.clear(in: root)
    precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent("vehicle.json").path))
    precondition(FileManager.default.fileExists(atPath: image.path))
    try checkReadback(values, false)
    print("PASS: original/resigned groups, invalid/ambiguous/missing permissions, shared data round trip")
    print("PASS: clear/idempotence, preserve artwork, scoped Siri readback, late write protection")
  }
}

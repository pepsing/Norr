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
    print("PASS: original/resigned groups, invalid/ambiguous/missing permissions, shared data round trip")
  }
}

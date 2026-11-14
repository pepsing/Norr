import Foundation

public enum WidgetStorage {
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
}

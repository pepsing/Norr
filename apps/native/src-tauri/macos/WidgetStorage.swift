import Foundation
import Darwin

enum WidgetStorage {
  static func directory() -> URL? {
    // Foundation home-directory APIs resolve to the extension's sandbox container.
    guard let user = getpwuid(getuid()), let path = user.pointee.pw_dir else { return nil }
    let home = String(cString: path)
    return URL(fileURLWithPath: home, isDirectory: true)
      .appendingPathComponent("Library/Application Support/app.norr.mac/widgets", isDirectory: true)
  }
}

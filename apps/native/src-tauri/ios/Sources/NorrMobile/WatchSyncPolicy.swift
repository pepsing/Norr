import Foundation

enum WatchSyncPolicy {
    static func shouldSend(automatic: Bool, paused: Bool, current: [String: Any], previous: [String: Any]?) -> Bool {
        guard automatic else { return true }
        guard !paused else { return false }
        guard var previous else { return true }
        var current = current
        previous.removeValue(forKey: "version")
        current.removeValue(forKey: "version")
        return !NSDictionary(dictionary: previous).isEqual(to: current)
    }
}

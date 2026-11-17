import Foundation

struct WatchSnapshot: Codable {
    var vin: String
    var model: String
    var batteryPercent: Double?
    var rangeKm: Double?
    var locked: Bool?
    var climateActive: Bool?
    var targetTemperature: Double?
    var interiorTemperature: Double?
    var chargePower: Double?
    var chargeTarget: Double?
    var chargingState: String?
    var updatedAt: Date?
    var lockUpdatedAt: Date?
    var climateUpdatedAt: Date?

    func confirms(_ record: WatchPendingCommand) -> Bool {
        guard vin == record.vin else { return false }
        switch record.action {
        case "lock", "unlock":
            return (lockUpdatedAt ?? .distantPast) >= record.sentAt && locked == (record.action == "lock")
        case "climateStart", "climateStop":
            return (climateUpdatedAt ?? .distantPast) >= record.sentAt && climateActive == (record.action == "climateStart")
        default:
            return false
        }
    }
}

struct WatchFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct WatchAuthorization: Codable {
    let version: Double
    let account: String
    let vin: String
    let accessToken: String
    let expiresAt: Double

    var isValid: Bool {
        guard version.isFinite, version > 0, expiresAt.isFinite else { return false }
        if accessToken.isEmpty { return account.isEmpty && vin.isEmpty && expiresAt == 0 }
        return !account.isEmpty && expiresAt > 0 && vin.utf8.count == 17
            && vin.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }
    }

    static func restored(from data: Data) -> WatchAuthorization? {
        guard let grant = try? JSONDecoder().decode(Self.self, from: data), grant.isValid, !grant.accessToken.isEmpty else {
            return nil
        }
        return grant
    }
}

struct WatchPendingCommand: Codable {
    let id: UUID
    let account: String
    let vin: String
    let action: String
    let sentAt: Date
}

struct WatchPendingCommands: Codable {
    private(set) var records: [WatchPendingCommand] = []

    func pending(for authorization: WatchAuthorization?) -> WatchPendingCommand? {
        guard let authorization, !authorization.accessToken.isEmpty else { return nil }
        return records.first { $0.account == authorization.account && $0.vin == authorization.vin }
    }

    mutating func store(_ command: WatchPendingCommand) {
        remove(account: command.account, vin: command.vin)
        records.append(command)
    }

    mutating func remove(account: String, vin: String) {
        records.removeAll { $0.account == account && $0.vin == vin }
    }

    mutating func clear(account: String) {
        records.removeAll { $0.account == account }
    }

    static func restored(from data: Data?, legacyData: Data?) -> WatchPendingCommands {
        if let data, let commands = try? JSONDecoder().decode(Self.self, from: data) {
            return commands
        }
        var commands = Self()
        if let legacyData, let command = try? JSONDecoder().decode(WatchPendingCommand.self, from: legacyData) {
            commands.store(command)
        }
        return commands
    }
}

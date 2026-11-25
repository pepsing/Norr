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
    var freshnessPending: Bool? = nil
    var vehicleService: String? = nil
    var observedAt: Date? = nil

    func pendingReason(for record: WatchPendingCommand) -> String {
        let reported = record.group == "lock" ? lockUpdatedAt : climateUpdatedAt
        if freshnessPending == true { return "车辆仍在更新，尚未确认操作结果" }
        guard let reported else { return "车辆尚未返回这项车况的上报时间" }
        if reported <= record.sentAt {
            return "最近上报于" + reported.formatted(date: .omitted, time: .standard) + "，仍在等待操作后的车况"
        }
        return "尚未取得与操作匹配的车况"
    }

    func confirms(_ record: WatchPendingCommand) -> Bool {
        guard vin == record.vin, freshnessPending != true else { return false }
        if let observedAt, !record.blocks(record.action, now: observedAt) { return false }
        func fresh(_ date: Date?) -> Bool {
            guard let date else { return false }
            guard date.timeIntervalSince(record.sentAt) < 600 else { return false }
            if vehicleService == "xchanger" {
                guard let observedAt, date <= observedAt else { return false }
                return date > record.sentAt
            }
            return date >= record.sentAt && (observedAt == nil || date <= observedAt!)
        }
        switch record.action {
        case "lock", "unlock":
            return fresh(lockUpdatedAt) && locked == (record.action == "lock")
        case "climateStart", "climateStop":
            return fresh(climateUpdatedAt) && climateActive == (record.action == "climateStart")
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
    var service: String? = nil
    var xchanger: WatchXchangerAuthorization? = nil

    var validUntil: Double { min(expiresAt, xchanger?.expiresAt ?? expiresAt) }

    var isValid: Bool {
        guard version.isFinite, version > 0, expiresAt.isFinite else { return false }
        if accessToken.isEmpty { return account.isEmpty && vin.isEmpty && expiresAt == 0 }
        let validService = (service == nil || service == "c3") ? xchanger == nil
            : service == "xchanger" && xchanger?.isValid == true
        return validService && !account.isEmpty && expiresAt > 0 && vin.utf8.count == 17
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

    var group: String { Self.group(action) }

    static func group(_ action: String) -> String {
        switch action {
        case "lock", "unlock": return "lock"
        case "climateStart", "climateStop": return "climate"
        default: return action
        }
    }

    func blocks(_ action: String, now: Date = .now) -> Bool {
        group == Self.group(action) && now.timeIntervalSince(sentAt) < 600
    }
}

struct WatchPendingCommands: Codable {
    private(set) var records: [WatchPendingCommand] = []

    func pending(for authorization: WatchAuthorization?, now: Date = .now) -> WatchPendingCommand? {
        guard let authorization, !authorization.accessToken.isEmpty else { return nil }
        let current = records.filter { $0.account == authorization.account && $0.vin == authorization.vin }
        return current.first { $0.blocks($0.action, now: now) } ?? current.first
    }

    func blocking(_ action: String, for authorization: WatchAuthorization?, now: Date = .now) -> WatchPendingCommand? {
        guard let authorization, !authorization.accessToken.isEmpty else { return nil }
        return records.last {
            $0.account == authorization.account && $0.vin == authorization.vin && $0.blocks(action, now: now)
        }
    }

    mutating func reconcile(_ snapshot: WatchSnapshot, for authorization: WatchAuthorization) {
        records.removeAll {
            $0.account == authorization.account && $0.vin == authorization.vin && snapshot.confirms($0)
        }
    }

    mutating func store(_ command: WatchPendingCommand) {
        records.removeAll { $0.account == command.account && $0.vin == command.vin && $0.group == command.group }
        records.append(command)
    }

    mutating func remove(id: UUID) { records.removeAll { $0.id == id } }

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

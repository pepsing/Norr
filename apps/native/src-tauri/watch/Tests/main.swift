import Foundation

func rejects(_ data: Data) {
    do {
        _ = try WatchWire(data)
        fatalError("Expected malformed input rejection")
    } catch {}
}

let fixture = WatchWire.string(2, "TESTVIN0000000000")
    + WatchWire.bytes(3, WatchWire.bytes(1, WatchWire.integer(1, 1_700_000_000) + WatchWire.integer(2, 500_000_000))
        + WatchWire.float(2, 78.5) + WatchWire.integer(4, 320))
let envelope = try WatchWire(fixture)
assert(envelope.string(2) == "TESTVIN0000000000")
let battery = try envelope.nested(3)!
assert(battery.number(2) == 78.5)
assert(battery.number(4) == 320)
let timestamp = try battery.timestamp(1)
assert(timestamp?.timeIntervalSince1970 == 1_700_000_000.5)
let maxInteger = try WatchWire(WatchWire.integer(1, UInt64.max))
assert(maxInteger.int(1) == UInt64.max)
let legacyExterior = try WatchWire(WatchWire.bytes(1, WatchWire.integer(1, 2)))
let legacyLock = try legacyExterior.nested(1)?.int(1)
assert(legacyLock == 2)
let invalidTimestamp = try WatchWire(WatchWire.bytes(1, WatchWire.integer(1, 123) + WatchWire.integer(2, 1_000_000_000)))
let invalidTime = try invalidTimestamp.timestamp(1)
assert(invalidTime == nil)
let nan = try WatchWire(WatchWire.float(1, .nan))
assert(nan.number(1) == nil)
rejects(Data([0]))
rejects(Data([10, 5, 1]))
rejects(Data([8] + Array(repeating: 255, count: 10)))
rejects(Data([13, 0]))
rejects(Data([15]))
rejects(Data(repeating: 0, count: 2_000_001))
print("WatchWire fixtures passed: scalar, nested, timestamp, legacy, malformed, truncated, oversized, overflow, NaN")
let vin = "TESTVIN0000000000"
let sentAt = Date(timeIntervalSince1970: 1_700_000_000)
let command = WatchPendingCommand(id: UUID(), account: "fixture", vin: vin, action: "unlock", sentAt: sentAt)
var snapshot = WatchSnapshot(vin: vin, model: "Polestar", locked: false, lockUpdatedAt: sentAt)
assert(snapshot.confirms(command))
snapshot.lockUpdatedAt = sentAt.addingTimeInterval(-1)
assert(!snapshot.confirms(command))
snapshot.lockUpdatedAt = sentAt
snapshot.locked = true
assert(!snapshot.confirms(command))
snapshot.locked = false
snapshot.vin = "OTHERVIN000000000"
assert(!snapshot.confirms(command))
snapshot.vin = vin
snapshot.lockUpdatedAt = nil
assert(!snapshot.confirms(command))
let climateCommand = WatchPendingCommand(id: UUID(), account: "fixture", vin: vin, action: "climateStart", sentAt: sentAt)
snapshot.climateActive = true
snapshot.climateUpdatedAt = sentAt
assert(snapshot.confirms(climateCommand))
snapshot.climateUpdatedAt = sentAt.addingTimeInterval(-1)
assert(!snapshot.confirms(climateCommand))
let authorization = WatchAuthorization(version: 1, account: "fixture", vin: vin, accessToken: "offline-fixture", expiresAt: 2_000_000_000_000)
let stored = try JSONEncoder().encode(authorization)
assert(WatchAuthorization.restored(from: stored)?.account == "fixture")
let clear = WatchAuthorization(version: 2, account: "", vin: "", accessToken: "", expiresAt: 0)
let clearedStorage = try JSONEncoder().encode(clear)
assert(clear.isValid)
assert(WatchAuthorization.restored(from: clearedStorage) == nil)
assert(WatchAuthorization.restored(from: Data()) == nil)
let malformed = WatchAuthorization(version: 3, account: "fixture", vin: "../invalid", accessToken: "offline-fixture", expiresAt: 10)
assert(!malformed.isValid)
let malformedStorage = try JSONEncoder().encode(malformed)
assert(WatchAuthorization.restored(from: malformedStorage) == nil)
print("Watch lifecycle fixtures passed: fresh, stale, mismatch, absent timestamp, clear/restart, invalid grant")

var pendingCommands = WatchPendingCommands()
pendingCommands.store(command)
let secondVIN = "TESTVIN0000000001"
let secondVehicle = WatchAuthorization(version: 2, account: authorization.account, vin: secondVIN, accessToken: "offline-fixture", expiresAt: authorization.expiresAt)
assert(pendingCommands.pending(for: secondVehicle) == nil)
assert(pendingCommands.pending(for: authorization)?.id == command.id)
let renewedAuthorization = WatchAuthorization(version: 3, account: authorization.account, vin: vin, accessToken: "renewed-offline-fixture", expiresAt: authorization.expiresAt + 1000)
assert(pendingCommands.pending(for: renewedAuthorization)?.id == command.id)
let secondCommand = WatchPendingCommand(id: UUID(), account: authorization.account, vin: secondVIN, action: "lock", sentAt: sentAt)
pendingCommands.store(secondCommand)
assert(pendingCommands.pending(for: secondVehicle)?.id == secondCommand.id)
assert(pendingCommands.pending(for: authorization)?.id == command.id)
let otherAccount = WatchAuthorization(version: 4, account: "another-fixture", vin: vin, accessToken: "offline-fixture", expiresAt: authorization.expiresAt)
assert(pendingCommands.pending(for: otherAccount) == nil)
let otherAccountCommand = WatchPendingCommand(id: UUID(), account: otherAccount.account, vin: vin, action: "climateStop", sentAt: sentAt)
pendingCommands.store(otherAccountCommand)
let persistedCommands = try JSONEncoder().encode(pendingCommands)
var restartedCommands = WatchPendingCommands.restored(from: persistedCommands, legacyData: nil)
assert(restartedCommands.pending(for: authorization)?.id == command.id)
assert(restartedCommands.pending(for: secondVehicle)?.id == secondCommand.id)
assert(restartedCommands.pending(for: otherAccount)?.id == otherAccountCommand.id)
restartedCommands.remove(account: authorization.account, vin: secondVIN)
assert(restartedCommands.pending(for: secondVehicle) == nil)
assert(restartedCommands.pending(for: authorization)?.id == command.id)
assert(restartedCommands.pending(for: otherAccount)?.id == otherAccountCommand.id)
pendingCommands.clear(account: authorization.account)
assert(pendingCommands.pending(for: authorization) == nil)
assert(pendingCommands.pending(for: secondVehicle) == nil)
assert(pendingCommands.pending(for: otherAccount)?.id == otherAccountCommand.id)
assert(pendingCommands.pending(for: clear) == nil)
assert(pendingCommands.pending(for: nil) == nil)
let legacyCommand = try JSONEncoder().encode(command)
let migratedCommands = WatchPendingCommands.restored(from: nil, legacyData: legacyCommand)
assert(migratedCommands.pending(for: authorization)?.id == command.id)
let clearedCommands = try JSONEncoder().encode(pendingCommands)
let noLegacyResurrection = WatchPendingCommands.restored(from: clearedCommands, legacyData: legacyCommand)
assert(noLegacyResurrection.pending(for: authorization) == nil)
assert(noLegacyResurrection.pending(for: otherAccount)?.id == otherAccountCommand.id)
print("Watch pending fixtures passed: vehicle switch/return, renewal, account isolation, clear, restart, legacy migration")

let syncGrant: [String: Any] = ["version": 1, "account": "fixture-account", "vin": "FIXTURE00000000001", "accessToken": "fixture-token", "expiresAt": 1000]
var nextGrant = syncGrant
nextGrant["version"] = 2
assert(!WatchSyncPolicy.shouldSend(automatic: true, paused: false, current: nextGrant, previous: syncGrant))
assert(WatchSyncPolicy.shouldSend(automatic: false, paused: true, current: nextGrant, previous: syncGrant))
assert(WatchSyncPolicy.shouldSend(automatic: true, paused: false, current: syncGrant, previous: nil))
for key in ["account", "vin", "accessToken", "expiresAt"] {
    var changed = nextGrant
    changed[key] = key == "expiresAt" ? 2000 : "changed-fixture"
    assert(WatchSyncPolicy.shouldSend(automatic: true, paused: false, current: changed, previous: syncGrant))
    assert(!WatchSyncPolicy.shouldSend(automatic: true, paused: true, current: changed, previous: syncGrant))
}
let clearGrant: [String: Any] = ["version": 3, "account": "", "vin": "", "accessToken": "", "expiresAt": 0]
assert(WatchSyncPolicy.shouldSend(automatic: true, paused: false, current: clearGrant, previous: syncGrant))
assert(WatchSyncPolicy.shouldSend(automatic: true, paused: false, current: syncGrant, previous: clearGrant))
print("Watch automatic sync fixtures passed: initial, deduplication, renewal, account/vehicle change, pause, manual retry, clear")

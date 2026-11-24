import Foundation

func rejectsP4(_ operation: () throws -> Void) {
    do { try operation(); fatalError("Expected P4 rejection") } catch {}
}

let p4Query = WatchXchanger.query(["userId": "test user", "target": "", "latest": "true"])
assert(p4Query == "latest=true&target=&userId=test%20user")
assert(WatchXchanger.query(["z": "", "q": "a b+*~%,&=北"]) == "q=a%20b%2B%2A~%25%2C%26%3D%E5%8C%97&z=")
assert(WatchXchanger.signature(key: Data("fixture-secret".utf8),
                              path: "/remote-control/vehicle/status/TEST1234567890123", query: p4Query,
                              body: Data(), time: 1700000000000, nonce: "fixture-nonce", method: "GET") == "aV+SgF7vyIjxgsMRBpWqh8OvvWI=")
assert(WatchXchanger.signature(key: Data("fixture-secret".utf8), path: "/auth-center/account/session", query: "",
                              body: Data(#"{"identityType":"polestar","accessToken":"fixture"}"#.utf8),
                              time: 1700000000000, nonce: "fixture-nonce", method: "POST") == "bc3WgfAUBbkUV9eotz9vVkBu6FU=")
let p4Grant = WatchXchangerAuthorization(accessToken: "fixture", userId: "fixture-user", clientId: "fixture-client",
                                         deviceId: "fixture-device", signingKey: Data("fixture-secret".utf8).base64EncodedString(),
                                         expiresAt: 4_000_000_000_000)
var p4Authorization = WatchAuthorization(version: 1, account: "fixture", vin: "TESTVIN0000000000", accessToken: "fixture-cn",
                                         expiresAt: 4_100_000_000_000, service: "xchanger", xchanger: p4Grant)
assert(p4Authorization.isValid && p4Authorization.validUntil == p4Grant.expiresAt)
let p4AuthorizationData = try JSONEncoder().encode(p4Authorization)
assert(!String(decoding: p4AuthorizationData, as: UTF8.self).contains("refreshToken"))
assert(WatchAuthorization.restored(from: p4AuthorizationData)?.service == "xchanger")
p4Authorization.xchanger = nil
assert(!p4Authorization.isValid)
let p4Client = WatchXchanger(grant: p4Grant, vin: "TESTVIN0000000000")
for (action, service) in [("lock", "RDL_2"), ("unlock", "RDU_2"), ("climateStart", "RCE_2"), ("climateStop", "RCE_2")] {
    let request = try p4Client.controlRequest(action)
    assert(request.httpMethod == "PUT" && request.url?.host == "device-api.xchanger.cn")
    assert(request.value(forHTTPHeaderField: "Authorization") == "fixture")
    let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
    assert(body["serviceId"] as? String == service)
    assert(body["command"] as? String == (action == "climateStop" ? "stop" : "start"))
    assert(body["userId"] as? String == "fixture-user")
    if action == "climateStart" {
        let parameters = body["serviceParameters"] as! [[String: String]]
        assert(parameters.contains(["key": "rce.temp", "value": "22"]))
        assert((body["operationScheduling"] as! [String: Any])["duration"] as? Int == 180)
    }
}
rejectsP4 { _ = try p4Client.controlRequest("tailgateOpen") }
rejectsP4 { _ = try WatchXchanger.response(http: 401, data: [:]) }
rejectsP4 { _ = try WatchXchanger.response(http: 200, data: ["error": ["code": "1403"]]) }
assert(!WatchXchanger.rejected(http: 504, data: [:]))
assert(!WatchXchanger.rejected(http: 200, data: ["code": 1000, "data": ["serviceResult": ["operationResult": 5]]]))
assert(WatchXchanger.rejected(http: 200, data: ["code": 1000, "data": ["success": false]]))
assert(!WatchXchanger.rejected(http: 200, data: ["code": 1000, "success": 0]))
let p4Capabilities: [String: Any] = ["list": [
    ["functionId": "remote_control_lock_2", "valueEnable": false],
    ["functionId": "remote_control_lock", "valueEnable": true],
    ["functionId": "remote_control_unlock_2", "valueEnable": true],
    ["functionId": "remote_climate_control_2", "valueEnable": true],
]]
assert(WatchXchanger.capabilities(p4Capabilities) == ["supportsLock": false, "supportsUnlock": true, "supportsParkingClimatization": true])
assert(WatchXchanger.capabilities(["list": [["functionId": "remote_control_lock_2", "valueEnable": 1]]]).isEmpty)
let p4Status: [String: Any] = [
    "result": ["serviceResult": ["operationResult": 0]],
    "vehicleStatus": ["configuration": ["vin": "TESTVIN0000000000"], "updateTime": 1700000001,
        "additionalVehicleStatus": [
            "electricVehicleStatus": ["chargeLevel": "0", "distanceToEmptyOnBatteryOnly": 250, "chargerState": 2],
            "drivingSafetyStatus": ["centralLockingStatus": 0],
            "climateStatus": ["preClimateActive": true, "interiorTemp": 20],
        ]],
]
var p4Snapshot = try WatchXchanger.snapshot(p4Status, target: ["soc": "900"], vin: "TESTVIN0000000000", now: Date(timeIntervalSince1970: 1700000002))
assert(p4Snapshot.batteryPercent == 0 && p4Snapshot.rangeKm == 250 && p4Snapshot.chargeTarget == 90)
assert(p4Snapshot.locked == false && p4Snapshot.climateActive == true && p4Snapshot.targetTemperature == nil)
let p4Pending = WatchPendingCommand(id: UUID(), account: "fixture", vin: p4Snapshot.vin, action: "unlock", sentAt: Date(timeIntervalSince1970: 1700000000))
assert(p4Snapshot.confirms(p4Pending))
p4Snapshot.freshnessPending = true
assert(!p4Snapshot.confirms(p4Pending))
p4Snapshot.freshnessPending = false
p4Snapshot.lockUpdatedAt = p4Pending.sentAt
assert(!p4Snapshot.confirms(p4Pending))
p4Snapshot.lockUpdatedAt = p4Snapshot.observedAt!.addingTimeInterval(1)
assert(!p4Snapshot.confirms(p4Pending))
rejectsP4 { _ = try WatchXchanger.snapshot(p4Status, target: [:], vin: "OTHER000000000000") }
let missingP4 = try WatchXchanger.snapshot(["result": ["serviceResult": ["operationResult": 1]], "vehicleStatus": [:]], target: [:], vin: "TESTVIN0000000000")
assert(missingP4.locked == nil && missingP4.climateActive == nil && missingP4.updatedAt == nil && missingP4.freshnessPending == true)
print("Watch P4 fixtures passed: Rust-compatible signing, access-only grants, expiry, capabilities, commands, uncertainty, readings and freshness")

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

var grouped = WatchPendingCommands()
grouped.store(command)
assert(grouped.blocking("lock", for: authorization, now: sentAt.addingTimeInterval(599))?.id == command.id)
assert(grouped.blocking("climateStop", for: authorization, now: sentAt.addingTimeInterval(20)) == nil)
assert(grouped.blocking("lock", for: otherAccount, now: sentAt) == nil)
assert(grouped.blocking("lock", for: secondVehicle, now: sentAt) == nil)
assert(grouped.blocking("lock", for: authorization, now: sentAt.addingTimeInterval(600)) == nil)
assert(grouped.pending(for: authorization)?.id == command.id)
grouped.store(climateCommand)
assert(grouped.records.count == 2)
var reconciled = WatchSnapshot(vin: vin, model: "Polestar", locked: false,
    lockUpdatedAt: sentAt.addingTimeInterval(1), observedAt: sentAt.addingTimeInterval(2))
grouped.reconcile(reconciled, for: authorization)
assert(grouped.records.map(\.id) == [climateCommand.id])
grouped.store(command)
reconciled.locked = true
grouped.reconcile(reconciled, for: authorization)
assert(grouped.records.contains { $0.id == command.id })
reconciled.locked = false
reconciled.observedAt = sentAt.addingTimeInterval(600)
assert(!reconciled.confirms(command))
grouped.reconcile(reconciled, for: authorization)
assert(grouped.records.contains { $0.id == command.id })
print("Watch pending recovery passed: command groups, bounded blocking, preserved uncertainty, scoped reconciliation")

final class CapabilityFailureProtocol: URLProtocol {
    static let lock = NSLock()
    static var paths: [String] = []
    static var ownsVehicle = true
    static var hasVehicleType = true
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let path = request.url!.path
        Self.lock.lock()
        Self.paths.append(path)
        let owns = Self.ownsVehicle
        let hasType = Self.hasVehicleType
        Self.lock.unlock()
        var status = 200
        let value: [String: Any]
        if path == "/device-platform/user/vehicle/secure" {
            var car: [String: Any] = ["vin": "TESTVIN0000000000"]
            if hasType { car["vehicleType"] = 1 }
            value = ["list": owns ? [car] : []]
        } else if path.contains("capability") {
            status = 503
            value = [:]
        } else if path.contains("/status/soc/") {
            value = ["soc": 700]
        } else if path.contains("/vehicle/status/") {
            value = ["result": ["serviceResult": ["operationResult": 0]],
                "vehicleStatus": ["configuration": ["vin": "TESTVIN0000000000"],
                    "additionalVehicleStatus": ["electricVehicleStatus": ["chargeLevel": 42]]]]
        } else { fatalError("Unexpected fixture request") }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: value))
        client?.urlProtocolDidFinishLoading(self)
    }
}
let fixtureConfiguration = URLSessionConfiguration.ephemeral
fixtureConfiguration.protocolClasses = [CapabilityFailureProtocol.self]
let fixtureTransport = URLSession(configuration: fixtureConfiguration)
let degradedReader = WatchXchanger(grant: p4Grant, vin: "TESTVIN0000000000", transport: fixtureTransport)
let (degradedSnapshot, degradedPermissions) = try await degradedReader.fetch()
assert(degradedSnapshot.batteryPercent == 42 && degradedSnapshot.chargeTarget == 70)
assert(degradedPermissions.isEmpty)
CapabilityFailureProtocol.paths = []
CapabilityFailureProtocol.hasVehicleType = false
let (missingTypeSnapshot, missingTypePermissions) = try await degradedReader.fetch()
assert(missingTypeSnapshot.batteryPercent == 42 && missingTypePermissions.isEmpty)
assert(!CapabilityFailureProtocol.paths.contains { $0.contains("capability") })
CapabilityFailureProtocol.paths = []
let verifiedStatus = try await degradedReader.commandReadback()
assert(verifiedStatus.vin == vin)
assert(CapabilityFailureProtocol.paths == ["/device-platform/user/vehicle/secure", "/remote-control/vehicle/status/" + vin])
CapabilityFailureProtocol.paths = []
CapabilityFailureProtocol.ownsVehicle = false
do { _ = try await degradedReader.fetch(); fatalError("Unowned vehicle read accepted") }
catch { assert(CapabilityFailureProtocol.paths == ["/device-platform/user/vehicle/secure"]) }
fixtureTransport.invalidateAndCancel()
print("Watch P4 network fixtures passed: capability failure preserves reads, missing ownership stops before status requests")

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

do {
    _ = try WatchXchanger.response(http: 400, data: ["error": ["code": "6666"]])
    fatalError("Expected a service rejection")
} catch let failure as WatchFailure {
    assert(failure.message.contains("HTTP 400，业务码 6666"))
}

import Combine
import Foundation
import Security
import WatchConnectivity
import WidgetKit

@MainActor
final class WatchRemoteClient: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var configured = false
    @Published private(set) var cachedSnapshot: WatchSnapshot?
    @Published private(set) var notice = ""
    @Published private(set) var pendingAction: String?
    @Published private(set) var phase = "idle"
    private var authorization: WatchAuthorization?
    private var pending: WatchPendingCommand?
    private var pendingCommands = WatchPendingCommands()
    private var busy = false
    private var generation = UUID()
    private var capabilities: [String: Bool] = [:]
    private let actionCapabilities = ["lock": "supportsLock", "unlock": "supportsUnlock", "climateStart": "supportsParkingClimatization", "climateStop": "supportsParkingClimatization"]

    override init() {
        super.init()
        if let data = try? Self.credential(), let grant = WatchAuthorization.restored(from: data) {
            authorization = grant
            configured = true
            notice = ""
        }
        if let authorization,
           UserDefaults.standard.string(forKey: "watch.snapshotAccount") == authorization.account,
           let data = UserDefaults.standard.data(forKey: "watch.snapshot"),
           let snapshot = try? JSONDecoder().decode(WatchSnapshot.self, from: data),
           snapshot.vin == authorization.vin {
            cachedSnapshot = snapshot
        }
        pendingCommands = WatchPendingCommands.restored(
            from: UserDefaults.standard.data(forKey: "watch.pendingCommands"),
            legacyData: UserDefaults.standard.data(forKey: "watch.pending"))
        try? savePendingCommands(pendingCommands)
        loadCurrentPending()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func requestSync() {
        notice = "请在 iPhone 打开 Norr，恢复车辆连接后将自动同步"
    }

    func unavailableReason(for action: String) -> String? {
        guard configured else { return "请在 iPhone 登录并连接车辆" }
        guard let authorization, authorization.validUntil / 1000 > Date().timeIntervalSince1970 + 30 else {
            return "登录已到期，请在 iPhone 恢复车辆连接"
        }
        guard let capability = actionCapabilities[action] else { return "手表暂不支持此操作" }
        if pendingCommands.blocking(action, for: authorization) != nil { return "请先核对上一条同类操作" }
        guard let supported = capabilities[capability] else { return "请刷新车辆以确认操作权限" }
        return supported ? nil : "车辆未开放此操作"
    }

    func refresh() async throws -> WatchSnapshot {
        guard !busy else { throw WatchFailure(message: "车辆请求正在进行") }
        busy = true
        defer { busy = false }
        return try await fetch()
    }

    func send(_ action: String) async throws -> WatchSnapshot {
        guard !busy else { throw WatchFailure(message: "车辆请求正在进行") }
        guard pendingCommands.blocking(action, for: authorization) == nil else {
            throw WatchFailure(message: "请先核对上一条同类操作")
        }
        busy = true
        defer { busy = false }
        let grant = try validAuthorization()
        let epoch = generation
        let xchanger = grant.xchanger.map { WatchXchanger(grant: $0, vin: grant.vin) }
        let endpoint: URL?
        let permissions: [String: Bool]
        let p4Request: URLRequest?
        if let xchanger {
            permissions = try await xchanger.capabilities()
            p4Request = try xchanger.controlRequest(action)
            endpoint = nil
        } else {
            let (address, _, car) = try await discovery(grant)
            endpoint = address
            permissions = car.compactMapValues { $0 as? Bool }
            p4Request = nil
        }
        try ensureCurrent(epoch)
        let methods = ["lock": "Lock", "unlock": "Unlock", "climateStart": "ClimatizationStart", "climateStop": "ClimatizationStop"]
        guard let capability = actionCapabilities[action], let method = methods[action], permissions[capability] == true else {
            throw WatchFailure(message: "车辆未确认支持此操作")
        }
        var body = WatchWire.bytes(1, WatchWire.string(1, grant.vin))
        if action == "lock" || action == "unlock" { body += WatchWire.integer(2, 0) }
        if action == "climateStart" { body += WatchWire.integer(2, 1) + WatchWire.float(3, 22) }
        let record = WatchPendingCommand(id: UUID(), account: grant.account, vin: grant.vin, action: action, sentAt: Date())
        var commands = pendingCommands
        commands.store(record)
        try savePendingCommands(commands)
        pending = record
        pendingAction = action
        phase = "sending"
        do {
            let rejected: Bool
            if let xchanger, let p4Request {
                let (http, data) = try await xchanger.raw(p4Request)
                rejected = WatchXchanger.rejected(http: http, data: data)
            } else if let endpoint {
                let data = try await grpc(endpoint, path: "/invocation.InvocationService/\(method)", body: body, grant: grant)
                let outer = try WatchWire(data)
                let response = outer.int(3) == nil ? try (outer.nested(1) ?? outer) : outer
                rejected = [9, 10, 12].contains(response.int(3) ?? 0) || (action == "lock" && outer.bytes(1) != nil && (outer.int(2) ?? 0) != 0)
            } else { throw WatchFailure(message: "车辆服务尚未配置") }
            try ensureCurrent(epoch)
            if rejected {
                try clearPending(record)
                throw WatchFailure(message: "车辆拒绝执行，请检查车门与当前权限")
            }
            phase = "pending"
            notice = "请求已返回，正在核对车辆状态"
            for _ in 0..<5 {
                try await Task.sleep(nanoseconds: 4_000_000_000)
                try ensureCurrent(epoch)
                let snapshot = try await fetch()
                if snapshot.confirms(record) {
                    try clearPending(record)
                    phase = "confirmed"
                    return snapshot
                }
            }
        } catch {
            if !pendingCommands.records.contains(where: { $0.id == record.id }) || generation != epoch { throw error }
        }
        phase = "pending"
        throw WatchFailure(message: "结果待核对，请读取车辆状态。指令不会自动重发")
    }

    func verifyPending() async throws -> WatchSnapshot {
        guard !busy, let record = pending else { throw WatchFailure(message: "没有可核对的操作，或请求正在进行") }
        let grant = try validAuthorization()
        guard record.account == grant.account, record.vin == grant.vin else {
            throw WatchFailure(message: "待核对操作属于另一辆车，请在 iPhone 切回原车辆")
        }
        busy = true
        defer { busy = false }
        let snapshot = try await fetch()
        guard snapshot.confirms(record) else {
            if !record.blocks(record.action) {
                phase = "unconfirmed"
                return snapshot
            }
            phase = "pending"
            throw WatchFailure(message: "尚无足够新的匹配回读，操作仍待核对")
        }
        try clearPending(record)
        phase = "confirmed"
        return snapshot
    }

    private func clearPending(_ record: WatchPendingCommand) throws {
        var commands = pendingCommands
        commands.remove(id: record.id)
        try savePendingCommands(commands)
        loadCurrentPending()
    }

    private func savePendingCommands(_ commands: WatchPendingCommands) throws {
        UserDefaults.standard.set(try JSONEncoder().encode(commands), forKey: "watch.pendingCommands")
        pendingCommands = commands
        UserDefaults.standard.removeObject(forKey: "watch.pending")
    }

    private func loadCurrentPending() {
        pending = pendingCommands.pending(for: authorization)
        pendingAction = pending?.action
        phase = pending == nil ? "idle" : "pending"
    }

    private func validAuthorization() throws -> WatchAuthorization {
        guard let grant = authorization, !grant.accessToken.isEmpty else { throw WatchFailure(message: "请在 iPhone 登录并连接车辆") }
        guard grant.validUntil / 1000 > Date().timeIntervalSince1970 + 30 else {
            requestSync()
            throw WatchFailure(message: "登录已到期，请在 iPhone 恢复车辆连接")
        }
        return grant
    }

    private func ensureCurrent(_ epoch: UUID) throws {
        guard generation == epoch else { throw WatchFailure(message: "车辆或登录态已变更，请重新读取") }
    }

    private func fetch() async throws -> WatchSnapshot {
        let grant = try validAuthorization()
        let epoch = generation
        capabilities = [:]
        if let authorization = grant.xchanger {
            let (snapshot, permissions) = try await WatchXchanger(grant: authorization, vin: grant.vin).fetch()
            try ensureCurrent(epoch)
            capabilities = permissions
            notice = permissions.isEmpty ? "车况已更新，操作权限暂不可用"
                : snapshot.freshnessPending == true ? "车辆数据等待更新" : ""
            try save(snapshot, account: grant.account)
            return snapshot
        }
        let (endpoint, targetEndpoint, car) = try await discovery(grant)
        let request = WatchWire.string(1, UUID().uuidString) + WatchWire.string(2, grant.vin)
        async let batteryData = grpc(endpoint, path: "/services.vehiclestates.battery.BatteryService/GetLatestBattery", body: request, grant: grant)
        async let exteriorData = grpc(endpoint, path: "/services.vehiclestates.exterior.ExteriorService/GetLatestExterior", body: request, grant: grant)
        async let climateData = grpc(endpoint, path: "/services.vehiclestates.parkingclimatization.ParkingClimatizationService/GetLatestParkingClimatization", body: request, grant: grant)
        async let targetData = readTarget(targetEndpoint, grant: grant)
        let battery = try? payload(await batteryData, vin: grant.vin)
        let exterior = try? payload(await exteriorData, vin: grant.vin)
        let climate = try? payload(await climateData, vin: grant.vin)
        let target = try? await targetData
        try ensureCurrent(epoch)
        capabilities = car.compactMapValues { $0 as? Bool }
        guard battery != nil || exterior != nil || climate != nil else { throw WatchFailure(message: "暂时无法读取车辆，请检查网络或重新同步登录态") }
        let digitalExterior = (2...16).contains { exterior?.int($0) != nil }
        let lock = digitalExterior ? exterior?.int(2) : try exterior?.nested(1)?.int(1)
        let digitalClimate = climate?.bytes(1) != nil
        let activity = climate?.int(digitalClimate ? 2 : 1)
        let active: Bool?
        if let activity, activity != 0 {
            let starting = digitalClimate ? activity == 3 : (2...3).contains(activity)
            active = starting ? nil : (digitalClimate ? activity == 1 : (4...8).contains(activity))
        } else {
            active = nil
        }
        let chargingStates: [UInt64: String] = [1: "正在充电", 2: "空闲", 3: "等待预约", 4: "放电中", 5: "充电异常", 6: "智能充电", 7: "已暂停", 8: "充电完成"]
        let snapshot = WatchSnapshot(
            vin: grant.vin, model: car["modelName"] as? String ?? "Polestar",
            batteryPercent: battery?.number(2).flatMap { (0...100).contains($0) ? $0 : nil },
            rangeKm: battery?.number(4), locked: lock == 2 ? true : lock == 1 ? false : nil,
            climateActive: active,
            targetTemperature: digitalClimate ? climate?.number(8) : nil, interiorTemperature: digitalClimate ? climate?.number(7) : nil,
            chargePower: battery?.number(10).map { $0 / 1000 }, chargeTarget: target,
            chargingState: battery?.int(7).flatMap { chargingStates[$0] },
            updatedAt: try battery?.timestamp(1), lockUpdatedAt: digitalExterior ? try exterior?.timestamp(1) : nil, climateUpdatedAt: digitalClimate ? try climate?.timestamp(1) : nil,
            observedAt: Date())
        notice = battery == nil || exterior == nil || climate == nil ? "部分数据读取失败" : ""
        try save(snapshot, account: grant.account)
        return snapshot
    }

    private func save(_ snapshot: WatchSnapshot, account: String) throws {
        if let authorization, authorization.account == account {
            var commands = pendingCommands
            commands.reconcile(snapshot, for: authorization)
            try savePendingCommands(commands)
            loadCurrentPending()
        }
        cachedSnapshot = snapshot
        UserDefaults.standard.set(try JSONEncoder().encode(snapshot), forKey: "watch.snapshot")
        UserDefaults.standard.set(account, forKey: "watch.snapshotAccount")
        try? WatchWidgetCache.save(WatchWidgetSnapshot(model: snapshot.model, batteryPercent: snapshot.batteryPercent, rangeKm: snapshot.rangeKm, updatedAt: snapshot.updatedAt, freshnessPending: snapshot.freshnessPending))
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func payload(_ data: Data, vin: String) throws -> WatchWire {
        let envelope = try WatchWire(data)
        if let actual = envelope.string(2), actual.caseInsensitiveCompare(vin) != .orderedSame { throw WatchFailure(message: "车辆响应身份不匹配") }
        guard let bytes = envelope.bytes(3) else { throw WatchFailure(message: "车辆响应缺少数据") }
        return try WatchWire(bytes)
    }

    private func discovery(_ grant: WatchAuthorization) async throws -> (URL, URL?, [String: Any]) {
        let discovery = try await json(URL(string: "https://cnepmob.volvocars.com.cn")!, grant: grant, accept: "application/volvo.cloud.cnepmob.v1+json")
        guard let service = (discovery as? [String: Any])?["c3"] as? [String: Any],
              let address = service["url"] as? String, let host = service["grpcHost"] as? String,
              !host.contains(where: { "/:@?#".contains($0) }) else { throw WatchFailure(message: "服务发现格式无效") }
        let port = (service["grpcPort"] as? NSNumber)?.intValue ?? Int(service["grpcPort"] as? String ?? "443") ?? 443
        guard (1...65535).contains(port) else { throw WatchFailure(message: "车辆服务端口无效") }
        let endpoint = try trustedURL("https://\(host):\(port)")
        let fleet = try await json(try trustedURL(address).appendingPathComponent("car-information/car"), grant: grant)
        guard let car = (fleet as? [[String: Any]])?.first(where: { ($0["vin"] as? String)?.uppercased() == grant.vin.uppercased() }),
              ["ICUP", "AccountLinking"].contains(car["remoteControlType"] as? String ?? "") else {
            throw WatchFailure(message: "当前账号未关联此车辆，或车型尚未适配")
        }
        let lbs = (discovery as? [String: Any])?["c3Lbs"] as? [String: Any]
        let targetEndpoint = try? serviceURL(lbs)
        return (endpoint, targetEndpoint, car)
    }

    private func serviceURL(_ service: [String: Any]?) throws -> URL {
        guard let host = service?["grpcHost"] as? String, !host.contains(where: { "/:@?#".contains($0) }) else {
            throw WatchFailure(message: "服务地址无效")
        }
        let port = (service?["grpcPort"] as? NSNumber)?.intValue ?? Int(service?["grpcPort"] as? String ?? "443") ?? 443
        guard (1...65535).contains(port) else { throw WatchFailure(message: "服务端口无效") }
        return try trustedURL("https://\(host):\(port)")
    }

    private func readTarget(_ endpoint: URL?, grant: WatchAuthorization) async throws -> Double? {
        guard let endpoint else { return nil }
        let state = WatchWire.string(1, UUID().uuidString) + WatchWire.string(2, grant.vin)
        let body = WatchWire.bytes(1, state + WatchWire.string(3, "RCS") + WatchWire.bytes(4, WatchWire.integer(1, 0)))
        let data = try await grpc(endpoint, path: "/chronos.services.v1.TargetSocService/GetTargetSoc", body: body, grant: grant, firstOnly: true)
        return try payload(data, vin: grant.vin).number(1).flatMap { (1...100).contains($0) ? $0 : nil }
    }

    private func trustedURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), let host = url.host, url.scheme == "https", url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              ["volvocars.com.cn", "volvocars.com", "polestar.cn", "polestar.com", "polestar-auto.com"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) else {
            throw WatchFailure(message: "服务发现地址不可信")
        }
        return url
    }

    private func json(_ url: URL, grant: WatchAuthorization, accept: String = "application/json") async throws -> Any {
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        request.setValue("Bearer \(grant.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let session = URLSession(configuration: .ephemeral, delegate: WatchRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count <= 2_000_000 else { throw WatchFailure(message: "车辆服务未接受请求，请重新同步登录态") }
        return try JSONSerialization.jsonObject(with: data)
    }

    private func grpc(_ endpoint: URL, path: String, body: Data, grant: WatchAuthorization, firstOnly: Bool = false) async throws -> Data {
        var request = URLRequest(url: endpoint.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/grpc", forHTTPHeaderField: "Content-Type")
        request.setValue("trailers", forHTTPHeaderField: "TE")
        request.setValue("25S", forHTTPHeaderField: "grpc-timeout")
        request.setValue("Bearer \(grant.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(grant.vin, forHTTPHeaderField: "vin")
        let count = UInt32(body.count)
        request.httpBody = Data([0] + (0..<4).reversed().map { UInt8(truncatingIfNeeded: count >> ($0 * 8)) }) + body
        let session = URLSession(configuration: .ephemeral, delegate: WatchRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (stream, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw WatchFailure(message: "车辆服务连接失败") }
        if let status = response.value(forHTTPHeaderField: "grpc-status"), status != "0" { throw WatchFailure(message: "车辆服务拒绝请求，请核对权限或登录态") }
        var frame = Data()
        var expected: Int?
        var latest: Data?
        for try await byte in stream {
            frame.append(byte)
            if frame.count == 5 {
                guard frame[0] == 0 else { throw WatchFailure(message: "车辆响应压缩格式不支持") }
                expected = 5 + frame.dropFirst().reduce(0) { ($0 << 8) | Int($1) }
                guard expected! <= 2_000_005 else { throw WatchFailure(message: "车辆响应过大") }
            }
            if frame.count == expected {
                latest = Data(frame.dropFirst(5))
                if firstOnly { return latest! }
                frame.removeAll(keepingCapacity: true)
                expected = nil
            }
        }
        guard frame.isEmpty, let latest else { throw WatchFailure(message: "车辆响应为空或不完整") }
        return latest
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor in self.receive(context) }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.receive(applicationContext) }
    }
    private func receive(_ context: [String: Any]) {
        guard let data = context["norrAuthorization"] as? Data,
              let grant = try? JSONDecoder().decode(WatchAuthorization.self, from: data),
              grant.isValid,
              grant.version > UserDefaults.standard.double(forKey: "watch.authorizationVersion") else { return }
        do {
            var commands = pendingCommands
            if grant.accessToken.isEmpty, let authorization {
                commands.clear(account: authorization.account)
            }
            let pendingData = try JSONEncoder().encode(commands)
            if grant.accessToken.isEmpty {
                let status = SecItemDelete(Self.credentialQuery as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else { throw WatchFailure(message: "无法清除手表登录态") }
            } else {
                try Self.saveCredential(data)
            }
            UserDefaults.standard.set(pendingData, forKey: "watch.pendingCommands")
            pendingCommands = commands
            UserDefaults.standard.removeObject(forKey: "watch.pending")
            UserDefaults.standard.set(grant.version, forKey: "watch.authorizationVersion")
            generation = UUID()
            capabilities = [:]
            if grant.accessToken.isEmpty || authorization?.account != grant.account || authorization?.vin != grant.vin {
                cachedSnapshot = nil
                UserDefaults.standard.removeObject(forKey: "watch.snapshot")
                UserDefaults.standard.removeObject(forKey: "watch.snapshotAccount")
                try? WatchWidgetCache.clear()
                WidgetCenter.shared.reloadAllTimelines()
            }
            authorization = grant.accessToken.isEmpty ? nil : grant
            loadCurrentPending()
            configured = authorization != nil
            notice = configured ? "已同步 iPhone 登录态" : "已退出登录，请在 iPhone 重新同步"
        } catch { notice = "登录态保存失败，请重新同步" }
    }

    private static var credentialQuery: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.norr.watch", kSecAttrAccount as String: "authorization"] }
    private static func credential() throws -> Data? {
        var query = credentialQuery
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw WatchFailure(message: "无法读取手表钥匙串") }
        return result as? Data
    }
    private static func saveCredential(_ data: Data) throws {
        let status = SecItemUpdate(credentialQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = credentialQuery
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw WatchFailure(message: "无法保存手表登录态") }
        } else if status != errSecSuccess { throw WatchFailure(message: "无法更新手表登录态") }
    }
}

private final class WatchRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

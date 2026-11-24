import CryptoKit
import Foundation

struct WatchXchangerAuthorization: Codable {
    let accessToken: String
    let userId: String
    let clientId: String
    let deviceId: String
    let signingKey: String
    let expiresAt: Double

    var isValid: Bool {
        !accessToken.isEmpty && !userId.isEmpty && !clientId.isEmpty && !deviceId.isEmpty
            && expiresAt.isFinite && expiresAt > 0
            && Data(base64Encoded: signingKey)?.isEmpty == false
    }
}

struct WatchXchanger {
    let grant: WatchXchangerAuthorization
    let vin: String
    var transport: URLSession? = nil

    static func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() { return nil }
        let number = (value as? NSNumber)?.doubleValue ?? (value as? String).flatMap(Double.init)
        return number.flatMap { $0.isFinite ? $0 : nil }
    }

    static func flag(_ value: Any?) -> Bool? {
        if let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() { return value.boolValue }
        if let text = value as? String {
            if text.lowercased() == "true" { return true }
            if text.lowercased() == "false" { return false }
        }
        switch number(value) { case 0: return false; case 1: return true; default: return nil }
    }

    static func isFalse(_ value: Any?) -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return !value.boolValue
    }

    static func query(_ values: [String: String]) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return values.keys.sorted().map {
            "\($0.addingPercentEncoding(withAllowedCharacters: allowed)!)=\(values[$0]!.addingPercentEncoding(withAllowedCharacters: allowed)!)"
        }.joined(separator: "&")
    }

    static func signature(key: Data, path: String, query: String, body: Data, time: UInt64, nonce: String, method: String) -> String {
        let digest = Data(Insecure.MD5.hash(data: body)).base64EncodedString()
        let source = "application/json\nx-api-signature-nonce:\(nonce)\nx-api-signature-version:1.0\n\n\(query)\n\(digest)\n\(time)\n\(method)\n\(path)"
        return Data(HMAC<Insecure.SHA1>.authenticationCode(for: Data(source.utf8), using: SymmetricKey(data: key))).base64EncodedString()
    }

    func request(host: String, path: String, query: [String: String] = [:], body: [String: Any]? = nil) throws -> URLRequest {
        guard grant.isValid, grant.expiresAt > Date().timeIntervalSince1970 * 1000 + 30_000 else {
            throw WatchFailure(message: "P4 登录已到期，请在 iPhone 恢复车辆连接后同步")
        }
        guard ["device-api", "api"].contains(host), path.hasPrefix("/"), !path.contains("?") else {
            throw WatchFailure(message: "P4 请求地址无效")
        }
        let query = Self.query(query)
        let url = URL(string: "https://\(host).xchanger.cn\(path)" + (query.isEmpty ? "" : "?\(query)"))!
        let bytes = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) } ?? Data()
        let time = UInt64(Date().timeIntervalSince1970 * 1000)
        let nonce = UUID().uuidString.lowercased()
        let method = body == nil ? "GET" : "PUT"
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = method
        if body != nil { request.httpBody = bytes }
        request.allHTTPHeaderFields = [
            "Accept": "application/json", "Content-Type": "application/json; charset=utf-8",
            "X-APP-ID": "polestar-app", "X-AGENT-TYPE": "android", "X-DEVICE-TYPE": "mobile",
            "X-OPERATOR-CODE": "POLESTAR", "X-ENV-TYPE": "production", "X-VERSION": "polestarNew",
            "PLATFORM": "NON-CMA", "X-DEVICE-IDENTIFIER": grant.deviceId, "Accept-Language": "zh-CN",
            "X-api-signature-version": "1.0", "X-api-signature-nonce": nonce,
            "X-TIMESTAMP": String(time), "Authorization": grant.accessToken, "X-CLIENT-ID": grant.clientId,
            "X-SIGNATURE": Self.signature(key: Data(base64Encoded: grant.signingKey)!, path: path, query: query,
                                          body: bytes, time: time, nonce: nonce, method: method),
        ]
        return request
    }

    func raw(_ request: URLRequest) async throws -> (Int, [String: Any]) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = transport ?? URLSession(configuration: configuration, delegate: XchangerRedirectGuard(), delegateQueue: nil)
        defer { if transport == nil { session.invalidateAndCancel() } }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, data.count <= 2_000_000 else {
            throw WatchFailure(message: "P4 响应无效")
        }
        return (response.statusCode, (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
    }

    static func response(http: Int, data: [String: Any]) throws -> [String: Any] {
        let error = data["error"] as? [String: Any]
        let code = number(data["code"]).flatMap { $0 == 0 ? nil : $0 } ?? number(error?["code"])
        if http < 500 && ([1402, 1403, 1404, 1408].contains(code ?? -1) || (http == 401 && (code == nil || code == 1000))) {
            throw WatchFailure(message: "P4 授权已失效，请在 iPhone 刷新车辆并重新同步手表")
        }
        guard (200..<300).contains(http), !data.isEmpty,
              data["error"] == nil || data["error"] is NSNull,
              !isFalse(data["success"]), !isFalse(data["isSuccess"]),
              data["code"] == nil || number(data["code"]) == 1000 else {
            throw WatchFailure(message: "P4 请求未被接受（HTTP \(http)）")
        }
        return data["code"] == nil ? data : data["data"] as? [String: Any] ?? [:]
    }

    func get(host: String, path: String, query: [String: String] = [:]) async throws -> [String: Any] {
        let (http, data) = try await raw(request(host: host, path: path, query: query))
        return try Self.response(http: http, data: data)
    }

    func capabilities() async throws -> [String: Bool] {
        try await capabilities(vehicleType: vehicleType())
    }

    private func vehicleType() async throws -> Double? {
        let fleet = try await get(host: "device-api", path: "/device-platform/user/vehicle/secure",
                                 query: ["userId": grant.userId, "needSharedCar": "1"])
        let result = fleet["serviceResult"] as? [String: Any]
        guard result?["operationResult"] == nil || Self.number(result?["operationResult"]) == 0,
              let car = (fleet["list"] as? [[String: Any]])?.first(where: { $0["vin"] as? String == vin }) else {
            throw WatchFailure(message: "P4 未列入当前账号车库")
        }
        return Self.number(car["vehicleType"]).flatMap { $0.rounded() == $0 ? $0 : nil }
    }

    private func capabilities(vehicleType: Double?) async throws -> [String: Bool] {
        guard let type = vehicleType else { throw WatchFailure(message: "P4 未返回车辆类型，无法确认操作权限") }
        let data = try await get(host: "api", path: "/geelyTCAccess/tcservices/capability/\(vin)",
                                 query: ["pageSize": "2000", "pageIndex": "1", "vehicleType": String(format: "%.0f", type), "sortField": "", "direction": ""])
        return Self.capabilities(data)
    }

    static func capabilities(_ data: [String: Any]) -> [String: Bool] {
        let result = data["serviceResult"] as? [String: Any]
        guard result?["operationResult"] == nil || number(result?["operationResult"]) == 0,
              let list = data["list"] as? [[String: Any]] else { return [:] }
        let flags = [
            "supportsLock": ["remote_control_lock_2", "remote_control_lock", "door_lock_switch_control"],
            "supportsUnlock": ["remote_control_unlock_2", "remote_control_unlock", "door_lock_switch_control"],
            "supportsParkingClimatization": ["remote_climate_control_2"],
        ]
        var capabilities: [String: Bool] = [:]
        for (capability, names) in flags {
            for name in names {
                let matches = list.filter { $0["functionId"] as? String == name }
                if matches.isEmpty { continue }
                if matches.count == 1, let value = matches[0]["valueEnable"] as? NSNumber,
                   CFGetTypeID(value) == CFBooleanGetTypeID() { capabilities[capability] = value.boolValue }
                break
            }
        }
        return capabilities
    }

    func fetch() async throws -> (WatchSnapshot, [String: Bool]) {
        let type = try await vehicleType()
        async let permissions = try? capabilities(vehicleType: type)
        async let target = get(host: "api", path: "/remote-control/vehicle/status/soc/\(vin)", query: ["setting": "charging"])
        let status = try await get(host: "device-api", path: "/remote-control/vehicle/status/\(vin)",
                                   query: ["userId": grant.userId, "latest": "false", "target": ""])
        return (try Self.snapshot(status, target: (try? await target) ?? [:], vin: vin), await permissions ?? [:])
    }

    static func snapshot(_ data: [String: Any], target: [String: Any], vin: String, now: Date = .now) throws -> WatchSnapshot {
        let result = (data["result"] as? [String: Any])?["serviceResult"] as? [String: Any] ?? [:]
        guard let status = data["vehicleStatus"] as? [String: Any],
              result["error"] == nil || result["error"] is NSNull,
              [0, 1].contains(number(result["operationResult"]) ?? -1) else {
            throw WatchFailure(message: "P4 车况读取未完成")
        }
        if let actual = (status["configuration"] as? [String: Any])?["vin"] as? String, actual != vin {
            throw WatchFailure(message: "P4 返回的车辆不匹配")
        }
        let additional = status["additionalVehicleStatus"] as? [String: Any] ?? [:]
        let ev = additional["electricVehicleStatus"] as? [String: Any] ?? [:]
        let safety = additional["drivingSafetyStatus"] as? [String: Any] ?? [:]
        let climate = additional["climateStatus"] as? [String: Any] ?? [:]
        func bounded(_ value: Any?, _ range: ClosedRange<Double>) -> Double? {
            number(value).flatMap { range.contains($0) ? $0 : nil }
        }
        let time = number(status["updateTime"]).map { $0 < 1e12 ? $0 : $0 / 1000 }
            .flatMap { (1e9...now.timeIntervalSince1970 + 60).contains($0) ? Date(timeIntervalSince1970: $0) : nil }
        let lock: Bool?
        switch number(safety["centralLockingStatus"]) { case 1, 2: lock = true; case 0: lock = false; default: lock = nil }
        let minutes = bounded(ev["timeToFullyCharged"], 0...10080)
        let charging: String?
        switch number(ev["chargerState"]) {
        case 2, 15, 24: charging = "正在充电"
        case 3: charging = "已暂停"
        case 5: charging = "等待充电"
        case 14, 18, 20, 21, 22, 23, 27: charging = "充电异常"
        default:
            switch number(ev["statusOfChargerConnection"]) {
            case 9: charging = "充电异常"
            case 3: charging = minutes.map { $0 == 0 ? "充电完成" : "正在充电" }
            case 5:
                switch number(ev["chargeSts"]) {
                case 0, 3: charging = "已暂停"
                case 1: charging = "等待预约"
                case 2: charging = minutes.map { $0 == 0 ? "充电完成" : "等待预约" }
                case 4: charging = "正在充电"
                default: charging = nil
                }
            default: charging = nil
            }
        }
        let soc = bounded(target["soc"], 0...1000).flatMap { $0.rounded() == $0 ? $0 / 10 : nil }
        return WatchSnapshot(vin: vin, model: "Polestar 4", batteryPercent: bounded(ev["chargeLevel"], 0...100),
                             rangeKm: bounded(ev["distanceToEmptyOnBatteryOnly"], 0...3000), locked: lock,
                             climateActive: flag(climate["preClimateActive"]), interiorTemperature: bounded(climate["interiorTemp"], -55...90),
                             chargeTarget: soc, chargingState: charging, updatedAt: ev.isEmpty ? nil : time,
                             lockUpdatedAt: safety.isEmpty ? nil : time, climateUpdatedAt: climate.isEmpty ? nil : time,
                             freshnessPending: number(result["operationResult"]) == 1, vehicleService: "xchanger", observedAt: now)
    }

    func controlRequest(_ action: String) throws -> URLRequest {
        try request(host: "device-api", path: "/remote-control/vehicle/telematics/\(vin)",
                    body: Self.controlBody(action, user: grant.userId, time: UInt64(Date().timeIntervalSince1970 * 1000)))
    }

    static func controlBody(_ action: String, user: String, time: UInt64) throws -> [String: Any] {
        let service: String
        let parameters: [[String: String]]
        switch action {
        case "lock", "unlock":
            service = action == "lock" ? "RDL_2" : "RDU_2"
            parameters = [["key": "door", "value": "all"]]
        case "climateStart":
            service = "RCE_2"
            parameters = [["key": "rce.conditioner", "value": "1"], ["key": "rce.temp", "value": "22"]]
        case "climateStop":
            service = "RCE_2"
            parameters = [["key": "rce.conditioner", "value": "1"]]
        default: throw WatchFailure(message: "手表暂不支持此操作")
        }
        return ["command": action == "climateStop" ? "stop" : "start", "creator": "tc", "serviceId": service,
                "serviceParameters": parameters, "timestamp": String(time), "userId": user,
                "operationScheduling": ["duration": action == "climateStart" ? 180 : 0, "interval": 0, "occurs": 1, "recurrentOperation": false]]
    }

    static func rejected(http: Int, data: [String: Any]) -> Bool {
        if [400, 401, 403, 404, 422, 429].contains(http) { return true }
        guard (200..<300).contains(http), !data.isEmpty else { return false }
        if let error = data["error"], !(error is NSNull) { return true }
        if isFalse(data["success"]) || isFalse(data["isSuccess"]) { return true }
        if let code = number(data["code"]), code != 1000 { return true }
        let payload = data["data"] as? [String: Any] ?? [:]
        if let error = payload["error"], !(error is NSNull) { return true }
        return isFalse(payload["success"]) || isFalse(payload["isSuccess"])
    }
}

private final class XchangerRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

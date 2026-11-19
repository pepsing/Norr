import AppIntents
import Foundation

@available(iOS 16.0, *)
struct SiriVehicle: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "车辆")
    static let defaultQuery = VehicleQuery()

    let id: String
    let name: String

    init(_ option: SiriVehicleOption) {
        id = option.id
        name = option.name
    }

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

@available(iOS 16.0, *)
struct VehicleQuery: EntityQuery {
    func entities(for identifiers: [SiriVehicle.ID]) async throws -> [SiriVehicle] {
        let vehicles = try await suggestedEntities()
        return try identifiers.map { id in
            guard let vehicle = vehicles.first(where: { $0.id == id }) else {
                throw SiriVehicleError("车辆已不属于当前账号，请重新选择。")
            }
            return vehicle
        }
    }

    func suggestedEntities() async throws -> [SiriVehicle] {
        try await (SiriBridge.run(.vehicles).vehicles ?? []).map(SiriVehicle.init)
    }
}

@available(iOS 16.0, *)
private protocol VehicleIntent: AppIntent {
    var vehicle: SiriVehicle? { get }
    var vehicleParameter: IntentParameter<SiriVehicle?> { get }
}

@available(iOS 16.0, *)
extension VehicleIntent {
    static var openAppWhenRun: Bool { false }

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    fileprivate func resolveVehicle() async throws -> SiriVehicle {
        let reply = try await SiriBridge.run(.vehicles)
        let options = (reply.vehicles ?? []).map(SiriVehicle.init)
        if let vehicle {
            guard let current = options.first(where: { $0.id == vehicle.id }) else {
                throw SiriVehicleError("车辆已不属于当前账号，请重新选择。")
            }
            return current
        }
        if let current = options.first(where: { $0.id == reply.preferred }) {
            return current
        }
        guard !options.isEmpty else { throw SiriVehicleError("请先在 Norr 连接车辆。") }
        return try await vehicleParameter.requestDisambiguation(among: options, dialog: "请选择车辆。")
    }

    fileprivate func performControl(
        _ action: SiriVehicleAction,
        confirmation: (String) -> IntentDialog,
        completed: String
    ) async throws -> String {
        let target = try await resolveVehicle()
        let dialog = confirmation(target.name)
        if #available(iOS 18.0, *) {
            try await requestConfirmation(conditions: [], dialog: dialog)
        } else {
            guard try await vehicleParameter.requestConfirmation(for: target, dialog: dialog) else {
                throw CancellationError()
            }
        }

        switch try await SiriBridge.run(action, vehicle: target.id).status {
        case .confirmed: return completed
        case .accepted: return "请求已受理，车辆状态仍待确认。"
        case .pending: return "暂时无法确认结果，请在 Norr 核对车辆状态。"
        case .pendingConflict: return "这辆车有一条操作待核对，本次指令尚未发送。"
        case .rejected: throw SiriVehicleError("车辆未接受请求，请在 Norr 查看操作记录。")
        default: throw SiriVehicleError()
        }
    }
}

private func timeDescription(_ reading: SiriReading) -> String {
    guard let timestamp = reading.reportedAt, timestamp > 0 else { return "车辆未提供上报时间。" }
    let date = Date(timeIntervalSince1970: Double(timestamp) / 1000)
    let time = date.formatted(date: .abbreviated, time: .shortened)
    return "车辆上报于 \(time)。"
}

private func readingText(_ value: Double, unit: String) -> String {
    value.formatted(.number.precision(.fractionLength(0...1))) + unit
}

@available(iOS 16.0, *)
struct GetVehicleEnergyIntent: VehicleIntent {
    static let title: LocalizedStringResource = "查询车辆电量与续航"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("查询 \(\.$vehicle) 的电量与续航")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let target = try await resolveVehicle()
        guard let reading = try await SiriBridge.run(.energy, vehicle: target.id).reading else {
            throw SiriVehicleError()
        }
        let battery = reading.value?.percent.map { "电量 \(readingText($0, unit: "%"))" } ?? "电量未知"
        let range = reading.value?.rangeKm.map { "续航 \(readingText($0, unit: " 公里"))" } ?? "续航未知"
        let text = "\(battery)，\(range)。\(timeDescription(reading))"
        return .result(value: text, dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
struct GetVehicleLockStateIntent: VehicleIntent {
    static let title: LocalizedStringResource = "查询车门锁状态"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("查询 \(\.$vehicle) 的门锁状态")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let target = try await resolveVehicle()
        guard let reading = try await SiriBridge.run(.lockState, vehicle: target.id).reading else {
            throw SiriVehicleError()
        }
        let lockState = reading.value?.locked.map { $0 ? "车辆已锁。" : "车辆未锁。" } ?? "门锁状态未知。"
        let text = "\(lockState)\(timeDescription(reading))"
        return .result(value: text, dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
struct LockVehicleIntent: VehicleIntent {
    static let title: LocalizedStringResource = "锁车"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary { Summary("锁定 \(\.$vehicle)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = try await performControl(.lock, confirmation: { "要锁定 \($0) 吗？" }, completed: "车辆已锁好。")
        return .result(dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
struct StartVehicleClimateIntent: VehicleIntent {
    static let title: LocalizedStringResource = "开启车辆空调"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary { Summary("开启 \(\.$vehicle) 的空调") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = try await performControl(.climateStart, confirmation: { "要开启 \($0) 的空调吗？" }, completed: "车辆空调已开启。")
        return .result(dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
struct StopVehicleClimateIntent: VehicleIntent {
    static let title: LocalizedStringResource = "关闭车辆空调"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary { Summary("关闭 \(\.$vehicle) 的空调") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = try await performControl(.climateStop, confirmation: { "要关闭 \($0) 的空调吗？" }, completed: "车辆空调已关闭。")
        return .result(dialog: "\(text)")
    }
}

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

    #if compiler(>=6.2)
        @available(iOS 26.0, *)
        static var supportedModes: IntentModes { .background }
    #endif

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

    fileprivate func batteryReading() async throws -> SiriReading {
        let target = try await resolveVehicle()
        guard let reading = try await SiriBridge.run(.energy, vehicle: target.id).reading else {
            throw SiriVehicleError()
        }
        return reading
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

    fileprivate func performLock(_ operation: VehicleLockOperation) async throws -> String {
        switch operation {
        case .lock:
            return try await performControl(.lock, confirmation: { "要锁定 \($0) 吗？" }, completed: "车辆已锁好。")
        case .unlock:
            return try await performControl(.unlock, confirmation: { "要解锁 \($0) 吗？" }, completed: "车辆已解锁。")
        }
    }

    fileprivate func performClimate(_ operation: VehicleClimateOperation) async throws -> String {
        switch operation {
        case .start:
            return try await performControl(.climateStart, confirmation: { "要开启 \($0) 的空调吗？" }, completed: "车辆空调已开启。")
        case .stop:
            return try await performControl(.climateStop, confirmation: { "要关闭 \($0) 的空调吗？" }, completed: "车辆空调已关闭。")
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

private func energySummary(_ reading: SiriReading) -> String {
    let battery = reading.value?.percent.map { "电量 \(readingText($0, unit: "%"))" } ?? "电量未知"
    let range = reading.value?.rangeKm.map { "续航 \(readingText($0, unit: " 公里"))" } ?? "续航未知"
    return "\(battery)，\(range)。"
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
        let reading = try await batteryReading()
        let text = energySummary(reading) + timeDescription(reading)
        return .result(value: text, dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
enum VehicleEnergyInformation: String, AppEnum {
    case energy, charging

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "电量与充电"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .energy: "车辆电量",
        .charging: "充电状态",
    ]
}

@available(iOS 16.0, *)
struct GetVehicleEnergyInformationIntent: VehicleIntent {
    static let title: LocalizedStringResource = "查询电量与充电"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "查询内容", requestValueDialog: "要查电量与续航，还是充电状态？")
    var information: VehicleEnergyInformation
    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("查询 \(\.$vehicle) 的 \(\.$information)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let reading = try await batteryReading()
        let summary = information == .charging ? reading.chargingSummary : energySummary(reading)
        let text = summary + timeDescription(reading)
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
        let text = try await performLock(.lock)
        return .result(dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
enum VehicleLockOperation: String, AppEnum {
    case lock, unlock

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "门锁操作"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .lock: "锁车",
        .unlock: "解锁",
    ]
}

@available(iOS 16.0, *)
struct ControlVehicleLockIntent: VehicleIntent {
    static let title: LocalizedStringResource = "门锁控制"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "操作", requestValueDialog: "要锁车还是解锁？")
    var operation: VehicleLockOperation
    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("对 \(\.$vehicle) 执行 \(\.$operation)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = try await performLock(operation)
        return .result(dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
enum VehicleOpeningOperation: String, AppEnum {
    case open, close

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "开关操作"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .open: "开",
        .close: "关",
    ]
}

@available(iOS 16.0, *)
struct ControlVehicleWindowsIntent: VehicleIntent {
    static let title: LocalizedStringResource = "车窗控制"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "操作", requestValueDialog: "要打开还是关闭车窗？")
    var operation: VehicleOpeningOperation
    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$operation) \(\.$vehicle) 的车窗")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text: String
        switch operation {
        case .open:
            text = try await performControl(
                .windowsOpen,
                confirmation: { "要打开 \($0) 的所有车窗吗？" },
                completed: "车窗已全部打开。"
            )
        case .close:
            text = try await performControl(
                .windowsClose,
                confirmation: { "要关闭 \($0) 的所有车窗吗？请确认车窗周围安全。" },
                completed: "车窗已全部关闭。"
            )
        }
        return .result(dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
struct ControlVehicleTailgateIntent: VehicleIntent {
    static let title: LocalizedStringResource = "后备箱控制"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "操作", requestValueDialog: "要打开还是关闭后备箱？")
    var operation: VehicleOpeningOperation
    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$operation) \(\.$vehicle) 的后备箱")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text: String
        switch operation {
        case .open:
            text = try await performControl(
                .tailgateOpen,
                confirmation: { "要打开 \($0) 的后备箱吗？请确认车后有足够空间。" },
                completed: "后备箱已打开。"
            )
        case .close:
            text = try await performControl(
                .tailgateClose,
                confirmation: { "要关闭 \($0) 的后备箱吗？请确认尾门周围安全。" },
                completed: "后备箱已关闭。"
            )
        }
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
        let text = try await performClimate(.start)
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
        let text = try await performClimate(.stop)
        return .result(dialog: "\(text)")
    }
}

@available(iOS 16.0, *)
enum VehicleClimateOperation: String, AppEnum {
    case start, stop

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "空调操作"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .start: "开启",
        .stop: "关闭",
    ]
}

@available(iOS 16.0, *)
struct ControlVehicleClimateIntent: VehicleIntent {
    static let title: LocalizedStringResource = "空调控制"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "操作", requestValueDialog: "要开启还是关闭空调？")
    var operation: VehicleClimateOperation
    @Parameter(title: "车辆") var vehicle: SiriVehicle?
    var vehicleParameter: IntentParameter<SiriVehicle?> { $vehicle }

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$operation) \(\.$vehicle) 的空调")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = try await performClimate(operation)
        return .result(dialog: "\(text)")
    }
}

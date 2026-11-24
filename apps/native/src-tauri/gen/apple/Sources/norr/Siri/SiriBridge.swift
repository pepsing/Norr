import Foundation

enum SiriVehicleAction: String, Encodable {
    case vehicles, energy, lockState, lock, unlock
    case windowsOpen, windowsClose, tailgateOpen, tailgateClose, climateStart, climateStop
}

struct SiriVehicleOption: Decodable, Sendable {
    let id: String
    let name: String
    let trunkUnlockOnly: Bool?
}

struct SiriTailgateControl {
    let action: SiriVehicleAction
    let confirmation: String
    let completed: String

    init(open: Bool, vehicle: String, unlockOnly: Bool) throws {
        if unlockOnly && !open {
            throw SiriVehicleError("此车辆仅支持解锁尾门，请手动关闭尾门。")
        }
        action = open ? .tailgateOpen : .tailgateClose
        if unlockOnly {
            confirmation = "要解锁 \(vehicle) 的后备箱吗？解锁后请手动打开。"
            completed = "后备箱已解锁。"
        } else {
            confirmation = open ? "要打开 \(vehicle) 的后备箱吗？请确认车后有足够空间。"
                : "要关闭 \(vehicle) 的后备箱吗？请确认尾门周围安全。"
            completed = open ? "后备箱已打开。" : "后备箱已关闭。"
        }
    }
}

struct SiriReading: Decodable {
    struct Value: Decodable {
        let percent: Double?
        let rangeKm: Double?
        let locked: Bool?
        let chargeState: UInt64?
        let powerKw: Double?
        let minutesToTarget: UInt64?
    }

    let value: Value?
    let reportedAt: UInt64?

    var chargingSummary: String {
        let states: [UInt64: String] = [
            1: "车辆正在充电。",
            2: "车辆目前没有在充电。",
            3: "车辆正在等待预约充电。",
            4: "车辆正在放电。",
            5: "车辆报告充电异常。",
            6: "车辆处于智能充电状态。",
            7: "充电已暂停。",
            8: "充电已完成。",
            9: "车辆正在等待充电。",
        ]
        guard let value, let state = value.chargeState, var summary = states[state] else {
            return "充电状态未知。"
        }
        if state == 1 || state == 6 {
            if let power = value.powerKw, power.isFinite, power > 0 {
                let number = power.formatted(.number.precision(.fractionLength(0...1)))
                summary += "当前充电功率 \(number) 千瓦。"
            }
            if let minutes = value.minutesToTarget, minutes > 0 {
                summary += "预计还有 \(minutes) 分钟达到目标电量。"
            } else {
                summary += "暂时无法估算充至目标电量的时间。"
            }
        }
        return summary
    }
}

struct SiriVehicleReply: Decodable {
    enum Status: String, Decodable {
        case vehicles, reading, confirmed, accepted, pending, pendingConflict, rejected, error
    }

    let status: Status
    let vehicles: [SiriVehicleOption]?
    let preferred: String?
    let reading: SiriReading?
    let message: String?
}

struct SiriVehicleError: LocalizedError {
    let errorDescription: String?

    init(_ message: String = "Norr 暂时无法处理这个请求。") {
        errorDescription = message
    }
}

enum SiriBridge {
    private struct Request: Encodable {
        let action: SiriVehicleAction
        let vehicle: String?
    }

    private final class Cancellation: @unchecked Sendable {
        let pointer = norr_siri_cancellation_new()
        func cancel() { norr_siri_cancel(pointer) }
        deinit { norr_siri_cancellation_free(pointer) }
    }

    private final class Completion {
        let continuation: CheckedContinuation<SiriVehicleReply, Error>
        init(_ continuation: CheckedContinuation<SiriVehicleReply, Error>) {
            self.continuation = continuation
        }
    }

    static func run(_ action: SiriVehicleAction, vehicle: String? = nil) async throws -> SiriVehicleReply {
        let data = try JSONEncoder().encode(Request(action: action, vehicle: vehicle))
        let payload = String(decoding: data, as: UTF8.self)
        let cancellation = Cancellation()
        let response: SiriVehicleReply = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let context = Unmanaged.passRetained(Completion(continuation)).toOpaque()
                payload.withCString { request in
                    norr_siri_run(request, cancellation.pointer, context) { context, payload in
                        let completion = Unmanaged<Completion>.fromOpaque(context).takeRetainedValue()
                        let result = Result {
                            guard let payload else { throw SiriVehicleError() }
                            let bytes = Data(String(cString: payload).utf8)
                            return try JSONDecoder().decode(SiriVehicleReply.self, from: bytes)
                        }
                        completion.continuation.resume(with: result)
                    }
                }
            }
        } onCancel: {
            cancellation.cancel()
        }
        try Task.checkCancellation()
        if response.status == .error {
            throw SiriVehicleError(response.message ?? "车辆请求未完成。")
        }
        return response
    }
}

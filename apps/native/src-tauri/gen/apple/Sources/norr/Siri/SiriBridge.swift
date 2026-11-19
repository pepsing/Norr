import Foundation

enum SiriVehicleAction: String, Encodable {
    case vehicles, energy, lockState, lock, climateStart, climateStop
}

struct SiriVehicleOption: Decodable, Sendable {
    let id: String
    let name: String
}

struct SiriReading: Decodable {
    struct Value: Decodable {
        let percent: Double?
        let rangeKm: Double?
        let locked: Bool?
    }

    let value: Value?
    let reportedAt: UInt64?
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

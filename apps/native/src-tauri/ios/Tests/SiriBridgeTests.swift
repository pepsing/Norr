import Foundation

@main
enum SiriBridgeTests {
    static func main() async throws {
        let fleet = try await SiriBridge.run(.vehicles)
        precondition(fleet.vehicles?.first?.id == "fixture" && fleet.preferred == "fixture")

        let reading = try await SiriBridge.run(.energy, vehicle: "fixture").reading
        precondition(reading?.value?.percent == 0 && reading?.value?.rangeKm == nil)
        precondition(reading?.reportedAt == 1000)
        precondition(reading?.chargingSummary == "充电状态未知。")

        let decoder = JSONDecoder()
        let charging = try decoder.decode(SiriReading.self, from: Data(
            #"{"value":{"chargeState":1,"powerKw":7.2,"minutesToTarget":36},"reportedAt":1000}"#.utf8
        ))
        precondition(charging.chargingSummary.contains("正在充电"))
        precondition(charging.chargingSummary.contains("千瓦"))
        precondition(charging.chargingSummary.contains("36 分钟"))

        let paused = try decoder.decode(SiriReading.self, from: Data(
            #"{"value":{"chargeState":7,"powerKw":7.2,"minutesToTarget":36}}"#.utf8
        ))
        precondition(paused.chargingSummary == "充电已暂停。")

        let unknown = try decoder.decode(SiriReading.self, from: Data(
            #"{"value":{"chargeState":99,"minutesToTarget":36}}"#.utf8
        ))
        precondition(unknown.chargingSummary == "充电状态未知。")

        let noEstimate = try decoder.decode(SiriReading.self, from: Data(
            #"{"value":{"chargeState":6,"powerKw":0,"minutesToTarget":0}}"#.utf8
        ))
        precondition(noEstimate.chargingSummary == "车辆处于智能充电状态。暂时无法估算充至目标电量的时间。")

        do {
            _ = try await SiriBridge.run(.lockState, vehicle: "fixture")
            preconditionFailure("Backend error was returned as success")
        } catch let error as SiriVehicleError {
            precondition(error.errorDescription == "请先在 Norr 登录")
        }

        do {
            _ = try await SiriBridge.run(.lock, vehicle: "fixture")
            preconditionFailure("Null payload was returned as success")
        } catch is SiriVehicleError {}

        for action: SiriVehicleAction in [.unlock, .windowsOpen, .windowsClose, .tailgateOpen, .tailgateClose] {
            let reply = try await SiriBridge.run(action, vehicle: "fixture")
            precondition(reply.status == .confirmed)
        }

        let task = Task { try await SiriBridge.run(.climateStart, vehicle: "fixture") }
        try await Task.sleep(nanoseconds: 30_000_000)
        task.cancel()
        do {
            _ = try await task.value
            preconditionFailure("Cancelled request returned success")
        } catch is CancellationError {}

        print("Siri bridge fixtures passed")
    }
}

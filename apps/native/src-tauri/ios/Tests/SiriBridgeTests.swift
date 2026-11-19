import Foundation

@main
enum SiriBridgeTests {
    static func main() async throws {
        let fleet = try await SiriBridge.run(.vehicles)
        precondition(fleet.vehicles?.first?.id == "fixture" && fleet.preferred == "fixture")

        let reading = try await SiriBridge.run(.energy, vehicle: "fixture").reading
        precondition(reading?.value?.percent == 0 && reading?.value?.rangeKm == nil)
        precondition(reading?.reportedAt == 1000)

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

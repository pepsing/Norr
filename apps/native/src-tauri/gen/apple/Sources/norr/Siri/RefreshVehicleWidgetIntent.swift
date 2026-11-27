import AppIntents
import CryptoKit
import Foundation

@available(iOS 17.0, *)
struct RefreshVehicleWidgetIntent: AppIntent {
    static let title: LocalizedStringResource = "刷新小组件车况"
    static let isDiscoverable = false
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "车辆") var vehicle: String

    init() {}

    init(account: String, vin: String) {
        vehicle = SHA256.hash(data: Data((account + vin).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    #if compiler(>=6.4)
    @available(iOS 27.0, *)
    static var allowedExecutionTargets: IntentExecutionTargets { .main }
    #endif

    func perform() async throws -> some IntentResult {
        try await refresh()
        return .result()
    }

    private func refresh() async throws {
        #if NORR_WIDGET_EXTENSION
        throw CocoaError(.featureUnsupported)
        #else
        let response = try await SiriBridge.run(.widgetRefresh, vehicle: vehicle)
        guard response.status == .refreshed else { throw SiriVehicleError() }
        #endif
    }
}

// On iOS 17–26 this conformance routes the button to the app process in the background.
@available(iOS 17.0, *)
@available(iOSApplicationExtension, unavailable)
extension RefreshVehicleWidgetIntent: ForegroundContinuableIntent {}

import Foundation
import Tauri
import WatchConnectivity

private struct WatchSyncArguments: Decodable {
    let authorization: String
    let automatic: Bool?
}

final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()
    private var pending: (Data, Bool, (Result<Void, Error>) -> Void)?

    private override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func synchronize(_ data: Data, automatic: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        guard WCSession.isSupported() else {
            completion(.failure(failure("此设备不支持 Apple Watch 配对")))
            return
        }
        if automatic && UserDefaults.standard.bool(forKey: "watch.autoSyncDisabled") {
            completion(.success(()))
            return
        }
        guard pending == nil else {
            completion(.failure(failure("手表同步正在进行")))
            return
        }
        pending = (data, automatic, completion)
        if WCSession.default.activationState == .activated { sendPending() }
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "NorrWatch", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func sendPending() {
        guard let (data, automatic, completion) = pending else { return }
        pending = nil
        do {
            guard WCSession.default.isPaired else { throw failure("请先将 Apple Watch 与这台 iPhone 配对") }
            guard WCSession.default.isWatchAppInstalled else { throw failure("请先在 Apple Watch 安装 Norr") }
            guard var authorization = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("手表同步数据无效") }
            let previousData = WCSession.default.applicationContext["norrAuthorization"] as? Data
            let previous = previousData.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            guard WatchSyncPolicy.shouldSend(automatic: automatic,
                                             paused: UserDefaults.standard.bool(forKey: "watch.autoSyncDisabled"),
                                             current: authorization, previous: previous) else {
                completion(.success(()))
                return
            }
            let version = max(Date().timeIntervalSince1970 * 1000, UserDefaults.standard.double(forKey: "watch.syncVersion") + 1)
            authorization["version"] = version
            let payload = try JSONSerialization.data(withJSONObject: authorization)
            try WCSession.default.updateApplicationContext(["norrAuthorization": payload])
            UserDefaults.standard.set(version, forKey: "watch.syncVersion")
            if !automatic {
                UserDefaults.standard.set((authorization["accessToken"] as? String)?.isEmpty == true,
                                          forKey: "watch.autoSyncDisabled")
            }
            completion(.success(()))
        } catch { completion(.failure(error)) }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            if let error {
                let completion = self.pending?.2
                self.pending = nil
                completion?(.failure(error))
            } else if activationState == .activated {
                self.sendPending()
            }
        }
    }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}

extension NorrPlugin {
    func synchronizeWatch(_ invoke: Invoke) throws {
        let arguments = try invoke.parseArgs(WatchSyncArguments.self)
        guard let data = arguments.authorization.data(using: .utf8) else {
            invoke.reject("手表同步数据无效")
            return
        }
        DispatchQueue.main.async {
            WatchBridge.shared.synchronize(data, automatic: arguments.automatic ?? false) { result in
                switch result {
                case .success: invoke.resolve()
                case .failure(let error): invoke.reject(error.localizedDescription)
                }
            }
        }
    }
}

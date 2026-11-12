import LocalAuthentication
import Tauri
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import WebKit

private struct UrlArgs: Decodable { let url: String }
private struct ExportArgs: Decodable {
  let path: String
  let format: String
}
private struct NoticeArgs: Decodable {
  let id: String
  let title: String
  let body: String
  let page: String
  let vin: String
}
private struct NotificationTarget: Codable {
  let page: String
  let vin: String
}

final class NorrPlugin: Plugin, UNUserNotificationCenterDelegate {
  private var active = false
  private var generation = 0
  private var target: NotificationTarget?
  private var verification: PhoneVerificationController?
  private var document: DocumentOperation?
  private weak var webview: WKWebView?

  override func load(webview: WKWebView) {
    self.webview = webview
    active = UIApplication.shared.applicationState == .active
    NotificationCenter.default.addObserver(
      self, selector: #selector(enteredForeground),
      name: UIApplication.didBecomeActiveNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(enteredBackground),
      name: UIApplication.willResignActiveNotification, object: nil)
    UNUserNotificationCenter.current().delegate = self
  }

  @objc private func enteredForeground() {
    active = true
    generation += 1
    webview?.evaluateJavaScript("window.dispatchEvent(new Event('focus'))")
  }
  @objc private func enteredBackground() { active = false }

  @objc func lifecycle(_ invoke: Invoke) {
    DispatchQueue.main.async {
      invoke.resolve(["active": self.active, "generation": self.generation])
    }
  }

  @objc func systemStatus(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      invoke.resolve(["launchAtLogin": -1, "notifications": settings.authorizationStatus.rawValue])
    }
  }

  @objc func requestNotifications(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
      allowed, error in
      if error != nil {
        invoke.reject("无法请求通知权限，请重试。")
      } else if !allowed {
        invoke.reject("请在 iOS 设置中允许 Norr 通知。")
      } else {
        invoke.resolve()
      }
    }
  }

  @objc func postNotification(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NoticeArgs.self)
    let content = UNMutableNotificationContent()
    content.title = args.title
    content.body = args.body
    content.sound = .default
    content.userInfo = ["page": args.page, "vin": args.vin]
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: args.id, content: content, trigger: nil)
    ) { error in
      if error != nil { invoke.reject("通知发送失败，请重试。") } else { invoke.resolve() }
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) { completionHandler([.banner, .list, .sound]) }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    DispatchQueue.main.async {
      if let page = info["page"] as? String,
        ["vehicle", "charging", "history", "settings"].contains(page)
      {
        self.target = NotificationTarget(page: page, vin: info["vin"] as? String ?? "")
        self.webview?.evaluateJavaScript("window.dispatchEvent(new Event('focus'))")
      }
      completionHandler()
    }
  }

  @objc func takeNotificationTarget(_ invoke: Invoke) {
    DispatchQueue.main.async {
      invoke.resolve(self.target)
      self.target = nil
    }
  }

  @objc func openSettings(_ invoke: Invoke) {
    DispatchQueue.main.async {
      UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) { opened in
        if opened { invoke.resolve() } else { invoke.reject("无法打开系统设置。") }
      }
    }
  }

  @objc func openUrl(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(UrlArgs.self)
    guard let url = URL(string: args.url), url.scheme == "https" else {
      invoke.reject("地图地址无效。")
      return
    }
    DispatchQueue.main.async {
      UIApplication.shared.open(url) { opened in
        if opened { invoke.resolve() } else { invoke.reject("无法打开地图。") }
      }
    }
  }

  @objc func confirmCredential(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let context = LAContext()
      var error: NSError?
      guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        invoke.reject("请先在 iOS 设置中配置设备密码或 Face ID，再确认车辆操作。")
        return
      }
      context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "确认 Norr 的车辆操作") {
        authorized, _ in
        invoke.resolve(["authorized": authorized])
      }
    }
  }

  @objc func verifyPhone(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard self.verification == nil, let presenter = self.manager.viewController,
        presenter.presentedViewController == nil
      else {
        invoke.reject("请先完成当前窗口中的操作。")
        return
      }
      let controller = PhoneVerificationController(invoke: invoke) { [weak self] in
        self?.verification = nil
      }
      self.verification = controller
      let navigation = UINavigationController(rootViewController: controller)
      navigation.modalPresentationStyle = .pageSheet
      navigation.isModalInPresentation = true
      presenter.present(navigation, animated: true)
    }
  }

  @objc func openBackup(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard self.document == nil, let presenter = self.manager.viewController,
        presenter.presentedViewController == nil
      else {
        invoke.reject("请先完成当前文件操作。")
        return
      }
      let operation = DocumentOperation(invoke: invoke, export: nil) { [weak self] in
        self?.document = nil
      }
      self.document = operation
      operation.present(from: presenter)
    }
  }

  @objc func saveHistory(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportArgs.self)
    let source = URL(fileURLWithPath: args.path).standardizedFileURL.resolvingSymlinksInPath()
    let appData = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[
      0
    ]
    .appendingPathComponent("app.norr.ios/files", isDirectory: true)
    .standardizedFileURL.resolvingSymlinksInPath()
    guard ["json", "csv"].contains(args.format), source.deletingLastPathComponent() == appData,
      source.lastPathComponent.hasPrefix("export-")
    else {
      invoke.reject("导出文件路径无效。")
      return
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let copy = directory.appendingPathComponent("norr-history.\(args.format)")
      try FileManager.default.copyItem(at: source, to: copy)
      DispatchQueue.main.async {
        guard self.document == nil, let presenter = self.manager.viewController,
          presenter.presentedViewController == nil
        else {
          try? FileManager.default.removeItem(at: directory)
          invoke.reject("请先完成当前文件操作。")
          return
        }
        let operation = DocumentOperation(invoke: invoke, export: copy) { [weak self] in
          self?.document = nil
        }
        self.document = operation
        operation.present(from: presenter)
      }
    } catch {
      try? FileManager.default.removeItem(at: directory)
      invoke.reject("无法准备导出文件，请重试。")
    }
  }
}

private final class DocumentOperation: NSObject, UIDocumentPickerDelegate {
  let invoke: Invoke
  let export: URL?
  let closed: () -> Void

  init(invoke: Invoke, export: URL?, closed: @escaping () -> Void) {
    self.invoke = invoke
    self.export = export
    self.closed = closed
  }

  func present(from presenter: UIViewController) {
    let picker: UIDocumentPickerViewController
    if let export {
      picker = UIDocumentPickerViewController(forExporting: [export], asCopy: true)
    } else {
      picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: false)
    }
    picker.delegate = self
    picker.allowsMultipleSelection = false
    presenter.present(picker, animated: true)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    if export != nil {
      invoke.resolve(["saved": false])
    } else {
      invoke.resolve(["path": NSNull()])
    }
    finish()
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL])
  {
    guard let source = urls.first else {
      documentPickerWasCancelled(controller)
      return
    }
    if export != nil {
      invoke.resolve(["saved": true])
      finish()
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      let access = source.startAccessingSecurityScopedResource()
      defer {
        if access { source.stopAccessingSecurityScopedResource() }
        DispatchQueue.main.async { self.finish() }
      }
      let copy = FileManager.default.temporaryDirectory.appendingPathComponent(
        "norr-import-\(UUID().uuidString).json")
      do {
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 256 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard
          FileManager.default.createFile(
            atPath: copy.path, contents: nil, attributes: [.posixPermissions: 0o600])
        else {
          throw CocoaError(.fileWriteUnknown)
        }
        let output = try FileHandle(forWritingTo: copy)
        defer { try? output.close() }
        var total = 0
        while let chunk = try input.read(upToCount: 65536), !chunk.isEmpty {
          total += chunk.count
          guard total <= 256 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
          try output.write(contentsOf: chunk)
        }
        try output.synchronize()
        self.invoke.resolve(["path": copy.path])
      } catch {
        try? FileManager.default.removeItem(at: copy)
        self.invoke.reject("无法读取备份，请确认文件有效且不超过 256 MB。")
      }
    }
  }

  private func finish() {
    if let export { try? FileManager.default.removeItem(at: export.deletingLastPathComponent()) }
    closed()
  }
}

@_cdecl("init_plugin_norr")
public func initPlugin() -> Plugin { NorrPlugin() }

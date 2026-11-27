import CryptoKit
import Foundation
import NorrWidgetSupport
import Tauri
import WidgetKit

struct WidgetVehicle: Codable {
  let vin: String
  let model: String
  let batteryPercent: Double?
  let rangeKm: Double?
  let locked: Bool?
  let climate: String
  let charging: Int?
  let updatedAt: Double?
  let artwork: String
  let freshnessPending: Bool?
  let accountScope: String?
  let observedAt: Double?
}

struct WidgetRecord: Codable {
  let data: WidgetVehicle
  let imageName: String
  let darkImageName: String?
  let portraitImageName: String?
}

struct WidgetUpdate: Decodable {
  let data: WidgetVehicle?
  let imagePath: String?
  let darkImagePath: String?
  let portraitPath: String?
  let clear: Bool?
}

extension NorrPlugin {
  func syncWidgets(_ invoke: Invoke) throws {
    let update = try invoke.parseArgs(WidgetUpdate.self)
    guard let directory = WidgetStorage.directory() else {
      invoke.reject("小组件共享权限不可用，请使用新版 IPA 重新签名安装，并保留小组件扩展。")
      return
    }
    do {
      if update.clear == true {
        try WidgetStorage.clear(in: directory)
        reloadVehicleWidgets()
        invoke.resolve()
        return
      }
      guard let data = update.data, let imagePath = update.imagePath else {
        invoke.reject("小组件数据不完整，请重新刷新车辆。")
        return
      }
      func storeImage(_ path: String, extension suffix: String) throws -> String {
        let image = try Data(contentsOf: URL(fileURLWithPath: path))
        let digest = SHA256.hash(data: image).map { String(format: "%02x", $0) }.joined()
        let name = "vehicle-\(digest).\(suffix)"
        let url = directory.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: url.path) {
          try image.write(to: url, options: .atomic)
        }
        return name
      }
      let imageName = try storeImage(imagePath, extension: "jpg")
      let darkImageName = try update.darkImagePath.map { try storeImage($0, extension: "webp") }
      let portrait = try update.portraitPath.map { try storeImage($0, extension: "webp") }
      let record = WidgetRecord(data: data, imageName: imageName, darkImageName: darkImageName, portraitImageName: portrait)
      try WidgetStorage.write(JSONEncoder().encode(record), to: directory)
      reloadVehicleWidgets()
      invoke.resolve()
    } catch {
      invoke.reject("小组件数据保存失败，请重新刷新车辆。")
    }
  }
}

@_cdecl("norr_widget_readback")
public func norrWidgetReadback(_ json: UnsafePointer<CChar>?) -> Bool {
  guard let json, let directory = WidgetStorage.directory(),
        let bytes = String(cString: json).data(using: .utf8),
        let values = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        (try? WidgetStorage.applyReadback(values, in: directory)) == true else { return false }
  reloadVehicleWidgets()
  return true
}

private func reloadVehicleWidgets() {
  WidgetCenter.shared.reloadTimelines(ofKind: "NorrVehicle")
  WidgetCenter.shared.reloadTimelines(ofKind: "NorrPortrait")
}

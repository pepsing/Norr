import CryptoKit
import Foundation
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
}

struct WidgetRecord: Codable {
  let data: WidgetVehicle
  let imageName: String
}

struct WidgetUpdate: Decodable {
  let data: WidgetVehicle
  let imagePath: String
}

extension NorrPlugin {
  @objc func updateWidgets(_ invoke: Invoke) throws {
    let update = try invoke.parseArgs(WidgetUpdate.self)
    guard let directory = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: "group.app.norr.widgets")
    else {
      invoke.reject("小组件共享空间不可用，请检查 App Groups 签名配置。")
      return
    }
    do {
      let image = try Data(contentsOf: URL(fileURLWithPath: update.imagePath))
      let digest = SHA256.hash(data: image).map { String(format: "%02x", $0) }.joined()
      let imageName = "vehicle-\(digest).jpg"
      let imageURL = directory.appendingPathComponent(imageName)
      if !FileManager.default.fileExists(atPath: imageURL.path) {
        try image.write(to: imageURL, options: .atomic)
      }
      let record = WidgetRecord(data: update.data, imageName: imageName)
      try JSONEncoder().encode(record).write(
        to: directory.appendingPathComponent("vehicle.json"), options: .atomic)
      WidgetCenter.shared.reloadTimelines(ofKind: "NorrVehicle")
      invoke.resolve()
    } catch {
      invoke.reject("小组件数据保存失败，请重新刷新车辆。")
    }
  }
}

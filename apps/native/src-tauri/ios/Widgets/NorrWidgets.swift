import AppIntents
import ImageIO
import SwiftUI
import WidgetKit

#if os(macOS)
typealias WidgetImage = NSImage
#else
typealias WidgetImage = UIImage
#endif

extension Image {
  init(widgetImage: WidgetImage) {
    #if os(macOS)
    self.init(nsImage: widgetImage)
    #else
    self.init(uiImage: widgetImage)
    #endif
  }
}

enum WidgetAppearance: String, AppEnum {
  case system, light, dark
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "外观"
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .system: "跟随系统", .light: "浅色", .dark: "深色"
  ]
}

struct WidgetOptions: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Norr 车辆"
  static let description = IntentDescription("显示当前车辆的电量、续航和控制入口。")
  @Parameter(title: "外观", default: .system) var appearance: WidgetAppearance
}

struct VehicleData: Decodable {
  let vin: String
  let model: String
  let batteryPercent: Double?
  let rangeKm: Double?
  let locked: Bool?
  let climate: String
  let charging: Int?
  let updatedAt: Double?
  let artwork: String
  var freshnessPending: Bool? = nil

  var lockLabel: String {
    guard let locked else { return "门锁未知" }
    return locked ? "已锁车" : "已解锁"
  }
  var climateLabel: String {
    switch climate {
    case "active": return "空调运行中"
    case "starting": return "空调启动中"
    case "idle": return "空调关闭"
    default: return "空调未知"
    }
  }
  var chargingLabel: String {
    switch charging {
    case 1: return "充电中"
    case 2: return "空闲"
    case 3: return "等待预约"
    case 4: return "放电中"
    case 5: return "充电异常"
    case 6: return "智能充电"
    case 7: return "已暂停"
    case 8: return "充电完成"
    case 9: return "等待充电"
    default: return "未知"
    }
  }
  func url(_ action: String) -> URL {
    var components = URLComponents()
    components.scheme = "norr"
    components.host = "widget"
    components.path = "/\(action)"
    components.queryItems = [URLQueryItem(name: "vin", value: vin)]
    return components.url!
  }
}

struct StoredVehicle: Decodable {
  let data: VehicleData
  let imageName: String
  let darkImageName: String?
  let portraitImageName: String?
}

struct VehicleEntry: TimelineEntry {
  let date: Date
  let configuration: WidgetOptions
  var data: VehicleData?
  var image: WidgetImage?
  var darkImage: WidgetImage?
  var preview = false
  var unavailableTitle = "等待车辆数据"
  var unavailableMessage = "打开 Norr 刷新车辆"
}

struct VehicleProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> VehicleEntry {
    VehicleEntry(date: .now, configuration: WidgetOptions())
  }

  func snapshot(for configuration: WidgetOptions, in context: Context) async -> VehicleEntry {
    var entry = load(configuration)
    if context.isPreview && entry.data == nil {
      entry.data = VehicleData(
        vin: "", model: "Polestar 2", batteryPercent: 30, rangeKm: 130,
        locked: true, climate: "idle", charging: 2, updatedAt: nil, artwork: "")
      entry.preview = true
    }
    return entry
  }

  func timeline(for configuration: WidgetOptions, in context: Context) async -> Timeline<VehicleEntry> {
    Timeline(entries: [load(configuration)], policy: .after(.now.addingTimeInterval(900)))
  }

  fileprivate func load(_ configuration: WidgetOptions, portrait: Bool = false) -> VehicleEntry {
    var entry = VehicleEntry(date: .now, configuration: configuration)
    guard let directory = WidgetStorage.directory() else {
      entry.unavailableTitle = "共享权限不可用"
      #if os(macOS)
      entry.unavailableMessage = "打开 Norr 刷新车辆后重试"
      #else
      entry.unavailableMessage = "请重新签名安装，并保留小组件扩展"
      #endif
      return entry
    }
    let stored: StoredVehicle
    do {
      let bytes = try Data(contentsOf: directory.appendingPathComponent("vehicle.json"))
      stored = try JSONDecoder().decode(StoredVehicle.self, from: bytes)
    } catch CocoaError.fileReadNoSuchFile {
      return entry
    } catch {
      entry.unavailableTitle = "车辆数据读取失败"
      return entry
    }
    entry.data = stored.data
    func croppedImage(_ name: String?, fullFrame: Bool = false) -> WidgetImage? {
      guard let name, name.hasPrefix("vehicle-"), !name.contains("/") else { return nil }
      let url = directory.appendingPathComponent(name)
      guard let image = CGImageSourceCreateWithURL(url as CFURL, nil),
            let source = CGImageSourceCreateImageAtIndex(image, 0, nil) else { return nil }
      let height = min(CGFloat(source.height), CGFloat(source.width) / 3.2)
      let width = CGFloat(source.width)
      // Both catalog side views have clear space at the ends of their studio canvas.
      let inset = portrait ? floor(width * 0.08) : 0
      let crop = CGRect(x: inset, y: (CGFloat(source.height) - height) * 0.6,
                        width: width - 2 * inset, height: height)
      let cropped = fullFrame ? source : (source.cropping(to: crop) ?? source)
      #if os(macOS)
      return NSImage(cgImage: cropped, size: NSSize(width: cropped.width, height: cropped.height))
      #else
      return UIImage(cgImage: cropped)
      #endif
    }
    if portrait {
      if let name = stored.portraitImageName {
        entry.image = croppedImage(name, fullFrame: true)
      } else {
        entry.image = croppedImage(stored.darkImageName)
      }
    } else {
      entry.image = croppedImage(stored.imageName)
      entry.darkImage = croppedImage(stored.darkImageName)
    }
    return entry
  }
}

struct VehicleWidgetView: View {
  let entry: VehicleEntry
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var systemScheme

  private var dark: Bool {
    entry.configuration.appearance == .dark ||
      (entry.configuration.appearance == .system && systemScheme == .dark)
  }
  private var canvas: Color { dark ? .black : Color(red: 247/255, green: 247/255, blue: 245/255) }
  private var ink: Color { dark ? Color(red: 238/255, green: 239/255, blue: 233/255) : Color(red: 32/255, green: 34/255, blue: 31/255) }
  private var muted: Color { dark ? Color(red: 176/255, green: 181/255, blue: 170/255) : Color(red: 98/255, green: 102/255, blue: 94/255) }
  private var tile: Color { dark ? Color(red: 32/255, green: 35/255, blue: 31/255) : Color(red: 236/255, green: 238/255, blue: 233/255) }
  private let orange = Color(red: 243/255, green: 132/255, blue: 70/255)

  var body: some View {
    Group {
      if let data = entry.data {
        content(data).widgetURL(data.url("vehicle"))
      } else {
        VStack(alignment: .leading, spacing: 12) {
          brand
          Spacer(minLength: 0)
          Text(entry.unavailableTitle).font(.headline)
          Text(entry.unavailableMessage).font(.caption).foregroundStyle(muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "norr://widget/vehicle")!)
      }
    }
    .foregroundStyle(ink)
    .padding(family == .systemLarge ? 24 : 20)
    .containerBackground(canvas, for: .widget)
  }

  private var brand: some View {
    (Text("Norr").foregroundColor(ink) + Text(".").foregroundColor(orange))
      .font(.custom("Archivo-Regular", size: family == .systemLarge ? 21 : 19)).tracking(-0.9)
  }

  @ViewBuilder private func content(_ data: VehicleData) -> some View {
    if family == .systemSmall {
      VStack(alignment: .leading, spacing: 4) {
        brand
        Spacer(minLength: 0)
        readout(data.batteryPercent, suffix: "%", size: 34)
        batteryBar(data)
        Text(data.rangeKm == nil ? "续航未知" : "续航 \(formatted(data.rangeKm)) km").font(.system(size: 12))
        Spacer(minLength: 0)
        HStack(spacing: 4) {
          Image(systemName: data.locked == false ? "lock.open" : "lock")
          Text(data.lockLabel)
          Spacer(minLength: 2)
          Text(timestamp(data, compact: true))
        }
        .font(.system(size: 10)).foregroundStyle(muted).lineLimit(1)
      }
    } else {
      VStack(alignment: .leading, spacing: family == .systemLarge ? 10 : 4) {
        HStack {
          brand
          Spacer()
          Text(data.model).font(.system(size: 12)).lineLimit(1).minimumScaleFactor(0.8)
        }
        if family == .systemLarge, let image = dark ? (entry.darkImage ?? entry.image) : entry.image {
          Image(widgetImage: image).resizable().scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: 90)
            .background(dark ? tile : Color.clear)
            .accessibilityLabel(data.model)
        }
        HStack(alignment: .firstTextBaseline) {
          VStack(alignment: .leading, spacing: 1) {
            readout(data.batteryPercent, suffix: "%", size: family == .systemLarge ? 32 : 26)
            if family == .systemLarge {
              Text("电量").font(.system(size: 11)).foregroundStyle(muted)
            }
          }
          Spacer()
          VStack(alignment: .trailing, spacing: 1) {
            readout(data.rangeKm, suffix: " km", size: family == .systemLarge ? 29 : 25)
            if family == .systemLarge {
              Text("续航").font(.system(size: 11)).foregroundStyle(muted)
            }
          }
        }
        batteryBar(data)
        if family == .systemLarge {
          HStack {
            Text("充电状态").foregroundStyle(muted)
            Spacer()
            Text(data.chargingLabel)
          }.font(.system(size: 13))
          Spacer(minLength: 0)
        }
        HStack(spacing: 8) {
          control(data, action: "lock", icon: data.locked == false ? "lock.open" : "lock", title: data.lockLabel)
          control(data, action: "climate", icon: "fanblades", title: data.climateLabel)
        }
        HStack {
          Text(timestamp(data, compact: false)).font(.system(size: 10)).foregroundStyle(muted)
          Spacer()
          Link(destination: data.url("refresh")) {
            Image(systemName: "arrow.clockwise").font(.system(size: family == .systemLarge ? 15 : 13))
              .frame(width: 28, height: family == .systemLarge ? 20 : 16)
          }.accessibilityLabel("刷新车辆")
        }
      }
    }
  }

  private func readout(_ value: Double?, suffix: String, size: CGFloat) -> some View {
    (Text(formatted(value)).font(.custom("Archivo-Regular", size: size)) +
      Text(value == nil ? "" : suffix).font(.custom("Archivo-Regular", size: size * 0.6)))
      .lineLimit(1).minimumScaleFactor(0.7)
  }

  private func batteryBar(_ data: VehicleData) -> some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Rectangle().fill(muted.opacity(0.3))
        Rectangle().fill(orange)
          .frame(width: geometry.size.width * min(100, max(0, data.batteryPercent ?? 0)) / 100)
      }
    }
    .frame(height: family == .systemLarge ? 4 : 3)
    .accessibilityHidden(true)
  }

  private func control(_ data: VehicleData, action: String, icon: String, title: String) -> some View {
    Link(destination: data.url(action)) {
      HStack(spacing: 7) {
        Image(systemName: icon).font(.system(size: 18, weight: .regular))
        Text(title).font(.system(size: 12)).lineLimit(1).minimumScaleFactor(0.8)
      }
      .frame(maxWidth: .infinity, minHeight: family == .systemLarge ? 40 : 34)
      .background(tile, in: RoundedRectangle(cornerRadius: 6))
    }.accessibilityLabel(action == "lock" ? "\(title)，打开门锁控制" : "\(title)，打开空调控制")
  }

  private func formatted(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "未知" }
    return String(format: "%.0f", value)
  }

  private func timestamp(_ data: VehicleData, compact: Bool) -> String {
    if entry.preview { return "示例数据" }
    if data.freshnessPending == true { return "等待车辆更新" }
    guard let time = data.updatedAt else { return "尚未读取" }
    let date = Date(timeIntervalSince1970: time / 1000)
    let formatter = DateFormatter()
    formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M/d HH:mm"
    return (compact ? "" : "数据于 ") + formatter.string(from: date)
  }
}

#if os(macOS)
@main
#endif
struct NorrWidgets: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "NorrVehicle", intent: WidgetOptions.self, provider: VehicleProvider()) { entry in
      VehicleWidgetView(entry: entry)
    }
    .configurationDisplayName("Norr 车辆")
    .description("查看电量与续航，打开门锁和空调控制。")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

#if os(iOS)
struct PortraitProvider: TimelineProvider {
  func placeholder(in context: Context) -> VehicleEntry {
    var entry = VehicleEntry(date: .now, configuration: WidgetOptions())
    entry.preview = true
    return entry
  }

  func getSnapshot(in context: Context, completion: @escaping (VehicleEntry) -> Void) {
    let entry = VehicleProvider().load(WidgetOptions(), portrait: true)
    completion(context.isPreview && entry.data == nil ? placeholder(in: context) : entry)
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<VehicleEntry>) -> Void) {
    let entry = VehicleProvider().load(WidgetOptions(), portrait: true)
    completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(900))))
  }
}

struct VehiclePortraitView: View {
  let entry: VehicleEntry

  private func caption(_ data: VehicleData) -> String {
    guard data.freshnessPending != true, let value = data.batteryPercent,
          (0...100).contains(value), let timestamp = data.updatedAt else { return data.model }
    let reported = Date(timeIntervalSince1970: timestamp / 1000)
    let prefix = Calendar.current.isDate(reported, inSameDayAs: entry.date) ? "" : "上次 "
    return "\(data.model) · \(prefix)\(Int(value.rounded()))%"
  }

  var body: some View {
    VStack(spacing: 6) {
      if let image = entry.image {
        Image(widgetImage: image).resizable().scaledToFit().accessibilityHidden(true)
      } else {
        Image(systemName: "car.side").font(.largeTitle).accessibilityHidden(true)
      }
      Text(entry.data.map(caption) ?? (entry.preview ? "北行车影 · 示例" : entry.unavailableTitle))
        .font(.subheadline).lineLimit(1).minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .containerBackground(.clear, for: .widget)
  }
}

struct NorrPortraitWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NorrPortrait", provider: PortraitProvider()) { entry in
      VehiclePortraitView(entry: entry)
    }
    .configurationDisplayName("北行车影")
    .description("在 CarPlay 查看你的车和电量。车辆视角跟随北行 App 设置。")
    .supportedFamilies([.systemSmall])
  }
}

@main
struct NorrWidgetBundle: WidgetBundle {
  var body: some Widget {
    NorrWidgets()
    NorrPortraitWidget()
  }
}
#endif

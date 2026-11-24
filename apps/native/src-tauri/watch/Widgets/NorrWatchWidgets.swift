import SwiftUI
import WidgetKit

struct VehicleEntry: TimelineEntry {
  let date: Date
  let vehicle: WatchWidgetSnapshot?
}

struct VehicleProvider: TimelineProvider {
  func placeholder(in context: Context) -> VehicleEntry {
    VehicleEntry(date: .now, vehicle: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (VehicleEntry) -> Void) {
    completion(VehicleEntry(date: .now, vehicle: WatchWidgetCache.read()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<VehicleEntry>) -> Void) {
    let entry = VehicleEntry(date: .now, vehicle: WatchWidgetCache.read())
    completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(900))))
  }
}

struct VehicleWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: VehicleEntry

  private var battery: String {
    entry.vehicle?.batteryPercent.map { String(format: "%.0f", $0) } ?? "--"
  }

  private var isStale: Bool {
    if entry.vehicle?.freshnessPending == true { return true }
    guard let date = entry.vehicle?.updatedAt else { return true }
    return entry.date.timeIntervalSince(date) > 900
  }

  private var batteryLabel: String {
    guard entry.vehicle?.batteryPercent != nil else { return "未知" }
    if entry.vehicle?.isDemo == true { return "演示 %" }
    return isStale ? "缓存 %" : "电量 %"
  }

  private var batteryValue: String {
    entry.vehicle?.batteryPercent == nil ? "--" : "\(battery)%"
  }

  var body: some View {
    Group {
      if family == .accessoryCircular {
        VStack(spacing: 0) {
          Text(battery).font(.custom("Archivo-Regular", size: 25, relativeTo: .title2))
          Text(batteryLabel).font(.caption2)
        }
      } else {
        VStack(alignment: .leading, spacing: 2) {
          Text(entry.vehicle?.isDemo == true ? "Norr · 演示" : "Norr").font(.caption)
          HStack(alignment: .firstTextBaseline) {
            Text(batteryValue).font(.custom("Archivo-Regular", size: 25, relativeTo: .title2))
            Spacer()
            Text(entry.vehicle?.rangeKm.map { String(format: "%.0f km", $0) } ?? "-- km")
              .font(.caption)
          }
          if let date = entry.vehicle?.updatedAt {
            HStack(spacing: 3) {
              Text(isStale ? "缓存" : "更新")
              Text(date, style: .time)
            }.font(.caption2).foregroundStyle(.secondary)
          } else {
            Text("打开 Norr 同步车辆").font(.caption2)
          }
        }
      }
    }
    .containerBackground(.black, for: .widget)
    .widgetURL(URL(string: "norr://vehicle"))
    .accessibilityLabel("Norr，电量 \(batteryValue)，\(batteryLabel)，打开查看车辆")
  }
}

@main
struct NorrWatchWidgets: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NorrWatchVehicle", provider: VehicleProvider()) { entry in
      VehicleWidgetView(entry: entry)
    }
    .configurationDisplayName("Norr 车辆")
    .description("查看最近同步的电量、续航与时间。")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular])
  }
}

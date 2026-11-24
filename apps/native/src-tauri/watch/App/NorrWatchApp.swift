import SwiftUI
import WatchKit
import WidgetKit

@main
struct NorrWatchApp: App {
  var body: some Scene {
    WindowGroup { WatchRootView() }
  }
}

private enum WatchPage: Hashable { case climate, locks, charging, more }

@MainActor
struct WatchRootView: View {
  @StateObject private var remote = WatchRemoteClient()
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dynamicTypeSize) private var systemTypeSize
  @State private var snapshot: WatchSnapshot?
  @State private var path: [WatchPage] = []
  @State private var confirmation: String?
  @State private var busy = false
  @State private var message = ""
  @State private var demoPending: String?
  @State private var timeoutDemo = false
  @State private var largeTypeDemo = false
  @State private var cached = false
  private let demo = ProcessInfo.processInfo.arguments.contains("--demo")
  private let compact = WKInterfaceDevice.current().screenBounds.width < 190
  private let orange = Color(red: 1, green: 0.502, blue: 0)
  private let ink = Color(red: 0.126, green: 0.133, blue: 0.122)
  private var pending: String? { demo ? demoPending : remote.pendingAction }
  private var priorityFeedback: Bool { busy || pending != nil }
  private var controlsLayout: AnyLayout {
    if largeTypeDemo || systemTypeSize.isAccessibilitySize {
      return AnyLayout(VStackLayout(spacing: 6))
    }
    return AnyLayout(HStackLayout(spacing: 6))
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollViewReader { reader in
        ScrollView {
          VStack(alignment: .leading, spacing: 6) {
            if priorityFeedback { feedback.id("status") }
            if cached { Text("缓存 · 最近读取未成功").font(.caption2).foregroundStyle(.secondary) }
            if let data = snapshot {
              overview(data)
            } else {
              Image(systemName: "iphone.and.arrow.forward").font(.largeTitle)
              Text(remote.configured ? "正在读取车辆" : "在 iPhone 登录").font(.headline)
              Text("打开 iPhone 上的 Norr，登录后自动同步。").font(.footnote).foregroundStyle(.secondary)
            }
            if !priorityFeedback { feedback }
          }.scenePadding(.horizontal).padding(.bottom, 8)
        }
        .safeAreaPadding(.bottom, 8)
        .scrollBounceBehavior(.basedOnSize)
        .onChange(of: priorityFeedback) { _, show in
          if show { reader.scrollTo("status", anchor: .top) }
        }
      }
      .navigationTitle(demo ? "Norr. · 演示" : "Norr.")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { path.append(.more) } label: {
            Image(systemName: "ellipsis").foregroundStyle(.white).accessibilityLabel("更多操作")
          }.tint(Color(red: 0.145, green: 0.161, blue: 0.137))
        }
      }
      .navigationDestination(for: WatchPage.self) { page in
        ScrollViewReader { reader in
          ScrollView {
            VStack(alignment: .leading, spacing: 8) {
              if priorityFeedback { feedback.id("status") }
              if page == .more {
                control("刷新车辆", symbol: "arrow.clockwise") { Task { await refresh() } }
                if let data = snapshot { timestamp(data.updatedAt) }
                if demo {
                  Text("演示 · 不连接车辆").font(.caption2).foregroundStyle(.orange)
                  Toggle("模拟请求超时", isOn: $timeoutDemo).font(.caption2)
                  Toggle("大字号预览", isOn: $largeTypeDemo).font(.caption2)
                  control("重置演示", symbol: "arrow.counterclockwise") { resetDemo() }
                }
              } else if let data = snapshot {
                switch page {
                case .climate: climate(data)
                case .locks: locks(data)
                case .charging: charging(data)
                case .more: EmptyView()
                }
              }
              if !priorityFeedback { feedback }
            }.scenePadding(.horizontal).padding(.bottom, 8)
          }
          .safeAreaPadding(.bottom, 8)
          .scrollBounceBehavior(.basedOnSize)
          .onChange(of: priorityFeedback) { _, show in
            if show { reader.scrollTo("status", anchor: .top) }
          }
        }
        .navigationTitle(
          (page == .climate ? "空调" : page == .locks ? "门锁" : page == .charging ? "充电" : "更多")
            + (demo ? " · 演示" : ""))
      }
      .sheet(
        item: Binding(get: { confirmation.map(ConfirmAction.init) }, set: { confirmation = $0?.id })
      ) { item in
        ScrollView {
          VStack(alignment: .leading, spacing: compact ? 2 : 10) {
            Text(item.id == "unlock" ? "确认解锁？" : "确认锁车？").font(compact ? .headline : .title3)
            Text("\(snapshot?.model ?? "车辆")\n\(item.id == "unlock" ? "车门可从车外打开。" : "将锁定车辆车门。")")
              .font(compact ? .caption2 : .footnote).foregroundStyle(.secondary)
            control(item.id == "unlock" ? "确认解锁" : "确认锁车", active: true) {
              confirmation = nil
              Task { await send(item.id) }
            }
            control("取消") { confirmation = nil }
          }.scenePadding(.horizontal).padding(.bottom, 12)
        }
        .safeAreaPadding(.bottom, 16)
        .dynamicTypeSize(demo && largeTypeDemo ? .accessibility3 : systemTypeSize)
      }
    }
    .tint(orange)
    .dynamicTypeSize(demo && largeTypeDemo ? .accessibility3 : systemTypeSize)
    .task {
      if demo {
        resetDemo()
      } else {
        if WatchWidgetCache.read()?.isDemo == true {
          try? WatchWidgetCache.clear()
          WidgetCenter.shared.reloadAllTimelines()
        }
        snapshot = remote.cachedSnapshot
        cached = snapshot != nil
        if remote.configured { await refresh() }
      }
    }
    .onReceive(remote.$configured) { configured in
      if !demo {
        snapshot = remote.cachedSnapshot
        cached = snapshot != nil
        confirmation = nil
        if configured { Task { await refresh() } }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active && !demo && remote.configured { Task { await refresh() } }
    }
    .onOpenURL { url in
      if url.host == "climate" {
        path = [.climate]
      } else if url.host == "lock" {
        path = [.locks]
      } else {
        path = []
      }
    }
  }

  private func overview(_ data: WatchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: compact ? 2 : 4) {
      HStack {
        Text(data.model).font(.custom("Archivo-Regular", size: 14, relativeTo: .headline))
          .lineLimit(1).minimumScaleFactor(0.8)
        Spacer(minLength: 2)
        Label(lockLabel(data.locked), systemImage: data.locked == false ? "lock.open" : "lock")
          .font(.system(size: 10)).foregroundStyle(.secondary)
      }
      Image(data.vehicleService == "xchanger" ? "vehicle-p4" : "vehicle").resizable().scaledToFill()
        .frame(width: compact ? 110 : 150, height: compact ? 32 : 42).clipped()
        .frame(maxWidth: .infinity).accessibilityLabel("白色 \(data.model)")
      Button {
        path.append(.charging)
      } label: {
        VStack(spacing: 2) {
          controlsLayout {
            Text(measurement(data.batteryPercent, "%")).font(
              .custom("Archivo-Regular", size: compact ? 26 : 32, relativeTo: .largeTitle)
            ).lineLimit(1).minimumScaleFactor(0.7)
            HStack(spacing: 3) {
              Spacer(minLength: 0)
              Text(measurement(data.rangeKm, " km")).font(
                .custom("Archivo-Regular", size: 16, relativeTo: .headline))
              Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
            }
          }
          if let battery = data.batteryPercent {
            ProgressView(value: min(100, max(0, battery)), total: 100).progressViewStyle(.linear)
              .tint(
                orange
              ).frame(height: 4).clipped()
          }
        }.frame(minHeight: 44)
      }.buttonStyle(.plain).accessibilityLabel(
        "电量 \(measurement(data.batteryPercent, "%"))，续航 \(measurement(data.rangeKm, "公里"))，查看充电状态")
      controlsLayout {
        control(
          "门锁", symbol: data.locked == false ? "lock.open" : "lock", active: data.locked == false
        ) { path.append(.locks) }
        control("空调", symbol: "fan", active: data.climateActive == true) { path.append(.climate) }
      }
    }
  }

  private func climate(_ data: WatchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: compact ? 4 : 6) {
      Label(
        data.climateActive == true ? "空调运行中" : data.climateActive == false ? "空调已关闭" : "空调状态未知",
        systemImage: "fan"
      )
      .font(.footnote)
      .foregroundStyle(data.climateActive == true ? orange : .primary)
      controlsLayout {
        Text(data.climateActive == true ? measurement(data.targetTemperature, "°C") : "22°C")
          .font(.custom("Archivo-Regular", size: compact ? 32 : 40, relativeTo: .largeTitle))
        Text(data.climateActive == true ? "回读目标温度" : "默认舒适温度").font(.footnote).foregroundStyle(
          .secondary)
      }
      if let inside = data.interiorTemperature { Text("车内 \(number(inside)) °C").font(.caption2) }
      timestamp(data.climateUpdatedAt)
      if data.climateActive == true {
        control("关闭空调", disabled: unavailable("climateStop") != nil) {
          Task { await send("climateStop") }
        }
      } else {
        control(
          "开启空调", active: true,
          disabled: unavailable("climateStart") != nil || data.climateActive == nil
        ) { Task { await send("climateStart") } }
      }
      if let reason = unavailable(data.climateActive == true ? "climateStop" : "climateStart") {
        Text(reason).font(.caption2).foregroundStyle(.secondary)
      }
    }
  }

  private func locks(_ data: WatchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: compact ? 6 : 10) {
      Label(lockLabel(data.locked), systemImage: data.locked == false ? "lock.open" : "lock").font(
        .title3)
      timestamp(data.lockUpdatedAt)
      control(
        data.locked == false ? "锁定车辆" : "解锁车辆", active: true,
        disabled: unavailable(data.locked == false ? "lock" : "unlock") != nil || data.locked == nil
      ) {
        confirmation = data.locked == false ? "lock" : "unlock"
      }
      Text("下一步确认，不立即发送").font(.caption2).foregroundStyle(.secondary)
      if let reason = unavailable(data.locked == false ? "lock" : "unlock") {
        Text(reason).font(.caption2).foregroundStyle(.secondary)
      }
    }
  }

  private func charging(_ data: WatchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: compact ? 4 : 6) {
      controlsLayout {
        Text(measurement(data.batteryPercent, "%")).font(
          .custom("Archivo-Regular", size: compact ? 32 : 40, relativeTo: .largeTitle))
        Text(data.chargingState ?? "充电状态未知").font(.caption2).foregroundStyle(.secondary)
      }
      controlsLayout {
        VStack(alignment: .leading, spacing: 1) {
          Text("功率").foregroundStyle(.secondary)
          Text(measurement(data.chargePower, " kW"))
        }.frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 1) {
          Text("目标").foregroundStyle(.secondary)
          Text(measurement(data.chargeTarget, "%"))
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.font(.caption2)
      timestamp(data.updatedAt)
      control("刷新充电状态", symbol: "arrow.clockwise") { Task { await refresh() } }
    }.font(.footnote)
  }

  @ViewBuilder private var feedback: some View {
    if busy { ProgressView(!demo && remote.phase == "pending" ? "等待车辆回读" : "正在处理").font(.caption) }
    if !message.isEmpty {
      Text(message).font(.footnote).foregroundStyle(.secondary).accessibilityAddTraits(
        .updatesFrequently)
    }
    if !demo && !remote.notice.isEmpty {
      Text(remote.notice).font(.caption).foregroundStyle(.secondary)
    }
    if pending != nil && !busy {
      let action = ["lock": "锁车", "unlock": "解锁", "climateStart": "开启空调", "climateStop": "关闭空调"][pending ?? ""] ?? "操作"
      Text("\(action)结果待核对").font(.headline)
      control("核对车辆状态", disabled: busy) { Task { await verify() } }
      Text("只读取，不重复发送").font(.caption2).foregroundStyle(.secondary)
    }
  }

  private func control(
    _ title: String, symbol: String? = nil, active: Bool = false, disabled: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 4) {
        if let symbol { Image(systemName: symbol) }
        Text(title).fixedSize(horizontal: false, vertical: true)
      }
      .font(.custom("Archivo-Regular", size: 14, relativeTo: .callout))
      .multilineTextAlignment(.center).padding(.horizontal, 6).padding(.vertical, 8)
      .frame(maxWidth: .infinity, minHeight: 44)
      .foregroundStyle(
        disabled ? Color.secondary : active ? ink : Color(red: 0.933, green: 0.937, blue: 0.914)
      )
      .background(
        active && !disabled ? orange : Color(red: 0.145, green: 0.161, blue: 0.137),
        in: RoundedRectangle(cornerRadius: 14))
    }.buttonStyle(.plain).disabled(disabled)
  }

  private func timestamp(_ date: Date?) -> some View {
    Group {
      if let date {
        Text("更新于 \(date.formatted(date: .omitted, time: .shortened))")
      } else {
        Text("尚无更新时间")
      }
    }.font(.caption2).foregroundStyle(.secondary)
  }
  private func lockLabel(_ locked: Bool?) -> String { locked.map { $0 ? "已锁车" : "已解锁" } ?? "门锁未知" }
  private func number(_ value: Double?) -> String { measurement(value, "") }
  private func measurement(_ value: Double?, _ suffix: String) -> String {
    value.map { $0.formatted(.number.precision(.fractionLength(0...1))) + suffix } ?? "未返回"
  }
  private func unavailable(_ action: String) -> String? {
    if busy { return "请等待当前请求完成" }
    if demo && pending != nil { return "请先核对上一条操作" }
    if cached { return "请先刷新车辆状态" }
    return demo ? nil : remote.unavailableReason(for: action)
  }

  private func resetDemo() {
    guard !busy else { return }
    snapshot = sample(locked: true, climate: false)
    demoPending = nil
    message = ""
    path = []
    cached = false
    saveDemoWidget()
  }
  private func sample(locked: Bool, climate: Bool) -> WatchSnapshot {
    WatchSnapshot(
      vin: "DEMO-NO-VEHICLE", model: "Polestar 2", batteryPercent: 78, rangeKm: 356, locked: locked,
      climateActive: climate, targetTemperature: 22, interiorTemperature: 23, chargePower: 7.2,
      chargeTarget: 90, chargingState: "正在充电", updatedAt: Date(), lockUpdatedAt: Date(),
      climateUpdatedAt: Date())
  }
  private func refresh() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    if demo {
      message = "演示快照，未连接车辆"
      return
    }
    do {
      snapshot = try await remote.refresh()
      message = ""
      cached = false
    } catch {
      message = error.localizedDescription
      cached = snapshot != nil
    }
  }
  private func send(_ action: String) async {
    guard unavailable(action) == nil else { return }
    busy = true
    defer { busy = false }
    message = "请求处理中，等待车辆回读"
    if demo {
      demoPending = action
      try? await Task.sleep(for: .seconds(1))
      if timeoutDemo {
        message = "演示请求超时，没有重发"
        return
      }
      completeDemo(action)
    } else {
      do {
        snapshot = try await remote.send(action)
        message = "车辆回读确认"
      } catch {
        snapshot = remote.cachedSnapshot ?? snapshot
        message = error.localizedDescription
      }
    }
  }
  private func verify() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    if demo, let action = demoPending {
      completeDemo(action)
    } else {
      do {
        snapshot = try await remote.verifyPending()
        cached = false
        message = remote.phase == "confirmed" ? "车辆回读确认" : "此前操作未确认，请以当前车况为准；可重新选择操作"
      } catch {
        snapshot = remote.cachedSnapshot ?? snapshot
        message = error.localizedDescription
      }
    }
  }
  private func completeDemo(_ action: String) {
    let locked = action == "lock" ? true : action == "unlock" ? false : snapshot?.locked ?? true
    let climate =
      action == "climateStart"
      ? true : action == "climateStop" ? false : snapshot?.climateActive ?? false
    snapshot = sample(locked: locked, climate: climate)
    demoPending = nil
    message = "演示：车辆回读一致"
    saveDemoWidget()
  }
  private func saveDemoWidget() {
    guard demo, let data = snapshot else { return }
    try? WatchWidgetCache.save(
      WatchWidgetSnapshot(
        model: data.model, batteryPercent: data.batteryPercent, rangeKm: data.rangeKm,
        updatedAt: data.updatedAt, isDemo: true))
    WidgetCenter.shared.reloadAllTimelines()
  }
}

private struct ConfirmAction: Identifiable { let id: String }

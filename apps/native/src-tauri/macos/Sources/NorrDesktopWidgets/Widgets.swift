import WidgetKit

@_cdecl("norr_widgets_reload")
public func reloadWidgets() {
  WidgetCenter.shared.reloadTimelines(ofKind: "NorrVehicle")
}

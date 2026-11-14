// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "NorrMobile",
  platforms: [.iOS(.v15)],
  products: [.library(name: "NorrMobile", type: .static, targets: ["NorrMobile"])],
  dependencies: [.package(name: "Tauri", path: ".tauri/tauri-api")],
  targets: [
    .target(name: "NorrWidgetSupport"),
    .target(name: "NorrMobile", dependencies: [.byName(name: "Tauri"), "NorrWidgetSupport"])
  ]
)

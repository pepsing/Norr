// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "NorrDesktopWidgets",
  platforms: [.macOS(.v13)],
  products: [.library(name: "NorrDesktopWidgets", type: .static, targets: ["NorrDesktopWidgets"])],
  targets: [.target(name: "NorrDesktopWidgets")]
)

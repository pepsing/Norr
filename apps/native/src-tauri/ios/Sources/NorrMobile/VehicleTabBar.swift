import UIKit
import WebKit

@available(iOS 26.0, *)
final class VehicleTabBar: NSObject, WKScriptMessageHandlerWithReply, UITabBarDelegate, UITabBarControllerDelegate {
  private weak var webView: WKWebView?
  private let bar = UITabBar()
  private var sideController: UITabBarController?
  private var sideHost: DuoTabHost?
  private let symbols = ["car", "slider.horizontal.3", "bolt.batteryblock", "clock", "gearshape"]

  init(webView: WKWebView) {
    self.webView = webView
    super.init()
    bar.delegate = self
    bar.tintColor = .systemOrange
    bar.isHidden = true
    webView.addSubview(bar)
    webView.configuration.userContentController.addScriptMessageHandler(
      self, contentWorld: .page, name: "norrVehicleTabs")
    webView.evaluateJavaScript("window.dispatchEvent(new Event('norr-tabs-ready'))")
  }

  func hide() {
    bar.isHidden = true
    removeSideTabs()
  }

  private func removeSideTabs() {
    sideController?.willMove(toParent: nil)
    sideController?.view.removeFromSuperview()
    sideController?.removeFromParent()
    sideController = nil
    sideHost?.removeFromSuperview()
    sideHost = nil
  }

  private func showSideTabs(in webView: WKWebView, labels: [String], selected: Int, dark: Bool) -> Bool {
    let controller: UITabBarController
    if let sideController {
      controller = sideController
    } else {
      var responder: UIResponder? = webView
      while responder != nil && !(responder is UIViewController) { responder = responder?.next }
      guard let parent = responder as? UIViewController else { return false }
      controller = UITabBarController()
      controller.delegate = self
      controller.viewControllers = labels.enumerated().map { index, title in
        let page = UIViewController()
        page.tabBarItem = UITabBarItem(title: title, image: UIImage(systemName: symbols[index]), tag: index)
        return page
      }
      let host = DuoTabHost(frame: webView.bounds)
      host.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      parent.addChild(controller)
      webView.addSubview(host)
      controller.view.frame = host.bounds
      controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      host.addSubview(controller.view)
      controller.didMove(toParent: parent)
      controller.view.tintColor = .systemOrange
      sideController = controller
      sideHost = host
    }
    controller.overrideUserInterfaceStyle = dark ? .dark : .light
    controller.selectedIndex = selected
    return true
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    guard message.frameInfo.isMainFrame, let webView, message.webView === webView else {
      replyHandler(false, nil)
      return
    }
    guard let body = message.body as? [String: Any], let labels = body["labels"] as? [String],
          labels.count == symbols.count, let selected = body["selected"] as? Int,
          labels.indices.contains(selected), let x = body["x"] as? CGFloat,
          let y = body["y"] as? CGFloat, let width = body["width"] as? CGFloat,
          let height = body["height"] as? CGFloat else {
      hide()
      replyHandler(false, nil)
      return
    }
    let dark = body["dark"] as? Bool == true
    if body["side"] as? Bool == true {
      bar.isHidden = true
      replyHandler(showSideTabs(in: webView, labels: labels, selected: selected, dark: dark), nil)
      return
    }
    removeSideTabs()
    let frame = CGRect(x: x, y: y, width: width, height: height).intersection(webView.bounds)
    guard frame.width > 0, frame.height >= 44 else {
      hide()
      replyHandler(false, nil)
      return
    }
    if bar.items?.compactMap({ $0.title }) != labels {
      bar.items = labels.enumerated().map { index, title in
        UITabBarItem(title: title, image: UIImage(systemName: symbols[index]), tag: index)
      }
    }
    bar.overrideUserInterfaceStyle = dark ? .dark : .light
    bar.frame = frame
    bar.selectedItem = bar.items?[selected]
    bar.isHidden = false
    webView.bringSubviewToFront(bar)
    replyHandler(true, nil)
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    select(item.tag)
  }

  func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
    select(viewController.tabBarItem.tag)
  }

  private func select(_ index: Int) {
    webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('norr-tab-select',{detail:\(index)}))")
  }
}

/// The web view owns the page content; UIKit owns the controls in the lateral safe-area inset.
private final class DuoTabHost: UIView {
  private var rail: CGRect {
    let insets = safeAreaInsets
    return insets.left > insets.right
      ? CGRect(x: 0, y: 0, width: insets.left, height: bounds.height)
      : CGRect(x: bounds.width - insets.right, y: 0, width: insets.right, height: bounds.height)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let mask = CAShapeLayer()
    mask.path = UIBezierPath(rect: rail).cgPath
    layer.mask = mask
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    rail.contains(point)
  }
}

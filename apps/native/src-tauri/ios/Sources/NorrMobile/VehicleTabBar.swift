import UIKit
import WebKit

@available(iOS 26.0, *)
final class VehicleTabBar: NSObject, WKScriptMessageHandlerWithReply, UITabBarDelegate {
  private weak var webView: WKWebView?
  private let bar = UITabBar()
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

  func hide() { bar.isHidden = true }

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
    bar.overrideUserInterfaceStyle = body["dark"] as? Bool == true ? .dark : .light
    bar.frame = frame
    bar.selectedItem = bar.items?[selected]
    bar.isHidden = false
    webView.bringSubviewToFront(bar)
    replyHandler(true, nil)
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('norr-tab-select',{detail:\(item.tag)}))")
  }
}

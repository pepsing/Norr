import NorrWindowRegions
import WebKit

/// Measures the WKWebView's window, including when a fold moves without a window resize.
final class WindowDivisionView: UIView {
  private weak var webView: WKWebView?
  private var loading: NSKeyValueObservation?
  private var lastDivision: WindowDivision?
  private var hasHinge = false
  private var fullyOpen = false
  private var lastSideTabs: String?
  private var hideTabs: (() -> Void)?

  init(webView: WKWebView) {
    self.webView = webView
    super.init(frame: webView.bounds)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
    webView.addSubview(self)
    NorrTrackWindowDivision(self) { [weak self] present, open in
      self?.hasHinge = present
      self?.fullyOpen = open
    }
    if #available(iOS 26.0, *) {
      let tabs = VehicleTabBar(webView: webView)
      hideTabs = { [weak tabs] in tabs?.hide() }
    }
    loading = webView.observe(\.isLoading, options: [.new]) { [weak self] _, change in
      if change.newValue == true { self?.hideTabs?() }
      if change.newValue == false {
        self?.lastSideTabs = nil
        self?.setNeedsLayout()
      }
    }
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let webView, window != nil, !webView.isLoading else { return }
    let division = WindowDivision(region: NorrWindowDivision(self), in: bounds)
    let outerLandscape = !fullyOpen && bounds.width > bounds.height
    let edge: UIRectEdge = hasHinge && division == nil && !outerLandscape ? NorrVerticalBarEdge(self) : []
    let sideTabs = edge == .left ? "left" : edge == .right ? "right" : ""
    guard division != lastDivision || sideTabs != lastSideTabs else { return }
    lastSideTabs = sideTabs
    lastDivision = division
    let unit = division?.axis == .vertical ? "vw" : "dvh"
    webView.evaluateJavaScript("""
      (() => {
        const root = document.documentElement;
        if ('\(sideTabs)') root.dataset.duoSideTabs = '\(sideTabs)';
        else delete root.dataset.duoSideTabs;
        root.dataset.windowDivision = '\(division?.axis.rawValue ?? "")';
        root.style.setProperty('--fold-start', '\(division?.start ?? 0)\(unit)');
        root.style.setProperty('--fold-end', '\(division?.end ?? 0)\(unit)');
      })()
      """)
  }
}

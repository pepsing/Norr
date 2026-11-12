import Tauri
import UIKit
import WebKit

final class PhoneVerificationController: UIViewController, WKNavigationDelegate,
  WKScriptMessageHandler
{
  private let invoke: Invoke
  private let closed: () -> Void
  private let page = URL(
    string: "https://h5.app.polestar-auto.com/account-components/auth-slider/index.html")!
  private var web: WKWebView!
  private let status = UILabel()
  private var timeout: DispatchWorkItem?
  private var finished = false

  init(invoke: Invoke, closed: @escaping () -> Void) {
    self.invoke = invoke
    self.closed = closed
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Polestar 手机验证"
    view.backgroundColor = .systemBackground
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      title: "取消", style: .plain, target: self, action: #selector(cancel))
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      title: "重新加载", style: .plain, target: self, action: #selector(reload))
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    for name in ["chinaVerification", "dispatch"] {
      config.userContentController.add(self, name: name)
    }
    config.userContentController.addUserScript(
      WKUserScript(
        source:
          "window.chromium={postMessage:function(value){window.webkit.messageHandlers.chinaVerification.postMessage(String(value));}};",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.translatesAutoresizingMaskIntoConstraints = false
    status.font = .preferredFont(forTextStyle: .footnote)
    status.textColor = .secondaryLabel
    status.numberOfLines = 0
    status.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    scroll.addSubview(web)
    scroll.addSubview(status)
    let safe = view.safeAreaLayoutGuide
    let content = scroll.contentLayoutGuide
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: safe.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
      content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
      web.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
      web.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
      web.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
      web.heightAnchor.constraint(equalToConstant: 270),
      status.topAnchor.constraint(equalTo: web.bottomAnchor, constant: 16),
      status.leadingAnchor.constraint(equalTo: web.leadingAnchor),
      status.trailingAnchor.constraint(equalTo: web.trailingAnchor),
      status.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
    ])
    reload()
    let work = DispatchWorkItem { [weak self] in self?.finish(error: "验证已超时，请重新获取验证码。") }
    timeout = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 300, execute: work)
  }

  @objc private func cancel() { finish() }

  @objc private func reload() {
    status.text = "正在加载 Polestar 验证页面…"
    web.load(URLRequest(url: page, cachePolicy: .reloadIgnoringLocalCacheData))
  }

  private func official(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == "https" && url.host == page.host && url.path == page.path
      && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    let origin = message.frameInfo.securityOrigin
    guard !finished, message.frameInfo.isMainFrame, official(web.url),
      origin.protocol == "https", origin.host == page.host,
      origin.port == 0 || origin.port == 443,
      let text = message.body as? String, text.utf8.count <= 16384
    else { return }
    var json = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !json.hasPrefix("{") {
      guard let callback = URLComponents(string: text),
        callback.scheme == "polestar", callback.host == "webview",
        callback.path == "/autoAccount", callback.user == nil,
        callback.password == nil, callback.port == nil, callback.fragment == nil,
        let data = callback.queryItems?.first(where: { $0.name == "data" })?.value
      else { return }
      json = data
    }
    guard let bytes = json.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    else {
      status.text = "验证结果无效，请重新加载后重试。"
      return
    }
    var result = [String: String]()
    for name in ["sessionId", "sig", "token"] {
      guard let field = value[name] as? String,
        !field.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        field.count <= 8192
      else {
        status.text = "验证结果无效，请重新加载后重试。"
        return
      }
      result[name] = field
    }
    finish(value: result)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let subframe = action.targetFrame?.isMainFrame == false
    let allowed = subframe ? action.request.url?.scheme == "https" : official(action.request.url)
    decisionHandler(allowed ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    status.text = "完成验证后会向所填手机号发送短信。"
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    guard (error as NSError).code != NSURLErrorCancelled, !finished else { return }
    status.text = "验证页面加载失败，请检查网络后重新加载。"
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
  }

  private func finish(value: [String: String]? = nil, error: String? = nil) {
    guard !finished else { return }
    finished = true
    timeout?.cancel()
    web.stopLoading()
    web.navigationDelegate = nil
    for name in ["chinaVerification", "dispatch"] {
      web.configuration.userContentController.removeScriptMessageHandler(forName: name)
    }
    dismiss(animated: true) {
      if let error { self.invoke.reject(error) } else { self.invoke.resolve(value) }
      self.closed()
    }
  }
}

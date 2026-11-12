package app.norr.mobile

import android.app.Activity
import android.app.AlertDialog
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONObject

class PhoneVerification(
    private val activity: Activity,
    private val invoke: Invoke,
    private val closed: () -> Unit,
) {
    private val page = "https://h5.app.polestar-auto.com/account-components/auth-slider/index.html"
    private val origin = "https://h5.app.polestar-auto.com"
    private val handler = Handler(Looper.getMainLooper())
    private var finished = false
    private var dialog: AlertDialog? = null
    private var webView: WebView? = null
    private val timeout = Runnable { fail("验证已超时，请重新获取验证码。") }

    fun cancel() {
        finish(null)
    }

    fun show() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            fail("请更新 Android System WebView 后再获取验证码。")
            return
        }
        try {
            val density = activity.resources.displayMetrics.density
            val padding = (20 * density).toInt()
            val layout =
                LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(padding, 0, padding, padding)
                }
            val status =
                TextView(activity).apply {
                    text = "正在加载 Polestar 验证页面…"
                    setTextColor(activity.getColor(R.color.norr_muted))
                    textSize = 14f
                }
            val web = WebView(activity)
            webView = web
            web.settings.javaScriptEnabled = true
            web.settings.domStorageEnabled = true
            web.settings.allowFileAccess = false
            web.settings.allowContentAccess = false
            web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            web.settings.cacheMode = WebSettings.LOAD_NO_CACHE
            WebViewCompat.addWebMessageListener(web, "norrVerification", setOf(origin)) {
                _,
                message,
                source,
                isMainFrame,
                _ ->
                if (
                    !isMainFrame ||
                        source.toString().trimEnd('/') != origin ||
                        !official(Uri.parse(web.url ?: ""))
                )
                    return@addWebMessageListener
                val text = message.data ?: return@addWebMessageListener
                try {
                    require(text.toByteArray(Charsets.UTF_8).size <= 16_384)
                    val data =
                        if (text.trimStart().startsWith("{")) text
                        else {
                            val callback = Uri.parse(text)
                            require(
                                callback.scheme == "polestar" &&
                                    callback.host == "webview" &&
                                    callback.path == "/autoAccount" &&
                                    callback.userInfo == null &&
                                    callback.port == -1 &&
                                    callback.fragment == null,
                            )
                            callback.getQueryParameter("data") ?: throw IllegalArgumentException()
                        }
                    val value = JSONObject(data)
                    val result = JSObject()
                    for (name in listOf("sessionId", "sig", "token")) {
                        val field = value.getString(name)
                        require(field.isNotBlank() && field.length <= 8192)
                        result.put(name, field)
                    }
                    finish(result)
                } catch (_: Exception) {
                    status.text = "验证结果无效，请重新加载后重试。"
                }
            }
            val bridge =
                "window.chromium={postMessage:function(value){window.norrVerification.postMessage(String(value));}};"
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(web, bridge, setOf(origin))
            }
            web.webViewClient =
                object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest,
                    ): Boolean {
                        return if (request.isForMainFrame) !official(request.url)
                        else request.url.scheme != "https"
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        if (official(Uri.parse(url))) {
                            view.evaluateJavascript(bridge, null)
                            status.text = "完成验证后会向所填手机号发送短信。"
                        }
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError,
                    ) {
                        if (request.isForMainFrame) status.text = "验证页面加载失败，请检查网络后重新加载。"
                    }
                }
            layout.addView(web, LinearLayout.LayoutParams(-1, (260 * density).toInt()))
            layout.addView(status, LinearLayout.LayoutParams(-1, -2))
            layout.addView(
                Button(activity).apply {
                    text = "重新加载"
                    setOnClickListener {
                        status.text = "正在加载 Polestar 验证页面…"
                        web.loadUrl(page)
                    }
                },
            )
            dialog =
                AlertDialog.Builder(activity)
                    .setTitle("Polestar 手机验证")
                    .setView(layout)
                    .setNegativeButton("取消") { _, _ -> cancel() }
                    .create()
                    .also {
                        it.setOnCancelListener { cancel() }
                        it.show()
                    }
            web.loadUrl(page)
            handler.postDelayed(timeout, 300_000)
        } catch (_: Exception) {
            fail("手机验证窗口加载失败，请重试。")
        }
    }

    private fun official(uri: Uri): Boolean =
        uri.scheme == "https" &&
            uri.host == "h5.app.polestar-auto.com" &&
            uri.path == "/account-components/auth-slider/index.html" &&
            uri.userInfo == null &&
            uri.port in listOf(-1, 443)

    private fun dispose() {
        finished = true
        handler.removeCallbacks(timeout)
        webView?.apply {
            stopLoading()
            destroy()
        }
        webView = null
        dialog?.dismiss()
        dialog = null
        closed()
    }

    private fun finish(result: JSObject?) {
        if (finished) return
        dispose()
        invoke.resolve(result)
    }

    private fun fail(message: String) {
        if (finished) return
        dispose()
        invoke.reject(message)
    }
}

package app.norr.mobile

import android.os.Bundle
import android.os.Build
import android.content.res.Configuration
import android.graphics.Color
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars =
                insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
                )
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
        restoreTheme()
    }

    fun applyTheme(dark: Boolean) {
        val background = if (dark) Color.rgb(25, 27, 25) else Color.rgb(247, 247, 245)
        findViewById<View>(android.R.id.content).setBackgroundColor(background)
        window.decorView.setBackgroundColor(background)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        getSharedPreferences("norr-appearance", MODE_PRIVATE).edit().putBoolean("dark", dark).apply()
    }

    private fun restoreTheme() {
        applyTheme(getSharedPreferences("norr-appearance", MODE_PRIVATE).getBoolean("dark", false))
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        restoreTheme()
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript(
                        """
                        (() => {
                          const dialog = document.querySelector('dialog[open]');
                          if (!dialog) return false;
                          dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
                          return true;
                        })()
                        """
                            .trimIndent(),
                    ) { handled ->
                        if (handled != "true") moveTaskToBack(true)
                    }
                }
            },
        )
    }
}

package app.norr.mobile

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread
import org.json.JSONObject

@TauriPlugin(
    permissions =
        [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class NorrPlugin(private val activity: Activity) : Plugin(activity) {
    private var active = true
    private var generation = 0L
    private var target: JSObject? = null
    private var widgetTarget: JSObject? = null
    private var webView: WebView? = null
    private var verification: PhoneVerification? = null
    private val preferences by lazy {
        activity.getSharedPreferences("norr-credentials", Context.MODE_PRIVATE)
    }

    override fun load(webView: WebView) {
        this.webView = webView
        captureNotification(activity.intent)
        captureWidget(activity.intent)
        if (Build.VERSION.SDK_INT >= 26) {
            activity
                .getSystemService(NotificationManager::class.java)
                .createNotificationChannel(
                    NotificationChannel("vehicle", "车辆状态", NotificationManager.IMPORTANCE_DEFAULT),
                )
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        active = false
    }

    override fun onResume(activity: AppCompatActivity) {
        active = true
        generation++
    }

    override fun onDestroy(activity: AppCompatActivity) {
        webView = null
        verification?.cancel()
        verification = null
    }

    override fun onNewIntent(intent: Intent) {
        captureNotification(intent)
        captureWidget(intent)
    }

    private fun captureWidget(intent: Intent) {
        val action = intent.getStringExtra("norrWidgetAction") ?: return
        if (action !in listOf("vehicle", "lock", "climate", "refresh")) return
        widgetTarget = JSObject().put("action", action)
            .put("vin", intent.getStringExtra("norrWidgetVin") ?: "") as JSObject
        intent.removeExtra("norrWidgetAction")
        intent.removeExtra("norrWidgetVin")
        activity.runOnUiThread {
            webView?.evaluateJavascript("window.dispatchEvent(new Event('norr-widget-open'))", null)
        }
    }

    @Command
    fun takeWidgetTarget(invoke: Invoke) {
        val result = widgetTarget
        widgetTarget = null
        invoke.resolve(result)
    }

    @Command
    fun updateWidgets(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            NorrWidgets.store(activity, args.getJSONObject("data"), File(args.getString("imagePath")))
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("小组件数据同步失败，请重试。")
        }
    }

    private fun captureNotification(intent: Intent) {
        val page = intent.getStringExtra("norrPage") ?: return
        if (page !in listOf("vehicle", "charging", "history", "settings")) return
        target =
            JSObject().put("page", page).put("vin", intent.getStringExtra("norrVin") ?: "")
                as JSObject
        intent.removeExtra("norrPage")
        intent.removeExtra("norrVin")
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "norr-session-v1"
        (store.getKey(alias, null) as? SecretKey)?.let {
            return it
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                            alias,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build(),
                )
            }
            .generateKey()
    }

    private fun account(invoke: Invoke): String {
        val value = invoke.getArgs().getString("account")
        require(
            value in listOf("polestar-china-session", "polestar-china-signing-key", "device-id"),
        )
        return value
    }

    @Command
    fun readCredential(invoke: Invoke) {
        try {
            val account = account(invoke)
            val stored = preferences.getString(account, null)
            if (stored == null) {
                invoke.resolve(JSObject().put("value", JSONObject.NULL) as JSObject)
                return
            }
            val record = JSONObject(stored)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(record.getString("iv"), Base64.NO_WRAP)),
            )
            cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
            val bytes = cipher.doFinal(Base64.decode(record.getString("data"), Base64.NO_WRAP))
            val result = JSObject().put("value", bytes.toString(Charsets.UTF_8)) as JSObject
            bytes.fill(0)
            invoke.resolve(result)
        } catch (_: Exception) {
            invoke.reject("无法解密本机登录会话，请重新登录。")
        }
    }

    @Command
    fun writeCredential(invoke: Invoke) {
        try {
            val account = account(invoke)
            val bytes = invoke.getArgs().getString("value").toByteArray(Charsets.UTF_8)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
            val encrypted =
                try {
                    cipher.doFinal(bytes)
                } finally {
                    bytes.fill(0)
                }
            val record =
                JSONObject()
                    .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                    .put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            check(preferences.edit().putString(account, record.toString()).commit())
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("Android 安全存储写入失败，请重试。")
        }
    }

    @Command
    fun verifyPhone(invoke: Invoke) {
        if (verification != null) {
            invoke.reject("请先完成或关闭当前验证。")
            return
        }
        verification = PhoneVerification(activity, invoke) { verification = null }
        verification?.show()
    }

    @Command
    fun confirmCredential(invoke: Invoke) {
        val manager = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val intent = manager.createConfirmDeviceCredentialIntent("确认车辆操作", "使用设备锁屏凭据确认 Norr 的车辆操作")
        if (intent == null) {
            invoke.reject("请先设置手机锁屏密码，再确认车辆操作。")
            return
        }
        startActivityForResult(invoke, intent, "confirmed")
    }

    @ActivityCallback
    private fun confirmed(invoke: Invoke, result: ActivityResult) {
        invoke.resolve(
            JSObject().put("authorized", result.resultCode == Activity.RESULT_OK) as JSObject,
        )
    }

    @Command
    fun setTheme(invoke: Invoke) {
        val dark = invoke.getArgs().getBoolean("dark")
        activity.runOnUiThread {
            (activity as MainActivity).applyTheme(dark)
            invoke.resolve()
        }
    }

    @Command
    fun lifecycle(invoke: Invoke) {
        invoke.resolve(JSObject().put("active", active).put("generation", generation) as JSObject)
    }

    @Command
    fun systemStatus(invoke: Invoke) {
        val allowed = NotificationManagerCompat.from(activity).areNotificationsEnabled()
        invoke.resolve(
            JSObject().put("launchAtLogin", -1).put("notifications", if (allowed) 2 else 1)
                as JSObject,
        )
    }

    @Command
    fun requestNotifications(invoke: Invoke) {
        if (
            Build.VERSION.SDK_INT >= 33 &&
                activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissionForAlias("notifications", invoke, "notificationsGranted")
        } else notificationsGranted(invoke)
    }

    @PermissionCallback
    private fun notificationsGranted(invoke: Invoke) {
        if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) invoke.resolve()
        else invoke.reject("通知已关闭，请在系统设置中允许 Norr 通知。")
    }

    @Command
    fun postNotification(invoke: Invoke) {
        try {
            if (Build.VERSION.SDK_INT >= 33 &&
                activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                invoke.reject("系统已关闭 Norr 通知。")
                return
            }
            if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
                invoke.reject("系统已关闭 Norr 通知。")
                return
            }
            val args = invoke.getArgs()
            val id = args.getString("id").hashCode()
            val intent =
                Intent(activity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra("norrPage", args.getString("page"))
                    .putExtra("norrVin", args.getString("vin"))
            val pending =
                PendingIntent.getActivity(
                    activity,
                    id,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            val notification =
                NotificationCompat.Builder(activity, "vehicle")
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(args.getString("title"))
                    .setContentText(args.getString("body"))
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .build()
            NotificationManagerCompat.from(activity).notify(id, notification)
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("通知发送失败，请检查系统通知设置。")
        }
    }

    @Command
    fun takeNotificationTarget(invoke: Invoke) {
        val result = target
        target = null
        invoke.resolve(result)
    }

    @Command
    fun openSettings(invoke: Invoke) {
        try {
            val intent =
                if (Build.VERSION.SDK_INT >= 26)
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                else
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:${activity.packageName}"),
                    )
            activity.startActivity(intent)
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法打开系统设置。")
        }
    }

    @Command
    fun openUrl(invoke: Invoke) {
        try {
            val uri = Uri.parse(invoke.getArgs().getString("url"))
            require(
                uri.scheme == "https" &&
                    uri.host in listOf("uri.amap.com", "www.google.com", "maps.apple.com"),
            )
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法打开地图链接，请确认手机已安装浏览器。")
        }
    }

    @Command
    fun openBackup(invoke: Invoke) {
        startActivityForResult(
            invoke,
            Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json"),
            "backupSelected",
        )
    }

    @ActivityCallback
    private fun backupSelected(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(JSObject().put("path", JSONObject.NULL) as JSObject)
            return
        }
        thread(name = "norr-backup-import") {
            var file: File? = null
            try {
                file = File.createTempFile("norr-import-", ".json", activity.cacheDir)
                activity.contentResolver.openInputStream(uri)!!.use { input ->
                    file.outputStream().use { output ->
                        val buffer = ByteArray(65536)
                        var total = 0L
                        while (true) {
                            val size = input.read(buffer)
                            if (size < 0) break
                            total += size
                            require(total <= 256L * 1024 * 1024)
                            output.write(buffer, 0, size)
                        }
                    }
                }
                invoke.resolve(JSObject().put("path", file.absolutePath) as JSObject)
            } catch (_: Exception) {
                file?.delete()
                invoke.reject("无法读取备份，请确认文件有效且不超过 256 MB。")
            }
        }
    }

    @Command
    fun saveHistory(invoke: Invoke) {
        val format = invoke.getArgs().getString("format")
        if (format !in listOf("json", "csv")) {
            invoke.reject("导出格式无效。")
            return
        }
        val intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (format == "json") "application/json" else "text/csv")
                .putExtra(Intent.EXTRA_TITLE, "norr-history.$format")
        startActivityForResult(invoke, intent, "historyDestination")
    }

    @ActivityCallback
    private fun historyDestination(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(JSObject().put("saved", false) as JSObject)
            return
        }
        thread(name = "norr-history-export") {
            try {
                val file = File(invoke.getArgs().getString("path")).canonicalFile
                require(
                    file.parentFile == activity.filesDir.canonicalFile &&
                        file.name.startsWith("export-"),
                )
                file.inputStream().use { input ->
                    activity.contentResolver.openOutputStream(uri, "wt")!!.use { input.copyTo(it) }
                }
                invoke.resolve(JSObject().put("saved", true) as JSObject)
            } catch (_: Exception) {
                invoke.reject("导出文件写入失败，请重新选择保存位置。")
            }
        }
    }
}

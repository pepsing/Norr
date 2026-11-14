package app.norr.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.AtomicFile
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

open class NorrWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { NorrWidgets.update(context, it) }
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        NorrWidgets.update(context, id)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        val preferences = NorrWidgets.preferences(context).edit()
        ids.forEach { preferences.remove("appearance-$it") }
        preferences.apply()
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == Intent.ACTION_CONFIGURATION_CHANGED) NorrWidgets.updateAll(context)
    }
}

class NorrSmallWidget : NorrWidgetProvider()
class NorrMediumWidget : NorrWidgetProvider()
class NorrLargeWidget : NorrWidgetProvider()

object NorrWidgets {
    private val providers = listOf(NorrSmallWidget::class.java, NorrMediumWidget::class.java, NorrLargeWidget::class.java)
    fun preferences(context: Context) = context.getSharedPreferences("norr-widgets", Context.MODE_PRIVATE)

    @Synchronized
    fun store(context: Context, data: JSONObject, image: File) {
        val directory = File(context.filesDir, "widgets").apply { mkdirs() }
        val bitmap = BitmapFactory.decodeFile(image.absolutePath) ?: error("车辆图片不可用")
        val height = minOf(bitmap.height, (bitmap.width / 3.2).roundToInt())
        val crop = Bitmap.createBitmap(bitmap, 0, ((bitmap.height - height) * 0.6).roundToInt(), bitmap.width, height)
        val scaled = Bitmap.createScaledBitmap(crop, 720, (720.0 * height / bitmap.width).roundToInt(), true)
        val digest = MessageDigest.getInstance("SHA-256").digest(image.readBytes())
        val imageName = "vehicle-${digest.joinToString("") { "%02x".format(it) }}.jpg"
        val imageFile = AtomicFile(File(directory, imageName))
        val output = imageFile.startWrite()
        try {
            check(scaled.compress(Bitmap.CompressFormat.JPEG, 90, output))
            imageFile.finishWrite(output)
        } catch (error: Exception) {
            imageFile.failWrite(output)
            throw error
        } finally {
            scaled.recycle()
            if (crop !== scaled) crop.recycle()
            if (bitmap !== crop && bitmap !== scaled) bitmap.recycle()
        }
        val record = JSONObject(data.toString()).put("imageName", imageName)
        check(preferences(context).edit().putString("vehicle", record.toString()).commit())
        updateAll(context)
    }

    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        providers.forEach { provider ->
            manager.getAppWidgetIds(ComponentName(context, provider)).forEach { update(context, it) }
        }
    }

    @Synchronized
    fun update(context: Context, id: Int) {
        val manager = AppWidgetManager.getInstance(context)
        val stored = preferences(context).getString("vehicle", null)
        val data = stored?.let { runCatching { JSONObject(it) }.getOrNull() }
        val appearance = preferences(context).getString("appearance-$id", "system")
        val dark = appearance == "dark" || (appearance == "system" &&
            context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
        val small = render(context, id, data, dark, 0)
        val medium = render(context, id, data, dark, 1)
        val large = render(context, id, data, dark, 2)
        val compactSmall = render(context, id, data, dark, 0, compact = true)
        val compactMedium = render(context, id, data, dark, 1, compact = true)
        val views = if (Build.VERSION.SDK_INT >= 31) {
            RemoteViews(mapOf(
                SizeF(130f, 110f) to compactSmall,
                SizeF(130f, 150f) to small,
                SizeF(260f, 150f) to compactMedium,
                SizeF(260f, 180f) to medium,
                SizeF(260f, 330f) to large,
            ))
        } else {
            val options = manager.getAppWidgetOptions(id)
            fun sized(width: Int, height: Int) = when {
                width < 260 || height < 150 -> if (height < 150) compactSmall else small
                height < 180 -> compactMedium
                height < 330 -> medium
                else -> large
            }
            RemoteViews(
                sized(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)),
                sized(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)),
            )
        }
        manager.updateAppWidget(id, views)
    }

    private fun render(context: Context, id: Int, data: JSONObject?, dark: Boolean, size: Int, compact: Boolean = false): RemoteViews {
        val small = size == 0
        val large = size == 2
        val layout = when {
            small -> R.layout.norr_widget_small
            compact -> R.layout.norr_widget_compact_wide
            else -> R.layout.norr_widget_wide
        }
        val views = RemoteViews(context.packageName, layout)
        val ink = Color.parseColor(if (dark) "#EEEFE9" else "#20221F")
        val muted = Color.parseColor(if (dark) "#B0B5AA" else "#62665E")
        views.setInt(R.id.widget_root, "setBackgroundResource", if (dark) R.drawable.widget_background_dark else R.drawable.widget_background_light)
        val density = context.resources.displayMetrics.density
        val padding = ((if (large) 24 else if (compact && small) 16 else 20) * density).roundToInt()
        val verticalPadding = if (compact && small) (8 * density).roundToInt() else padding
        views.setViewPadding(R.id.widget_root, padding, verticalPadding, padding, verticalPadding)
        if (compact && small) {
            views.setTextViewTextSize(R.id.widget_brand, TypedValue.COMPLEX_UNIT_SP, 16f)
            views.setTextViewTextSize(R.id.widget_battery, TypedValue.COMPLEX_UNIT_SP, 24f)
        }
        val brand = SpannableString("Norr.").apply {
            setSpan(ForegroundColorSpan(Color.rgb(243, 132, 70)), 4, 5, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        views.setTextViewText(R.id.widget_brand, brand)
        for (view in listOf(R.id.widget_brand, R.id.widget_battery, R.id.widget_range, R.id.widget_empty)) views.setTextColor(view, ink)
        views.setTextColor(R.id.widget_time, muted)
        views.setViewVisibility(R.id.widget_empty, if (data == null) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.widget_content, if (data == null) View.GONE else View.VISIBLE)
        val vin = data?.optString("vin") ?: ""
        views.setOnClickPendingIntent(R.id.widget_root, open(context, id, vin, "vehicle"))
        if (data == null) return views
        fun number(key: String): String {
            val value = data.optDouble(key, Double.NaN)
            return if (value.isFinite()) String.format(Locale.getDefault(), "%.0f", value) else "未知"
        }
        val percent = number("batteryPercent")
        val range = number("rangeKm")
        views.setTextViewText(R.id.widget_battery, if (percent == "未知") "电量未知" else "$percent%")
        views.setTextViewText(R.id.widget_range, if (range == "未知") "续航未知" else if (small) "续航 $range km" else "$range km")
        views.setProgressBar(R.id.widget_battery_bar, 100, data.optDouble("batteryPercent", 0.0).coerceIn(0.0, 100.0).toInt(), false)
        val locked = if (data.isNull("locked")) "门锁未知" else if (data.optBoolean("locked")) "已锁车" else "已解锁"
        views.setTextViewText(R.id.widget_lock, locked)
        views.setTextColor(R.id.widget_lock, if (small) muted else ink)
        val time = data.optLong("updatedAt", 0)
        val today = android.text.format.DateUtils.isToday(time)
        val timestamp = if (time > 0) SimpleDateFormat(if (today) "HH:mm" else "M/d HH:mm", Locale.getDefault()).format(Date(time)) else "尚未读取"
        views.setTextViewText(R.id.widget_time, if (small || time == 0L) timestamp else "数据于 $timestamp")
        if (!small) {
            views.setTextViewText(R.id.widget_model, data.optString("model"))
            views.setTextColor(R.id.widget_model, muted)
            val climate = when (data.optString("climate")) {
                "active" -> "空调运行中"
                "starting" -> "空调启动中"
                "idle" -> "空调关闭"
                else -> "空调未知"
            }
            views.setTextViewText(R.id.widget_climate, climate)
            views.setTextColor(R.id.widget_climate, ink)
            views.setTextColor(R.id.widget_refresh, muted)
            for (view in listOf(R.id.widget_lock, R.id.widget_climate)) {
                views.setInt(view, "setBackgroundResource", if (dark) R.drawable.widget_control_dark else R.drawable.widget_control_light)
            }
            views.setOnClickPendingIntent(R.id.widget_lock, open(context, id, vin, "lock"))
            views.setOnClickPendingIntent(R.id.widget_climate, open(context, id, vin, "climate"))
            views.setOnClickPendingIntent(R.id.widget_refresh, open(context, id, vin, "refresh"))
            views.setContentDescription(R.id.widget_lock, "$locked，打开门锁控制")
            views.setContentDescription(R.id.widget_climate, "$climate，打开空调控制")
            if (!compact) {
                views.setViewVisibility(R.id.widget_artwork, if (large) View.VISIBLE else View.GONE)
                views.setViewVisibility(R.id.widget_charging, if (large) View.VISIBLE else View.GONE)
            }
            if (large) {
                val image = BitmapFactory.decodeFile(File(context.filesDir, "widgets/${data.optString("imageName")}").absolutePath)
                views.setImageViewBitmap(R.id.widget_artwork, image)
                views.setContentDescription(R.id.widget_artwork, data.optString("model"))
                val charging = when (data.optInt("charging")) {
                    1 -> "充电中"
                    2 -> "空闲"
                    3 -> "等待预约"
                    4 -> "放电中"
                    5 -> "充电异常"
                    6 -> "智能充电"
                    7 -> "已暂停"
                    8 -> "充电完成"
                    else -> "未知"
                }
                views.setTextViewText(R.id.widget_charging, "充电状态 · $charging")
                views.setTextColor(R.id.widget_charging, muted)
            }
        }
        return views
    }

    private fun open(context: Context, id: Int, vin: String, action: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setData(Uri.Builder().scheme("norr").authority("widget").appendPath(id.toString()).appendPath(action).build())
            .putExtra("norrWidgetAction", action)
            .putExtra("norrWidgetVin", vin)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

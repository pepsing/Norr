package app.norr.mobile

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.ImageView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NorrWidgetThemeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val sizes = listOf(
        intArrayOf(0, 0, 130, 150), intArrayOf(0, 1, 130, 110),
        intArrayOf(1, 0, 260, 180), intArrayOf(1, 1, 260, 150),
        intArrayOf(2, 0, 260, 330),
    )
    private val data = JSONObject()
        .put("vin", "WIDGET-TEST")
        .put("model", "Polestar 2")
        .put("batteryPercent", 30)
        .put("rangeKm", 130)
        .put("locked", true)
        .put("climate", "idle")
        .put("charging", 2)

    private fun host(night: Boolean): Context {
        val configuration = Configuration(context.resources.configuration)
        configuration.uiMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        return context.createConfigurationContext(configuration)
    }

    @Test
    fun systemAppearanceUsesHostThemeAfterCreation() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            for (size in sizes) {
                val views = NorrWidgets.render(host(false), 0, data, false, size[0], size[1] == 1, true)
                for (night in listOf(false, true)) {
                    val root = views.apply(host(night), null)
                    assertEquals(Color.parseColor(if (night) "#EEEFE9" else "#20221F"),
                        root.findViewById<TextView>(R.id.widget_battery).currentTextColor)
                    assertEquals(Color.parseColor(if (night) "#B0B5AA" else "#62665E"),
                        root.findViewById<TextView>(R.id.widget_time).currentTextColor)
                    assertEquals(Color.parseColor(if (night) "#000000" else "#F7F7F5"),
                        (root.findViewById<View>(R.id.widget_root).background as GradientDrawable).color!!.defaultColor)
                    checkLayout(root, size)
                }
            }
        }
    }

    @Test
    fun explicitAppearanceSurvivesOppositeHostTheme() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            for (size in sizes) {
                for (dark in listOf(false, true)) {
                    val views = NorrWidgets.render(host(false), 0, data, dark, size[0], size[1] == 1)
                    val root = views.apply(host(!dark), null)
                    assertEquals(Color.parseColor(if (dark) "#EEEFE9" else "#20221F"),
                        root.findViewById<TextView>(R.id.widget_battery).currentTextColor)
                    assertEquals(Color.parseColor(if (dark) "#000000" else "#F7F7F5"),
                        (root.findViewById<View>(R.id.widget_root).background as GradientDrawable).color!!.defaultColor)
                }
            }
        }
    }

    @Test
    fun emptyAndMissingReadingsRemainReadable() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            for (size in sizes) {
                val empty = NorrWidgets.render(host(false), 0, null, false, size[0], size[1] == 1, true)
                    .apply(host(true), null)
                assertEquals(View.VISIBLE, empty.findViewById<View>(R.id.widget_empty).visibility)
                assertEquals(Color.parseColor("#EEEFE9"), empty.findViewById<TextView>(R.id.widget_empty).currentTextColor)
                val missing = NorrWidgets.render(host(false), 0, JSONObject(), false, size[0], size[1] == 1, true)
                    .apply(host(true), null)
                assertEquals("电量未知", missing.findViewById<TextView>(R.id.widget_battery).text.toString())
                assertEquals("门锁未知", missing.findViewById<TextView>(R.id.widget_lock).text.toString())
            }
        }
    }

    @Test
    fun artworkUsesHostThemeAndFixedAppearanceKeepsItsSelection() {
        withArtwork { record ->
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val system = NorrWidgets.render(host(false), 0, record, false, 2, followSystem = true)
                for (night in listOf(false, true, false)) {
                    checkArtwork(system.apply(host(night), null), night, night)
                }
                for (dark in listOf(false, true)) {
                    val fixed = NorrWidgets.render(host(!dark), 0, record, dark, 2)
                    assertTrue("Returning to system must reinflate the artwork", fixed.layoutId != system.layoutId)
                    for (night in listOf(false, true)) checkArtwork(fixed.apply(host(night), null), dark, dark)
                }
            }
        }
    }

    @Test
    fun oldOrMissingDarkArtworkFallsBackToTheSameVehicle() {
        withArtwork { record ->
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                for (missing in listOf(null, "vehicle-missing-${UUID.randomUUID()}.png")) {
                    val old = JSONObject(record.toString())
                    if (missing == null) old.remove("darkImageName") else old.put("darkImageName", missing)
                    val views = NorrWidgets.render(host(false), 0, old, false, 2, followSystem = true)
                    checkArtwork(views.apply(host(true), null), true, false)
                }
            }
        }
    }

    private fun withArtwork(check: (JSONObject) -> Unit) {
        val directory = File(context.filesDir, "widgets").apply { mkdirs() }
        val files = mutableListOf<File>()
        fun image(color: Int): String {
            val file = File(directory, "vehicle-test-${UUID.randomUUID()}.png")
            files.add(file)
            val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(color)
                bitmap.setPixel(2, 2, Color.RED)
                file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            } finally {
                bitmap.recycle()
            }
            return file.name
        }
        try {
            check(JSONObject(data.toString()).put("imageName", image(Color.WHITE))
                .put("darkImageName", image(Color.TRANSPARENT)))
        } finally {
            files.forEach { it.delete() }
        }
    }

    private fun checkArtwork(root: View, dark: Boolean, transparent: Boolean) {
        val light = root.findViewById<ImageView>(R.id.widget_artwork_light)
        val night = root.findViewById<ImageView>(R.id.widget_artwork_dark)
        assertEquals(if (dark) View.GONE else View.VISIBLE, light.visibility)
        assertEquals(if (dark) View.VISIBLE else View.GONE, night.visibility)
        val bitmap = ((if (dark) night else light).drawable as BitmapDrawable).bitmap
        assertEquals(if (transparent) 0 else 255, Color.alpha(bitmap.getPixel(0, 0)))
        assertEquals(Color.RED, bitmap.getPixel(2, 2))
        assertEquals(if (dark) Color.rgb(32, 35, 31) else Color.TRANSPARENT,
            (root.findViewById<View>(R.id.widget_artwork).background as ColorDrawable).color)
    }

    private fun checkLayout(root: View, size: IntArray) {
        val density = root.resources.displayMetrics.density
        val width = (size[2] * density).toInt()
        val height = (size[3] * density).toInt()
        root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, width, height)
        checkChildren(root, 0, height)
    }

    private fun checkChildren(view: View, offset: Int, height: Int) {
        if (view.visibility != View.VISIBLE) return
        val top = offset + view.top
        if (view is TextView && view.text.isNotEmpty()) {
            assertTrue("${view.text} extends below widget", top + view.height <= height)
            assertTrue("${view.text} is clipped vertically", view.height >= view.lineHeight)
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) checkChildren(view.getChildAt(index), top, height)
        }
    }
}

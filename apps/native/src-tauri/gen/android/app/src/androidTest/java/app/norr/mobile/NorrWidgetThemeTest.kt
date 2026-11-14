package app.norr.mobile

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

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
                        (root.background as GradientDrawable).color!!.defaultColor)
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
                        (root.background as GradientDrawable).color!!.defaultColor)
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

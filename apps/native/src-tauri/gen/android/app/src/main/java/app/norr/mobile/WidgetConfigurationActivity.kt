package app.norr.mobile

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.RadioGroup
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class WidgetConfigurationActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setResult(Activity.RESULT_CANCELED)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val provider = AppWidgetManager.getInstance(this).getAppWidgetInfo(id)?.provider
        if (provider?.packageName != packageName) {
            finish()
            return
        }
        setContentView(R.layout.widget_configuration)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        val choices = mapOf(R.id.widget_system to "system", R.id.widget_light to "light", R.id.widget_dark to "dark")
        val group = findViewById<RadioGroup>(R.id.widget_appearance)
        val preferences = NorrWidgets.preferences(this)
        group.check(choices.entries.find { it.value == preferences.getString("appearance-$id", "system") }?.key ?: R.id.widget_system)
        findViewById<View>(R.id.widget_save).setOnClickListener {
            preferences.edit().putString("appearance-$id", choices.getValue(group.checkedRadioButtonId)).apply()
            NorrWidgets.update(this, id)
            setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
            finish()
        }
        findViewById<View>(R.id.widget_cancel).setOnClickListener { finish() }
    }
}

package app.norr.mobile

import android.content.Context
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.SecretKey
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NorrCredentialStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val name = "credential-test-${UUID.randomUUID()}"
    private val preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    private val store = NorrCredentialStore(context, name, name)
    private val accounts = listOf("polestar-china-session", "polestar-china-signing-key", "device-id",
        "polestar-geely-session", "polestar-geely-client-config")

    @After
    fun cleanUp() {
        preferences.edit().clear().commit()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(name) }
    }

    @Test
    fun firstLoginHasNoSavedCredentials() {
        for (account in accounts) assertNull(store.read(account))
        assertTrue(preferences.all.isEmpty())
    }

    @Test
    fun p2AndP4SurviveStoreRecreationAndRenewal() {
        for (account in accounts) store.write(account, "fixture-original-$account")
        val restored = NorrCredentialStore(context, name, name)
        for (account in accounts) {
            assertEquals("fixture-original-$account", restored.read(account))
            assertFalse(preferences.getString(account, "")!!.contains("fixture-original"))
            restored.write(account, "fixture-renewed-$account")
        }
        val renewed = NorrCredentialStore(context, name, name)
        for (account in accounts) assertEquals("fixture-renewed-$account", renewed.read(account))
    }

    @Test
    fun existingV1CiphertextIsReadableWithoutMigration() {
        store.write("device-id", "fixture-device")
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(name, null) as SecretKey
        val account = "polestar-china-session"
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal("fixture-legacy-session".toByteArray(Charsets.UTF_8))
        val record = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString()
        assertTrue(preferences.edit().putString(account, record).commit())
        assertEquals("fixture-legacy-session", store.read(account))
        assertEquals(record, preferences.getString(account, null))
    }

    @Test
    fun unknownAccountsAreRejectedWithoutChangingStorage() {
        store.write("polestar-geely-session", "fixture-p4")
        val before = preferences.all.toMap()
        for (account in listOf("", "unknown-account", "../polestar-geely-session")) {
            try { store.read(account); fail("Unknown read accepted") } catch (_: UnsupportedCredentialAccount) {}
            try { store.write(account, "fixture"); fail("Unknown write accepted") } catch (_: UnsupportedCredentialAccount) {}
        }
        assertEquals(before, preferences.all)
    }

    @Test
    fun ciphertextRemainsBoundToItsAccountAndFailuresPreserveData() {
        store.write("polestar-china-session", "fixture-cn")
        val record = preferences.getString("polestar-china-session", null)
        assertTrue(preferences.edit().putString("polestar-geely-session", record).commit())
        try {
            store.read("polestar-geely-session")
            fail("Ciphertext copied across accounts must not decrypt")
        } catch (error: Exception) {
            assertFalse(error is UnsupportedCredentialAccount)
        }
        assertEquals(record, preferences.getString("polestar-geely-session", null))
        assertEquals("fixture-cn", store.read("polestar-china-session"))
        store.write("polestar-geely-session", "fixture-p4-recovered")
        assertEquals("fixture-p4-recovered", store.read("polestar-geely-session"))
    }
}

package app.norr.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal class UnsupportedCredentialAccount : IllegalArgumentException()

internal class NorrCredentialStore(
    context: Context,
    preferencesName: String = "norr-credentials",
    private val keyAlias: String = "norr-session-v1",
) {
    private val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    private fun validate(account: String) {
        if (account !in setOf(
                "polestar-china-session", "polestar-china-signing-key", "device-id",
                "polestar-geely-session", "polestar-geely-client-config",
            )) throw UnsupportedCredentialAccount()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build())
            }.generateKey()
    }

    @Synchronized
    fun read(account: String): String? {
        validate(account)
        val stored = preferences.getString(account, null) ?: return null
        val record = JSONObject(stored)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(),
            GCMParameterSpec(128, Base64.decode(record.getString("iv"), Base64.NO_WRAP)))
        cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
        val bytes = cipher.doFinal(Base64.decode(record.getString("data"), Base64.NO_WRAP))
        return try { bytes.toString(Charsets.UTF_8) } finally { bytes.fill(0) }
    }

    @Synchronized
    fun write(account: String, value: String) {
        validate(account)
        val bytes = value.toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val encrypted = try {
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
            cipher.doFinal(bytes)
        } finally { bytes.fill(0) }
        val record = JSONObject()
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP))
        check(preferences.edit().putString(account, record.toString()).commit())
    }
}

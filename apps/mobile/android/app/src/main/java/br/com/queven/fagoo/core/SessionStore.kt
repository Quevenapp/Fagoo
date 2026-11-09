package br.com.queven.fagoo.core

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import br.com.queven.fagoo.core.model.User
import br.com.queven.fagoo.core.model.FagooJson
import java.util.UUID

/** Private state is encrypted. Keystore failure prevents login; no plaintext fallback. */
class SessionStore(context: Context) {
    private val secure = EncryptedSharedPreferences.create(context, "fagoo.secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    private fun get(key: String) = secure.getString(key, null)
    private fun set(key: String, value: String?) { check(secure.edit().putString(key, value).commit()) { "Armazenamento seguro indisponível" } }
    init { context.getSharedPreferences("fagoo.secure.fallback", Context.MODE_PRIVATE).edit().clear().commit() }
    var serverUrl: String? get() = get("server"); set(v) = set("server", v)
    var discovery: String? get() = get("discovery"); set(v) = set("discovery", v)
    var webUrl: String? get() = get("web"); set(v) = set("web", v)
    var token: String? get() = get("token"); set(v) = set("token", v)
    var refreshToken: String? get() = get("refresh"); set(v) = set("refresh", v)
    var tokenExpires: Long get() = get("expires")?.toLongOrNull() ?: 0; set(v) = set("expires", v.toString())
    var user: User?
        get() = get("user")?.let { runCatching { FagooJson.decodeFromString(User.serializer(), it) }.getOrNull() }
        set(v) = set("user", v?.let { FagooJson.encodeToString(User.serializer(), it) })
    var contextJson: String? get() = get("context"); set(v) = set("context", v)
    var profileId: String? get() = get("unit"); set(v) = set("unit", v)
    var mode: String get() = get("mode") ?: "login"; set(v) = set("mode", v)
    var panelToken: String? get() = get("panel_token"); set(v) = set("panel_token", v)
    var panelDeviceId: String? get() = get("panel_device"); set(v) = set("panel_device", v)
    val deviceId: String get() = get("installation") ?: UUID.randomUUID().toString().also { set("installation", it) }
    var pushToken: String? get() = get("push_token"); set(v) = set("push_token", v)
    var registeredPushToken: String? get() = get("push_registered"); set(v) = set("push_registered", v)
    var notificationsEnabled: Boolean get() = get("notifications") != "false"; set(v) = set("notifications", v.toString())
    fun eventCursor(profileId: String): Long = get("cursor.$profileId")?.toLongOrNull() ?: 0
    fun setEventCursor(profileId: String, cursor: Long) = set("cursor.$profileId", cursor.toString())
    fun clearSession() { check(secure.edit().clear().commit()) { "Não foi possível limpar a sessão" } }
    companion object {
        fun normalizeServer(input: String): String? {
            val text = input.trim().let { if (it.contains("://")) it else "https://$it" }
            val uri = runCatching { java.net.URI(text) }.getOrNull() ?: return null
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.fragment != null || uri.query != null) return null
            if (uri.path !in listOf("", "/")) return null
            return "https://${uri.host.lowercase()}" + if (uri.port > 0 && uri.port != 443) ":${uri.port}" else ""
        }
    }
}

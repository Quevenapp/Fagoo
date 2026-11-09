// SPDX-License-Identifier: AGPL-3.0-only
package br.com.queven.fagoo.panel

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest

@Serializable data class EffectReceipt(val job: String, val claim: String, val result: String)
/** Only technical receipts. No ticket database, actions to run offline, phone, message, or token. */
class PanelJournal(context: Context, origin: String, device: String) {
    private val scope = MessageDigest.getInstance("SHA-256").digest("${origin.trimEnd('/')}:$device".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private val prefs = context.getSharedPreferences("fagoo-panel-receipts-$scope", Context.MODE_PRIVATE)
    private val json = Json
    var pendingCommand: String?
        get() = prefs.getString("command", null)
        set(value) { check(prefs.edit().putString("command", value).commit()) { "Não foi possível guardar a confirmação." } }
    fun receipts(): List<EffectReceipt> = prefs.all.filterKeys { it.startsWith("effect:") }.values.mapNotNull { raw -> runCatching { json.decodeFromString<EffectReceipt>(raw as String) }.getOrNull() }
    fun find(id: String) = prefs.getString("effect:$id", null)?.let { json.decodeFromString<EffectReceipt>(it) }
    fun record(receipt: EffectReceipt) { check(prefs.edit().putString("effect:${receipt.job}", json.encodeToString(EffectReceipt.serializer(), receipt)).commit()) { "Não foi possível guardar o resultado." } }
    fun confirmed(id: String) { check(prefs.edit().remove("effect:$id").commit()) }
}

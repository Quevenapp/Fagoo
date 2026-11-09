// SPDX-License-Identifier: AGPL-3.0-only
package br.com.queven.fagoo.panel

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant

enum class PanelTemplate(val id: String, val label: String) {
    SINAL("sinal", "Sinal"), CLINICA("clinica", "Clínica"), TERMINAL("terminal", "Terminal"), VITRINE("vitrine", "Vitrine"), SOL("sol", "Sol");
    companion object { val DEFAULT = SINAL; fun fromId(id: String?) = entries.firstOrNull { it.id == id } ?: DEFAULT }
}
@Serializable data class PanelDevice(val id: String, val unit_id: String, val name: String, val capabilities: List<String> = emptyList())
@Serializable data class PanelUnit(val id: String, val name: String, val timezone: String)
@Serializable data class PanelConfig(val template: String = "sinal", val functions: List<String> = listOf("chamada"), val title: String = "", val footer: String = "", val media_enabled: Boolean = true)
@Serializable data class PanelSettings(val template: String? = null, val volume: Float = 1f, val muted: Boolean = false)
@Serializable data class PanelQueue(val id: String, val name: String, val prefix: String, val active: Boolean = true)
@Serializable data class PanelTicket(val id: String, val display_number: String, val status: String, val desk: String? = null, val recalls: Int = 0, val last_called_at: String? = null, val public_token: String? = null, val tracking_url: String? = null)
@Serializable data class PanelOrder(val id: String, val code: String, val status: String)
@Serializable data class PanelCampaign(val id: String, val title: String, val media_url: String, val media_type: String, val starts_at: String, val expires_at: String, val duration_seconds: Int = 10, val priority: Int = 0, val surfaces: List<String> = emptyList(), val active: Boolean = true)
@Serializable data class PanelSnapshot(val unit: PanelUnit, val revision: Long, val server_time: String, val config: PanelConfig, val device_settings: PanelSettings? = null, val queues: List<PanelQueue> = emptyList(), val tickets: List<PanelTicket> = emptyList(), val recent_calls: List<PanelTicket> = emptyList(), val orders: List<PanelOrder> = emptyList(), val campaigns: List<PanelCampaign> = emptyList())
@Serializable data class PanelJob(val id: String, val event_id: String, val kind: String, val payload: JsonObject, val claim_id: String, val expires_at: String)
@Serializable data class PanelJobs(val jobs: List<PanelJob> = emptyList())
data class PanelState(val device: PanelDevice? = null, val snapshot: PanelSnapshot? = null, val online: Boolean = false, val busy: Boolean = false, val message: String = "Conectando…", val issued: PanelTicket? = null, val pendingCommand: String? = null, val printMessage: String? = null)

object PanelRules {
    fun canExecuteAudio(job: PanelJob, snapshot: PanelSnapshot, now: Instant): Boolean {
        if (job.kind != "audio" || Instant.parse(job.expires_at) <= now) return false
        return snapshot.tickets.any { it.id == job.payload["ticket_id"]?.jsonPrimitive?.content && it.status == "chamada" && it.desk == job.payload["desk"]?.jsonPrimitive?.content && it.recalls.toString() == job.payload["recalls"]?.jsonPrimitive?.content }
    }
    fun campaigns(snapshot: PanelSnapshot, surface: String, now: Instant): List<PanelCampaign> =
        if (!snapshot.config.media_enabled) emptyList() else snapshot.campaigns.filter { it.active && surface in it.surfaces && Instant.parse(it.starts_at) <= now && Instant.parse(it.expires_at) > now && it.media_url.startsWith("https://") }.sortedWith(compareByDescending<PanelCampaign> { it.priority }.thenBy { it.id })
}

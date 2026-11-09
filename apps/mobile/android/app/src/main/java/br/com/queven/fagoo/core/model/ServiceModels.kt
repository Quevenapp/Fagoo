package br.com.queven.fagoo.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable data class TeamContact(
    val id: String, val kind: String, val name: String, val online: Boolean,
    val bot_id: String? = null, val line_ids: List<String>? = null,
)
@Serializable data class LineService(val mode: String = "inherit", val bot_id: String? = null, val menu_mode: String = "automatic")
@Serializable data class ServiceLine(
    val id: String, val name: String, val kind: String, val mode: String, val status: String,
    val number: String? = null, val number_policy: JsonObject = JsonObject(emptyMap()), val service: LineService = LineService(),
)
@Serializable data class InternalChat(val id: String, val peer: TeamContact? = null, val messages: List<InternalMessage> = emptyList())
@Serializable data class InternalMessage(val id: String, val author: String, val text: String, val created: Long, val status: String? = null, val run_id: String? = null)

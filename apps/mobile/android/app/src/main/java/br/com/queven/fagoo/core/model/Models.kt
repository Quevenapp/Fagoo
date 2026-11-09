package br.com.queven.fagoo.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Modelos da API Fagoo (docs/API.md e docs/MOBILE.md). Datas são Unix em milissegundos.
// Campos do banco que chegam como JSON em string (attachments, content, tags, profiles) são mantidos como String
// e lidos com os auxiliares de Json.kt.

@Serializable data class HealthInfo(val service: String = "", val version: String = "", val commit: String = "", val runtime: String = "")
@Serializable data class AuthStatus(val initialized: Boolean = false, val configured: Boolean = false)
@Serializable data class DeviceInfo(val platform: String = "android", val name: String, val app_version: String)
@Serializable data class MobileLoginRequest(val email: String, val password: String, val device: DeviceInfo)
@Serializable data class MobileSession(val token: String, val expires: Long, val user: User)
@Serializable data class User(
    val id: String,
    val name: String = "",
    val email: String = "",
    val role: String = "operator",
    val profiles: List<String> = emptyList(),
) { val isAdmin get() = role == "admin" }

/** Resposta de GET /api/v1/me (Actor). */
@Serializable data class Me(
    val id: String,
    val kind: String = "user",
    val name: String = "",
    val role: String = "operator",
    val profiles: List<String> = emptyList(),
)

@Serializable data class Profile(val id: String, val name: String, val enabled: Int = 0, val settings: JsonElement? = null, val created: Long = 0)
@Serializable data class Page<T>(val data: List<T> = emptyList(), val next_cursor: String? = null)
@Serializable data class ApiErrorBody(val error: ApiErrorInfo? = null)
@Serializable data class ApiErrorInfo(val code: String = "", val message: String = "", val request_id: String? = null)
@Serializable data class Ok(val ok: Boolean = true)

@Serializable data class Conversation(
    val id: String,
    val profile_id: String = "",
    val connection_id: String? = null,
    val external_namespace: String = "",
    val external_id: String = "",
    val phone: String? = null,
    val state: String = "ai", // ai | waiting | human | closed
    val owner: String? = null,
    val epoch: Long = 0,
    val topic: String? = null,
    val tags: String = "[]",
    val last_customer: Long = 0,
    val created: Long = 0,
    val updated: Long = 0,
    val chat_type: String = "direct", // direct | group
    val title: String = "",
    val bot_policy: String = "mentions",
    val recipient_id: String? = null,
    val contact_name: String? = null,
    val contact_id: String? = null,
) {
    val displayName: String get() = contact_name?.takeIf { it.isNotBlank() } ?: title.takeIf { it.isNotBlank() } ?: phone ?: external_id
    val isGroup get() = chat_type == "group"
    fun isOwnedBy(userId: String?) = owner != null && owner == userId && state == "human"
}

@Serializable data class Message(
    val id: String,
    val profile_id: String = "",
    val conversation_id: String = "",
    val direction: String = "", // customer | outbound | operator | note | system
    val author: String = "",
    val text: String = "",
    val attachments: String = "[]",
    val external_id: String? = null,
    val created: Long = 0,
    val content: String = "{}",
    val delivery_status: String = "",
    val status_at: Long = 0,
) {
    val attachmentIds: List<String> get() = attachments.parseJsonStringList()
    val contentJson: JsonObject get() = content.parseJsonObject()
    val isIncoming get() = direction == "customer"
    val isNote get() = direction == "note"
}

@Serializable data class MediaFile(val id: String, val name: String = "", val type: String = "application/octet-stream", val size: Long = 0)
@Serializable data class Delivery(val id: String, val status: String = "", val error: String? = null, val created: Long = 0)
@Serializable data class ConversationDetail(
    val conversation: Conversation,
    val media: List<MediaFile> = emptyList(),
    val capabilities: JsonObject? = null,
    val group: JsonObject? = null,
    val contact: JsonObject? = null,
    val messages: List<Message> = emptyList(),
    val deliveries: List<Delivery> = emptyList(),
) {
    fun can(feature: String): Boolean = capabilities?.bool(feature) ?: false
}

/** POST /conversations/{id}/actions. `content` segue o esquema MessageContent da API. */
@Serializable data class ActionRequest(
    val action: String, // claim | reply | note | transfer | resolve | resume | tags
    val text: String? = null,
    val target: String? = null,
    val attachments: List<String>? = null,
    val content: JsonObject? = null,
    val tags: List<String>? = null,
    val menu_id: String? = null,
)
@Serializable data class ActionResult(val delivery_id: String? = null, val status: String? = null, val id: String? = null)
@Serializable data class MessageActionRequest(val action: String, val message_id: String, val emoji: String? = null, val text: String? = null)
@Serializable data class UploadInit(val name: String, val type: String, val size: Long)
@Serializable data class UploadCreated(val id: String, val part_size: Long, val parts: Int)
@Serializable data class UploadDone(val id: String, val name: String? = null, val size: Long? = null, val status: String? = null)
@Serializable data class GroupPolicyRequest(val bot_policy: String)

@Serializable data class Ticket(
    val id: String,
    val number: String = "",
    val profile_id: String = "",
    val conversation_id: String = "",
    val title: String = "",
    val status: String = "open", // open | in_progress | closed
    val owner: String? = null,
    val response_due_at: Long? = null,
    val first_response_at: Long? = null,
    val created: Long = 0,
    val updated: Long = 0,
) {
    val isOverdue: Boolean get() = status != "closed" && first_response_at == null && response_due_at != null && response_due_at < System.currentTimeMillis()
}
@Serializable data class TicketUpdate(val id: String, val ticket_id: String = "", val actor: String = "", val text: String = "", val internal: Int = 0, val created: Long = 0)
@Serializable data class TicketDetail(val ticket: Ticket, val updates: List<TicketUpdate> = emptyList(), val conversation: JsonObject? = null)
@Serializable data class TicketCreate(val conversation_id: String, val title: String)

@Serializable data class Bot(val id: String, val profile_id: String = "", val connection_id: String = "", val remote_profile: String = "", val name: String = "", val enabled: Int = 0, val line_ids: String? = null)
@Serializable data class BotRunRequest(val profile_id: String, val bot_id: String, val input: String)
@Serializable data class BotRun(
    val id: String,
    val profile_id: String = "",
    val bot_id: String = "",
    val actor: String = "",
    val conversation_id: String? = null,
    val status: String = "queued", // queued | starting | running | cancelling | cancelled | completed | failed | unknown
    val input: String = "",
    val result: String? = null,
    val error: String? = null,
    val attachments: List<String> = emptyList(),
    val created: Long = 0,
    val updated: Long = 0,
) {
    val isFinal get() = status in setOf("completed", "failed", "cancelled", "unknown")
}

@Serializable data class PresenceEntry(val actor: String, val name: String = "", val present: Int = 0, val telegram_id: String? = null)
@Serializable data class PresenceRequest(val present: Boolean)
@Serializable data class PresenceResult(val actor: String = "", val present: Boolean = false)

@Serializable data class Event(val id: Long, val profile_id: String = "", val kind: String = "", val resource_id: String? = null, val payload: JsonElement? = null, val created: Long = 0)
@Serializable data class Events(val data: List<Event> = emptyList(), val cursor: Long = 0)

@Serializable data class CallSession(val sdp_type: String, val sdp: String)
@Serializable data class Call(
    val id: String,
    val conversation_id: String = "",
    val direction: String = "", // inbound | outbound
    val actor: String? = null,
    val status: String = "", // dialing | connecting | ringing | preaccepted | active | completed | rejected | missed | failed | unknown
    val error: String? = null,
    val started: Long? = null,
    val ended: Long? = null,
    val duration: Long? = null,
    val created: Long = 0,
    val updated: Long = 0,
    val session: CallSession? = null,
) {
    val isLive get() = status !in setOf("completed", "missed", "rejected", "failed")
}
@Serializable data class CallStart(val conversation_id: String, val session: CallSession)
@Serializable data class CallAccept(val session: CallSession)
@Serializable data class CallPermissionRequest(val conversation_id: String)
@Serializable data class CallReconcile(val confirmed_ended: Boolean = true)
@Serializable data class CallActionResult(val id: String = "", val status: String = "", val delivery_id: String? = null)

@Serializable data class DeviceRegistration(
    // Required by the API; a default would be omitted by FagooJson.encodeDefaults=false.
    val platform: String,
    val provider: String = "fcm",
    val token: String,
    val name: String,
    val app_version: String,
    val profiles: List<String> = emptyList(),
    val enabled: Boolean = true,
)
@Serializable data class Device(
    val id: String,
    val user_id: String = "",
    val platform: String = "",
    val provider: String = "fcm",
    val name: String = "",
    val app_version: String = "",
    /** O servidor (deviceView em src/index.ts) devolve a lista já decodificada. */
    val profiles: List<String> = emptyList(),
    val enabled: Int = 1,
    val last_error: String? = null,
    val created: Long = 0,
    val updated: Long = 0,
)

@Serializable data class CountRow(val state: String? = null, val status: String? = null, val count: Long = 0)
@Serializable data class ConnectionSummary(val id: String, val name: String = "", val kind: String = "", val status: String = "", val last_seen: Long? = null)
@Serializable data class ProfileStatus(
    val settings: JsonObject? = null,
    val enabled: Int? = null,
    val conversations: List<CountRow> = emptyList(),
    val deliveries: List<CountRow> = emptyList(),
    val connections: List<ConnectionSummary> = emptyList(),
)
@Serializable data class Contact(
    val id: String,
    val name: String = "",
    val phone: String? = null,
    val email: String? = null,
    val company: String? = null,
    val notes: String? = null,
    val version: Int = 1,
)

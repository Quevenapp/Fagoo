package br.com.queven.fagoo.ui.conversations

import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.Conversation
import br.com.queven.fagoo.core.model.ConversationDetail
import br.com.queven.fagoo.core.model.FagooJson
import br.com.queven.fagoo.core.model.bool
import br.com.queven.fagoo.core.model.parseJsonStringList
import br.com.queven.fagoo.core.model.string
import br.com.queven.fagoo.core.net.ApiClient
import br.com.queven.fagoo.core.net.ApiException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Textos e conversões compartilhados pelas telas de conversas (pt-BR, mobile/README.md "Textos e comportamento").

internal fun stateLabel(state: String): String = when (state) {
    "ai" -> "Com a IA"
    "waiting" -> "Na fila"
    "human" -> "Com atendente"
    "closed" -> "Concluído"
    else -> state
}

internal fun deliveryLabel(status: String): String = when (status) {
    "sent" -> "Enviada"
    "delivered" -> "Entregue"
    "read" -> "Lida"
    "played" -> "Ouvida"
    "pending" -> "Na fila"
    "sending" -> "Enviando"
    "failed" -> "Falhou"
    "unknown" -> "Sem confirmação"
    "cancelled" -> "Cancelada"
    else -> status
}

internal fun botPolicyLabel(policy: String): String = when (policy) {
    "off" -> "Somente atendimento humano"
    "all" -> "Todas as mensagens"
    else -> "Quando mencionada ou /bot"
}

private val timeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())
private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM", Locale.getDefault())
private val dayYearFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yy", Locale.getDefault())

/** "Hoje 14:32", "Ontem 09:10", "08/11 14:32" ou "08/11/25 14:32", no fuso do aparelho. */
internal fun formatWhen(ms: Long, withTime: Boolean = true): String {
    if (ms <= 0) return ""
    val zone = ZoneId.systemDefault()
    val moment = Instant.ofEpochMilli(ms).atZone(zone)
    val today = LocalDate.now(zone)
    val date = moment.toLocalDate()
    val time = moment.format(timeFormat)
    val day = when {
        date == today -> "Hoje"
        date == today.minusDays(1) -> "Ontem"
        date.year == today.year -> moment.format(dayFormat)
        else -> moment.format(dayYearFormat)
    }
    return if (withTime) "$day $time" else day
}

/** Duração "m:ss" para players e gravação. */
internal fun formatClock(ms: Long): String {
    val totalSeconds = (ms.coerceAtLeast(0) / 1000)
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return String.format(Locale.getDefault(), "%d:%02d", minutes, seconds)
}

/** Traduz a exceção e, em 401, encerra a sessão mantendo o servidor (regra 8 do contrato). */
internal fun AppContainer.handleError(e: Throwable): String {
    if (e is ApiException && e.isUnauthorized) onLoggedOut(keepServer = true)
    return ApiClient.describe(e)
}

internal fun Conversation.tagList(): List<String> = tags.parseJsonStringList()

data class GroupMember(val id: String, val name: String, val admin: Boolean) {
    val display: String get() = name.ifBlank { id }
}

/** Participantes do grupo (`group.participants` chega como JSON em string, igual ao painel web). */
internal fun ConversationDetail.groupMembers(): List<GroupMember> {
    val raw = group?.get("participants") ?: return emptyList()
    val array: JsonArray = when (raw) {
        is JsonArray -> raw
        else -> {
            val text = group?.string("participants") ?: return emptyList()
            runCatching { FagooJson.parseToJsonElement(text) }.getOrNull() as? JsonArray ?: return emptyList()
        }
    }
    return array.mapNotNull { element ->
        val obj = element as? JsonObject ?: return@mapNotNull null
        val id = obj.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        GroupMember(id = id, name = obj.string("name").orEmpty(), admin = obj.bool("admin") ?: false)
    }
}

/**
 * Heurística de reserva (quando o `kind` da conexão não está disponível): canal Meta direto não oferece editar/apagar nem
 * menções e nunca tem `upgrade_required` (que em src/whatsapp.ts só é true para QR/Hermes sem protocol_version 2, cujos
 * conectores antigos também não anunciam edit/delete). Prefira [ConversationViewModel] com o `kind` de GET /profiles/{p}/status.
 */
internal fun ConversationDetail.isMetaLike(): Boolean =
    capabilities != null && !can("upgrade_required") && !can("edit") && !can("delete") && !can("mentions")

internal fun initialOf(name: String): String = name.trim().firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "?"

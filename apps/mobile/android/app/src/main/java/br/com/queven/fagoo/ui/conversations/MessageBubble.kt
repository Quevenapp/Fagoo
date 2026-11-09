@file:OptIn(ExperimentalFoundationApi::class)

package br.com.queven.fagoo.ui.conversations

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.ConversationDetail
import br.com.queven.fagoo.core.model.Delivery
import br.com.queven.fagoo.core.model.MediaFile
import br.com.queven.fagoo.core.model.Message
import br.com.queven.fagoo.core.model.array
import br.com.queven.fagoo.core.model.bool
import br.com.queven.fagoo.core.model.double
import br.com.queven.fagoo.core.model.obj
import br.com.queven.fagoo.core.model.string
import br.com.queven.fagoo.ui.theme.IncomingBubble
import br.com.queven.fagoo.ui.theme.IncomingBubbleDark
import br.com.queven.fagoo.ui.theme.NoteBubble
import br.com.queven.fagoo.ui.theme.NoteBubbleDark
import br.com.queven.fagoo.ui.theme.OutgoingBubble
import br.com.queven.fagoo.ui.theme.OutgoingBubbleDark
import kotlinx.serialization.json.JsonObject
import java.util.Locale

/**
 * Bolha de mensagem: cliente à esquerda, enviadas à direita, nota interna destacada, sistema centralizado.
 * Mostra autor (grupos), citação, texto/apagada, anexos, localização, contatos, reações, horário, "Editada" e recibo.
 */
@Composable
internal fun MessageBubble(
    message: Message,
    detail: ConversationDetail,
    meId: String?,
    names: Map<String, String>,
    mediaById: Map<String, MediaFile>,
    quotedText: String?,
    container: AppContainer,
    profileId: String,
    onLongPress: () -> Unit,
    onOpenImage: (MediaFile) -> Unit,
) {
    val content = remember(message.content) { message.contentJson }
    val deleted = content.bool("deleted") == true

    if (message.direction == "system") {
        Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp)) {
                Text(
                    message.text,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        return
    }

    val outgoing = !message.isIncoming && !message.isNote
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val bubbleColor = when {
        message.isNote -> if (dark) NoteBubbleDark else NoteBubble
        message.isIncoming -> if (dark) IncomingBubbleDark else IncomingBubble
        else -> if (dark) OutgoingBubbleDark else OutgoingBubble
    }
    val textColor = if (dark) Color(0xFFE9EDEF) else Color(0xFF111B21)
    val subtle = textColor.copy(alpha = 0.65f)
    val alignment = when {
        message.isNote -> Alignment.Center
        outgoing -> Alignment.CenterEnd
        else -> Alignment.CenterStart
    }
    val shape = RoundedCornerShape(
        topStart = if (message.isIncoming) 4.dp else 14.dp,
        topEnd = if (outgoing) 4.dp else 14.dp,
        bottomStart = 14.dp,
        bottomEnd = 14.dp,
    )
    val authorLabel = authorLabel(message, detail, content, meId, names)

    Box(Modifier.fillMaxWidth(), contentAlignment = alignment) {
        Surface(
            color = bubbleColor,
            contentColor = textColor,
            shape = shape,
            shadowElevation = 1.dp,
            modifier = Modifier
                .widthIn(max = 320.dp)
                .combinedClickable(onClick = {}, onLongClick = onLongPress, onLongClickLabel = "Ações da mensagem"),
        ) {
            Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                if (authorLabel != null) {
                    Text(
                        authorLabel,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (message.isNote) subtle else MaterialTheme.colorScheme.primary,
                    )
                }
                val hasQuote = content.string("reply_to") != null || content.string("reply_external_id") != null
                if (hasQuote) {
                    QuoteBlock(quotedText ?: content.string("reply_text") ?: "Mensagem citada", subtle, textColor)
                }
                if (deleted) {
                    Text("Mensagem apagada", style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = subtle)
                } else {
                    if (message.text.isNotBlank()) {
                        Text(message.text, style = MaterialTheme.typography.bodyMedium)
                    }
                    message.attachmentIds.forEach { id ->
                        AttachmentView(
                            media = mediaById[id] ?: MediaFile(id = id, name = "Anexo", type = "application/octet-stream", size = 0),
                            profileId = profileId,
                            container = container,
                            onOpenImage = onOpenImage,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                    content.obj("location")?.let { LocationCard(it, subtle) }
                    content.array("contacts")?.let { list ->
                        list.forEach { element -> (element as? JsonObject)?.let { ContactCard(it) } }
                    }
                }
                val reactions = content.obj("reactions")?.values?.mapNotNull { (it as? JsonObject)?.string("emoji")?.takeIf { e -> e.isNotBlank() } }.orEmpty()
                if (reactions.isNotEmpty()) {
                    Row(Modifier.padding(top = 4.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        reactions.forEach { emoji ->
                            Surface(color = textColor.copy(alpha = 0.1f), shape = RoundedCornerShape(50)) {
                                Text(emoji, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                            }
                        }
                    }
                }
                Row(Modifier.align(Alignment.End).padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    val footer = buildString {
                        append(formatWhen(message.created))
                        if (content.bool("edited") == true) append(" · Editada")
                        if (outgoing && message.delivery_status.isNotBlank()) append(" · ").append(deliveryLabel(message.delivery_status))
                    }
                    Text(footer, style = MaterialTheme.typography.labelSmall, color = subtle)
                    if (outgoing && message.delivery_status.isNotBlank()) {
                        Spacer(Modifier.width(3.dp))
                        StatusIcon(message.delivery_status, subtle)
                    }
                }
                content.obj("receipts")?.let { receipts ->
                    val total = receipts.size
                    val read = receipts.values.count { (it as? JsonObject)?.string("status") in setOf("read", "played") }
                    Text("$read leram · $total receberam", style = MaterialTheme.typography.labelSmall, color = subtle, modifier = Modifier.align(Alignment.End))
                }
            }
        }
    }
}

private fun authorLabel(message: Message, detail: ConversationDetail, content: JsonObject, meId: String?, names: Map<String, String>): String? = when {
    message.isNote -> {
        val who = if (message.author == meId) "você" else names[message.author]
        if (who != null) "Nota interna · $who" else "Nota interna"
    }
    message.isIncoming -> if (detail.conversation.isGroup) content.string("participant_name")?.takeIf { it.isNotBlank() } ?: content.string("participant") ?: "Participante" else null
    message.author == meId -> null
    else -> names[message.author] ?: when {
        message.author.isBlank() || message.author == "system" -> "Sistema"
        message.author.startsWith("app:") -> "Integração"
        else -> "Assistente"
    }
}

@Composable
private fun QuoteBlock(text: String, subtle: Color, textColor: Color) {
    Row(Modifier.padding(bottom = 4.dp).height(IntrinsicSize.Min)) {
        Surface(color = MaterialTheme.colorScheme.primary, modifier = Modifier.width(3.dp).fillMaxHeight()) { Spacer(Modifier.width(3.dp)) }
        Surface(color = textColor.copy(alpha = 0.06f), shape = RoundedCornerShape(topEnd = 6.dp, bottomEnd = 6.dp), modifier = Modifier.weight(1f)) {
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                color = subtle,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun StatusIcon(status: String, subtle: Color) {
    val readColor = Color(0xFF53BDEB)
    when (status) {
        "pending", "sending" -> Icon(Icons.Filled.Schedule, contentDescription = null, tint = subtle, modifier = Modifier.size(14.dp))
        "sent" -> Icon(Icons.Filled.Done, contentDescription = null, tint = subtle, modifier = Modifier.size(14.dp))
        "delivered" -> Icon(Icons.Filled.DoneAll, contentDescription = null, tint = subtle, modifier = Modifier.size(14.dp))
        "read", "played" -> Icon(Icons.Filled.DoneAll, contentDescription = null, tint = readColor, modifier = Modifier.size(14.dp))
        "failed" -> Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
        "unknown" -> Icon(Icons.Filled.HelpOutline, contentDescription = null, tint = subtle, modifier = Modifier.size(14.dp))
        else -> {}
    }
}

/** Localização recebida/enviada: abre no app de mapas (geo:) ou no OpenStreetMap. */
@Composable
private fun LocationCard(location: JsonObject, subtle: Color) {
    val context = LocalContext.current
    val lat = location.double("latitude") ?: return
    val lng = location.double("longitude") ?: return
    val name = location.string("name")?.takeIf { it.isNotBlank() }
    val address = location.string("address")?.takeIf { it.isNotBlank() }
    val coords = String.format(Locale.US, "%.5f, %.5f", lat, lng)
    Surface(
        color = subtle.copy(alpha = 0.08f),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .clickable {
                val label = Uri.encode(name ?: "Localização")
                val geo = Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lng?q=$lat,$lng($label)"))
                try {
                    context.startActivity(geo)
                } catch (e: ActivityNotFoundException) {
                    val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/?mlat=$lat&mlon=$lng#map=16/$lat/$lng"))
                    runCatching { context.startActivity(web) }
                }
            },
    ) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.LocationOn, contentDescription = "Localização", tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(8.dp))
            Column {
                Text(name ?: "Ver localização", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                if (address != null) Text(address, style = MaterialTheme.typography.bodySmall, color = subtle)
                Text(coords, style = MaterialTheme.typography.labelSmall, color = subtle)
            }
        }
    }
}

/** Cartão de contato: toque abre o discador com o número. */
@Composable
private fun ContactCard(contact: JsonObject) {
    val context = LocalContext.current
    val name = contact.string("name")?.takeIf { it.isNotBlank() } ?: "Contato"
    val phone = contact.string("phone").orEmpty()
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .clickable(enabled = phone.isNotBlank()) {
                runCatching { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }
            }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Person, contentDescription = "Contato", tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(8.dp))
        Column {
            Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            if (phone.isNotBlank()) Text(phone, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Entrega pendente (fila de saída que ainda não virou mensagem confirmada). */
@Composable
internal fun DeliveryRow(delivery: Delivery) {
    Box(Modifier.fillMaxWidth().padding(vertical = 2.dp), contentAlignment = Alignment.CenterEnd) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp)) {
            Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                val failed = delivery.status == "failed"
                Icon(
                    if (failed) Icons.Filled.ErrorOutline else Icons.Filled.Schedule,
                    contentDescription = null,
                    tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    buildString {
                        append(deliveryLabel(delivery.status))
                        delivery.error?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

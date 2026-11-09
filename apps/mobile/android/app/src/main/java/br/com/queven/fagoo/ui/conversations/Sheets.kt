@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.fagoo.ui.conversations

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AddReaction
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MarkChatRead
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import br.com.queven.fagoo.core.model.Bot
import br.com.queven.fagoo.core.model.ConversationDetail
import br.com.queven.fagoo.core.model.Message
import br.com.queven.fagoo.core.model.PresenceEntry
import br.com.queven.fagoo.core.model.bool
import br.com.queven.fagoo.core.model.obj

// Folhas e diálogos da tela de conversa: transferir, etiquetas, bots, política do grupo, ações por mensagem.

@Composable
private fun SheetTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

@Composable
private fun PresenceDot(present: Boolean) {
    Box(
        Modifier
            .size(10.dp)
            .background(if (present) Color(0xFF25D366) else MaterialTheme.colorScheme.outline, CircleShape),
    )
}

/** Transferir para outro atendente (GET /presence com presença). */
@Composable
internal fun TransferSheet(contacts: List<br.com.queven.fagoo.core.model.TeamContact>, meId: String?, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val others = contacts.filter { it.id != meId }.sortedWith(compareByDescending<br.com.queven.fagoo.core.model.TeamContact> { it.online }.thenBy { it.name.lowercase() })
    ModalBottomSheet(onDismissRequest = onDismiss) {
        SheetTitle("Transferir para")
        if (others.isEmpty()) {
            Text(
                "Nenhuma pessoa ou bot autorizado para esta linha.",
                modifier = Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(Modifier.navigationBarsPadding()) {
                items(others, key = { it.id }) { entry ->
                    br.com.queven.fagoo.ui.team.TeamContactItem(entry, Modifier.clickable { onPick(entry.id) })
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

/** Consultar bot: lista os bots habilitados (GET /bots) e abre o chat do bot com o contexto da conversa. */
@Composable
internal fun BotsSheet(bots: List<Bot>?, onPick: (Bot) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        SheetTitle("Consultar bot")
        when {
            bots == null -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            bots.isEmpty() -> Text("Nenhum bot habilitado neste perfil.", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> LazyColumn(Modifier.navigationBarsPadding()) {
                items(bots, key = { it.id }) { bot ->
                    ListItem(
                        headlineContent = { Text(bot.name.ifBlank { bot.id }) },
                        supportingContent = { if (bot.remote_profile.isNotBlank()) Text(bot.remote_profile) },
                        leadingContent = { Icon(Icons.Filled.SmartToy, contentDescription = null) },
                        modifier = Modifier.clickable { onPick(bot) },
                    )
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

/** Mencionar participante do grupo (capabilities.mentions). */
@Composable
internal fun MentionSheet(members: List<GroupMember>, onPick: (GroupMember) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        SheetTitle("Mencionar participante")
        if (members.isEmpty()) {
            Text("Participantes do grupo ainda não foram carregados. Atualize os dados do grupo no painel.", modifier = Modifier.padding(16.dp))
        } else {
            LazyColumn(Modifier.navigationBarsPadding()) {
                items(members, key = { it.id }) { member ->
                    ListItem(
                        headlineContent = { Text(member.display) },
                        supportingContent = { if (member.admin) Text("Administrador") },
                        modifier = Modifier.clickable { onPick(member) },
                    )
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

/** Etiquetas da conversa (action: tags, até 20 de 40 caracteres). */
@Composable
internal fun TagsDialog(current: List<String>, onSave: (List<String>) -> Unit, onDismiss: () -> Unit) {
    var tags by remember { mutableStateOf(current) }
    var input by remember { mutableStateOf("") }
    fun addInput() {
        val value = input.trim().trimStart('#').take(40)
        if (value.isNotEmpty() && tags.none { it.equals(value, ignoreCase = true) } && tags.size < 20) tags = tags + value
        input = ""
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Etiquetas") },
        text = {
            Column {
                if (tags.isEmpty()) {
                    Text("Nenhuma etiqueta.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                } else {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        tags.forEach { tag ->
                            InputChip(
                                selected = false,
                                onClick = { tags = tags - tag },
                                label = { Text(tag) },
                                trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remover $tag", modifier = Modifier.size(16.dp)) },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = input,
                    onValueChange = { if (it.length <= 40) input = it },
                    label = { Text("Nova etiqueta") },
                    singleLine = true,
                    trailingIcon = { TextButton(onClick = { addInput() }, enabled = input.isNotBlank()) { Text("Adicionar") } },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("Até 20 etiquetas de 40 caracteres.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            Button(onClick = {
                if (input.isNotBlank()) addInput()
                onSave(tags)
            }) { Text("Salvar") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

/** Política de resposta da IA em grupo (PUT /groups/{id}/policy). */
@Composable
internal fun GroupPolicyDialog(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    var selected by remember { mutableStateOf(current.ifBlank { "mentions" }) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Respostas da IA no grupo") },
        text = {
            Column {
                listOf("off", "mentions", "all").forEach { option ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .selectable(selected = selected == option, onClick = { selected = option })
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selected == option, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Text(botPolicyLabel(option))
                    }
                }
                Text(
                    "O controle de atendimento humano continua valendo: devolva à IA quando quiser que o bot responda.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = { Button(onClick = { onPick(selected) }, enabled = selected != current) { Text("Salvar") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

/** Confirmação de exclusão no WhatsApp. */
@Composable
internal fun DeleteMessageDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Apagar mensagem") },
        text = { Text("Apagar esta mensagem também no WhatsApp? O registro de auditoria do atendimento é mantido.") },
        confirmButton = { Button(onClick = onConfirm) { Text("Apagar") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}

private val reactionChoices = listOf("👍", "❤️", "😊", "🙏")

/**
 * Ações por mensagem (toque longo), conforme capabilities e propriedade da conversa:
 * Responder, Reagir, Editar (enviadas, sem anexo, < 15 min), Apagar, Marcar como lida, Copiar texto.
 */
@Composable
internal fun MessageActionsSheet(
    message: Message,
    detail: ConversationDetail,
    own: Boolean,
    busy: Boolean,
    onReply: () -> Unit,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onMarkRead: () -> Unit,
    onDismiss: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val content = remember(message.content) { message.contentJson }
    val deleted = content.bool("deleted") == true
    val sendable = message.external_id != null && !message.isNote && !deleted && own
    val canEdit = sendable && detail.can("edit") && message.direction == "outbound" &&
        System.currentTimeMillis() - message.created < 15 * 60 * 1000 && message.attachmentIds.isEmpty()
    val canDelete = sendable && detail.can("delete") && message.direction == "outbound"
    val canRead = sendable && detail.can("read") && message.isIncoming
    val reactions = content.obj("reactions")

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            Text(
                message.text.ifBlank { if (message.attachmentIds.isNotEmpty()) "Anexo" else "Mensagem" }.take(140),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                maxLines = 3,
            )
            if (sendable && detail.can("reaction")) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.AddReaction, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    reactionChoices.forEach { emoji ->
                        TextButton(onClick = { onReact(emoji) }, enabled = !busy) {
                            Text(emoji, style = MaterialTheme.typography.titleLarge)
                        }
                    }
                    if (reactions != null && reactions.isNotEmpty()) {
                        TextButton(onClick = { onReact("") }, enabled = !busy) { Text("Remover") }
                    }
                }
            }
            if (sendable && detail.can("reply")) ActionRow(Icons.AutoMirrored.Filled.Reply, "Responder com citação", onClick = onReply)
            if (canEdit) ActionRow(Icons.Filled.Edit, "Editar", onClick = onEdit)
            if (canDelete) ActionRow(Icons.Filled.Delete, "Apagar", tint = MaterialTheme.colorScheme.error, onClick = onDelete)
            if (canRead) ActionRow(Icons.Filled.MarkChatRead, "Marcar como lida", onClick = onMarkRead)
            if (message.text.isNotBlank()) {
                ActionRow(Icons.Filled.ContentCopy, "Copiar texto") {
                    clipboard.setText(AnnotatedString(message.text))
                    onDismiss()
                }
            }
            if (!own && !message.isNote) {
                Text(
                    "Assuma a conversa para responder, reagir ou alterar mensagens.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun ActionRow(icon: ImageVector, label: String, tint: Color = MaterialTheme.colorScheme.onSurface, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label, color = tint, fontWeight = FontWeight.Medium) },
        leadingContent = { Icon(icon, contentDescription = null, tint = tint) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

/** Mensagem de erro com botão de fechar, usada no composer e no topo da tela. */
@Composable
internal fun InlineError(text: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        IconButton(onClick = onDismiss, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Filled.Close, contentDescription = "Fechar aviso", modifier = Modifier.size(16.dp))
        }
    }
}

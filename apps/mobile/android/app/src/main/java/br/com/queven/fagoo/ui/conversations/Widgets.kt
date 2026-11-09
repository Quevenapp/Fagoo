package br.com.queven.fagoo.ui.conversations

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Avatar redondo com a inicial do nome (ou ícone de grupo). */
@Composable
internal fun Avatar(name: String, group: Boolean, modifier: Modifier = Modifier, size: Int = 44) {
    Box(
        modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        if (group) {
            Icon(Icons.Filled.Group, contentDescription = "Grupo", tint = MaterialTheme.colorScheme.onPrimaryContainer)
        } else {
            Text(initialOf(name), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}

/** Chip pequeno com o estado da conversa (Com a IA / Na fila / Com atendente / Concluído). */
@Composable
internal fun StateChip(state: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val (container, content) = when (state) {
        "waiting" -> scheme.errorContainer to scheme.onErrorContainer
        "human" -> scheme.primaryContainer to scheme.onPrimaryContainer
        "ai" -> scheme.secondaryContainer to scheme.onSecondaryContainer
        else -> scheme.surfaceVariant to scheme.onSurfaceVariant
    }
    Surface(color = container, contentColor = content, shape = RoundedCornerShape(50), modifier = modifier) {
        Text(
            stateLabel(state),
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            maxLines = 1,
        )
    }
}

/**
 * Faixa de ligação tocando (status `ringing`) com Atender / Recusar. [answerLabel] permite trocar o rótulo quando a ação
 * principal não atende de fato (ex.: a lista de conversas só consegue abrir a conversa).
 */
@Composable
internal fun RingingCallStrip(
    name: String,
    busy: Boolean,
    onAnswer: () -> Unit,
    onReject: () -> Unit,
    modifier: Modifier = Modifier,
    answerLabel: String = "Atender",
) {
    Surface(color = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer, modifier = modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Filled.Call, contentDescription = null)
            Column(Modifier.weight(1f)) {
                Text("Ligação recebida", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = onReject, enabled = !busy) {
                Icon(Icons.Filled.CallEnd, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Recusar")
            }
            Button(onClick = onAnswer, enabled = !busy) { Text(answerLabel) }
        }
    }
}

@file:OptIn(ExperimentalMaterial3Api::class)

package br.com.queven.fagoo.ui.conversations

import android.Manifest
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.StickyNote2
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.media.DeviceInputs
import br.com.queven.fagoo.core.media.MediaKinds
import br.com.queven.fagoo.core.media.MediaUploader
import br.com.queven.fagoo.core.media.VoiceRecorder
import br.com.queven.fagoo.core.model.ConversationDetail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale

/**
 * Composer da conversa: texto multilinha, anexar (galeria, câmera, arquivo), gravar áudio,
 * localização, contato, nota interna, tipo automático/documento, menções em grupo, progresso de
 * upload e pedido pendente (mesma Idempotency-Key). Quando a conversa não é da pessoa, só permite nota interna.
 */
@Composable
internal fun Composer(vm: ConversationViewModel, container: AppContainer, detail: ConversationDetail, onClaim: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val own = vm.isOwn
    val conversation = detail.conversation
    val canVoice = detail.can("voice") || detail.can("audio")
    val members = remember(detail.group) { detail.groupMembers() }
    val locked = vm.sending || vm.pending != null

    // --- gravação de voz ---
    val recorder = remember { VoiceRecorder(context) }
    var recording by remember { mutableStateOf(false) }
    var seconds by remember { mutableIntStateOf(0) }
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    fun stopRecording() {
        if (!recording) return
        recording = false
        val file = recorder.stop()
        if (file != null && file.length() > 0) {
            vm.attachVoice(PendingAttachment.fromFile(file, recorder.mime, recorder.contentType, "Mensagem de voz"))
        } else {
            vm.composerError = "A gravação ficou vazia. Segure um pouco mais antes de parar."
        }
    }

    fun cancelRecording() {
        recording = false
        recorder.cancel()
    }

    fun startRecording() {
        try {
            recorder.start()
            recording = true
            vm.composerError = null
        } catch (e: Exception) {
            vm.composerError = "Não foi possível iniciar a gravação. Confira se outro app está usando o microfone."
        }
    }

    LaunchedEffect(recording) {
        if (recording) {
            seconds = 0
            while (recording) {
                delay(1000)
                seconds++
                if (seconds >= 120) stopRecording()
            }
        }
    }

    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else vm.composerError = "Permita o microfone nas configurações para gravar áudio."
    }

    fun requestRecord() {
        if (DeviceInputs.hasPermission(context, Manifest.permission.RECORD_AUDIO)) startRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    // --- anexos ---
    fun addUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val items = withContext(Dispatchers.IO) { uris.mapNotNull { MediaUploader.readUploadItem(context, it) } }
            if (items.size < uris.size) vm.composerError = "Alguns arquivos não puderam ser lidos."
            vm.addAttachments(items.map { PendingAttachment(it) })
        }
    }

    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MediaKinds.MAX_ATTACHMENTS)) { addUris(it) }
    val pickDocuments = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { addUris(it) }

    var cameraPath by rememberSaveable { mutableStateOf<String?>(null) }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = cameraPath
        cameraPath = null
        if (path != null) {
            val file = File(path)
            if (ok && file.exists() && file.length() > 0) {
                vm.addAttachments(listOf(PendingAttachment.fromFile(file, "image/jpeg", null, file.name)))
            } else {
                file.delete()
            }
        }
    }

    fun openCamera() {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "foto-${System.currentTimeMillis()}.jpg")
        cameraPath = file.absolutePath
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        try {
            takePicture.launch(uri)
        } catch (e: Exception) {
            cameraPath = null
            vm.composerError = "Nenhum aplicativo de câmera disponível."
        }
    }

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) openCamera() else vm.composerError = "Permita a câmera nas configurações para tirar fotos."
    }

    fun requestCamera() {
        if (DeviceInputs.hasPermission(context, Manifest.permission.CAMERA)) openCamera() else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    // --- localização ---
    var locating by remember { mutableStateOf(false) }

    fun fetchLocation() {
        if (locating) return
        locating = true
        scope.launch {
            val location = DeviceInputs.currentLocation(context)
            locating = false
            if (location == null) {
                vm.composerError = "Não foi possível obter a posição do aparelho. Informe as coordenadas manualmente."
            } else {
                vm.location = vm.location.copy(
                    latitude = String.format(Locale.US, "%.6f", location.latitude),
                    longitude = String.format(Locale.US, "%.6f", location.longitude),
                )
            }
        }
    }

    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.any { it }) fetchLocation() else vm.composerError = "Sem permissão de localização. Informe as coordenadas manualmente."
    }

    fun requestLocation() {
        vm.kind = ComposeKind.Location
        if (DeviceInputs.hasLocationPermission(context)) fetchLocation()
        else locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    // --- contato ---
    val pickContact = rememberLauncherForActivityResult(ActivityResultContracts.PickContact()) { uri ->
        if (uri != null) {
            scope.launch {
                val picked = DeviceInputs.readContact(context, uri)
                if (picked == null) vm.composerError = "Não foi possível ler o contato. Informe nome e telefone manualmente."
                else vm.contact = ContactDraft(name = picked.first, phone = picked.second)
            }
        }
    }
    val contactsPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) pickContact.launch(null) else vm.composerError = "Sem acesso à agenda. Informe nome e telefone manualmente."
    }

    fun requestContact() {
        vm.kind = ComposeKind.Contacts
        if (DeviceInputs.hasPermission(context, Manifest.permission.READ_CONTACTS)) pickContact.launch(null) else contactsPermission.launch(Manifest.permission.READ_CONTACTS)
    }

    var attachMenu by remember { mutableStateOf(false) }
    var mentionSheet by remember { mutableStateOf(false) }

    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
            if (!own) {
                val ownerName = conversation.owner?.let { if (it == vm.meId) "você" else vm.names[it] ?: "outro atendente" }
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        when {
                            conversation.state == "human" && ownerName != null && conversation.owner != vm.meId -> "Em atendimento por $ownerName. Assuma a conversa para responder, enviar arquivos ou ligar."
                            conversation.state == "closed" -> "Conversa concluída. Assuma para reabrir o atendimento."
                            else -> "Assuma a conversa para responder, enviar arquivos ou ligar."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    if (conversation.owner == null || conversation.owner == vm.meId || vm.isAdmin) {
                        Spacer(Modifier.width(8.dp))
                        FilledTonalButton(onClick = onClaim, enabled = !vm.busy) { Text("Assumir") }
                    }
                }
            }
            vm.composerError?.let { InlineError(it, onDismiss = { vm.composerError = null }, modifier = Modifier.padding(horizontal = 4.dp)) }
            vm.quote?.let { quoted ->
                DraftRow(
                    label = "Respondendo",
                    text = quoted.text.ifBlank { "Anexo" }.take(100),
                    onCancel = { vm.quote = null },
                )
            }
            vm.editing?.let {
                DraftRow(label = "Editando mensagem", text = "Limite de 15 minutos após o envio.", onCancel = { vm.cancelEdit() })
            }
            vm.pending?.let {
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(4.dp)) {
                    Column(Modifier.padding(8.dp)) {
                        Text(
                            "O pedido está guardado para uma tentativa segura (mesma chave de idempotência).",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { vm.send() }, enabled = !vm.sending) {
                                if (vm.sending) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                                else Text("Tentar novamente")
                            }
                            TextButton(onClick = { vm.abandonPending() }, enabled = !vm.sending) { Text("Abandonar pedido") }
                        }
                    }
                }
            }
            if (own) {
                vm.attachments.forEach { attachment ->
                    AttachmentPreviewRow(attachment, document = vm.kind == ComposeKind.Document, enabled = !locked) { vm.removeAttachment(attachment.key) }
                }
                vm.voice?.let { voice ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        AudioPlayerBar(uri = voice.item.source.localUri().toString(), container = container, modifier = Modifier.weight(1f))
                        Text(
                            "${if (voice.contentType == "voice") "Voz" else "Áudio"} · ${MediaKinds.formatSize(voice.size)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        IconButton(onClick = { vm.clearVoice() }, enabled = !locked) { Icon(Icons.Filled.Close, contentDescription = "Descartar gravação") }
                    }
                }
                if (vm.kind == ComposeKind.Location) {
                    LocationFields(vm, locating = locating, enabled = !locked, onUseDevice = { requestLocation() }, onRemove = { vm.kind = ComposeKind.Auto })
                }
                if (vm.kind == ComposeKind.Contacts) {
                    ContactFields(vm, enabled = !locked, onPick = { requestContact() }, onRemove = { vm.kind = ComposeKind.Auto })
                }
                if (vm.mentions.isNotEmpty()) {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.AlternateEmail, contentDescription = "Menções", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        vm.mentions.forEach { member ->
                            InputChip(
                                selected = false,
                                onClick = { vm.removeMention(member.id) },
                                label = { Text(member.display) },
                                trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remover menção a ${member.display}", modifier = Modifier.size(16.dp)) },
                                enabled = !locked,
                            )
                        }
                    }
                }
                if (vm.kind == ComposeKind.Document && vm.attachments.isNotEmpty()) {
                    Text("Os anexos serão enviados como documento.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp))
                }
            }
            if (recording) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(10.dp).padding(0.dp)) {
                        Surface(color = Color(0xFFE53935), shape = RoundedCornerShape(50), modifier = Modifier.size(10.dp)) {}
                    }
                    Spacer(Modifier.width(8.dp))
                    Text("Gravando · ${formatClock(seconds * 1000L)} / 2:00", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { cancelRecording() }) { Text("Descartar") }
                    FilledTonalButton(onClick = { stopRecording() }) {
                        Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Parar e revisar")
                    }
                }
            }
            vm.progress?.let { label ->
                Text(label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 4.dp))
                val pct = vm.progressPercent
                if (pct != null) LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp))
                else LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp))
            }

            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                if (own) {
                    Box {
                        IconButton(onClick = { attachMenu = true }, enabled = !locked && !recording && vm.editing == null) {
                            Icon(Icons.Filled.AttachFile, contentDescription = "Anexar ou escolher conteúdo")
                        }
                        DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Fotos e vídeos") },
                                leadingIcon = { Icon(Icons.Filled.PhotoLibrary, contentDescription = null) },
                                onClick = { attachMenu = false; pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
                            )
                            DropdownMenuItem(
                                text = { Text("Câmera") },
                                leadingIcon = { Icon(Icons.Filled.PhotoCamera, contentDescription = null) },
                                onClick = { attachMenu = false; requestCamera() },
                            )
                            DropdownMenuItem(
                                text = { Text("Arquivo") },
                                leadingIcon = { Icon(Icons.Filled.Description, contentDescription = null) },
                                onClick = { attachMenu = false; pickDocuments.launch(arrayOf("*/*")) },
                            )
                            if (detail.can("location")) {
                                DropdownMenuItem(
                                    text = { Text("Localização") },
                                    leadingIcon = { Icon(Icons.Filled.LocationOn, contentDescription = null) },
                                    onClick = { attachMenu = false; requestLocation() },
                                )
                            }
                            if (detail.can("contacts")) {
                                DropdownMenuItem(
                                    text = { Text("Compartilhar contato") },
                                    leadingIcon = { Icon(Icons.Filled.Contacts, contentDescription = null) },
                                    onClick = { attachMenu = false; requestContact() },
                                )
                            }
                            if (conversation.isGroup && detail.can("mentions")) {
                                DropdownMenuItem(
                                    text = { Text("Mencionar participante") },
                                    leadingIcon = { Icon(Icons.Filled.AlternateEmail, contentDescription = null) },
                                    onClick = { attachMenu = false; mentionSheet = true },
                                )
                            }
                            DropdownMenuItem(
                                text = { Text(if (vm.kind == ComposeKind.Document) "Tipo automático pelo arquivo" else "Enviar como documento") },
                                leadingIcon = { Icon(if (vm.kind == ComposeKind.Document) Icons.Filled.Check else Icons.Filled.Description, contentDescription = null) },
                                onClick = {
                                    attachMenu = false
                                    vm.kind = if (vm.kind == ComposeKind.Document) ComposeKind.Auto else ComposeKind.Document
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Nota interna") },
                                leadingIcon = { Icon(Icons.Filled.StickyNote2, contentDescription = null) },
                                onClick = { attachMenu = false; vm.sendNote() },
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = vm.text,
                    onValueChange = { vm.text = it },
                    modifier = Modifier.weight(1f),
                    placeholder = {
                        Text(
                            when {
                                !own -> "Escreva uma nota interna…"
                                vm.editing != null -> "Novo texto da mensagem"
                                else -> "Escreva sua resposta…"
                            },
                        )
                    },
                    enabled = !locked && !recording,
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences),
                    supportingText = if (vm.text.length > MediaKinds.MAX_TEXT) {
                        { Text("${vm.text.length}/${MediaKinds.MAX_TEXT} caracteres", color = MaterialTheme.colorScheme.error) }
                    } else null,
                )
                if (!own) {
                    IconButton(onClick = { vm.sendNote() }, enabled = vm.text.isNotBlank() && !vm.busy) {
                        Icon(Icons.Filled.StickyNote2, contentDescription = "Registrar nota interna")
                    }
                } else {
                    val showMic = canVoice && vm.editing == null && vm.text.isBlank() && vm.attachments.isEmpty() && vm.voice == null &&
                        vm.kind != ComposeKind.Location && vm.kind != ComposeKind.Contacts && vm.pending == null
                    if (showMic) {
                        IconButton(onClick = { if (recording) stopRecording() else requestRecord() }, enabled = !vm.sending) {
                            Icon(if (recording) Icons.Filled.Stop else Icons.Filled.Mic, contentDescription = if (recording) "Parar gravação" else "Gravar áudio")
                        }
                    } else {
                        IconButton(onClick = { vm.send() }, enabled = vm.canSend && !recording) {
                            if (vm.sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            else Icon(Icons.AutoMirrored.Filled.Send, contentDescription = if (vm.editing != null) "Salvar edição" else "Enviar")
                        }
                    }
                }
            }
        }
    }

    if (mentionSheet) {
        MentionSheet(members = members, onPick = { vm.addMention(it); mentionSheet = false }, onDismiss = { mentionSheet = false })
    }
}

@Composable
private fun DraftRow(label: String, text: String, onCancel: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(4.dp)) {
        Row(Modifier.padding(start = 10.dp, top = 2.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                Text(text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = onCancel) { Icon(Icons.Filled.Close, contentDescription = "Cancelar $label") }
        }
    }
}

@Composable
private fun AttachmentPreviewRow(attachment: PendingAttachment, document: Boolean, enabled: Boolean, onRemove: () -> Unit) {
    val kind = if (document) "document" else MediaKinds.kindOf(attachment.mime)
    val icon = when (kind) {
        "image", "sticker" -> Icons.Filled.Image
        "video" -> Icons.Filled.Videocam
        "audio", "voice" -> Icons.Filled.Audiotrack
        else -> Icons.Filled.Description
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = MediaKinds.label(kind), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(attachment.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${MediaKinds.formatSize(attachment.size)} · ${MediaKinds.label(kind)}${if (attachment.uploadedId != null) " · enviado" else ""}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Filled.Close, contentDescription = "Remover ${attachment.name}") }
    }
}

@Composable
private fun LocationFields(vm: ConversationViewModel, locating: Boolean, enabled: Boolean, onUseDevice: () -> Unit, onRemove: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(4.dp)) {
        Column(Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.LocationOn, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(6.dp))
                Text("Localização", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Filled.Close, contentDescription = "Remover localização") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = vm.location.latitude,
                    onValueChange = { vm.location = vm.location.copy(latitude = it) },
                    label = { Text("Latitude") },
                    singleLine = true,
                    enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = vm.location.longitude,
                    onValueChange = { vm.location = vm.location.copy(longitude = it) },
                    label = { Text("Longitude") },
                    singleLine = true,
                    enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.weight(1f),
                )
            }
            OutlinedTextField(
                value = vm.location.name,
                onValueChange = { if (it.length <= 200) vm.location = vm.location.copy(name = it) },
                label = { Text("Nome do local (opcional)") },
                singleLine = true,
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = vm.location.address,
                onValueChange = { if (it.length <= 500) vm.location = vm.location.copy(address = it) },
                label = { Text("Endereço (opcional)") },
                singleLine = true,
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            OutlinedButton(onClick = onUseDevice, enabled = enabled && !locating) {
                if (locating) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                else Icon(Icons.Filled.MyLocation, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (locating) "Obtendo posição…" else "Usar minha localização")
            }
            Text(
                "Revise as coordenadas antes de enviar. Elas são compartilhadas com o cliente no WhatsApp.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ContactFields(vm: ConversationViewModel, enabled: Boolean, onPick: () -> Unit, onRemove: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(4.dp)) {
        Column(Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Contacts, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(6.dp))
                Text("Cartão de contato", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Filled.Close, contentDescription = "Remover contato") }
            }
            OutlinedTextField(
                value = vm.contact.name,
                onValueChange = { if (it.length <= 100) vm.contact = vm.contact.copy(name = it) },
                label = { Text("Nome") },
                singleLine = true,
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = vm.contact.phone,
                onValueChange = { vm.contact = vm.contact.copy(phone = DeviceInputs.normalizePhone(it).take(17)) },
                label = { Text("Telefone com DDI") },
                placeholder = { Text("5511999990000") },
                singleLine = true,
                enabled = enabled,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            OutlinedButton(onClick = onPick, enabled = enabled) {
                Icon(Icons.Filled.Contacts, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Escolher da agenda")
            }
        }
    }
}

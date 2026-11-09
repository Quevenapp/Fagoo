package br.com.queven.fagoo.ui.conversations

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.fagoo.core.PrivateReadGate
import br.com.queven.fagoo.core.media.AuthenticatedMedia
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.media.MediaKinds
import br.com.queven.fagoo.core.media.MediaUploader
import br.com.queven.fagoo.core.media.UploadItem
import br.com.queven.fagoo.core.media.UploadSource
import br.com.queven.fagoo.core.model.ActionRequest
import br.com.queven.fagoo.core.model.ConversationDetail
import br.com.queven.fagoo.core.model.Event
import br.com.queven.fagoo.core.model.Message
import br.com.queven.fagoo.core.model.MessageActionRequest
import br.com.queven.fagoo.core.model.PresenceEntry
import br.com.queven.fagoo.core.model.string
import br.com.queven.fagoo.core.net.ApiClient
import br.com.queven.fagoo.core.net.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.File
import java.util.UUID

/** Tipo do conteúdo escolhido no composer (seletor "Automático pelo arquivo" / "Enviar como documento" / localização / contato). */
enum class ComposeKind(val label: String) {
    Auto("Automático pelo arquivo"),
    Document("Enviar como documento"),
    Location("Localização"),
    Contacts("Compartilhar contato"),
}

data class LocationDraft(val latitude: String = "", val longitude: String = "", val name: String = "", val address: String = "")
data class ContactDraft(val name: String = "", val phone: String = "")

/** Anexo escolhido e ainda não enviado; [uploadedId] evita subir de novo ao repetir o pedido. */
data class PendingAttachment(
    val item: UploadItem,
    /** `voice` ou `audio` para gravações; null para anexos comuns (tipo inferido). */
    val contentType: String? = null,
    val uploadedId: String? = null,
    val key: String = UUID.randomUUID().toString(),
) {
    val name: String get() = item.name
    val mime: String get() = item.mime
    val size: Long get() = item.size

    companion object {
        fun fromFile(file: File, mime: String, contentType: String?, name: String = file.name) =
            PendingAttachment(UploadItem(name = name, mime = mime, size = file.length(), source = UploadSource.FileSource(file)), contentType)
    }
}

/** Pedido já montado (anexos enviados) aguardando confirmação; repetido com a mesma Idempotency-Key. */
data class PendingSend(val key: String, val request: ActionRequest)

class ConversationViewModel(private val container: AppContainer, val conversationId: String) : ViewModel() {
    val profileId: String get() = container.session.profileId ?: ""
    val meId: String? get() = container.session.user?.id
    val isAdmin: Boolean get() = container.session.user?.isAdmin == true

    var detail by mutableStateOf<ConversationDetail?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    /** Aviso transitório (snackbar). A tela zera após exibir. */
    var notice by mutableStateOf<String?>(null)
    var team by mutableStateOf<List<br.com.queven.fagoo.core.model.TeamContact>>(emptyList())
        private set
    var presence by mutableStateOf<List<PresenceEntry>>(emptyList())
        private set

    // --- composer ---
    var text by mutableStateOf("")
    var attachments by mutableStateOf<List<PendingAttachment>>(emptyList())
        private set
    var voice by mutableStateOf<PendingAttachment?>(null)
        private set
    var quote by mutableStateOf<Message?>(null)
    var editing by mutableStateOf<Message?>(null)
        private set
    var kind by mutableStateOf(ComposeKind.Auto)
    var location by mutableStateOf(LocationDraft())
    var contact by mutableStateOf(ContactDraft())
    var mentions by mutableStateOf<List<GroupMember>>(emptyList())
        private set
    var pending by mutableStateOf<PendingSend?>(null)
        private set
    var sending by mutableStateOf(false)
        private set
    var progress by mutableStateOf<String?>(null)
        private set
    var progressPercent by mutableStateOf<Int?>(null)
        private set
    var composerError by mutableStateOf<String?>(null)

    private var sendKey: String = ApiClient.newIdempotencyKey()
    private var editKey: String = ApiClient.newIdempotencyKey()
    /**
     * Última ação de conversa (claim/transfer/note/...) que falhou na rede, com a Idempotency-Key usada: repetir o MESMO
     * pedido reutiliza a chave (docs/API.md: nunca gerar outra chave após timeout, a operação pode já ter sido aceita).
     * Zerada após sucesso, 4xx definitivo ou 409 idempotency_conflict.
     */
    private var pendingAct: Pair<ActionRequest, String>? = null
    /** Idem para ações por mensagem (reação, apagar, marcar lida). */
    private var pendingMessageAction: Pair<MessageActionRequest, String>? = null
    /** `connection_id` → `kind` (meta | qr | hermes…) de GET /profiles/{p}/status, carregado uma vez por ViewModel. */
    private var connectionKinds: Map<String, String>? = null
    private val uploader = MediaUploader(container)
    private val readGate = PrivateReadGate()
    private var detailJob: Job? = null
    var authorized by mutableStateOf(false)
        private set
    fun can(capability: String): Boolean = PrivateReadGate.canAct(authorized, container.context?.units?.find { it.id == profileId }?.capabilities ?: emptyList(), capability)
    val canClaim get() = can("communication.claim")
    val canReply get() = isOwn && can("communication.reply")
    val canTransfer get() = isOwn && can("communication.transfer")
    fun pauseActions() { readGate.invalidate(); detailJob?.cancel(); authorized = false }

    private fun clearRevokedContent() {
        readGate.invalidate(); authorized = false; detail = null; clearComposer()
        pending = null; editing = null; pendingAct = null; pendingMessageAction = null
        team = emptyList(); presence = emptyList(); AuthenticatedMedia.clear()
    }
    private fun revokeIfDenied(e: ApiException) {
        if (e.status in listOf(401,403,404)) clearRevokedContent()
    }


    val names: Map<String, String> get() = presence.associate { it.actor to it.name }
    val isOwn: Boolean get() = detail?.conversation?.isOwnedBy(meId) == true

    init {
        load()
        loadPresence()
    }

    fun load(silent: Boolean = false): Job {
        val read = readGate.begin()
        detailJob?.cancel()
        return viewModelScope.launch {
            if (!silent) loading = detail == null
            try {
                val response = container.api.conversation(profileId, conversationId)
                if (readGate.current(read)) { detail = response; authorized = true; loadError = null }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (readGate.current(read)) {
                    authorized = false
                    if (readGate.revoked(read, (e as? ApiException)?.status)) {
                        clearRevokedContent()
                    }
                    val message = container.handleError(e)
                    if (detail == null) loadError = message else notice = "Sem confirmação online. As ações estão indisponíveis."
                }
            } finally { if (detailJob == kotlinx.coroutines.currentCoroutineContext()[Job] || readGate.current(read)) loading = false }
        }.also { detailJob = it }
    }

    fun loadPresence() {
        viewModelScope.launch {
            try {
                presence = container.api.presence(profileId)
                team = container.api.team(profileId).data
            } catch (_: Exception) {
            }
        }
    }

    fun onEvents(events: List<Event>) {
        val relevant = events.any { e ->
            (e.kind.startsWith("message.") || e.kind.startsWith("conversation.")) &&
                (e.resource_id == conversationId || (e.payload as? JsonObject)?.string("conversation_id") == conversationId)
        }
        if (relevant) load(silent = true)
    }

    // --- ações da conversa (POST /actions) ---

    private fun act(request: ActionRequest, successNotice: String? = null, onDone: (() -> Unit)? = null) {
        val required = when (request.action) { "claim" -> "communication.claim"; "transfer" -> "communication.transfer"; else -> "communication.reply" }
        if (busy || !can(required) || (request.action != "claim" && !isOwn)) return
        // Mesmo pedido repetido após falha de rede → mesma chave; pedido diferente → chave nova.
        val key = pendingAct?.takeIf { it.first == request }?.second
            ?: ApiClient.newIdempotencyKey().also { pendingAct = request to it }
        viewModelScope.launch {
            busy = true
            try {
                container.api.act(profileId, conversationId, key, request)
                pendingAct = null
                load(silent = true).join()
                if (successNotice != null) notice = successNotice
                onDone?.invoke()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                revokeIfDenied(e)
                val message = container.handleError(e)
                notice = when {
                    e.isIdempotencyConflict -> {
                        pendingAct = null
                        "$message Confira a conversa antes de repetir; uma nova chave será usada."
                    }
                    isDefinitive(e) -> {
                        // O servidor recusou o pedido: não há o que repetir com a mesma chave.
                        pendingAct = null
                        message
                    }
                    else -> "$message Se repetir a mesma ação, o pedido sai com a mesma chave."
                }
            } catch (e: Exception) {
                // Sem resposta (timeout, rede): a chave fica guardada para a repetição do mesmo pedido.
                notice = container.handleError(e) + " Se repetir a mesma ação, o pedido sai com a mesma chave."
            } finally {
                busy = false
            }
        }
    }

    /** 4xx que não é timeout nem limite de taxa: o servidor decidiu e repetir com a mesma chave não ajuda. */
    private fun isDefinitive(e: ApiException): Boolean = e.status in 400..499 && e.status != 408 && e.status != 429

    fun claim() = act(ActionRequest(action = "claim"), "Conversa assumida.")
    fun transfer(target: String) = act(ActionRequest(action = "transfer", target = target), "Conversa transferida.")
    fun resolve() = act(ActionRequest(action = "resolve"), "Conversa concluída.")
    fun saveTags(tags: List<String>) = act(ActionRequest(action = "tags", tags = tags.map { it.trim().take(40) }.filter { it.isNotEmpty() }.distinct().take(20)), "Etiquetas salvas.")

    /**
     * Nota interna com o texto do composer (permitida mesmo sem ter assumido a conversa). O texto permanece no composer
     * em falha de rede; tocar de novo com o mesmo texto repete o pedido com a mesma Idempotency-Key (ver [act]).
     */
    fun sendNote() {
        val value = text.trim()
        if (value.isEmpty()) {
            composerError = "Escreva o texto da nota interna."
            return
        }
        if (value.length > MediaKinds.MAX_TEXT) {
            composerError = "A nota pode ter até 3.800 caracteres."
            return
        }
        composerError = null
        act(ActionRequest(action = "note", text = value), "Nota interna registrada.") { text = "" }
    }

    // --- ações por mensagem (POST /message-actions) ---

    fun messageAction(action: String, message: Message, emoji: String? = null) {
        if (busy || !canReply) return
        val request = MessageActionRequest(action = action, message_id = message.id, emoji = emoji)
        val key = pendingMessageAction?.takeIf { it.first == request }?.second
            ?: ApiClient.newIdempotencyKey().also { pendingMessageAction = request to it }
        viewModelScope.launch {
            busy = true
            try {
                container.api.messageAction(profileId, conversationId, key, request)
                pendingMessageAction = null
                load(silent = true).join()
                notice = when (action) {
                    "reaction" -> if (emoji.isNullOrEmpty()) "Reação removida." else "Reação enviada."
                    "delete" -> "Pedido de exclusão enviado ao WhatsApp."
                    "read" -> "Mensagem marcada como lida."
                    else -> null
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                revokeIfDenied(e)
                val message = container.handleError(e)
                if (e.isIdempotencyConflict || isDefinitive(e)) pendingMessageAction = null
                notice = if (pendingMessageAction != null) "$message Se repetir a mesma ação, o pedido sai com a mesma chave." else message
            } catch (e: Exception) {
                notice = container.handleError(e) + " Se repetir a mesma ação, o pedido sai com a mesma chave."
            } finally {
                busy = false
            }
        }
    }

    fun startEdit(message: Message) {
        editing = message
        quote = null
        text = message.text
        composerError = null
    }

    fun cancelEdit() {
        editing = null
        text = ""
    }

    // --- composer ---

    fun addAttachments(items: List<PendingAttachment>) {
        if (items.isEmpty()) return
        voice?.let { discardVoiceFile(it) }
        voice = null
        val merged = (attachments + items)
        attachments = merged.take(MediaKinds.MAX_ATTACHMENTS)
        composerError = if (merged.size > MediaKinds.MAX_ATTACHMENTS) "Use até 10 anexos por mensagem." else null
        if (kind == ComposeKind.Location || kind == ComposeKind.Contacts) kind = ComposeKind.Auto
    }

    fun removeAttachment(key: String) {
        attachments = attachments.filterNot { it.key == key }
    }

    fun attachVoice(recording: PendingAttachment?) {
        voice?.let { if (it.key != recording?.key) discardVoiceFile(it) }
        voice = recording
        if (recording != null) {
            attachments = emptyList()
            kind = ComposeKind.Auto
        }
    }

    fun clearVoice() = attachVoice(null)

    fun addMention(member: GroupMember) {
        if (mentions.none { it.id == member.id } && mentions.size < 30) mentions = mentions + member
    }

    fun removeMention(id: String) {
        mentions = mentions.filterNot { it.id == id }
    }

    fun clearMentions() {
        mentions = emptyList()
    }

    val canSend: Boolean
        get() = canReply && !sending && (
            pending != null || editing != null && text.isNotBlank() || text.isNotBlank() || attachments.isNotEmpty() || voice != null ||
                kind == ComposeKind.Location || kind == ComposeKind.Contacts
            )

    /** Envia (ou repete o pedido pendente com a mesma Idempotency-Key). */
    fun send() {
        if (sending || !canReply) return
        val current = detail ?: return
        viewModelScope.launch {
            sending = true
            composerError = null
            try {
                val edit = editing
                if (edit != null) {
                    val value = text.trim()
                    if (value.isEmpty()) {
                        composerError = "Escreva o novo texto da mensagem."
                        return@launch
                    }
                    if (value.length > MediaKinds.MAX_TEXT) {
                        composerError = "O texto pode ter até 3.800 caracteres."
                        return@launch
                    }
                    container.api.messageAction(
                        profileId, conversationId, editKey,
                        MessageActionRequest(action = "edit", message_id = edit.id, text = value),
                    )
                    editKey = ApiClient.newIdempotencyKey()
                    editing = null
                    text = ""
                    notice = "Edição enviada ao WhatsApp."
                } else {
                    var request = pending
                    if (request == null) {
                        val built = buildRequest(current) ?: return@launch
                        request = PendingSend(sendKey, built)
                        pending = request
                    }
                    progress = "Confirmando envio…"
                    progressPercent = null
                    container.api.act(profileId, conversationId, request.key, request.request)
                    pending = null
                    sendKey = ApiClient.newIdempotencyKey()
                    clearComposer()
                }
                load(silent = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                revokeIfDenied(e)
                val message = container.handleError(e)
                when {
                    e.isIdempotencyConflict -> {
                        sendKey = ApiClient.newIdempotencyKey()
                        pending = pending?.copy(key = sendKey)
                        composerError = "$message Uma nova chave foi gerada; confira as entregas e toque em Tentar novamente se a mensagem não saiu."
                    }
                    e.status in 400..499 && e.status != 408 && e.status != 429 -> {
                        // Pedido recusado pelo servidor: não há o que repetir com a mesma chave. O rascunho permanece.
                        pending = null
                        sendKey = ApiClient.newIdempotencyKey()
                        composerError = message
                    }
                    else -> composerError = if (pending != null) "$message O pedido ficou guardado: toque em Tentar novamente." else message
                }
            } catch (e: Exception) {
                val message = container.handleError(e)
                composerError = if (pending != null) "$message O pedido ficou guardado: toque em Tentar novamente." else message
            } finally {
                sending = false
                progress = null
                progressPercent = null
            }
        }
    }

    /** Abandona o pedido guardado (confira Entregas antes de reenviar). O rascunho permanece. */
    fun abandonPending() {
        pending = null
        sendKey = ApiClient.newIdempotencyKey()
        composerError = "Pedido abandonado. Confira as entregas antes de enviar de novo para evitar duplicidade."
    }

    private fun fail(message: String): ActionRequest? {
        composerError = message
        return null
    }

    /** Valida o rascunho, sobe os anexos (com progresso) e monta o corpo de `action: reply`. */
    private suspend fun buildRequest(current: ConversationDetail): ActionRequest? {
        val value = text.trim()
        if (value.length > MediaKinds.MAX_TEXT) return fail("O texto pode ter até 3.800 caracteres.")
        val voiceItem = voice
        val files = if (voiceItem != null) listOf(voiceItem) else attachments
        if (files.size > MediaKinds.MAX_ATTACHMENTS) return fail("Use até 10 anexos por mensagem.")
        if (value.isEmpty() && files.isEmpty() && kind != ComposeKind.Location && kind != ComposeKind.Contacts) {
            return fail("Escreva uma mensagem ou escolha um conteúdo.")
        }
        val meta = if (files.isEmpty()) false else isMetaChannel(current)

        var contentType = when {
            voiceItem != null -> voiceItem.contentType ?: "voice"
            kind == ComposeKind.Document -> "document"
            kind == ComposeKind.Location -> "location"
            kind == ComposeKind.Contacts -> "contacts"
            else -> "text"
        }
        if (contentType == "voice" && !current.can("voice")) {
            if (current.can("audio")) contentType = "audio" else return fail("O canal não oferece mensagem de voz nesta conversa.")
        }
        for (file in files) {
            val fileKind = when {
                voiceItem != null -> contentType
                kind == ComposeKind.Document -> "document"
                else -> MediaKinds.kindOf(file.mime)
            }
            if (!current.can(fileKind)) {
                return fail("O canal não oferece envio de ${MediaKinds.label(fileKind)} nesta conversa.${if (fileKind != "document" && current.can("document")) " Tente \"Enviar como documento\"." else ""}")
            }
            MediaKinds.checkLimit(fileKind, file.mime, file.size, meta)?.let { return fail(it) }
        }
        if (kind == ComposeKind.Location) {
            if (!current.can("location")) return fail("O canal não oferece envio de localização nesta conversa.")
            val lat = location.latitude.trim().replace(',', '.').toDoubleOrNull()
            val lng = location.longitude.trim().replace(',', '.').toDoubleOrNull()
            if (lat == null || lng == null || lat !in -90.0..90.0 || lng !in -180.0..180.0) return fail("Informe latitude (-90 a 90) e longitude (-180 a 180) válidas.")
            if (location.name.length > 200 || location.address.length > 500) return fail("Nome do local (até 200) ou endereço (até 500) muito longo.")
        }
        if (kind == ComposeKind.Contacts) {
            if (!current.can("contacts")) return fail("O canal não oferece cartão de contato nesta conversa.")
            val phone = contact.phone.trim()
            if (contact.name.trim().isEmpty() || contact.name.length > 100 || !Regex("^\\+?\\d{8,16}$").matches(phone)) {
                return fail("Informe nome (até 100) e telefone completo com DDI, só dígitos (ex.: 5511999990000).")
            }
        }
        if (quote != null && !current.can("reply")) return fail("O canal não oferece resposta com citação nesta conversa.")
        if (mentions.isNotEmpty() && !current.can("mentions")) return fail("O canal não oferece menções nesta conversa.")

        val ids = ArrayList<String>()
        for (file in files) {
            val existing = file.uploadedId
            if (existing != null) {
                ids += existing
                continue
            }
            progress = "Enviando ${file.name}: 0%"
            progressPercent = 0
            val id = uploader.upload(profileId, file.item) { pct ->
                progress = "Enviando ${file.name}: $pct%"
                progressPercent = pct
            }
            markUploaded(file, id)
            ids += id
        }

        val lat = location.latitude.trim().replace(',', '.').toDoubleOrNull()
        val lng = location.longitude.trim().replace(',', '.').toDoubleOrNull()
        val quoted = quote
        val mentionIds = mentions.map { it.id }
        val content = buildJsonObject {
            put("type", contentType)
            if (quoted != null) put("reply_to", quoted.id)
            if (mentionIds.isNotEmpty()) putJsonArray("mentions") { mentionIds.forEach { add(it) } }
            if (kind == ComposeKind.Location && lat != null && lng != null) {
                putJsonObject("location") {
                    put("latitude", lat)
                    put("longitude", lng)
                    put("name", location.name.trim())
                    put("address", location.address.trim())
                }
            }
            if (kind == ComposeKind.Contacts) {
                putJsonArray("contacts") {
                    addJsonObject {
                        put("name", contact.name.trim())
                        put("phone", contact.phone.trim())
                    }
                }
            }
        }
        return ActionRequest(action = "reply", text = value, attachments = ids, content = content)
    }

    /**
     * O servidor só aplica os limites/formatos da Meta quando a conexão é `kind == "meta"` (validateMedia em
     * src/whatsapp.ts). Usa o `kind` da conexão da conversa via GET /profiles/{p}/status (uma consulta por ViewModel);
     * se não der para descobrir (rede, conversa sem connection_id), cai na heurística [isMetaLike].
     */
    private suspend fun isMetaChannel(current: ConversationDetail): Boolean {
        val connectionId = current.conversation.connection_id?.takeIf { it.isNotBlank() } ?: return current.isMetaLike()
        val kinds = connectionKinds ?: try {
            container.api.profileStatus(profileId).connections.associate { it.id to it.kind }.also { connectionKinds = it }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiException && e.isUnauthorized) container.handleError(e)
            null
        }
        val kind = kinds?.get(connectionId) ?: return current.isMetaLike()
        return kind == "meta"
    }

    private fun markUploaded(file: PendingAttachment, id: String) {
        if (voice?.key == file.key) voice = voice?.copy(uploadedId = id)
        attachments = attachments.map { if (it.key == file.key) it.copy(uploadedId = id) else it }
    }

    private fun clearComposer() {
        text = ""
        attachments = emptyList()
        voice?.let { discardVoiceFile(it) }
        voice = null
        quote = null
        kind = ComposeKind.Auto
        location = LocationDraft()
        contact = ContactDraft()
        mentions = emptyList()
    }

    private fun discardVoiceFile(recording: PendingAttachment) {
        (recording.item.source as? UploadSource.FileSource)?.file?.delete()
    }
}

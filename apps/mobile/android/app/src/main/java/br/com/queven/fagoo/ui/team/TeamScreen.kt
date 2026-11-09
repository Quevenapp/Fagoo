package br.com.queven.fagoo.ui.team

import androidx.compose.foundation.clickable
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.fagoo.core.PrivateReadGate
import br.com.queven.fagoo.core.media.AuthenticatedMedia
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.ui.conversations.handleError
import br.com.queven.fagoo.core.model.*
import br.com.queven.fagoo.core.net.ApiClient
import br.com.queven.fagoo.core.net.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class TeamViewModel(private val container: AppContainer, private val profile: String) : ViewModel() {
    var contacts by mutableStateOf<List<TeamContact>>(emptyList()); private set
    var history by mutableStateOf<List<InternalChat>>(emptyList()); private set
    var peer by mutableStateOf<TeamContact?>(null); private set
    var chat by mutableStateOf<InternalChat?>(null); private set
    var draft by mutableStateOf("")
    var error by mutableStateOf<String?>(null); private set
    var busy by mutableStateOf(false); private set
    var loading by mutableStateOf(true); private set
    var pending by mutableStateOf<Pair<String, String>?>(null); private set
    private var openKey = ApiClient.newIdempotencyKey()
    private val reads = Mutex()
    private val readGate = PrivateReadGate()
    var authorized by mutableStateOf(false); private set
    fun pauseActions() { readGate.invalidate(); authorized = false }
    val canSend: Boolean get() = PrivateReadGate.canAct(authorized, container.context?.units?.find { it.id == profile }?.capabilities ?: emptyList(), "team.chat")
    private fun revokePrivate() {
        readGate.invalidate(); authorized = false; contacts = emptyList(); history = emptyList()
        peer = null; chat = null; draft = ""; pending = null
        AuthenticatedMedia.clear()
    }

    suspend fun refresh() = reads.withLock {
        val read = readGate.begin()
        try {
            if (peer == null) {
                val people = container.api.team(profile).data.sortedWith(compareByDescending<TeamContact> { it.online }.thenBy { it.name.lowercase() })
                val chats = container.api.internalChats(profile).data
                if (readGate.current(read)) { contacts = people; history = chats }
            } else refreshChat(read)
            if (readGate.current(read)) { authorized = true; if (pending == null) error = null }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (readGate.current(read)) {
                authorized = false
                if (readGate.revoked(read, (e as? ApiException)?.status)) revokePrivate()
                error = container.handleError(e)
            }
        } finally { loading = false }
    }
    fun open(contact: TeamContact) {
        if (busy || pending != null || !canSend) return
        readGate.invalidate(); authorized = false
        peer = contact; chat = null; draft = ""; error = null; openKey = ApiClient.newIdempotencyKey()
        viewModelScope.launch { refresh() }
    }
    fun openExisting(saved: InternalChat) {
        if (busy || pending != null || !canSend) return
        readGate.invalidate(); authorized = false
        peer = saved.peer ?: return; chat = saved.copy(messages = emptyList()); draft = ""; error = null
        viewModelScope.launch { refresh() }
    }
    fun back(): Boolean {
        if (peer == null) return false
        if (busy || pending != null) { error = "Confirme o envio pendente antes de sair desta conversa."; return true }
        readGate.invalidate(); authorized = false
        peer = null; chat = null; draft = ""; error = null
        return true
    }
    fun discardAttempt() { if (!busy) { pending = null; draft = ""; error = null } }
    private suspend fun refreshChat(read: Long) {
        val contact = peer ?: return
        val opened = chat ?: container.api.openInternalChat(profile, openKey, buildJsonObject { put("peer_id", contact.id) })
        if (!readGate.current(read) || peer?.id != contact.id) return
        val result = container.api.internalChat(profile, opened.id)
        if (readGate.current(read) && peer?.id == contact.id) chat = result
    }
    fun send() {
        val id = chat?.id ?: return
        if (busy || !canSend) return
        val request = pending ?: (draft.trim() to ApiClient.newIdempotencyKey())
        if (request.first.isEmpty()) return
        pending = request; busy = true
        viewModelScope.launch {
            try {
                container.api.sendInternal(profile, id, request.second, buildJsonObject { put("text", request.first) })
                pending = null; draft = ""; error = null; refresh()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                authorized = false
                if (e is ApiException && e.status in listOf(401,403,404)) revokePrivate()
                error = container.handleError(e)
                if (e is ApiException && e.status in 400..499 && e.status !in listOf(408, 429) && e.code !in listOf("operation_unknown", "idempotency_conflict")) pending = null
            } finally { busy = false }
        }
    }
}

@Composable
fun TeamContactItem(contact: TeamContact, modifier: Modifier = Modifier) {
    ListItem(
        headlineContent = { Text(contact.name) },
        supportingContent = { Text((if (contact.kind == "bot") "Bot" else "Pessoa") + " · " + if (contact.online) "Online" else "Offline") },
        leadingContent = { Icon(if (contact.kind == "bot") Icons.Default.SmartToy else Icons.Default.Person, contentDescription = null, tint = if (contact.online) Color(0xFF138A48) else MaterialTheme.colorScheme.outline) },
        modifier = modifier,
    )
}

@Composable
fun TeamScreen(container: AppContainer, onBack: () -> Unit) {
    val profile = container.session.profileId ?: return
    val vm: TeamViewModel = viewModel(key = "team:$profile") { TeamViewModel(container, profile) }
    var confirmDiscard by remember { mutableStateOf(false) }
    BackHandler(vm.peer != null) { vm.back() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, profile) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { vm.pauseActions(); try { while (true) { vm.refresh(); delay(2000) } } finally { vm.pauseActions() } } }
    val list = rememberLazyListState()
    LaunchedEffect(vm.chat?.messages?.lastOrNull()?.id) { val size = vm.chat?.messages?.size ?: 0; if (size > 0) list.animateScrollToItem(size - 1) }
    if (confirmDiscard) AlertDialog(onDismissRequest = { confirmDiscard = false }, title = { Text("Parar de tentar este envio?") }, text = { Text("Isso não apaga uma mensagem que já tenha sido enviada. Confira o histórico antes de escrever a mesma mensagem novamente.") }, confirmButton = { TextButton(onClick = { confirmDiscard = false; vm.discardAttempt() }) { Text("Descartar tentativa") } }, dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Continuar tentando") } })
    Scaffold(topBar = { TopAppBar(title = { Text(vm.peer?.name ?: "Equipe") }, navigationIcon = { IconButton(onClick = { if (!vm.back()) onBack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Voltar") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Text(if (vm.peer == null) "Pessoas e bots da unidade. Converse internamente pelo Fagoo." else "Conversa interna · nenhuma mensagem vai ao WhatsApp", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
            if (vm.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (vm.peer == null) {
                LazyColumn {
                    if (vm.history.isNotEmpty()) item { Text("Conversas internas", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(16.dp)) }
                    items(vm.history, key = { "chat:" + it.id }) { chat -> chat.peer?.let { TeamContactItem(it, Modifier.clickable(enabled = vm.canSend) { vm.openExisting(chat) }) } }
                    item { Text("Iniciar conversa", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(16.dp)) }
                    items(vm.contacts.filter { it.id != container.session.user?.id }, key = { "person:" + it.id }) { contact -> TeamContactItem(contact, Modifier.clickable(enabled = vm.canSend) { vm.open(contact) }) }
                }
            } else {
                LazyColumn(state = list, modifier = Modifier.weight(1f), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(vm.chat?.messages ?: emptyList(), key = { it.id }) { message ->
                        Surface(color = if (message.author == container.session.user?.id) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium) {
                            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                                Text(if (message.author == container.session.user?.id) "Você" else vm.peer?.name ?: "Equipe", style = MaterialTheme.typography.labelSmall)
                                Text(message.text)
                                message.status?.takeIf { it !in listOf("sent", "completed") }?.let { Text(when (it) { "queued", "pending", "running" -> "Aguardando resposta"; "failed" -> "Falha na resposta"; else -> "Sem confirmação" }, style = MaterialTheme.typography.labelSmall) }
                            }
                        }
                    }
                }
                if (vm.pending != null && !vm.busy) {
                    Text("Envio sem confirmação. Toque em enviar para repetir o mesmo pedido.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
                    TextButton(onClick = { confirmDiscard = true }) { Text("Parar de tentar") }
                }
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(vm.draft, { vm.draft = it }, modifier = Modifier.weight(1f), label = { Text("Mensagem interna") }, maxLines = 5, enabled = vm.canSend && !vm.busy && vm.pending == null)
                    IconButton(onClick = vm::send, enabled = vm.canSend && !vm.busy && vm.chat != null && (vm.pending != null || vm.draft.isNotBlank())) { if (vm.busy) CircularProgressIndicator(Modifier.size(24.dp)) else Icon(Icons.AutoMirrored.Filled.Send, "Enviar") }
                }
            }
        }
    }
}

package br.com.queven.fagoo.ui.conversations

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.fagoo.core.net.ApiException
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.Conversation
import br.com.queven.fagoo.core.model.Event
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Filtros em chips da aba Conversas (mobile/README.md). "Minhas" = state=human filtrado por owner == eu. */
enum class ConversationFilter(val label: String, val state: String?) {
    Queue("Fila", "waiting"),
    Mine("Minhas", "human"),
}

class ConversationsViewModel(private val container: AppContainer) : ViewModel() {
    val profileId: String get() = container.session.profileId ?: ""
    val meId: String? get() = container.session.user?.id

    var filter by mutableStateOf(ConversationFilter.Mine)
        private set
    var query by mutableStateOf("")
    var appliedQuery by mutableStateOf("")
        private set
    var items by mutableStateOf<List<Conversation>>(emptyList())
        private set
    var nextCursor by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var names by mutableStateOf<Map<String, String>>(emptyMap())
        private set

    private var loadJob: Job? = null
    private var generation = 0

    fun selectFilter(value: ConversationFilter) {
        if (filter == value) return
        filter = value
        load(reset = true, keepCount = false)
    }

    /** Aplica a busca digitada (a tela faz o debounce). */
    fun applyQuery() {
        if (appliedQuery == query) return
        appliedQuery = query
        load(reset = true, keepCount = false)
    }

    fun refresh() {
        refreshing = true
        load(reset = true, keepCount = false)
    }

    /** Recarga sem indicador (eventos, volta ao primeiro plano), preservando a quantidade já carregada. */
    fun reloadSilently() = load(reset = true, keepCount = true)

    fun loadMore() {
        if (nextCursor == null || loadingMore || loading || refreshing) return
        load(reset = false, keepCount = false)
    }

    fun dismissError() { error = null }

    private fun load(reset: Boolean, keepCount: Boolean): Job {
        val gen = ++generation
        loadJob?.cancel()
        val target = if (reset && keepCount) items.size else 0
        val state = filter.state
        val mine = filter == ConversationFilter.Mine
        val q = appliedQuery.trim().ifBlank { null }
        val me = meId
        loadJob = viewModelScope.launch {
            if (reset) loading = items.isEmpty() else loadingMore = true
            try {
                val collected = if (reset) ArrayList<Conversation>() else ArrayList(items)
                var cursor: String? = if (reset) null else nextCursor
                var pages = 0
                do {
                    val page = container.api.conversations(profileId, state = state, q = q, cursor = cursor, limit = 50)
                    collected += if (mine) page.data.filter { it.owner == me } else page.data
                    cursor = page.next_cursor
                    pages++
                    val wantMore = cursor != null && pages < 6 && (collected.size < target || (mine && collected.size < 20))
                } while (wantMore)
                if (gen != generation) return@launch
                items = collected.distinctBy { it.id }
                nextCursor = cursor
                error = null
                loaded = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (gen == generation) {
                    error = container.handleError(e)
                    if (e is ApiException && e.status in listOf(401,403,404)) { items = emptyList(); names = emptyMap(); nextCursor = null }
                }
            } finally {
                if (gen == generation) {
                    loading = false
                    refreshing = false
                    loadingMore = false
                }
            }
        }
        return requireNotNull(loadJob)
    }

    fun loadPresence() {
        viewModelScope.launch {
            try {
                names = container.api.presence(profileId).associate { it.actor to it.name }
            } catch (_: Exception) {
                // nomes são apenas decorativos na lista
            }
        }
    }

    fun onEvents(events: List<Event>) {
        if (events.any { it.kind.startsWith("conversation.") || it.kind.startsWith("message.") }) reloadSilently()
    }
}

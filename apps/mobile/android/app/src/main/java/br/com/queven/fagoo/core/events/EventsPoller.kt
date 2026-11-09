package br.com.queven.fagoo.core.events

import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.Event
import br.com.queven.fagoo.core.net.ApiClient
import br.com.queven.fagoo.core.net.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import java.io.IOException

/**
 * Consulta GET /v1/communication/units/{p}/events?after=cursor a cada [intervalMs] (padrão 4 s) enquanto o
 * Flow devolvido por [events] estiver sendo coletado, e emite cada [Event] novo. O cursor é persistido
 * por perfil em [br.com.queven.fagoo.core.SessionStore.setEventCursor], então reabrir a tela continua
 * de onde parou.
 *
 * Uso típico em uma tela:
 * ```
 * val poller = remember(profileId) { EventsPoller(container, profileId) }
 * LaunchedEffect(poller) {
 *     poller.events().collect { e -> if (e.kind in EventsPoller.CONVERSATION_KINDS) reload() }
 * }
 * ```
 * Coletar com `repeatOnLifecycle(STARTED)` (ou `collectAsStateWithLifecycle`) pausa a consulta quando a tela some.
 *
 * Erros de rede não interrompem o Flow: ficam em [lastError] (texto amigável) e a próxima rodada tenta de novo.
 * Um 401 encerra a sessão (`container.onLoggedOut(keepServer = true)`) e completa o Flow.
 */
class EventsPoller(
    private val container: AppContainer,
    val profileId: String,
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
    /** Na primeira execução (cursor 0) avança até o fim sem emitir histórico antigo. */
    private val skipBacklog: Boolean = true,
) {
    private val _lastError = MutableStateFlow<String?>(null)

    /** Última falha de rede/API (null quando a última consulta deu certo). */
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /** Cursor atual (id do último evento visto). */
    @Volatile
    var cursor: Long = container.session.eventCursor(profileId)
        private set

    /** Flow frio: cada coleta inicia o ciclo de consultas; cancelar a coleta para o ciclo. */
    fun events(): Flow<Event> = flow {
        var after = cursor
        if (after == 0L && skipBacklog) {
            after = fastForward()
            persist(after)
        }
        while (currentCoroutineContext().isActive) {
            var batch: List<Event> = emptyList()
            var stop = false
            try {
                val page = container.api.events(profileId, after)
                // Eventos chegam em ordem de id; o servidor pode omitir alguns (visibilidade), por isso usamos page.cursor.
                batch = page.data.filter { it.id > after }
                val next = maxOf(page.cursor, batch.maxOfOrNull { it.id } ?: 0L)
                if (next > after) {
                    after = next
                    persist(after)
                }
                _lastError.value = null
            } catch (e: ApiException) {
                if (e.isUnauthorized) {
                    container.onLoggedOut(keepServer = true)
                    stop = true
                }
                _lastError.value = ApiClient.describe(e)
            } catch (e: IOException) {
                _lastError.value = ApiClient.describe(e)
            } catch (_: IllegalStateException) {
                // Servidor não configurado (sessão encerrada): não há o que consultar.
                stop = true
            } catch (e: Exception) {
                _lastError.value = ApiClient.describe(e)
            }
            // emit fora do try: exceções do coletor não podem ser engolidas (transparência do Flow).
            for (event in batch) emit(event)
            if (stop) break
            delay(intervalMs)
        }
    }.flowOn(Dispatchers.IO)

    /** Avança o cursor até o último evento disponível sem emitir nada (até [MAX_FAST_FORWARD_PAGES] páginas). */
    private suspend fun fastForward(): Long {
        var after = 0L
        repeat(MAX_FAST_FORWARD_PAGES) {
            val page = try {
                container.api.events(profileId, after)
            } catch (_: Exception) {
                return after
            }
            val next = maxOf(page.cursor, page.data.maxOfOrNull { it.id } ?: 0L)
            if (next <= after) return after
            after = next
            if (page.data.size < PAGE_SIZE) return after
        }
        return after
    }

    private fun persist(value: Long) {
        if (value > cursor) {
            cursor = value
            container.session.setEventCursor(profileId, value)
        }
    }

    companion object {
        const val DEFAULT_INTERVAL_MS = 4_000L
        private const val PAGE_SIZE = 100
        private const val MAX_FAST_FORWARD_PAGES = 20

        /** Eventos que mudam a lista de conversas ou a conversa aberta. */
        val CONVERSATION_KINDS = setOf(
            "message.received", "message.sent", "message.updated",
            "conversation.created", "conversation.updated",
        )
        val TICKET_KINDS = setOf("ticket.created", "ticket.updated", "ticket.closed")
        val CALL_KINDS = setOf("call.updated")

        /** True para eventos de protocolo (`ticket.*`). */
        fun isTicketEvent(e: Event) = e.kind.startsWith("ticket.")
    }
}

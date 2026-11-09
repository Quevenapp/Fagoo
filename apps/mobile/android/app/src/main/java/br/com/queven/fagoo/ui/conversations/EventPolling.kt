package br.com.queven.fagoo.ui.conversations

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.Event
import br.com.queven.fagoo.core.net.ApiException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.io.IOException

/**
 * Consulta GET /profiles/{p}/events?after=cursor a cada [intervalMs] enquanto a tela está visível
 * (STARTED). [onStart] roda sempre que a tela volta ao primeiro plano (recarga completa) e
 * [onEvents] recebe os eventos novos de cada ciclo. O cursor é persistido por perfil em SessionStore.
 */
@Composable
internal fun EventPolling(
    container: AppContainer,
    profileId: String,
    intervalMs: Long = 4_000,
    onStart: suspend () -> Unit,
    onEvents: suspend (List<Event>) -> Unit,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(profileId, lifecycle) {
        if (profileId.isBlank()) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            onStart()
            while (isActive) {
                delay(intervalMs)
                val events = pollEvents(container, profileId) ?: continue
                if (events.isNotEmpty()) onEvents(events)
            }
        }
    }
}

/**
 * Busca eventos após o cursor salvo. Na primeira consulta de um perfil (cursor 0) apenas avança o cursor,
 * sem repetir o histórico: a tela já recarregou tudo em [EventPolling.onStart]. Devolve null em falha de rede.
 */
internal suspend fun pollEvents(container: AppContainer, profileId: String): List<Event>? {
    val session = container.session
    var cursor = session.eventCursor(profileId)
    var skipFirst = cursor == 0L
    val collected = ArrayList<Event>()
    repeat(5) {
        val result = try {
            container.api.events(profileId, cursor)
        } catch (e: ApiException) {
            if (e.isUnauthorized) container.onLoggedOut(keepServer = true)
            return null
        } catch (e: IOException) {
            return null
        } catch (e: IllegalStateException) {
            // servidor não configurado (sessão encerrada no meio do ciclo)
            return null
        }
        if (result.cursor > cursor) {
            cursor = result.cursor
            session.setEventCursor(profileId, cursor)
        }
        if (!skipFirst) collected += result.data
        skipFirst = false
        // O servidor devolve no máximo 100 por chamada; menos que isso significa que alcançamos o fim.
        if (result.data.size < 100) return collected
    }
    return collected
}

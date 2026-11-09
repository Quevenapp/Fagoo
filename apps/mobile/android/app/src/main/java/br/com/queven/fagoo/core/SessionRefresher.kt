package br.com.queven.fagoo.core

import br.com.queven.fagoo.core.net.ApiException
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

object SessionRefresher {
    const val THRESHOLD_MS = 60_000L
    private val mutex = Mutex()
    fun shouldRefresh(session: SessionStore, now: Long = System.currentTimeMillis()) = session.tokenExpires - now < THRESHOLD_MS
    fun remainingMs(session: SessionStore, now: Long = System.currentTimeMillis()): Long? = session.tokenExpires.takeIf { it > 0 }?.minus(now)
    suspend fun refreshIfNeeded(container: AppContainer, force: Boolean = false): Boolean = mutex.withLock {
        if (container.session.mode != "human" || (!force && !shouldRefresh(container.session))) return@withLock false
        val generation = container.generation
        try {
            val credentials = FagooAuth.refresh(container.discovery, container.session.refreshToken ?: error("Sessão expirada"))
            check(container.generation == generation && container.session.mode == "human") { "Sessão alterada" }
            container.saveCredentials(credentials)
            container.refreshAuthState()
            true
        } catch (e: ApiException) {
            if (e.status in listOf(400, 401, 403)) container.onLoggedOut(true)
            throw e
        }
    }
    fun refreshInBackground(container: AppContainer) { container.scope.launch { runCatching { refreshIfNeeded(container) } } }
}

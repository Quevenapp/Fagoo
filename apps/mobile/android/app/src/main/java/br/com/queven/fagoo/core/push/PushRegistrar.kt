package br.com.queven.fagoo.core.push

import android.os.Build
import br.com.queven.fagoo.BuildConfig
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.model.DeviceRegistration
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

object PushRegistrar {
    fun registerIfNeeded(container: AppContainer, force: Boolean = false) { container.scope.launch { runCatching { register(container, force) } } }
    suspend fun register(container: AppContainer, force: Boolean = false): Boolean {
        if (!container.auth.value.isLoggedIn) return false
        val unit = container.session.profileId ?: return false
        val generation = container.generation
        val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull() ?: return false
        if (generation != container.generation || !container.auth.value.isLoggedIn) return false
        if (!force && token == container.session.registeredPushToken) return true
        container.api.registerDevice(unit, container.session.deviceId, DeviceRegistration(platform="android", provider="fcm", token=token, name="${Build.MANUFACTURER} ${Build.MODEL}".take(80), app_version=BuildConfig.VERSION_NAME, profiles=listOf(unit), enabled=container.session.notificationsEnabled))
        if (generation == container.generation) { container.session.pushToken=token; container.session.registeredPushToken=token }
        return true
    }
    /** Required before a deliberate mode/account switch. Server failure keeps the switch pending. */
    suspend fun unregister(container: AppContainer) {
        if (container.session.registeredPushToken != null) container.api.deleteDevice(container.session.profileId ?: error("Unidade ausente"), container.session.deviceId)
        runCatching { FirebaseMessaging.getInstance().deleteToken().await() }
        container.session.registeredPushToken = null; container.session.pushToken = null
    }
}
object IncomingCallBus {
    private val _calls = MutableSharedFlow<Map<String, String>>(extraBufferCapacity=1)
    val calls = _calls.asSharedFlow()
}

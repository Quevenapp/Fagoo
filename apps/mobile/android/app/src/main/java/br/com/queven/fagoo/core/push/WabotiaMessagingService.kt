package br.com.queven.fagoo.core.push

import br.com.queven.fagoo.FagooApp
import br.com.queven.fagoo.core.SessionRefresher
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

class FagooMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val container = FagooApp.instance.containerOrNull ?: return
        if(container.session.mode == "human") { container.session.registeredPushToken=null; PushRegistrar.registerIfNeeded(container, true) }
    }
    override fun onMessageReceived(message: RemoteMessage) {
        val c = FagooApp.instance.containerOrNull ?: return
        val data = message.data
        if(c.session.mode != "human" || !c.session.notificationsEnabled || data["server"] != c.session.serverUrl || data["user_id"] != c.session.user?.id || data["unit_id"] != c.session.profileId) return
        val generation = c.generation
        c.scope.launch {
            runCatching {
                c.validateOnline()
                if(generation != c.generation || !c.auth.value.isLoggedIn) return@runCatching
                val unit=c.session.profileId ?: return@runCatching
                val allowed = when(data["type"]) {
                    "internal" -> { c.api.internalChat(unit, data["chat_id"] ?: return@runCatching); true }
                    "queue" -> c.api.queue(unit)["data"]?.jsonArray?.any { it.jsonObject["id"]?.jsonPrimitive?.content == data["conversation_id"] } == true
                    "message", "transfer" -> { c.api.conversation(unit, data["conversation_id"] ?: return@runCatching); true }
                    else -> false
                }
                if(allowed && generation == c.generation && c.auth.value.isLoggedIn) Notifications.show(applicationContext,"Fagoo","Novo aviso de atendimento",data)
            }
        }
    }
}

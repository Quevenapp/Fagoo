package br.com.queven.fagoo

import android.app.Application
import br.com.queven.fagoo.core.AppContainer
import br.com.queven.fagoo.core.push.Notifications

class FagooApp : Application() {
    var containerOrNull: AppContainer? = null; private set
    val container: AppContainer get() = containerOrNull ?: error("Armazenamento seguro indisponível")
    override fun onCreate() {
        super.onCreate(); instance = this
        containerOrNull = runCatching { AppContainer(this) }.getOrNull()
        Notifications.ensureChannels(this)
    }
    companion object { lateinit var instance: FagooApp; private set }
}

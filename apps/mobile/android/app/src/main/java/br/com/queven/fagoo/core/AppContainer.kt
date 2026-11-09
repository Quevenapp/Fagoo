package br.com.queven.fagoo.core

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import br.com.queven.fagoo.core.model.User
import br.com.queven.fagoo.core.model.FagooJson
import br.com.queven.fagoo.core.net.ApiClient
import br.com.queven.fagoo.core.net.FagooApi
import br.com.queven.fagoo.core.media.AuthenticatedMedia
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient

class AppContainer(context: Context) {
    val appContext = context.applicationContext
    val session = SessionStore(appContext)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile var generation = 0L; private set
    @Volatile var verified = false; private set
    private val _auth = MutableStateFlow(AuthState.from(session, verified, generation))
    val auth: StateFlow<AuthState> = _auth.asStateFlow()
    private var client: ApiClient? = null
    val discovery: FagooDiscovery get() = FagooJson.decodeFromString(FagooDiscovery.serializer(), session.discovery ?: error("Instalação não configurada"))
    val context: FagooContext? get() = session.contextJson?.let { FagooJson.decodeFromString(FagooContext.serializer(), it) }
    val api: FagooApi get() = clientFor(session.serverUrl ?: error("Servidor não configurado")).api
    val okHttp: OkHttpClient get() = clientFor(session.serverUrl ?: error("Servidor não configurado")).okHttp
    fun clientFor(serverUrl: String): ApiClient {
        check(serverUrl == session.serverUrl && session.mode == "human" && verified) { "Sessão não validada online" }
        return client ?: ApiClient(serverUrl, { session.token }, { generation }, { verified && session.mode == "human" && session.tokenExpires > System.currentTimeMillis() }).also { client = it }
    }
    fun accept(result: FagooLogin) {
        clearPrivate()
        session.clearSession()
        session.webUrl = result.web
        session.discovery = FagooJson.encodeToString(FagooDiscovery.serializer(), result.discovery)
        session.serverUrl = result.discovery.api_url.trimEnd('/')
        saveCredentials(result.credentials)
        saveContext(result.context, result.credentials["user"]?.jsonObject)
        session.mode = "human"
        verified = true
        refreshAuthState()
    }
    fun saveCredentials(data: JsonObject) {
        session.token = data.text("access_token") ?: error("Sessão sem token")
        session.refreshToken = data.text("refresh_token") ?: session.refreshToken
        session.tokenExpires = System.currentTimeMillis() + ((data["expires_in"]?.jsonPrimitive?.longOrNull ?: 3600) * 1000)
    }
    fun saveContext(ctx: FagooContext, authUser: JsonObject? = null) {
        session.contextJson = FagooJson.encodeToString(FagooContext.serializer(), ctx)
        val email = authUser?.text("email") ?: session.user?.email.orEmpty()
        // A canonical administrator remains an operator on the mobile communication surface.
        session.user = User(ctx.user_id, authUser?.get("user_metadata")?.jsonObject?.text("name") ?: email, email, "operator", ctx.units.map { it.id })
        if (session.profileId !in ctx.units.map { it.id }) session.profileId = ctx.units.firstOrNull { "communication.read" in it.capabilities || "team.chat" in it.capabilities }?.id
    }
    suspend fun validateOnline() {
        if (session.mode != "human") return
        val before=generation
        SessionRefresher.refreshIfNeeded(this)
        val ctx = FagooAuth.context(discovery, session.token ?: error("Entre novamente"))
        check(before==generation && session.mode=="human") { "Sessão alterada" }
        saveContext(ctx)
        verified = true
        refreshAuthState()
    }
    fun onProfileSelected(profileId: String) {
        require(context?.units?.any { it.id == profileId } == true)
        clearPrivate()
        session.profileId = profileId
        session.registeredPushToken = null
        refreshAuthState()
    }
    fun enterPanel(deviceId: String, token: String) {
        require(token.matches(Regex("fgd_[a-f0-9]{64}")))
        val d = session.discovery; val api = session.serverUrl; val web = session.webUrl
        clearPrivate(); session.clearSession()
        session.discovery = d; session.serverUrl = api; session.webUrl = web
        session.panelDeviceId = deviceId; session.panelToken = token; session.mode = "panel"
        verified = false; refreshAuthState()
    }
    fun onLoggedOut(keepServer: Boolean) {
        val web = session.webUrl
        clearPrivate(); session.clearSession()
        if (keepServer) session.webUrl = web
        verified = false; refreshAuthState()
    }
    private fun clearPrivate() {
        generation++
        client?.okHttp?.dispatcher?.cancelAll(); client?.okHttp?.connectionPool?.evictAll(); client = null
        AuthenticatedMedia.clear()
        NotificationManagerCompat.from(appContext).cancelAll()
        appContext.getSharedPreferences("fagoo.notifications", Context.MODE_PRIVATE).edit().clear().commit()
        // All these paths are private app cache directories, never external storage.
        for (name in listOf("media", "voice", "recordings", "image_cache")) java.io.File(appContext.cacheDir, name).deleteRecursively()
    }
    fun refreshAuthState() { _auth.value = AuthState.from(session, verified, generation) }
}

data class AuthState(val serverUrl: String?, val token: String?, val user: User?, val profileId: String?, val mode: String, val verified: Boolean, val generation: Long) {
    val isLoggedIn: Boolean get() = mode == "human" && verified && !token.isNullOrBlank() && user != null
    companion object { fun from(s: SessionStore, verified: Boolean, generation: Long) = AuthState(s.serverUrl, s.token, s.user, s.profileId, s.mode, verified, generation) }
}

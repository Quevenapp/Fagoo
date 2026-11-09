package br.com.queven.fagoo.core

import br.com.queven.fagoo.core.model.FagooJson
import br.com.queven.fagoo.core.net.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable data class FagooDiscovery(val product: String, val protocol: Int, val online_required: Boolean, val api_url: String, val auth_url: String, val public_key: String)
@Serializable data class FagooUnit(val id: String, val name: String, val capabilities: List<String> = emptyList(), val team_ids: List<String> = emptyList())
@Serializable data class FagooContext(val user_id: String, val role: String, val units: List<FagooUnit> = emptyList())
data class FagooLogin(val discovery: FagooDiscovery, val web: String, val credentials: JsonObject, val context: FagooContext)
class MfaRequired(val discovery: FagooDiscovery, val web: String, val credentials: JsonObject, val factor: String, val challenge: String) : IOException("Digite o código do autenticador.")
internal fun JsonObject.text(key: String) = this[key]?.jsonPrimitive?.contentOrNull

/** Canonical Auth protocol, confirmed against @supabase/auth-js in this repository. */
object FagooAuth {
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    suspend fun json(url: String, method: String = "GET", body: JsonObject? = null, token: String? = null, publicKey: String? = null, mobile: Boolean = false): JsonObject = withContext(Dispatchers.IO) {
        require(url.startsWith("https://")) { "HTTPS obrigatório" }
        val req = Request.Builder().url(url).header("Accept", "application/json")
        token?.let { req.header("Authorization", "Bearer $it") }
        publicKey?.let { req.header("apikey", it) }
        if (mobile) req.header("X-Fagoo-Client", "mobile")
        if (method != "GET") req.method(method, (body ?: buildJsonObject {}).toString().toRequestBody("application/json".toMediaType()))
        http.newCall(req.build()).execute().use { response ->
            val source = response.body?.source() ?: throw IOException("Resposta vazia")
            source.request(1_048_577)
            if (source.buffer.size > 1_048_576) throw IOException("Resposta muito grande")
            val value = runCatching { FagooJson.parseToJsonElement(source.readUtf8()).jsonObject }.getOrNull()
            if (!response.isSuccessful) {
                val error = value?.get("error")
                val code = (error as? JsonObject)?.text("code") ?: value?.text("code") ?: (error as? JsonPrimitive)?.contentOrNull ?: "http_${response.code}"
                throw ApiException(response.code, code, (error as? JsonObject)?.text("message") ?: value?.text("msg") ?: value?.text("message") ?: "Acesso recusado ($code)")
            }
            value ?: throw IOException("Resposta inválida")
        }
    }
    suspend fun discover(input: String): Pair<String, FagooDiscovery> {
        val web = SessionStore.normalizeServer(input) ?: throw IOException("Informe somente o endereço HTTPS do Fagoo.")
        val d = FagooJson.decodeFromJsonElement(FagooDiscovery.serializer(), json("$web/fagoo-mobile.json"))
        require(d.product == "fagoo" && d.protocol == 1 && d.online_required && d.public_key.isNotBlank()) { "Instalação incompatível" }
        require(SessionStore.normalizeServer(d.api_url) == d.api_url.trimEnd('/') && SessionStore.normalizeServer(d.auth_url) == d.auth_url.trimEnd('/')) { "Endereços inválidos na descoberta" }
        val publicRole=runCatching { FagooJson.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(d.public_key.split('.')[1]))).jsonObject.text("role") }.getOrNull()
        require(d.public_key.startsWith("sb_publishable_") || publicRole=="anon") { "A descoberta deve fornecer somente a chave pública anon/publishable" }
        return web to d.copy(api_url=d.api_url.trimEnd('/'),auth_url=d.auth_url.trimEnd('/'))
    }
    suspend fun login(input: String, email: String, password: String): FagooLogin {
        val (web, d) = discover(input)
        val credentials = json("${d.auth_url.trimEnd('/')}/auth/v1/token?grant_type=password", "POST", buildJsonObject { put("email", email.trim()); put("password", password) }, publicKey = d.public_key)
        return finish(d, web, credentials)
    }
    private suspend fun finish(d: FagooDiscovery, web: String, credentials: JsonObject): FagooLogin {
        val token = credentials.text("access_token") ?: throw IOException("Sessão inválida")
        val ctx = try { context(d, token) } catch (e: ApiException) {
            if (e.code != "ERP_MFA_REQUIRED") throw e
            val user = json("${d.auth_url}/auth/v1/user", token = token, publicKey = d.public_key)
            val factor = user["factors"]?.jsonArray?.firstOrNull { it.jsonObject.text("status") == "verified" && it.jsonObject.text("factor_type") == "totp" }?.jsonObject?.text("id")
                ?: throw IOException("Configure o autenticador no Fagoo web antes de entrar no aplicativo.")
            val challenge = json("${d.auth_url}/auth/v1/factors/$factor/challenge", "POST", buildJsonObject {}, token, d.public_key).text("id") ?: throw IOException("Desafio MFA inválido")
            throw MfaRequired(d, web, credentials, factor, challenge)
        }
        return FagooLogin(d, web, credentials, ctx)
    }
    suspend fun verify(mfa: MfaRequired, code: String): FagooLogin {
        require(code.matches(Regex("[0-9]{6}"))) { "Digite os seis dígitos do autenticador" }
        val credentials = json("${mfa.discovery.auth_url}/auth/v1/factors/${mfa.factor}/verify", "POST", buildJsonObject { put("challenge_id", mfa.challenge); put("code", code) }, mfa.credentials.text("access_token"), mfa.discovery.public_key)
        return finish(mfa.discovery, mfa.web, credentials)
    }
    suspend fun context(d: FagooDiscovery, token: String): FagooContext = FagooJson.decodeFromJsonElement(FagooContext.serializer(), json("${d.api_url}/v1/fagoo/context", token = token, mobile = true))
    suspend fun refresh(d: FagooDiscovery, refresh: String): JsonObject = json("${d.auth_url}/auth/v1/token?grant_type=refresh_token", "POST", buildJsonObject { put("refresh_token", refresh) }, publicKey = d.public_key)
}

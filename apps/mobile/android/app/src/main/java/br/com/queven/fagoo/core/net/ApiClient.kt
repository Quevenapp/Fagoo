package br.com.queven.fagoo.core.net

import br.com.queven.fagoo.BuildConfig
import br.com.queven.fagoo.core.model.ApiErrorBody
import br.com.queven.fagoo.core.model.FagooJson
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Erro devolvido pela API no formato {"error":{"code","message","request_id"}}. */
class ApiException(val status: Int, val code: String, override val message: String, val requestId: String? = null) : IOException(message) {
    val isUnauthorized get() = status == 401
    val isIdempotencyConflict get() = code == "idempotency_conflict"
    val isDefinitiveWriteRejection get() = status in 400..499 && status !in listOf(408, 429) && code !in listOf("operation_unknown", "idempotency_conflict")
}

/** Cliente HTTP para um servidor. Acrescenta Authorization: Bearer e traduz erros da API. */
class ApiClient(val baseUrl: String, private val tokenProvider: () -> String?, private val generation: () -> Long, private val allowed: () -> Boolean) {
    val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false)
        .addInterceptor(AuthInterceptor(baseUrl, tokenProvider, generation, allowed))
        .addInterceptor(ErrorInterceptor())
        .build()

    val api: FagooApi = Retrofit.Builder()
        .baseUrl("$baseUrl/")
        .client(okHttp)
        .addConverterFactory(FagooJson.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(FagooApi::class.java)

    /** URL absoluta para baixar/exibir um anexo privado (exige Authorization; use [okHttp]). */
    fun mediaUrl(profileId: String, mediaId: String, inline: Boolean = true) =
        "$baseUrl/v1/communication/units/$profileId/media/$mediaId/content" + if (inline) "?inline=1" else ""

    private class AuthInterceptor(private val origin: String, private val tokenProvider: () -> String?, private val generation: () -> Long, private val allowed: () -> Boolean) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val before = generation()
            val uri = chain.request().url
            if (!allowed() || "${uri.scheme}://${uri.host}" + (if (uri.port == 443) "" else ":${uri.port}") != origin || !uri.encodedPath.startsWith("/v1/communication/units/")) throw IOException("Sessão ou destino inválido")
            val token = tokenProvider() ?: throw IOException("Sessão encerrada")
            val request = chain.request().newBuilder()
                .header("Accept", "application/json")
                .header("X-Fagoo-Client", "mobile")
                .header("User-Agent", "Fagoo-Android/${BuildConfig.VERSION_NAME}")
                .apply { if (!token.isNullOrBlank()) header("Authorization", "Bearer $token") }
                .build()
            val response = chain.proceed(request)
            if (!allowed() || before != generation()) { response.close(); throw IOException("Sessão alterada") }
            return response
        }
    }

    private class ErrorInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val response = chain.proceed(chain.request())
            if (response.isSuccessful) return response
            val body = response.peekBody(64 * 1024).string()
            val parsed = runCatching { FagooJson.decodeFromString(ApiErrorBody.serializer(), body) }.getOrNull()?.error
            response.close()
            throw ApiException(
                status = response.code,
                code = parsed?.code ?: "http_${response.code}",
                message = parsed?.message ?: when (response.code) {
                    401 -> "Sessão expirada. Entre novamente."
                    403 -> "Sem permissão para esta ação."
                    404 -> "Recurso não encontrado."
                    429 -> "Muitas requisições. Aguarde um instante."
                    else -> "Não foi possível concluir a operação (HTTP ${response.code})."
                },
                requestId = parsed?.request_id,
            )
        }
    }

    companion object {
        fun newIdempotencyKey(): String = UUID.randomUUID().toString()

        /** Mensagem amigável para qualquer exceção de rede/API. */
        fun describe(e: Throwable): String = when (e) {
            is ApiException -> e.message
            is HttpException -> "Erro HTTP ${e.code()}"
            is java.net.UnknownHostException -> "Servidor não encontrado. Confira o endereço e a conexão."
            is java.net.SocketTimeoutException -> "O servidor demorou a responder."
            is javax.net.ssl.SSLException -> "Falha de certificado HTTPS no servidor."
            is IOException -> "Falha de rede. Verifique sua conexão."
            else -> e.message ?: "Erro inesperado."
        }
    }
}

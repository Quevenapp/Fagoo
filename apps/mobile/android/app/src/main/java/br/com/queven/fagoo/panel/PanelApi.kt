// SPDX-License-Identifier: AGPL-3.0-only
package br.com.queven.fagoo.panel

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

class PanelHttpException(val status: Int) : Exception("Falha na conexão do painel ($status).")
class PanelApi(private val origin: String, private val token: String) {
    val originIdentity: String get() = origin.trimEnd('/')
    val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(12, TimeUnit.SECONDS).build()
    init {
        val uri = URI(origin)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/"))
        require(Regex("fgd_[a-f0-9]{64}").matches(token))
    }
    suspend fun request(path: String, body: JsonObject? = null): JsonElement = withContext(Dispatchers.IO) {
        require(path.startsWith("/v1/queues/") || path == "/v1/fagoo/device")
        val builder = Request.Builder().url(origin.trimEnd('/') + path).header("Authorization", "FagooDevice $token").header("Accept", "application/json").header("Cache-Control", "no-store")
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw PanelHttpException(response.code)
            val bytes = response.body?.byteStream()?.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= 2_097_152); output.write(buffer, 0, count) }
                output.toByteArray()
            } ?: error("Resposta vazia")
            require(bytes.size <= 2_097_152) { "Resposta excessiva" }
            json.parseToJsonElement(bytes.toString(Charsets.UTF_8))
        }
    }
    suspend fun device(): PanelDevice = json.decodeFromJsonElement(request("/v1/fagoo/device"))
    suspend fun snapshot(unit: String): PanelSnapshot = json.decodeFromJsonElement(request(base(unit) + "/snapshot"))
    suspend fun jobs(unit: String, kind: String, claim: String, after: Long): List<PanelJob> = json.decodeFromJsonElement<PanelJobs>(request(base(unit) + "/effects/claim", buildJsonObject { put("kind", kind); put("claim_id", claim); put("after_revision", after) })).jobs
    suspend fun ack(unit: String, id: String, claim: String, result: String) { request(base(unit) + "/effects/ack", buildJsonObject { put("job_id", id); put("claim_id", claim); put("result", result) }) }
    companion object { fun base(unit: String): String { require(Regex("[a-fA-F0-9-]{36}").matches(unit)); return "/v1/queues/units/$unit" } }
}

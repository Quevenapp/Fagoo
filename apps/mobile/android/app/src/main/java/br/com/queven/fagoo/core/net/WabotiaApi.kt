package br.com.queven.fagoo.core.net

import br.com.queven.fagoo.core.model.*
import kotlinx.serialization.json.JsonObject
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

/**
 * Contrato REST do Fagoo consumido pelo aplicativo (docs/API.md + docs/MOBILE.md).
 * Escritas exigem Idempotency-Key: gere uma chave por intenção e reutilize a mesma ao repetir após falha de rede.
 */
interface FagooApi {
    // --- descoberta e autenticação ---
    @GET("api/health") suspend fun health(): HealthInfo
    @GET("api/auth/status") suspend fun authStatus(): AuthStatus
    @POST("api/auth/mobile/login") suspend fun mobileLogin(@Body body: MobileLoginRequest): MobileSession
    @POST("api/v1/auth/mobile/refresh") suspend fun refresh(@Header("Idempotency-Key") key: String): MobileSession
    @POST("api/v1/logout") suspend fun logout(@Header("Idempotency-Key") key: String): Ok
    @GET("api/v1/me") suspend fun me(): Me
    @GET("api/v1/profiles") suspend fun profiles(): List<Profile>

    // --- dispositivos / push ---
    @PUT("v1/communication/units/{p}/devices/{id}") suspend fun registerDevice(@Path("p") p: String, @Path("id") id: String, @Body body: DeviceRegistration): Device
    @GET("v1/communication/units/{p}/devices") suspend fun devices(@Path("p") p: String): Page<Device>
    @DELETE("v1/communication/units/{p}/devices/{id}") suspend fun deleteDevice(@Path("p") p: String, @Path("id") id: String): Ok
    @POST("api/v1/devices/{id}/test") suspend fun testDevice(@Path("id") id: String, @Header("Idempotency-Key") key: String): JsonObject

    // --- perfil ---
    @GET("v1/communication/units/{p}/status") suspend fun profileStatus(@Path("p") p: String): ProfileStatus
    @GET("v1/communication/units/{p}/presence") suspend fun presence(@Path("p") p: String): List<PresenceEntry>
    @PUT("v1/communication/units/{p}/presence") suspend fun setPresence(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: PresenceRequest): PresenceResult
    @GET("v1/communication/units/{p}/events") suspend fun events(@Path("p") p: String, @Query("after") after: Long): Events

    @GET("v1/communication/units/{p}/queue") suspend fun queue(@Path("p") p: String): JsonObject
    // --- conversas ---
    @GET("v1/communication/units/{p}/conversations") suspend fun conversations(
        @Path("p") p: String,
        @Query("state") state: String? = null,
        @Query("q") q: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int = 50,
    ): Page<Conversation>
    @GET("v1/communication/units/{p}/conversations/{id}") suspend fun conversation(@Path("p") p: String, @Path("id") id: String): ConversationDetail
    @POST("v1/communication/units/{p}/conversations/{id}/actions") suspend fun act(
        @Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: ActionRequest,
    ): JsonObject
    @POST("v1/communication/units/{p}/conversations/{id}/message-actions") suspend fun messageAction(
        @Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: MessageActionRequest,
    ): JsonObject
    @PUT("v1/communication/units/{p}/groups/{id}/policy") suspend fun groupPolicy(
        @Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: GroupPolicyRequest,
    ): JsonObject
    @GET("v1/communication/units/{p}/contacts/{id}") suspend fun contact(@Path("p") p: String, @Path("id") id: String): JsonObject

    // --- mídia (upload em partes de 5 MiB; GET content é feito via OkHttp direto com Authorization) ---
    @POST("v1/communication/units/{p}/media/uploads") suspend fun uploadCreate(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: UploadInit): UploadCreated
    @PUT("v1/communication/units/{p}/media/uploads/{id}/parts/{part}") suspend fun uploadPart(
        @Path("p") p: String, @Path("id") id: String, @Path("part") part: Int, @Header("Idempotency-Key") key: String, @Body body: RequestBody,
    ): JsonObject
    @POST("v1/communication/units/{p}/media/uploads/{id}/complete") suspend fun uploadComplete(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): UploadDone
    @POST("v1/communication/units/{p}/media/uploads/{id}/abort") suspend fun uploadAbort(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): UploadDone

    // --- protocolos ---
    @GET("v1/communication/units/{p}/tickets") suspend fun tickets(
        @Path("p") p: String,
        @Query("status") status: String? = null,
        @Query("overdue") overdue: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int = 100,
    ): Page<Ticket>
    @GET("v1/communication/units/{p}/tickets/{id}") suspend fun ticket(@Path("p") p: String, @Path("id") id: String): TicketDetail
    @POST("v1/communication/units/{p}/tickets") suspend fun createTicket(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: TicketCreate): Ticket
    /** Corpo livre porque `response_due_at: null` precisa ser enviado explicitamente para remover o prazo. */
    @PATCH("v1/communication/units/{p}/tickets/{id}") suspend fun updateTicket(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): Ticket

    // --- bots ---
    @GET("v1/communication/units/{p}/bots") suspend fun bots(@Path("p") p: String, @Query("cursor") cursor: String? = null): Page<Bot>
    @GET("v1/communication/units/{p}/bot-runs") suspend fun botRuns(@Path("p") p: String, @Query("cursor") cursor: String? = null, @Query("limit") limit: Int = 100): Page<BotRun>
    @POST("api/v1/bot-runs") suspend fun startBotRun(@Header("Idempotency-Key") key: String, @Body body: BotRunRequest): BotRun
    @GET("api/v1/bot-runs/{id}") suspend fun botRun(@Path("id") id: String): BotRun
    @POST("v1/communication/units/{p}/bot-runs/{id}/cancel") suspend fun cancelBotRun(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): JsonObject

    // --- ligações (Meta Calling API, sinalização WebRTC) ---
    @GET("v1/communication/units/{p}/calls") suspend fun calls(@Path("p") p: String, @Query("conversation_id") conversationId: String? = null, @Query("limit") limit: Int = 30, @Query("cursor") cursor: String? = null): Page<Call>
    @GET("v1/communication/units/{p}/calls/{id}") suspend fun call(@Path("p") p: String, @Path("id") id: String, @Query("session") session: String? = null): Call
    @GET("v1/communication/units/{p}/conversations/{id}/call-permission") suspend fun callPermission(@Path("p") p: String, @Path("id") id: String): JsonObject
    @POST("v1/communication/units/{p}/calls/permission") suspend fun requestCallPermission(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: CallPermissionRequest): CallActionResult
    @POST("v1/communication/units/{p}/calls") suspend fun startCall(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: CallStart): Call
    @POST("v1/communication/units/{p}/calls/{id}/claim") suspend fun claimCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): Call
    @POST("v1/communication/units/{p}/calls/{id}/pre_accept") suspend fun preAcceptCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: CallAccept): CallActionResult
    @POST("v1/communication/units/{p}/calls/{id}/accept") suspend fun acceptCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: CallAccept): CallActionResult
    @POST("v1/communication/units/{p}/calls/{id}/reject") suspend fun rejectCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): CallActionResult
    @POST("v1/communication/units/{p}/calls/{id}/terminate") suspend fun terminateCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): CallActionResult
    @POST("v1/communication/units/{p}/calls/{id}/keepalive") suspend fun keepaliveCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject = JsonObject(emptyMap())): JsonObject
    @POST("v1/communication/units/{p}/calls/{id}/reconcile") suspend fun reconcileCall(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: CallReconcile): CallActionResult

    // --- equipe, linhas e menus ---
    @GET("v1/communication/units/{p}/team") suspend fun team(@Path("p") p: String): Page<TeamContact>
    @GET("v1/communication/units/{p}/lines") suspend fun lines(@Path("p") p: String): Page<ServiceLine>
    @PUT("v1/communication/units/{p}/lines/{id}") suspend fun saveLine(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject
    @GET("v1/communication/units/{p}/menus") suspend fun menus(@Path("p") p: String, @Query("connection_id") connectionId: String? = null): Page<JsonObject>
    @PUT("v1/communication/units/{p}/settings") suspend fun saveSettings(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject
    @PATCH("v1/communication/units/{p}/bots/{id}") suspend fun updateBot(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject
    @POST("v1/communication/units/{p}/internal-chats") suspend fun openInternalChat(@Path("p") p: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): InternalChat
    @GET("v1/communication/units/{p}/internal-chats") suspend fun internalChats(@Path("p") p: String): Page<InternalChat>
    @GET("v1/communication/units/{p}/internal-chats/{id}") suspend fun internalChat(@Path("p") p: String, @Path("id") id: String): InternalChat
    @POST("v1/communication/units/{p}/internal-chats/{id}/messages") suspend fun sendInternal(@Path("p") p: String, @Path("id") id: String, @Header("Idempotency-Key") key: String, @Body body: JsonObject): JsonObject

    // --- genérico, para respostas cruas quando necessário ---
    @GET suspend fun raw(@Url url: String): Response<JsonObject>
}

// SPDX-License-Identifier: AGPL-3.0-only
package br.com.queven.fagoo.panel

import android.content.Context
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalPrintDelivery
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

class PanelRuntime(private val api: PanelApi, private val context: Context, private val printer: ThermalPrinter, private val speech: PanelSpeech) {
    private val mutable = MutableStateFlow(PanelState())
    val state = mutable.asStateFlow()
    private val lock = Mutex()
    private var journal: PanelJournal? = null
    private val claim = UUID.randomUUID().toString()
    private var audioFloor = 0L
    private var serverOffset = 0L
    private fun now() = Instant.ofEpochMilli(System.currentTimeMillis() + serverOffset)
    suspend fun run() {
        mutable.value = mutable.value.copy(online = false)
        while (currentCoroutineContext().isActive) {
            try {
                lock.withLock {
                    val device = api.device()
                    check("panel.read" in device.capabilities)
                    if (mutable.value.device?.id != device.id || journal == null) journal = PanelJournal(context, api.originIdentity, device.id)
                    val snapshot = api.snapshot(device.unit_id)
                    check(snapshot.unit.id == device.unit_id && snapshot.revision >= 0)
                    serverOffset = Instant.parse(snapshot.server_time).toEpochMilli() - System.currentTimeMillis()
                    if (!mutable.value.online) audioFloor = snapshot.revision
                    mutable.value = mutable.value.copy(device = device, snapshot = snapshot, online = true, message = if (!mutable.value.online) "Conectado" else mutable.value.message, pendingCommand = journal?.pendingCommand)
                    recoverEffects(device)
                    if (journal?.pendingCommand != null) recoverCommand(device)
                    for (kind in listOf("print", "audio")) {
                        if ((if (kind == "print") "print.execute" else "audio.execute") !in device.capabilities) continue
                        for (job in api.jobs(device.unit_id, kind, claim, if (kind == "audio") audioFloor else 0)) execute(device, job)
                    }
                }
            } catch (e: CancellationException) { mutable.value = mutable.value.copy(online = false); throw e }
            catch (e: Exception) {
                val denied = e is PanelHttpException && e.status in listOf(401, 403)
                mutable.value = mutable.value.copy(online = false, snapshot = if (denied) null else mutable.value.snapshot, message = if (denied) "Acesso do painel revogado. Peça a um responsável para vincular o aparelho." else "Sem conexão. Conecte-se à internet para continuar.")
                speech.stop()
            }
            delay(2000)
        }
    }
    private suspend fun recoverEffects(device: PanelDevice) {
        for (receipt in requireNotNull(journal).receipts()) {
            api.ack(device.unit_id, receipt.job, receipt.claim, receipt.result)
            journal?.confirmed(receipt.job)
        }
    }
    private suspend fun execute(device: PanelDevice, job: PanelJob) {
        val cache = requireNotNull(journal)
        cache.find(job.id)?.let { api.ack(device.unit_id, it.job, it.claim, it.result); cache.confirmed(it.job); return }
        // Recheck cloud authority immediately before the physical action. No work runs after failed polling.
        val fresh = api.snapshot(device.unit_id)
        currentCoroutineContext().ensureActive()
        serverOffset = Instant.parse(fresh.server_time).toEpochMilli() - System.currentTimeMillis()
        val default = if (job.kind == "print") "incerto" else "skipped"
        cache.record(EffectReceipt(job.id, job.claim_id, default)) // durable BEFORE any bytes/audio
        currentCoroutineContext().ensureActive()
        val result = if (Instant.parse(job.expires_at) <= now()) { if (job.kind == "print") "falhou" else "skipped" }
        else if (job.kind == "audio") {
            val settings = fresh.device_settings ?: PanelSettings()
            if (settings.muted || !PanelRules.canExecuteAudio(job, fresh, now())) "skipped"
            else if (speech.say("Senha ${job.payload["display_number"]?.jsonPrimitive?.content}, guichê ${job.payload["desk"]?.jsonPrimitive?.content}", settings.volume)) "played" else "skipped"
        } else {
            val receipt = FagooTicketReceipt.create(job.payload["display_number"]!!.jsonPrimitive.content, job.payload["tracking_url"]?.jsonPrimitive?.contentOrNull, job.payload["unit"]?.jsonPrimitive?.content ?: "FAGOO")
            try { when (val printed = printer.print(receipt)) {
                ThermalPrintResult.Printed -> "impresso"
                is ThermalPrintResult.Failed -> if (printed.delivery == ThermalPrintDelivery.INDETERMINATE) "incerto" else "falhou"
            } } catch (e: CancellationException) { throw e } catch (_: Exception) { "incerto" } finally { receipt.clear() }
        }
        cache.record(EffectReceipt(job.id, job.claim_id, result))
        if (job.kind == "print" && job.payload["ticket_id"]?.jsonPrimitive?.contentOrNull == mutable.value.issued?.id) mutable.value = mutable.value.copy(printMessage = when(result) { "impresso" -> "Comprovante enviado à impressora. Confira o papel."; "incerto" -> "Não foi possível confirmar a impressão. Peça ajuda antes de imprimir novamente."; else -> "Não foi possível imprimir. A senha continua válida; acompanhe pelo QR." })
        api.ack(device.unit_id, job.id, job.claim_id, result)
        cache.confirmed(job.id)
    }
    private suspend fun recoverCommand(device: PanelDevice) {
        val id = journal?.pendingCommand ?: return
        val receipt = api.request(PanelApi.base(device.unit_id) + "/receipts/$id").jsonObject
        if (receipt["status"]?.jsonPrimitive?.content == "confirmed") acceptCommand(receipt.getValue("response").jsonObject)
    }
    private fun acceptCommand(result: JsonObject) {
        val ok = requireNotNull(result["ok"]?.jsonPrimitive?.booleanOrNull) { "Resposta sem confirmação da operação" }
        val ticket = result["result"]?.jsonObject?.get("ticket")?.let { api.json.decodeFromJsonElement<PanelTicket>(it) }
        journal?.pendingCommand = null
        mutable.value = mutable.value.copy(pendingCommand = null, issued = ticket ?: mutable.value.issued, message = if (ok) "Senha confirmada." else "Operação não executada. Confira a fila e tente novamente.")
    }
    fun hideIssued(id: String) { if (mutable.value.issued?.id == id) mutable.value = mutable.value.copy(issued = null, printMessage = null, message = "Conectado") }
    suspend fun cancelUnconfirmed() = lock.withLock {
        val device = mutable.value.device ?: return@withLock
        val id = journal?.pendingCommand ?: return@withLock
        try { acceptCommand(api.request(PanelApi.base(device.unit_id) + "/receipts/$id", buildJsonObject { put("cancel", true) }).jsonObject) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { mutable.value = mutable.value.copy(online = false, message = "Não foi possível confirmar. Reconecte-se.") }
    }
    suspend fun issue(queue: String, priority: Boolean) = lock.withLock {
        val state = mutable.value; val device = state.device ?: return@withLock
        if (!state.online || state.busy || journal?.pendingCommand != null || "ticket.issue" !in device.capabilities) return@withLock
        val id = UUID.randomUUID().toString();requireNotNull(journal).pendingCommand = id
        mutable.value = state.copy(busy = true, pendingCommand = id, issued = null, printMessage = null, message = "Confirmando senha…")
        try {
            val result = api.request(PanelApi.base(device.unit_id) + "/commands", buildJsonObject {
                put("command_id", id); put("type", "ticket.issue"); put("payload", buildJsonObject { put("queue_id", queue); put("priority", priority); put("print", "print.execute" in device.capabilities) })
            }).jsonObject
            acceptCommand(result)
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { mutable.value = mutable.value.copy(online = false, message = "A confirmação foi interrompida. A mesma senha será consultada ao reconectar.") }
        finally { mutable.value = mutable.value.copy(busy = false) }
    }
}

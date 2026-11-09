// SPDX-License-Identifier: AGPL-3.0-only
package br.com.queven.fagoo.panel

import android.app.Activity
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.printher.ThermalPrinterContent
import br.com.thermalprinterkit.printher.ThermalPrinterTheme
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

/** A public device only. The host must authorize onExit online before changing mode. */
@Composable fun PanelScreen(apiBaseUrl: String, deviceToken: String, onExit: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val api = remember(apiBaseUrl, deviceToken) { PanelApi(apiBaseUrl, deviceToken) }
    val printer = remember(context) { createFagooThermalPrinter(context) }
    val speech = remember(context) { PanelSpeech(context) }
    val runtime = remember(api, printer, speech) { PanelRuntime(api, context.applicationContext, printer, speech) }
    val state by runtime.state.collectAsState()
    var surface by remember { mutableStateOf("chamada") }
    var priority by remember { mutableStateOf(false) }
    val template = PanelTemplate.fromId(state.snapshot?.device_settings?.template ?: state.snapshot?.config?.template)
    BackHandler { onExit() }
    DisposableEffect(speech) {
        (context as? Activity)?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { speech.close(); (context as? Activity)?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    LaunchedEffect(runtime, lifecycle) {
        withTimeoutOrNull(15000) { runCatching { printer.restore() } }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { runtime.run() }
    }
    val snapshot = state.snapshot
    LaunchedEffect(state.issued?.id) { state.issued?.id?.let { delay(30000); runtime.hideIssued(it) } }
    PanelTheme(template) {
        val style = LocalPanelStyle.current
        Column(Modifier.fillMaxSize().background(style.bg).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth().background(style.headerBg).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(snapshot?.config?.title?.ifBlank { snapshot.unit.name } ?: "FAGOO", color = style.headerFg, fontFamily = style.text, modifier = Modifier.weight(1f), fontSize = 22.sp)
                TextButton(onClick = onExit) { Text("Responsável", color = style.headerFg) }
            }
            if (!state.online) Surface(color = MaterialTheme.colorScheme.errorContainer) { Text(state.message, Modifier.fillMaxWidth().padding(16.dp), color = MaterialTheme.colorScheme.onErrorContainer) }
            if (snapshot != null) {
                val functions = snapshot.config.functions.filter { it != "emitir" || "ticket.issue" in (state.device?.capabilities ?: emptyList()) }
                val current = surface.takeIf { it in functions } ?: functions.firstOrNull() ?: "chamada"
                if (functions.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { functions.forEach { mode -> FilterChip(selected = current == mode, onClick = { surface = mode }, label = { Text(when (mode) { "emitir" -> "Retirar senha"; "pedidos" -> "Pedidos"; else -> "Chamadas" }) }) } }
                if (state.pendingCommand != null) {
                    Text("Aguardando confirmação da senha. Nenhuma outra senha será emitida até confirmar.")
                    Button(enabled = state.online && !state.busy, onClick = { scope.launch { runtime.cancelUnconfirmed() } }) { Text("Encerrar tentativa não confirmada") }
                }
                if (current == "emitir") {
                    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(priority, onCheckedChange = { priority = it }, enabled = state.online); Text("Atendimento prioritário") }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        snapshot.queues.filter { it.active }.forEach { queue ->
                            Button(modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp), enabled = state.online && !state.busy && state.pendingCommand == null, onClick = { scope.launch { runtime.issue(queue.id, priority) } }) { Text(queue.name, fontSize = 28.sp) }
                        }
                        state.issued?.let {
                            Text("Sua senha", Modifier.align(Alignment.CenterHorizontally)); Text(it.display_number, Modifier.align(Alignment.CenterHorizontally), fontFamily = style.display, fontWeight = style.displayWeight, fontSize = 68.sp)
                            Text("Aguarde a chamada.")
                            it.tracking_url?.takeIf { url -> url.startsWith("https://") }?.let { url -> PublicTicketQr(url, Modifier.align(Alignment.CenterHorizontally)); Text("Aponte a câmera para acompanhar sua senha.") }
                            if ("print.execute" in (state.device?.capabilities ?: emptyList())) Text(state.printMessage ?: "Aguardando confirmação da impressora…")
                        }
                        if (state.issued == null && state.online && !state.busy && state.message != "Conectado") Text(state.message)
                    }
                } else {
                    PanelBoard(snapshot, current, Modifier.weight(1f), state.online)
                }
                Text(snapshot.config.footer, color = style.muted, fontFamily = style.text)
            } else { Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { Text(state.message, textAlign = TextAlign.Center) } }
        }
    }
}

@Composable private fun PublicTicketQr(url: String, modifier: Modifier) {
    val matrix = remember(url) { QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 0, 0) }
    Canvas(modifier.size(220.dp).background(Color.White).semantics { contentDescription = "QR para acompanhar esta senha" }) {
        val cell = size.minDimension / matrix.width
        for (y in 0 until matrix.height) for (x in 0 until matrix.width) if (matrix[x,y]) drawRect(Color.Black, Offset(x * cell, y * cell), Size(cell + .2f, cell + .2f))
    }
}

@Composable private fun PanelBoard(snapshot: PanelSnapshot, surface: String, modifier: Modifier, online: Boolean) {
    val style = LocalPanelStyle.current
    val calls = snapshot.recent_calls.filter { it.status == "chamada" }
    val latest = calls.firstOrNull()
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val horizontal = maxWidth > maxHeight
        val size = minOf(maxWidth.value / style.numEm, maxHeight.value * style.numHeight).coerceIn(38f, 160f).sp
        val board: @Composable () -> Unit = {
            Column(Modifier.fillMaxWidth().background(style.heroBg, RoundedCornerShape(style.radius)).border(style.border, style.line, RoundedCornerShape(style.radius)).padding(20.dp), horizontalAlignment = if (style.alignStart) Alignment.Start else Alignment.CenterHorizontally) {
                Text(if (surface == "pedidos") "PEDIDOS PRONTOS" else if (latest == null) "AGUARDE A CHAMADA" else "SENHA", color = style.heroFg, fontFamily = style.text, fontSize = 20.sp)
                if (surface == "pedidos") snapshot.orders.filter { it.status == "pronto" }.take(8).forEach { Text(it.code, color = style.readyFg, fontFamily = style.display, fontSize = (size.value * .55f).sp) }
                else { Text(latest?.display_number ?: "—", color = style.heroFg, fontFamily = style.display, fontWeight = style.displayWeight, fontSize = size); latest?.let { Text((if (style.arrow) "→ " else "") + "Guichê ${it.desk}", Modifier.background(style.destBg, RoundedCornerShape(if (style.destPill) 50.dp else 0.dp)).padding(12.dp), color = style.destFg, fontFamily = style.text, fontSize = 28.sp) } }
            }
            calls.drop(1).take(5).forEach { ticket -> Row(Modifier.fillMaxWidth().padding(8.dp)) { Text(ticket.display_number, color = style.fg, fontFamily = style.display, fontSize = 26.sp, modifier = Modifier.weight(1f)); Text("Guichê ${ticket.desk}", color = style.prevDest, fontFamily = style.text, fontSize = 22.sp) } }
        }
        if (horizontal) Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) { Column(Modifier.weight(1f), content = { board() }); CampaignMedia(snapshot, surface, online, Modifier.weight(if (style.template == PanelTemplate.VITRINE) 1.5f else 1f)) }
        else Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { board(); CampaignMedia(snapshot, surface, online, Modifier.weight(1f, false)) }
    }
}

@Composable private fun CampaignMedia(snapshot: PanelSnapshot, surface: String, online: Boolean, modifier: Modifier) {
    var index by remember { mutableIntStateOf(0) }
    val receivedAt = remember(snapshot.server_time) { System.currentTimeMillis() }
    var now by remember { mutableStateOf(Instant.parse(snapshot.server_time)) }
    LaunchedEffect(snapshot.server_time) { while (true) { now = Instant.parse(snapshot.server_time).plusMillis(System.currentTimeMillis() - receivedAt); delay(1000) } }
    val campaign = PanelRules.campaigns(snapshot, surface, now).let { it.getOrNull(index % maxOf(1, it.size)) }
    LaunchedEffect(campaign?.id, index) { if (campaign != null) { delay(campaign.duration_seconds.coerceIn(3, 300) * 1000L); index++ } }
    if (campaign == null || !online) return
    if (campaign.media_type == "image") AsyncImage(campaign.media_url, campaign.title, modifier.fillMaxWidth())
    else {
        val context = LocalContext.current
        val player = remember(campaign.media_url) { ExoPlayer.Builder(context).build().apply { volume = 0f; repeatMode = ExoPlayer.REPEAT_MODE_ONE; setMediaItem(MediaItem.fromUri(campaign.media_url)); prepare(); playWhenReady = true } }
        DisposableEffect(player) { onDispose { player.release() } }
        AndroidView(factory = { PlayerView(it).apply { this.player = player; useController = false } }, update = { it.player = player }, modifier = modifier.fillMaxWidth())
    }
}

/** Called only by the authenticated shell, after online authorization. */
@Composable fun PanelPrinterSettings(onBack: () -> Unit) {
    val context = LocalContext.current
    val printer = remember(context) { createFagooThermalPrinter(context) }
    LaunchedEffect(printer) { withTimeoutOrNull(15000) { runCatching { printer.restore() } } }
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        TextButton(onClick = onBack) { Text("Voltar") }
        Text("Impressora deste aparelho", style = MaterialTheme.typography.headlineSmall)
        Text("Escolha o transporte e confirme o comprovante de teste no papel antes de usar a impressora.")
        ThermalPrinterContent(printer = printer, theme = ThermalPrinterTheme.neutral, modifier = Modifier.fillMaxWidth())
    }
}

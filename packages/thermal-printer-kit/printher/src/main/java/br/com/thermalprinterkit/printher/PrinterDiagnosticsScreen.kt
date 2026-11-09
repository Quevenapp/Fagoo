package br.com.thermalprinterkit.printher

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.thermalprinterkit.AndroidUsbInventory
import br.com.thermalprinterkit.BundledPrinterDrivers
import br.com.thermalprinterkit.PrinterHomologationHost
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.RawCommandConfirmation
import br.com.thermalprinterkit.RawCommandController
import br.com.thermalprinterkit.RawCommandSender
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalPrinterState
import kotlinx.coroutines.launch

/**
 * Diagnóstico de impressora: varredura de rede, inventário USB, rede Wi-Fi da impressora e comando
 * cru.
 *
 * Nasceu como tela do app de bancada e subiu porque tem dois públicos, não um. Na bancada ela
 * responde por hardware que compramos; num app publicado ela responde por hardware que nunca
 * teremos, e é de lá que vem relato aproveitável. Quem fica travado sem estas três ferramentas só
 * consegue dizer "não imprime", e isso não conserta nada.
 *
 * Os painéis também são públicos um a um: um hospedeiro que precise intercalar algo próprio entre
 * eles monta a própria coluna em vez de copiar o arquivo. É o que o `android-lab` faz para inserir
 * o scan BLE legado, que **não** pode morar aqui — ele depende de `ACCESS_FINE_LOCATION` abaixo do
 * Android 12, permissão que [AndroidPrinterUiPolicy] recusa a qualquer app publicado.
 *
 * `systemBarsPadding` porque esta é a **página inteira**, e o hospedeiro a apresenta fora do
 * `Scaffold` dele: com `targetSdk` 36 o desenho é ponta a ponta, e sem isto o primeiro painel nasce
 * debaixo da barra de status. Medido na bancada em 19/08. O padding fica aqui e não em
 * [PrinterDiagnosticsColumn] de propósito: a coluna é peça avulsa, e quem a monta dentro de um
 * `Scaffold` — o `android-lab` — ganharia o recuo duas vezes.
 */
@Composable
fun PrinterDiagnosticsScreen(
    printer: ThermalPrinter,
    modifier: Modifier = Modifier,
) {
    PrinterDiagnosticsColumn(modifier.systemBarsPadding()) {
        // Primeiro porque é o painel que responde à pergunta com que a pessoa chega: por que está
        // lento, ou por que a imagem sai errada. Os outros três respondem "onde está a impressora".
        PrinterTransportPanel(printer)
        PrinterNetworkScanPanel(printer)
        PrinterUsbInventoryPanel()
        // Depois de "onde está a impressora" e antes do comando cru: configurar a Wi-Fi só faz
        // sentido para quem já achou a impressora, e existir aqui é o que tira essa configuração do
        // painel de hexadecimal digitado — que foi por onde um quadro perdeu um byte em 21/08.
        PrinterWifiSetupPanel(printer)
        PrinterRawCommandPanel(printer)
    }
}

/** A coluna rolável dos painéis, exposta para quem monta a própria ordem. */
@Composable
fun PrinterDiagnosticsColumn(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .testTag("printer.diagnostics"),
        verticalArrangement = Arrangement.spacedBy(20.dp),
        content = content,
    )
}

/**
 * Procura impressora na Wi-Fi da vez.
 *
 * O endereço encontrado vale só para esta sessão e não é persistido: o store guarda `profileId` e
 * mais nada. IP e porta em disco foi divergência corrigida na extração do kit e não volta por aqui.
 */
@Composable
fun PrinterNetworkScanPanel(
    printer: ThermalPrinter,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val state by printer.state.collectAsStateWithLifecycle()
    val profile =
        remember {
            BundledPrinterDrivers.all.first { it.supports(PrinterTransport.LOCAL_WIFI) }
        }

    PrinterDiagnosticsPanel("Scan de rede local", modifier) {
        Text("O endereço aparece somente durante esta sessão e nunca é salvo.")
        Button(
            onClick = { scope.launch { printer.searchLocalWifi(profile.id) } },
            modifier = Modifier.testTag("printer.diagnostics.network.scan"),
        ) {
            Text("Procurar na Wi-Fi")
        }
        val candidates =
            (state as? ThermalPrinterState.LocalWifiCandidatesFound)?.candidates.orEmpty()
        candidates.forEach { candidate ->
            OutlinedButton(
                onClick = { scope.launch { printer.testSearchedLocalWifiPrinter(candidate.id) } },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(candidate.label)
            }
        }
    }
}

/**
 * Lista as interfaces USB que o kit sabe usar.
 *
 * Foi este inventário que explicou a Bematech MP-4200 "não reconhecida": ela se apresenta como
 * `CDC_DATA` (10), não como impressora (7). Sem ver a classe, "não reconheceu" fica
 * indistinguível de "não está no cabo".
 *
 * VID, PID, serial e caminho de kernel não aparecem — identificam o aparelho e não ajudam a
 * decidir nada na tela.
 */
@Composable
fun PrinterUsbInventoryPanel(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val inventory = remember(context) { AndroidUsbInventory(context) }
    var entries by remember { mutableStateOf(inventory.read()) }

    PrinterDiagnosticsPanel("Inventário USB", modifier) {
        Text("Somente interfaces PRINTER (7) e CDC_DATA (10); VID, PID e serial não são exibidos.")
        Button(
            onClick = { entries = inventory.read() },
            modifier = Modifier.testTag("printer.diagnostics.usb.refresh"),
        ) {
            Text("Atualizar inventário")
        }
        if (entries.isEmpty()) Text("Nenhuma interface compatível conectada.")
        entries.forEach { entry -> Text(entry.label) }
    }
}

/**
 * Envia bytes ESC/POS crus pela sessão efêmera do host.
 *
 * São dois gestos conscientes de propósito: preparar e confirmar. O aviso de risco vem do core e
 * não é reescrito aqui — comando cru grava configuração não volátil, e uma tela que resumisse isso
 * viraria um botão destrutivo silencioso.
 */
@Composable
fun PrinterRawCommandPanel(
    printer: ThermalPrinter,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf<RawCommandConfirmation?>(null) }
    var result by remember { mutableStateOf<String?>(null) }
    val controller =
        remember(printer) {
            RawCommandController(
                RawCommandSender { bytes ->
                    val host =
                        printer as? PrinterHomologationHost
                            ?: error("O host não oferece sessão efêmera.")
                    val target =
                        host.openHomologationTarget()
                            ?: error("Teste uma candidata ou restaure uma impressora antes do comando cru.")
                    val session = target.openSession()
                    try {
                        when (val sent = session.send(bytes)) {
                            ThermalPrintResult.Printed -> Unit
                            is ThermalPrintResult.Failed -> error(sent.message)
                        }
                    } finally {
                        session.close()
                    }
                },
            )
        }

    PrinterDiagnosticsPanel("Comando hexadecimal cru", modifier) {
        Text("Até 256 bytes. O texto e o buffer não são persistidos nem enviados a logs.")
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text("Bytes hexadecimais") },
            modifier = Modifier.fillMaxWidth().testTag("printer.diagnostics.raw.input"),
        )
        Button(
            onClick = {
                result = null
                runCatching { controller.prepare(text) }
                    .onSuccess {
                        confirmation = it
                        text = ""
                    }.onFailure { result = it.message ?: "Comando inválido." }
            },
            modifier = Modifier.testTag("printer.diagnostics.raw.prepare"),
        ) {
            Text("Revisar risco e enviar")
        }
        result?.let { Text(it) }
    }

    confirmation?.let { pending ->
        AlertDialog(
            onDismissRequest = {
                controller.cancel()
                confirmation = null
            },
            title = { Text("Confirmar ${pending.byteCount} bytes") },
            text = { Text(pending.warning) },
            confirmButton = {
                Button(
                    onClick = {
                        confirmation = null
                        scope.launch {
                            runCatching { controller.confirmAndSend() }
                                .onSuccess { result = "Comando concluído pelo transporte." }
                                .onFailure { result = it.message ?: "O envio não foi concluído." }
                        }
                    },
                    modifier = Modifier.testTag("printer.diagnostics.raw.confirm"),
                ) {
                    Text("Conheço o efeito e a reversão")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        controller.cancel()
                        confirmation = null
                    },
                ) {
                    Text("Cancelar")
                }
            },
        )
    }
}

/** Título e conteúdo de um painel, para o hospedeiro que acrescenta os seus. */
@Composable
fun PrinterDiagnosticsPanel(
    title: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    }
}

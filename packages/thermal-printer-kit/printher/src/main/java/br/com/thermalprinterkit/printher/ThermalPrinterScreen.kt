package br.com.thermalprinterkit.printher

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Bluetooth
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Cable
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Router
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.thermalprinterkit.DialetoNoBalcao
import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.AdoptedPrinter
import br.com.thermalprinterkit.BluetoothCandidateOrigin
import br.com.thermalprinterkit.BluetoothDiscoveryHost
import br.com.thermalprinterkit.BluetoothDiscoveryState
import br.com.thermalprinterkit.BundledPrinterDrivers
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterDriverProfile
import br.com.thermalprinterkit.PrinterHomologationHost
import br.com.thermalprinterkit.PrinterProfileSource
import br.com.thermalprinterkit.PrinterNetworkAttachment
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalPrinterState
import br.com.thermalprinterkit.TemporaryPrinterDiscoveryProfileHost
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Tela completa e rolável de configuração da impressora.
 *
 * Esta é a única camada que adiciona rolagem. Hosts que já possuem um contêiner rolável devem usar
 * [ThermalPrinterContent], que preserva o mesmo fluxo sem criar scroll aninhado.
 * [profileActions] só é composto para um perfil medido; `null` mantém a superfície comum sem ações
 * próprias do app hospedeiro.
 */
@Composable
fun ThermalPrinterScreen(
    printer: ThermalPrinter?,
    theme: ThermalPrinterTheme = ThermalPrinterTheme.neutral,
    modifier: Modifier = Modifier,
    profileActions: (@Composable (MeasuredProfile) -> Unit)? = null,
) {
    ThermalPrinterScreenContent(
        printer = printer,
        theme = theme,
        modifier = modifier,
        profileActions = profileActions,
    )
}

@Composable
private fun ThermalPrinterScreenContent(
    printer: ThermalPrinter?,
    theme: ThermalPrinterTheme,
    modifier: Modifier,
    profileActions: (@Composable (MeasuredProfile) -> Unit)?,
) {
    val scrollState = rememberScrollState()
    val scope = rememberCoroutineScope()
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .testTag("print-setup.screen")
                .verticalScroll(scrollState)
                .padding(theme.contentPadding),
    ) {
        ThermalPrinterContentBody(
            printer = printer,
            theme = theme,
            modifier = Modifier,
            onHomologationRequested = null,
            onSetupRouteChanged = { scope.launch { scrollState.scrollTo(0) } },
            profileActions = profileActions,
        )
    }
}

/**
 * Conteúdo embutível da configuração, deliberadamente sem rolagem e sem padding externo.
 *
 * Quando [printer] também implementa [PrinterHomologationHost], os dois caminhos de homologação
 * trocam o conteúdo no mesmo dono de scroll. [onHomologationRequested] apenas notifica o host; não
 * recebe endpoint nem precisa reconstruir a sessão. [profileActions] recebe somente o perfil
 * medido, para o host acrescentar UI sem a superfície compartilhada conhecer a finalidade dela.
 */
@Composable
fun ThermalPrinterContent(
    printer: ThermalPrinter?,
    theme: ThermalPrinterTheme = ThermalPrinterTheme.neutral,
    modifier: Modifier = Modifier,
    onHomologationRequested: (() -> Unit)? = null,
    profileActions: (@Composable (MeasuredProfile) -> Unit)? = null,
) {
    ThermalPrinterContentBody(
        printer = printer,
        theme = theme,
        modifier = modifier,
        onHomologationRequested = onHomologationRequested,
        onSetupRouteChanged = null,
        profileActions = profileActions,
    )
}

@Composable
private fun ThermalPrinterContentBody(
    printer: ThermalPrinter?,
    theme: ThermalPrinterTheme,
    modifier: Modifier,
    onHomologationRequested: (() -> Unit)?,
    onSetupRouteChanged: (() -> Unit)?,
    profileActions: (@Composable (MeasuredProfile) -> Unit)?,
) {
    val host = printer as? PrinterHomologationHost
    var showHomologation by remember(printer) { mutableStateOf(false) }
    var homologationPreparationAccepted by remember(printer) { mutableStateOf(false) }
    var measuredProfiles by remember(host) { mutableStateOf<List<MeasuredProfile>>(emptyList()) }
    // Apagar uma medição muda o disco; a lista em memória precisa ser relida, e a releitura é a
    // mesma que acontece ao voltar da adoção.
    var profilesReloadToken by remember(host) { mutableIntStateOf(0) }

    // Recarrega depois de voltar da adoção. Store é síncrono e pode tocar disco, então a leitura
    // não acontece durante composição nem bloqueia a thread principal.
    LaunchedEffect(host, showHomologation, profilesReloadToken) {
        if (host != null && !showHomologation) {
            measuredProfiles =
                withContext(Dispatchers.IO) {
                    runCatching { host.profileStore.read() }.getOrDefault(emptyList())
                }
        }
    }
    val profiles =
        remember(measuredProfiles) {
            configurationPrinterProfileChoices(
                measuredProfiles = measuredProfiles,
                bundledProfiles = BundledPrinterDrivers.all,
            )
        }

    // O modificador pertence ao host. As tags internas ficam em filhos para não apagar, por
    // exemplo, `print-setup.screen` aplicado por um app que embute este conteúdo.
    Column(modifier = modifier.fillMaxWidth()) {
        if (showHomologation && printer != null && host != null) {
            PrinterHomologationContent(
                printer = printer,
                store = host.profileStore,
                onFinished = {
                    homologationPreparationAccepted = false
                    showHomologation = false
                },
                theme = theme,
                modifier = Modifier.fillMaxWidth(),
                preparationAlreadyAccepted = homologationPreparationAccepted,
                profileActions = profileActions,
            )
        } else {
            var homologationUnavailable by remember(printer) { mutableStateOf(false) }
            Column(
                modifier = Modifier.fillMaxWidth().testTag("print-setup.content"),
                verticalArrangement = Arrangement.spacedBy(theme.sectionSpacing),
            ) {
                if (!theme.usesPrintherLayout) {
                    SectionHeading(
                        title = "Impressora térmica",
                        supportingText = configurationTransportSummary(Build.VERSION.SDK_INT),
                        theme = theme,
                    )
                }
                if (homologationUnavailable) {
                    NoticeCard(
                        title = "Configuração indisponível",
                        body = "Este aparelho não oferece uma sessão temporária de teste.",
                        tone = NoticeTone.WARNING,
                        theme = theme,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .testTag("thermal-printer.homologation-unavailable"),
                    )
                }
                ThermalPrinterCard(
                    printer = printer,
                    profiles = profiles,
                    theme = theme,
                    onProfilesChanged = { profilesReloadToken += 1 },
                    onHomologationRequested = { preparationAlreadyAccepted ->
                        onHomologationRequested?.invoke()
                        if (host == null) {
                            homologationUnavailable = true
                        } else {
                            // A candidata continua no core. Remover o cartão também suprime o alerta
                            // de três respostas enquanto a sessão de teste está visível.
                            homologationPreparationAccepted = preparationAlreadyAccepted
                            showHomologation = true
                        }
                    },
                    onSetupRouteChanged = onSetupRouteChanged,
                    modifier = Modifier.fillMaxWidth(),
                    profileActions = profileActions,
                )
            }
        }
    }
}

@Composable
private fun ThermalPrinterCard(
    printer: ThermalPrinter?,
    profiles: List<ConfigurationPrinterProfile>,
    theme: ThermalPrinterTheme,
    onHomologationRequested: (preparationAlreadyAccepted: Boolean) -> Unit,
    onProfilesChanged: () -> Unit,
    onSetupRouteChanged: (() -> Unit)?,
    modifier: Modifier = Modifier,
    profileActions: (@Composable (MeasuredProfile) -> Unit)?,
) {
    val context = LocalContext.current
    val homologationHost = printer as? PrinterHomologationHost
    var profileToForget by remember(printer) { mutableStateOf<MeasuredProfile?>(null) }
    var printerToRemove by remember(printer) { mutableStateOf<AdoptedPrinter?>(null) }
    val temporaryDiscoveryHost = printer as? TemporaryPrinterDiscoveryProfileHost
    val bluetoothDiscoveryHost = printer as? BluetoothDiscoveryHost
    val state = printer?.state?.collectAsStateWithLifecycle()?.value
    val bluetoothDiscovery =
        if (bluetoothDiscoveryHost != null) {
            bluetoothDiscoveryHost.bluetoothDiscovery.collectAsStateWithLifecycle().value
        } else {
            BluetoothDiscoveryState.Idle
        }
    val adopted = printer?.adoptedPrinters?.collectAsStateWithLifecycle()?.value.orEmpty()
    val scope = rememberCoroutineScope()
    val selectableProfiles =
        remember(profiles) {
            profiles.filter { profile ->
                profile.driver.supports(PrinterTransport.LOCAL_WIFI) ||
                    profile.driver.supports(PrinterTransport.USB) ||
                    profile.driver.supports(PrinterTransport.BLUETOOTH) ||
                    profile.driver.supports(PrinterTransport.BLUETOOTH_LE)
            }
        }
    var selectedProfileId by remember { mutableStateOf<String?>(null) }
    var setupPath by remember { mutableStateOf(PrinterSetupPath.PROFILE_LIST) }
    var manualConfigurationTransport by remember(printer) { mutableStateOf<PrinterTransport?>(null) }
    var automaticSearchPending by remember(printer) { mutableStateOf(false) }
    var showSearchAgain by remember(printer) { mutableStateOf(false) }
    var preliminaryTestInProgress by remember(printer) { mutableStateOf(false) }
    LaunchedEffect(setupPath) { onSetupRouteChanged?.invoke() }
    var selectedConnection by remember { mutableStateOf<PrinterConnectionChoice?>(null) }
    var creatingProfile by remember { mutableStateOf(false) }

    /**
     * A língua respondida por quem entrou sem card, e `null` enquanto ninguém respondeu.
     *
     * **`null` não é "use o padrão": é "ainda não perguntei".** É essa a diferença que faltava —
     * o tipo [EscPosDialect] não tem valor "desconhecido", então a ausência de resposta precisa
     * morar fora dele. Quem tenta seguir sem resposta volta para a pergunta, e não cai em ESC/POS.
     */
    var newPrinterDialect by remember { mutableStateOf<EscPosDialect?>(null) }
    var temporaryDiscoveryProfile by remember { mutableStateOf<PrinterDriverProfile?>(null) }

    // Depois que o processo morre, o perfil USB continua salvo, mas o handle escolhido não: ele é
    // deliberadamente efêmero. Com mais de uma USB, entrar na tela precisa cair direto na lista que
    // recompõe esse vínculo, não mostrar uma impressora ativa sem nenhuma ação possível.
    LaunchedEffect(state, adopted) {
        if (state !is ThermalPrinterState.UsbCandidatesFound) return@LaunchedEffect
        val installedUsb = adopted.firstOrNull { it.active && it.transport == PrinterTransport.USB }
            ?: adopted.firstOrNull { it.transport == PrinterTransport.USB }
            ?: return@LaunchedEffect
        val profileId = installedUsb.profileId ?: return@LaunchedEffect
        selectedProfileId = profileId
        selectedConnection = PrinterConnectionChoice.USB
        temporaryDiscoveryProfile = null
        creatingProfile = false
        setupPath = PrinterSetupPath.SEARCH
    }

    /**
     * Largura do **primeiro** teste, antes de o assistente medir qualquer coisa.
     *
     * O estreito é o padrão seguro: cupom de 58 sai inteiro numa impressora de 80, e o contrário
     * corta na margem. Mas na bancada, testar uma de 80 mm e receber um papel que se anuncia
     * "Impressora temporária 58 mm" com meia largura parece defeito da impressora — então a
     * escolha fica à mão de quem está com o aparelho na frente.
     */
    var discoveryPaperWidthMm by remember { mutableIntStateOf(CONSERVATIVE_DISCOVERY_PAPER_WIDTH_MM) }
    var selectedSearchCandidate by remember { mutableStateOf<SelectedSearchCandidate?>(null) }
    var localNotice by remember { mutableStateOf<LocalNotice?>(null) }
    // A reconexão da ativação varre BLE por segundos; sem um sinal visível a tela parece travada.
    var connectingPrinter by remember { mutableStateOf<AdoptedPrinter?>(null) }
    // Testar a unidade parada conecta nela antes de imprimir, e depois devolve a conexão à ativa:
    // são duas varreduras, e o card precisa dizer que está trabalhando.
    var testingPrinter by remember { mutableStateOf<AdoptedPrinter?>(null) }
    var showLocalWifiConsent by remember { mutableStateOf(false) }
    var showAdvancedAddress by remember { mutableStateOf(false) }
    // Endereço e porta usam apenas `remember`: não atravessam processo, estado salvo ou disco.
    var advancedAddress by remember { mutableStateOf("") }
    var advancedPort by
        remember { mutableStateOf("") }
    var confirmationResolutionInProgress by remember(printer) { mutableStateOf(false) }
    var bluetoothPermissionRequestPending by remember { mutableStateOf(false) }
    var blePermissionDeniedForSearch by remember { mutableStateOf(false) }
    var fallbackBluetoothSearchCompleted by remember { mutableStateOf(false) }

    /**
     * A candidata USB cujo descritor contradiz a língua respondida, e a frase do aviso.
     *
     * Enquanto isto existe, **nada é enviado** àquela impressora. É o único ponto do fluxo em que
     * uma informação de graça — o `manufacturer_name` do descritor — chega depois da resposta
     * humana, e ela não tem autoridade para trocar a resposta: tem para interromper o teste e
     * mostrar a discordância a quem está com o aparelho na mão.
     */
    var usbDialectContradiction by remember { mutableStateOf<Pair<Long, String>?>(null) }

    fun returnToPreviousSetupScreen() {
        showAdvancedAddress = false
        when (setupPath) {
            PrinterSetupPath.PROFILE_LIST -> Unit
            PrinterSetupPath.MODEL_GRID,
            PrinterSetupPath.READY_PROFILE_CONNECTION,
            PrinterSetupPath.MANUAL_CONFIGURATION,
            -> {
                manualConfigurationTransport = null
                setupPath = PrinterSetupPath.PROFILE_LIST
            }
            PrinterSetupPath.NEW_PROFILE_DIALECT -> {
                setupPath = PrinterSetupPath.MODEL_GRID
            }
            PrinterSetupPath.NEW_PROFILE_CONNECTION -> {
                setupPath =
                    DialetoNaAdicaoDeImpressora.telaAoVoltarDaConexao(
                        doCard =
                            selectableProfiles
                                .firstOrNull { it.driver.id == selectedProfileId }
                                ?.driver
                                ?.dialect,
                    )
            }
            PrinterSetupPath.SEARCH -> {
                setupPath =
                    if (creatingProfile) {
                        PrinterSetupPath.NEW_PROFILE_CONNECTION
                    } else {
                        PrinterSetupPath.READY_PROFILE_CONNECTION
                    }
            }
        }
    }

    BackHandler(enabled = setupPath != PrinterSetupPath.PROFILE_LIST) {
        returnToPreviousSetupScreen()
    }

    val selectedProfile = selectableProfiles.firstOrNull { it.driver.id == selectedProfileId }

    /**
     * A língua que a descoberta vai falar com a impressora — ou `null` quando ninguém respondeu.
     *
     * Duas procedências, e nenhuma delas é padrão: o card do catálogo, para quem escolheu um
     * modelo, e a resposta da pergunta, para quem entrou por "Nova impressora". Aqui estava
     * `?: EscPosDialect.EPSON_COMPATIBLE`, em três lugares — e era esse `?:` que fazia uma Diebold
     * chegada por "Nova impressora" receber o prólogo ESC/POS na primeira tira.
     */
    val discoveryDialect: EscPosDialect? =
        DialetoNaAdicaoDeImpressora.daCandidata(
            doCard = selectedProfile?.driver?.dialect,
            respondido = newPrinterDialect,
        )
    val awaitingConfirmation = state is ThermalPrinterState.SearchConfirmationRequired
    val wifiCandidates =
        (state as? ThermalPrinterState.LocalWifiCandidatesFound)?.candidates.orEmpty()
    val usbCandidates = (state as? ThermalPrinterState.UsbCandidatesFound)?.candidates.orEmpty()
    val legacyBluetoothCandidates =
        (state as? ThermalPrinterState.BluetoothCandidatesFound)?.candidates.orEmpty()
    val bluetoothCandidates =
        when (bluetoothDiscovery) {
            BluetoothDiscoveryState.Idle -> legacyBluetoothCandidates
            is BluetoothDiscoveryState.Searching -> bluetoothDiscovery.candidates
            is BluetoothDiscoveryState.Finished -> bluetoothDiscovery.candidates
        }
    // Uma busca só entrega candidatas ao transporte que a pessoa escolheu. O estado do kit é um
    // só e sobrevive à troca de conexão: sem este filtro, as 29 candidatas de Bluetooth de uma
    // busca anterior ficavam na tela do Wi-Fi, e ainda faziam a tela achar que já tinha achado
    // algo — o botão de procurar desaparecia. Visto na bancada, nos três transportes.
    val listedCandidates =
        candidatesOfSelectedConnection(
            selectedConnection,
            bluetoothCandidates,
            usbCandidates,
            wifiCandidates,
        )
    val likelyBluetoothCandidateIds =
        when (bluetoothDiscovery) {
            BluetoothDiscoveryState.Idle -> emptySet()
            is BluetoothDiscoveryState.Searching -> bluetoothDiscovery.likelyCandidateIds
            is BluetoothDiscoveryState.Finished -> bluetoothDiscovery.likelyCandidateIds
        } +
            bluetoothCandidates
                .filter { candidate -> candidate.origin == BluetoothCandidateOrigin.SPP }
                .map { candidate -> candidate.id }
    val connectionProfile =
        if (creatingProfile) {
            temporaryDiscoveryProfile
        } else {
            selectedProfile?.driver
        }
    val creatingProfileForConfirmation =
        creatingProfile ||
            (awaitingConfirmation &&
                temporaryDiscoveryHost?.hasPendingTemporaryDiscoveryProfile() == true)

    LaunchedEffect(awaitingConfirmation, listedCandidates, selectedConnection) {
        if (!awaitingConfirmation) {
            confirmationResolutionInProgress = false
            val selectedStillListed =
                when (val selected = selectedSearchCandidate) {
                    is SelectedSearchCandidate.Bluetooth ->
                        listedCandidates.bluetooth.any { it.id == selected.candidate.id }
                    is SelectedSearchCandidate.Usb ->
                        listedCandidates.usb.any { it.id == selected.id }
                    is SelectedSearchCandidate.Wifi ->
                        listedCandidates.wifi.any { it.id == selected.id }
                    null -> true
                }
            // O callback de teste pode terminar depois que o cabo saiu. Nesse caso o core publica
            // USB indisponível e a lista some, mas a escolha Compose sobrevivia porque o booleano
            // `awaitingConfirmation` continuava falso. O botão Continuar então reaparecia para um
            // ID que já não existia e prendia a pessoa num ciclo de “enviar teste”.
            if (!selectedStillListed) {
                selectedSearchCandidate = null
            }
        }
    }

    val showConfirmation = awaitingConfirmation && !confirmationResolutionInProgress
    // Busca que terminou sem achar nada **não** é "Bluetooth não disponível": o rádio está ligado
    // e a busca concluiu. O estado do kit usa `BluetoothUnavailable` para as duas coisas, e no A10s
    // (Android 11, sem impressora pareada) a tela dizia "não disponível" logo acima de "Busca
    // concluída · 0 aparelhos" — duas frases se contradizendo no mesmo cartão.
    val bluetoothSearchEndedEmpty =
        selectedConnection == PrinterConnectionChoice.BLUETOOTH &&
            (
                (bluetoothDiscovery is BluetoothDiscoveryState.Finished &&
                    bluetoothDiscovery.candidates.isEmpty()) ||
                    (fallbackBluetoothSearchCompleted && bluetoothCandidates.isEmpty())
            )
    val presentation =
        if (bluetoothSearchEndedEmpty) {
            PrinterPresentation(
                NoticeTone.INFO,
                "Nenhuma encontrada",
                AndroidPrinterUiPolicy.NO_BLUETOOTH_PRINTER_MESSAGE,
            )
        } else {
            state.printerPresentation(selectedConnection)
        }
    val busy = state.isBusy()

    /**
     * Ocupação **desta** tela de instalação.
     *
     * A busca de outro transporte sobrevive à troca de conexão — é o mesmo estado único que já
     * fazia a tela do Wi-Fi anunciar candidatas Bluetooth —, e tratá-la como ocupação daqui
     * desabilitava a tela de um transporte por causa de uma varredura do outro. Envio e conexão em
     * curso continuam valendo em qualquer caminho, que é o que [belongsToSearchOf] devolve.
     */
    val busyHere = busy && state.belongsToSearchOf(selectedConnection)

    /**
     * De quem é a ocupação, quando há bytes a caminho.
     *
     * O estado do kit é um só e não diz em qual impressora ele está trabalhando; quem sabe é a
     * tela. Ativar mira a unidade tocada, o comprovante do card mira a unidade do card, e um cupom
     * do app hospedeiro vai para a ativa. Sem esta conta, `busy` desabilitava a lista inteira — foi
     * assim que a tela ficou cinza no iPhone 7 em 21/08, e aqui o defeito é o mesmo por
     * construção. Ver [PrinterUnitAvailability].
     */
    val sendingTransport =
        if (state.isSendingBytes()) {
            connectingPrinter?.transport
                ?: testingPrinter?.transport
                ?: adopted.firstOrNull { it.active }?.transport
        } else {
            null
        }

    fun activityOf(entry: AdoptedPrinter): PrinterUnitActivity =
        PrinterUnitActivity(
            isActive = entry.active,
            transportIsSending = sendingTransport?.sharesRadioWith(entry.transport) == true,
            receiptIsUnderwayOnTransport =
                testingPrinter?.transport?.sharesRadioWith(entry.transport) == true,
            setupIsOpen = awaitingConfirmation,
        )

    /**
     * Abaixo do Android 12 a busca só enxerga o que já está pareado. Se ela terminou sem nada, não
     * existe segunda tentativa possível: tocar em Procurar de novo gira em falso, e o único caminho
     * é parear nos Ajustes do sistema.
     *
     * Por isso os Ajustes abrem sozinhos **apenas aqui** — busca concluída, zero pareadas, versão
     * sem BLE. No Android 12 em diante a varredura acha impressora não pareada, e desviar a pessoa
     * para fora do app seria atrapalhar. A chave do efeito é a própria condição, então ele dispara
     * uma vez por busca e não reabre quando a pessoa volta.
     */
    var awaitingPairingReturn by remember { mutableStateOf(false) }
    LaunchedEffect(bluetoothSearchEndedEmpty) {
        if (!bluetoothSearchEndedEmpty) return@LaunchedEffect
        showSearchAgain = true
        if (Build.VERSION.SDK_INT >= AndroidPrinterUiPolicy.ANDROID_12_API) return@LaunchedEffect
        runCatching { context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }
            .onSuccess {
                awaitingPairingReturn = true
                localNotice =
                    LocalNotice(
                        "Pareie a impressora nos Ajustes",
                        "Nesta versão do Android só aparecem impressoras já pareadas. Pareie por " +
                            "lá e volte: a busca recomeça sozinha.",
                        NoticeTone.INFO,
                    )
            }
    }


    fun unavailableNotice() {
        localNotice =
            LocalNotice(
                "Impressora indisponível",
                "A impressora ainda não está disponível neste aparelho.",
                NoticeTone.WARNING,
            )
    }

    /**
     * A recusa de procurar sem saber a língua, e **nada foi enviado** é o que ela precisa dizer.
     *
     * É a rede de segurança de um caminho que não deveria existir: a pergunta vem antes desta
     * tela. Se um caminho novo chegar aqui sem resposta, ele encontra recusa em vez do
     * `EPSON_COMPATIBLE` silencioso que estava aqui — o tom é `DANGER` pela mesma razão da
     * `DialectNotSupported` do kit, que tampa aberta e falta de papel a pessoa resolve e repete, e
     * esta não tem repetição que resolva.
     */
    fun unansweredDialectNotice() {
        localNotice =
            LocalNotice(
                "Falta dizer a língua da impressora",
                "Nada foi enviado. Volte e responda em que língua ela fala antes de procurar — " +
                    "mandar ESC/POS para uma Diebold trava o aparelho, e só desligar e ligar recupera.",
                NoticeTone.DANGER,
            )
    }

    fun discardPendingSearch() {
        if (!awaitingConfirmation || confirmationResolutionInProgress) return
        val currentPrinter = printer ?: return
        confirmationResolutionInProgress = true
        localNotice =
            LocalNotice(
                title = "Impressora não selecionada",
                body = "Escolha outra candidata ou procure novamente.",
                tone = NoticeTone.WARNING,
            )
        scope.launch {
            val transport = selectedSearchCandidate?.transport ?: selectedConnection?.discoveryTransport()
            val result =
                if (transport == null) {
                    // Compatibilidade para hosts que só publicam o estado de confirmação. O host
                    // completo sempre conhece a conexão e preserva a lista pelo método novo.
                    runPrinterCall { currentPrinter.discardSearchedPrinter() }
                } else {
                    runPrinterCall { currentPrinter.returnToSearchedPrinters(transport) }
                }
            if (
                result.isFailure ||
                    currentPrinter.state.value is ThermalPrinterState.SearchConfirmationRequired
            ) {
                confirmationResolutionInProgress = false
                localNotice =
                    LocalNotice(
                        title = "Confirmação pendente",
                        body = "Não foi possível descartar esta impressora. Tente responder novamente.",
                        tone = NoticeTone.WARNING,
                    )
            } else {
                confirmationResolutionInProgress = false
                showSearchAgain = true
            }
        }
    }

    fun searchLocalWifi() {
        val currentPrinter = printer ?: return unavailableNotice()
        val profile = connectionProfile ?: return unavailableNotice()
        selectedSearchCandidate = null
        localNotice = null
        scope.launch {
            // Wi-Fi da impressora e rede do local emitem os mesmos bytes, mas se procuram de
            // formas opostas: no primeiro a impressora é o ponto de acesso, e portanto o gateway;
            // no segundo o gateway é o roteador do estabelecimento, que não se deve sondar.
            val attachment =
                if (selectedConnection == PrinterConnectionChoice.DIRECT_WIFI) {
                    PrinterNetworkAttachment.DIRECT_AP
                } else {
                    PrinterNetworkAttachment.ROUTER_LAN
                }
            val result = runPrinterCall { currentPrinter.searchLocalWifi(profile.id, attachment) }
            showSearchAgain = result.getOrNull() != ThermalPrintResult.Printed
            localNotice =
                result.searchNotice(
                    success = "Escolha uma impressora encontrada e envie o comprovante de teste.",
                    thrownFailure =
                        "Não foi possível procurar na rede Wi-Fi. Confira a conexão e tente novamente.",
                )
        }
    }

    fun searchUsb() {
        val currentPrinter = printer ?: return unavailableNotice()
        val profile = connectionProfile ?: return unavailableNotice()
        selectedSearchCandidate = null
        localNotice = null
        scope.launch {
            val result = runPrinterCall { currentPrinter.searchUsb(profile.id) }
            showSearchAgain = result.getOrNull() != ThermalPrintResult.Printed
            localNotice =
                result.searchNotice(
                    success = "Escolha a impressora USB e autorize o comprovante de teste.",
                    thrownFailure =
                        "Não foi possível procurar impressoras USB. Confira o cabo ou hub de dados.",
                )
        }
    }

    fun searchBluetooth() {
        val currentPrinter = printer ?: return unavailableNotice()
        val pairedProfile =
            if (creatingProfile) {
                // Sem dialeto respondido não se monta candidata nenhuma. Ver `discoveryDialect`:
                // aqui estava `?: EPSON_COMPATIBLE`, e era por ele que uma Diebold chegada por
                // "Nova impressora" recebia o prólogo ESC/POS.
                val dialeto = discoveryDialect ?: return unansweredDialectNotice()
                temporaryDiscoveryHost?.prepareTemporaryDiscoveryProfile(
                    transport = PrinterTransport.BLUETOOTH,
                    paperWidthMm = discoveryPaperWidthMm,
                    displayName = selectedProfile?.driver?.displayName,
                    // Sem isto a escolha do catalogo nao chega ao fio: o comprovante de teste da
                    // Diebold saia em ESC/POS mesmo com o card Procomp selecionado, e travava o
                    // aparelho. Medido em 24/08/2026 pelo digest do payload.
                    dialect = dialeto,
                )
            } else {
                connectionProfile?.takeIf { it.supports(PrinterTransport.BLUETOOTH) }
            }
        val bleProfile =
            if (Build.VERSION.SDK_INT < AndroidPrinterUiPolicy.ANDROID_12_API) {
                null
            } else if (creatingProfile) {
                val dialeto = discoveryDialect ?: return unansweredDialectNotice()
                temporaryDiscoveryHost?.prepareTemporaryDiscoveryProfile(
                    transport = PrinterTransport.BLUETOOTH_LE,
                    paperWidthMm = discoveryPaperWidthMm,
                    displayName = selectedProfile?.driver?.displayName,
                    // Sem isto a escolha do catalogo nao chega ao fio: o comprovante de teste da
                    // Diebold saia em ESC/POS mesmo com o card Procomp selecionado, e travava o
                    // aparelho. Medido em 24/08/2026 pelo digest do payload.
                    dialect = dialeto,
                )
            } else {
                connectionProfile?.takeIf { it.supports(PrinterTransport.BLUETOOTH_LE) }
            }
        if (pairedProfile == null && bleProfile == null) return unavailableNotice()
        selectedSearchCandidate = null
        localNotice = null
        fallbackBluetoothSearchCompleted = false
        scope.launch {
            val result =
                if (bluetoothDiscoveryHost != null) {
                    runPrinterCall {
                        bluetoothDiscoveryHost.searchBluetoothPrinters(
                            pairedProfileId = pairedProfile?.id,
                            bleProfileId = bleProfile?.id,
                            scanBle = bleProfile != null && !blePermissionDeniedForSearch,
                        )
                    }
                } else {
                    // Compatibilidade para implementações históricas de ThermalPrinter. O app
                    // produtivo usa BluetoothDiscoveryHost e recebe a lista realmente mesclada.
                    runPrinterCall {
                        when {
                            pairedProfile != null -> currentPrinter.searchBluetooth(pairedProfile.id)
                            bleProfile != null && !blePermissionDeniedForSearch ->
                                currentPrinter.searchBluetoothLe(bleProfile.id)
                            else ->
                                ThermalPrintResult.Failed(
                                    ThermalPrinterState.BluetoothPermissionDenied.message,
                                    ThermalPrinterState.BluetoothPermissionDenied,
                                )
                        }
                    }.also { fallbackBluetoothSearchCompleted = true }
                }

            val finished = bluetoothDiscoveryHost?.bluetoothDiscovery?.value
                as? BluetoothDiscoveryState.Finished
            val candidatesFound = finished?.candidates?.size ?: bluetoothCandidates.size
            val pairedPermissionDenied =
                finished?.pairedFailure == ThermalPrinterState.BluetoothPermissionDenied
            val blePermissionDenied =
                blePermissionDeniedForSearch ||
                    finished?.bleFailure == ThermalPrinterState.BluetoothPermissionDenied
            showSearchAgain = candidatesFound == 0 || result.getOrNull() != ThermalPrintResult.Printed
            localNotice =
                when {
                    result.isFailure ->
                        LocalNotice(
                            "Busca Bluetooth interrompida",
                            "Não foi possível concluir a busca Bluetooth. Tente novamente.",
                            NoticeTone.WARNING,
                        )
                    candidatesFound > 0 && (pairedPermissionDenied || blePermissionDenied) ->
                        LocalNotice(
                            "Busca concluída com acesso parcial",
                            "$candidatesFound ${bluetoothDeviceCountLabel(candidatesFound)}. " +
                                "Uma das buscas não teve permissão Bluetooth.",
                            NoticeTone.WARNING,
                        )
                    candidatesFound > 0 ->
                        LocalNotice(
                            "Busca Bluetooth concluída",
                            "$candidatesFound ${bluetoothDeviceCountLabel(candidatesFound)}. " +
                                "Escolha uma e envie o comprovante de teste.",
                            NoticeTone.INFO,
                        )
                    pairedPermissionDenied || blePermissionDenied ->
                        LocalNotice(
                            "Nenhuma impressora encontrada",
                            "Não há impressora SPP pareada disponível e a busca BLE não teve " +
                                "permissão. Autorize o Bluetooth e tente novamente.",
                            NoticeTone.WARNING,
                        )
                    // A pílula e a mensagem de estado já dizem isto; repetir palavra por palavra
                    // num cartão logo abaixo foi o que o A10s mostrou.
                    else -> null
                }
        }
    }

    val bluetoothPermissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            bluetoothPermissionRequestPending = false
            val granted = context.grantedBluetoothPermissions()
            val pairedAccess =
                AndroidPrinterUiPolicy.bluetoothAccess(
                    apiLevel = Build.VERSION.SDK_INT,
                    operation = BluetoothUiOperation.PAIRED_SPP,
                    grantedPermissions = granted,
                )
            if (pairedAccess != BluetoothUiAccess.Allowed) {
                showSearchAgain = true
                localNotice =
                    LocalNotice(
                        "Acesso Bluetooth não permitido",
                        "Autorize os dispositivos por perto para consultar impressoras pareadas.",
                        NoticeTone.WARNING,
                    )
            } else {
                blePermissionDeniedForSearch =
                    AndroidPrinterUiPolicy.bluetoothAccess(
                        apiLevel = Build.VERSION.SDK_INT,
                        operation = BluetoothUiOperation.BLE_SCAN,
                        grantedPermissions = granted,
                    ) is BluetoothUiAccess.MissingPermissions
                searchBluetooth()
            }
        }

    fun requestBluetooth() {
        val granted = context.grantedBluetoothPermissions()
        val operations =
            if (Build.VERSION.SDK_INT >= AndroidPrinterUiPolicy.ANDROID_12_API) {
                listOf(BluetoothUiOperation.PAIRED_SPP, BluetoothUiOperation.BLE_SCAN)
            } else {
                listOf(BluetoothUiOperation.PAIRED_SPP)
            }
        val missing =
            operations
                .map {
                    AndroidPrinterUiPolicy.bluetoothAccess(
                        apiLevel = Build.VERSION.SDK_INT,
                        operation = it,
                        grantedPermissions = granted,
                    )
                }.filterIsInstance<BluetoothUiAccess.MissingPermissions>()
                .flatMap { it.permissions }
                .toSet()
        if (missing.isEmpty()) {
            blePermissionDeniedForSearch = false
            searchBluetooth()
        } else {
            bluetoothPermissionRequestPending = true
            bluetoothPermissionLauncher.launch(missing.toTypedArray())
        }
    }

    /**
     * Voltar dos Ajustes recomeça a busca sozinho.
     *
     * Sem isto, a pessoa pareava a impressora, voltava e encontrava a mesma tela de antes — que diz
     * "nenhuma encontrada". Ou ela acha que já está conectada, ou não descobre que precisa tocar em
     * Procurar de novo. Nós é que a mandamos para fora do app; refazer a busca na volta é parte da
     * mesma tarefa, não uma segunda que sobra para ela.
     */
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, awaitingPairingReturn) {
        val observer =
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME && awaitingPairingReturn) {
                    awaitingPairingReturn = false
                    localNotice = null
                    requestBluetooth()
                }
            }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    /**
     * O comprovante sai **na unidade do card tocado**.
     *
     * Por transporte não serve: com duas instaladas no mesmo meio físico, ele alcança a que está
     * conectada — a ativa — e o papel sai na impressora que ninguém pediu. O fallback por
     * transporte fica só para o contrato que ainda permite instalação sem id.
     */
    fun testAdoptedPrinter(installed: AdoptedPrinter) {
        val currentPrinter = printer ?: return unavailableNotice()
        localNotice = null
        testingPrinter = installed
        scope.launch {
            val installationId = installed.installationId
            val result =
                if (installationId == null) {
                    runPrinterCall { currentPrinter.testPrinter(installed.transport) }
                } else {
                    runPrinterCall { currentPrinter.testInstallation(installationId) }
                }
            testingPrinter = null
            localNotice =
                result.printNotice(
                    success = "Comprovante enviado. Confira se o papel saiu.",
                    thrownFailure = "Não foi possível enviar o comprovante de teste.",
                )
        }
    }

    fun runPreliminaryTest(test: PendingPreliminaryTest) {
        val currentPrinter = printer ?: return unavailableNotice()
        if (preliminaryTestInProgress) return
        preliminaryTestInProgress = true
        localNotice = null
        scope.launch {
            val result =
                runPrinterCall {
                    when (test) {
                        is PendingPreliminaryTest.Candidate ->
                            when (val candidate = test.candidate) {
                                is SelectedSearchCandidate.Bluetooth ->
                                    when (candidate.candidate.origin) {
                                        BluetoothCandidateOrigin.SPP ->
                                            currentPrinter.testSearchedBluetoothPrinter(
                                                candidate.candidate.id,
                                            )
                                        BluetoothCandidateOrigin.BLE ->
                                            currentPrinter.testSearchedBluetoothLePrinter(
                                                candidate.candidate.id,
                                            )
                                    }
                                is SelectedSearchCandidate.Usb ->
                                    currentPrinter.testSearchedUsbPrinter(candidate.id)
                                is SelectedSearchCandidate.Wifi ->
                                    currentPrinter.testSearchedLocalWifiPrinter(candidate.id)
                            }
                        is PendingPreliminaryTest.ManualAddress ->
                            currentPrinter.testLocalWifiAddress(
                                profileId = test.profileId,
                                address = test.address,
                                port = test.port,
                            )
                    }
                }
            val printed = result.getOrNull() == ThermalPrintResult.Printed
            if (!printed) {
                val transport = test.transport
                runPrinterCall { currentPrinter.returnToSearchedPrinters(transport) }
                showSearchAgain = true
            }
            preliminaryTestInProgress = false
            localNotice =
                result.printNotice(
                    success = "Teste enviado. Confira se o papel saiu.",
                    thrownFailure = "Não foi possível testar esta impressora.",
                )
        }
    }

    LaunchedEffect(setupPath, automaticSearchPending) {
        if (setupPath != PrinterSetupPath.SEARCH || !automaticSearchPending) return@LaunchedEffect
        automaticSearchPending = false
        showSearchAgain = false
        when (selectedConnection) {
            PrinterConnectionChoice.USB -> searchUsb()
            PrinterConnectionChoice.BLUETOOTH -> requestBluetooth()
            PrinterConnectionChoice.DIRECT_WIFI,
            PrinterConnectionChoice.LOCAL_NETWORK,
            -> showLocalWifiConsent = true
            null -> Unit
        }
    }

    Card(
        modifier = modifier.fillMaxWidth().testTag("thermal-printer.card"),
        colors =
            CardDefaults.cardColors(
                containerColor = theme.cardContainerColor,
                contentColor = theme.cardContentColor,
            ),
        border = if (theme.usesPrintherLayout) null else BorderStroke(1.dp, theme.outlineColor),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(if (theme.usesPrintherLayout) 0.dp else 18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when (setupPath) {
                PrinterSetupPath.PROFILE_LIST -> {
                    SectionHeading(
                        title = "Impressoras",
                        supportingText = if (theme.usesPrintherLayout) "" else "Escolha uma impressora testada ou configure uma nova.",
                        theme = theme,
                    )
                    AdoptedPrinterRows(
                        adopted = adopted,
                        activityOf = ::activityOf,
                        testing = testingPrinter,
                        theme = theme,
                        onActivate = { installed ->
                            val currentPrinter = printer ?: return@AdoptedPrinterRows
                            localNotice = null
                            connectingPrinter = installed
                            scope.launch {
                                // Por instalação, não por perfil: com duas unidades do mesmo
                                // modelo, o perfil não diz qual delas a pessoa tocou.
                                val installationId = installed.installationId
                                val result =
                                    if (installationId == null) {
                                        runPrinterCall { currentPrinter.activatePrinter(installed.transport) }
                                    } else {
                                        runPrinterCall { currentPrinter.activateInstallation(installationId) }
                                    }
                                connectingPrinter = null
                                if (result.isFailure) {
                                    localNotice =
                                        LocalNotice(
                                            title = "Não foi possível conectar",
                                            body =
                                                "${installed.displayName} ficou como escolhida, mas a conexão " +
                                                    "falhou. Confira se ela está ligada e faça um teste.",
                                            tone = NoticeTone.WARNING,
                                        )
                                }
                            }
                        },
                        onTest = ::testAdoptedPrinter,
                        onEdit = { installed ->
                            val currentPrinter = printer
                            if (currentPrinter != null) {
                                connectingPrinter = installed
                                scope.launch {
                                    installed.installationId?.let { installationId ->
                                        runPrinterCall {
                                            currentPrinter.activateInstallation(installationId)
                                        }
                                    }
                                    connectingPrinter = null
                                    manualConfigurationTransport = installed.transport
                                    setupPath = PrinterSetupPath.MANUAL_CONFIGURATION
                                }
                            }
                        },
                        onRemove = { printerToRemove = it },
                    )
                    if (adopted.isEmpty()) {
                        NoticeCard(
                            title = "Você ainda não adicionou uma impressora",
                            body = "Toque em Adicionar impressora para começar.",
                            tone = NoticeTone.INFO,
                            theme = theme,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Button(
                        onClick = {
                            selectedProfileId = null
                            selectedConnection = null
                            temporaryDiscoveryProfile = null
                            creatingProfile = false
                            setupPath = PrinterSetupPath.MODEL_GRID
                        },
                        // Saída de emergência: com a ativa inalcançável, é por aqui que a pessoa
                        // volta a ter impressora. Nunca desabilita.
                        enabled = PrinterUnitAvailability.allowsAddingPrinter(PrinterUnitActivity()),
                        modifier = Modifier.fillMaxWidth().testTag("thermal-printer.add"),
                        colors =
                            ButtonDefaults.buttonColors(
                                containerColor = theme.accentColor,
                                contentColor = theme.onAccentColor,
                            ),
                    ) {
                        if (theme.usesPrintherLayout) {
                            Icon(Icons.Outlined.Add, contentDescription = null)
                            Spacer(Modifier.width(10.dp))
                        }
                        Text("Adicionar impressora")
                    }
                }
                PrinterSetupPath.NEW_PROFILE_DIALECT -> {
                    SectionHeading(
                        title = "Em que língua ela fala?",
                        supportingText =
                            "Esta é a única pergunta cujo erro não custa papel: custa a impressora parada.",
                        theme = theme,
                    )
                    Text(
                        DialetoNoBalcao.pergunta(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = theme.cardContentColor.copy(alpha = 0.78f),
                    )
                    DialetoNoBalcao.ordem.forEach { dialeto ->
                        OutlinedButton(
                            onClick = {
                                newPrinterDialect = dialeto
                                setupPath = PrinterSetupPath.NEW_PROFILE_CONNECTION
                            },
                            enabled = !busyHere && !awaitingConfirmation,
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.dialect-${dialeto.name.lowercase()}"),
                        ) {
                            Row(
                                modifier =
                                    Modifier
                                        .fillMaxWidth()
                                        .height(if (theme.usesPrintherLayout) 86.dp else 52.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(18.dp),
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        DialetoNoBalcao.rotulo(dialeto),
                                        fontWeight = FontWeight.SemiBold,
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                    Text(
                                        DialetoNoBalcao.explicacao(dialeto),
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                }
                            }
                        }
                    }
                    // A saída de quem não sabe, e ela não gasta byte nosso: o autoteste é dela.
                    // Qualquer sonda que mandássemos precisaria escolher um dialeto antes de saber
                    // qual é — que é exatamente a pergunta desta tela.
                    NoticeCard(
                        title = DialetoNoBalcao.COMO_DESCOBRIR_TITULO,
                        body = DialetoNoBalcao.comoDescobrir(),
                        tone = NoticeTone.INFO,
                        theme = theme,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .testTag("thermal-printer.dialect-how"),
                    )
                    // Voltar é desistir da medição, e não escolher o padrão: quem não respondeu
                    // não escolheu. É a mesma regra do `JOptionPane` fechado no Windows.
                    TextButton(
                        onClick = ::returnToPreviousSetupScreen,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .testTag("thermal-printer.dialect-back"),
                    ) {
                        Text("Voltar")
                    }
                }
                PrinterSetupPath.READY_PROFILE_CONNECTION,
                PrinterSetupPath.NEW_PROFILE_CONNECTION,
                -> {
                    val profile = selectedProfile?.driver
                    SectionHeading(
                        title = "Adicionar impressora",
                        supportingText = "Como essa impressora se liga ao celular?",
                        theme = theme,
                    )
                    if (!creatingProfile && selectedProfile != null) {
                        NoticeCard(
                            title = selectedProfile.driver.displayName,
                            body = selectedProfile.badge,
                            tone = NoticeTone.INFO,
                            theme = theme,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        selectedProfile.measuredProfile?.let { measuredProfile ->
                            profileActions?.invoke(measuredProfile)
                        }
                    }
                    PrinterConnectionChoice.values()
                        .filter { choice ->
                            creatingProfile ||
                                profile?.let {
                                    choice.supports(it, Build.VERSION.SDK_INT)
                                } == true
                        }
                        .forEach { choice ->
                            OutlinedButton(
                                onClick = {
                                    // A conferência da língua vem **antes de qualquer estado
                                    // mudar**. Sem língua respondida, esta tela não monta
                                    // candidata: ela devolve a pessoa à pergunta, e devolve com a
                                    // tela intacta — mexer no transporte escolhido e na largura
                                    // para depois desistir deixaria meia escolha registrada.
                                    //
                                    // Aqui estava `?: EscPosDialect.EPSON_COMPATIBLE`, e é este o
                                    // ponto por onde TODA busca passa: o `?:` alcançava os quatro
                                    // transportes de uma vez.
                                    val dialetoDaDescoberta = discoveryDialect
                                    if (
                                        creatingProfile &&
                                        DialetoNaAdicaoDeImpressora.faltaPerguntar(
                                            doCard = selectedProfile?.driver?.dialect,
                                            respondido = newPrinterDialect,
                                        )
                                    ) {
                                        setupPath = PrinterSetupPath.NEW_PROFILE_DIALECT
                                        return@OutlinedButton
                                    }
                                    selectedConnection = choice
                                    selectedSearchCandidate = null
                                    // A largura volta ao palpite seguro a cada impressora nova.
                                    // Ela não é medição: carregá-la de uma impressora para a
                                    // seguinte foi como a T210 ganhou 80 mm e 48 colunas depois de
                                    // a bancada medir a LUOGAO — e o papel dela quebrou "impressor
                                    // / a" no meio da palavra, porque a firmware tem 32.
                                    discoveryPaperWidthMm =
                                        selectedProfile
                                            ?.takeIf { creatingProfile && it.source == PrinterProfileSource.BUNDLED }
                                            ?.paperWidthMm
                                            ?: CONSERVATIVE_DISCOVERY_PAPER_WIDTH_MM
                                    temporaryDiscoveryProfile =
                                        if (creatingProfile && dialetoDaDescoberta != null) {
                                            temporaryDiscoveryHost?.prepareTemporaryDiscoveryProfile(
                                                transport = choice.discoveryTransport(),
                                                paperWidthMm = discoveryPaperWidthMm,
                                                displayName = selectedProfile?.driver?.displayName,
                                                dialect = dialetoDaDescoberta,
                                            )
                                        } else {
                                            null
                                        }
                                    advancedPort =
                                        if (creatingProfile) {
                                            temporaryDiscoveryProfile?.tcpPort
                                                ?.toString()
                                                .orEmpty()
                                        } else {
                                            profile?.tcpPort?.toString().orEmpty()
                                        }
                                    automaticSearchPending = true
                                    showSearchAgain = false
                                    setupPath = PrinterSetupPath.SEARCH
                                },
                                enabled = !busyHere && !awaitingConfirmation,
                                modifier =
                                    Modifier
                                        .fillMaxWidth()
                                        .testTag("thermal-printer.connection-${choice.slug}"),
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().height(if (theme.usesPrintherLayout) 86.dp else 52.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(18.dp),
                                ) {
                                    if (theme.usesPrintherLayout) {
                                        Icon(
                                            imageVector = when (choice) {
                                                PrinterConnectionChoice.USB -> Icons.Outlined.Cable
                                                PrinterConnectionChoice.BLUETOOTH -> Icons.Outlined.Bluetooth
                                                PrinterConnectionChoice.DIRECT_WIFI -> Icons.Outlined.Wifi
                                                PrinterConnectionChoice.LOCAL_NETWORK -> Icons.Outlined.Router
                                            },
                                            contentDescription = null,
                                            modifier = Modifier.size(38.dp),
                                        )
                                    }
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(choice.title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                                        Text(choice.explanation, style = MaterialTheme.typography.bodyMedium)
                                    }
                                }
                            }
                        }
                    Text(
                        "Não sabe? Comece pelo Bluetooth.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(
                        onClick = ::returnToPreviousSetupScreen,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .testTag("thermal-printer.connection-back"),
                    ) {
                        Text("Voltar")
                    }
                }
                PrinterSetupPath.MANUAL_CONFIGURATION -> {
                    val currentPrinter = printer
                    val currentHost = homologationHost
                    val currentTransport = manualConfigurationTransport
                    if (currentPrinter != null && currentHost != null && currentTransport != null) {
                        PrinterManualConfigurationContent(
                            printer = currentPrinter,
                            store = currentHost.profileStore,
                            transport = currentTransport,
                            theme = theme,
                            onSaved = {
                                onProfilesChanged()
                                manualConfigurationTransport = null
                                setupPath = PrinterSetupPath.PROFILE_LIST
                            },
                            onBack = {
                                manualConfigurationTransport = null
                                setupPath = PrinterSetupPath.PROFILE_LIST
                            },
                        )
                    } else {
                        NoticeCard(
                            title = "Configuração indisponível",
                            body = "Não foi possível abrir os dados desta impressora.",
                            tone = NoticeTone.WARNING,
                            theme = theme,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        TextButton(
                            onClick = { setupPath = PrinterSetupPath.PROFILE_LIST },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Voltar") }
                    }
                }
                PrinterSetupPath.MODEL_GRID -> {
                    KnownPrinterGrid(
                        profiles = selectableProfiles.filter { it.source == PrinterProfileSource.BUNDLED },
                        theme = theme,
                        onSelect = { profile ->
                            // Os cards são catálogo visual, não configuração homologada. Cada
                            // modelo volta a passar pelas sondas antes de ser instalado.
                            creatingProfile = true
                            selectedProfileId = profile.driver.id
                            discoveryPaperWidthMm = profile.paperWidthMm
                            advancedPort = ""
                            // O card responde a pergunta de dialeto sozinho — quem escolhe a
                            // Diebold IM453H escolhe junto o `PROCOMP_ESC_P`. A resposta anterior
                            // sai de cena para não sobreviver a uma segunda impressora.
                            newPrinterDialect = null
                            setupPath =
                                DialetoNaAdicaoDeImpressora.telaDepoisDaGrade(profile.driver.dialect)
                        },
                        onNew = {
                            selectedProfileId = null
                            creatingProfile = true
                            // Sem card não há quem responda pela pessoa: é este caminho que caía
                            // em `EPSON_COMPATIBLE` silencioso, e é por isso que ele passa a
                            // perguntar antes de qualquer transporte ser escolhido.
                            newPrinterDialect = null
                            setupPath = DialetoNaAdicaoDeImpressora.telaDepoisDaGrade(doCard = null)
                        },
                        onBack = ::returnToPreviousSetupScreen,
                    )
                }
                PrinterSetupPath.SEARCH -> {
                    val connection = selectedConnection
                    SectionHeading(
                        title = "Procurar impressora",
                        supportingText =
                            if (connection == null) {
                                "Escolha como a impressora está conectada."
                            } else {
                                "Procurando por ${connection.searchLabel}."
                            },
                        theme = theme,
                    )
                    if (theme.usesPrintherLayout && connection == PrinterConnectionChoice.BLUETOOTH) {
                        PrinterSearchRadar(theme)
                    }
                    StatusPill(presentation.tone, presentation.label, theme)
                    Text(
                        presentation.message,
                        style = MaterialTheme.typography.bodySmall,
                        color = theme.cardContentColor.copy(alpha = 0.78f),
                    )
                    localNotice?.let { notice ->
                        NoticeCard(
                            title = notice.title,
                            body = notice.body,
                            tone = notice.tone,
                            theme = theme,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (
                        connection == PrinterConnectionChoice.BLUETOOTH &&
                            Build.VERSION.SDK_INT < AndroidPrinterUiPolicy.ANDROID_12_API
                    ) {
                        NoticeCard(
                            title = "Busca Bluetooth limitada",
                            body =
                                "A busca BLE não está disponível nesta versão do Android. " +
                                    "Vamos mostrar somente impressoras SPP já pareadas.",
                            tone = NoticeTone.WARNING,
                            theme = theme,
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.bluetooth-legacy-limit"),
                        )
                    }
                    if (
                        connection == PrinterConnectionChoice.BLUETOOTH &&
                            bluetoothDiscovery is BluetoothDiscoveryState.Searching
                    ) {
                        BluetoothSearchProgress(
                            count = bluetoothDiscovery.candidates.size,
                            finished = false,
                            theme = theme,
                        )
                    }
                    if (
                        connection == PrinterConnectionChoice.BLUETOOTH &&
                            bluetoothDiscovery is BluetoothDiscoveryState.Finished
                    ) {
                        BluetoothSearchProgress(
                            count = bluetoothDiscovery.candidates.size,
                            finished = true,
                            theme = theme,
                        )
                    }
                    if (preliminaryTestInProgress) {
                        LinearProgressIndicator(
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.preliminary-test-progress"),
                            color = theme.accentColor,
                        )
                        Text(
                            "Enviando o comprovante de teste…",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.testTag("thermal-printer.preliminary-test-message"),
                        )
                    }
                    // Achar uma não encerra a procura. Quem pareia uma impressora nova nos Ajustes
                    // e volta precisa procurar de novo — e o botão sumia justamente porque a lista
                    // já tinha a antiga. Visto no A10s: a T210 na lista, a MTP-II recém-pareada
                    // invisível, e nenhuma forma de mandar procurar outra vez.
                    val searchEnabled =
                        connectionProfile != null &&
                            !busyHere &&
                            !preliminaryTestInProgress &&
                            !bluetoothPermissionRequestPending &&
                            !awaitingConfirmation
                    if (showSearchAgain && connection == PrinterConnectionChoice.BLUETOOTH) {
                        // A tag histórica da antiga ação BLE passa a apontar semanticamente
                        // para o único botão Bluetooth, sem criar um segundo controle visual.
                        Box(
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.search-bluetooth-le")
                                    .semantics {
                                        onClick {
                                            if (searchEnabled) requestBluetooth()
                                            searchEnabled
                                        }
                                    },
                        ) {
                            SearchButton(
                                choice = connection,
                                state = state,
                                enabled = searchEnabled,
                                theme = theme,
                                searchLocalWifi = { showLocalWifiConsent = true },
                                searchUsb = ::searchUsb,
                                searchBluetooth = ::requestBluetooth,
                            )
                        }
                    } else if (showSearchAgain) {
                        SearchButton(
                            choice = connection,
                            state = state,
                            enabled = searchEnabled,
                            theme = theme,
                            searchLocalWifi = { showLocalWifiConsent = true },
                            searchUsb = ::searchUsb,
                            searchBluetooth = ::requestBluetooth,
                        )
                    }
                    val bluetoothSearchFinishedEmpty =
                        connection == PrinterConnectionChoice.BLUETOOTH &&
                            (
                                bluetoothDiscovery is BluetoothDiscoveryState.Finished ||
                                    fallbackBluetoothSearchCompleted
                            )
                    if (bluetoothSearchFinishedEmpty) {
                        OutlinedButton(
                            onClick = {
                                runCatching {
                                    context.startActivity(
                                        Intent(Settings.ACTION_BLUETOOTH_SETTINGS),
                                    )
                                }.onFailure {
                                    localNotice =
                                        LocalNotice(
                                            "Ajustes indisponíveis",
                                            "Não foi possível abrir os Ajustes de Bluetooth.",
                                            NoticeTone.WARNING,
                                        )
                                }
                            },
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.open-bluetooth-settings"),
                        ) {
                            Text("Abrir Ajustes de Bluetooth")
                        }
                    }
                    // Cada lista pertence ao seu transporte. Sem este filtro, o resultado de uma
                    // busca anterior continuava na tela depois de trocar de conexão: quem escolhia
                    // Wi-Fi, rede local ou USB via a lista do Bluetooth sob o título "Procurando
                    // por Wi-Fi da impressora". Visto na bancada, nos três transportes.
                    BluetoothCandidateRows(
                        candidates = listedCandidates.bluetooth,
                        likelyCandidateIds = likelyBluetoothCandidateIds,
                        selectedId =
                            (selectedSearchCandidate as? SelectedSearchCandidate.Bluetooth)
                                ?.candidate
                                ?.id,
                        enabled = !busyHere && !preliminaryTestInProgress && !awaitingConfirmation,
                        theme = theme,
                        onSelect = { candidate ->
                            val selected = SelectedSearchCandidate.Bluetooth(candidate)
                            selectedSearchCandidate = selected
                            runPreliminaryTest(PendingPreliminaryTest.Candidate(selected))
                        },
                        selectedAction = {},
                    )
                    // O aviso pertence a UMA candidata, e vive enquanto ela estiver na lista.
                    //
                    // Sem este `takeIf` ele era estado sem dono: `remember` sem chave, anulado só
                    // por gesto sobre o próprio cartão. Ele vazava para o Bluetooth e para a
                    // impressora seguinte — e, pior, o `Long` guardado **morre em toda re-busca**:
                    // `nextHandleId` é um `AtomicLong` de instância que nunca reinicia, então a
                    // mesma impressora física ganha id novo a cada `discover`, e "Imprimir mesmo
                    // assim" remontaria uma candidata que não existe.
                    //
                    // `listedCandidates.usb` já é filtrado por `selectedConnection`, então um
                    // predicado só cobre os dois casos. Mesmo idioma de auto-supressão do
                    // `UsbCandidateRows`.
                    usbDialectContradiction
                        ?.takeIf { (candidateId, _) ->
                            listedCandidates.usb.any { it.id == candidateId }
                        }
                        ?.let { (candidateId, aviso) ->
                        NoticeCard(
                            title = "Confira a língua desta impressora",
                            body = aviso,
                            tone = NoticeTone.DANGER,
                            theme = theme,
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.usb-dialect-contradiction"),
                        )
                        if (creatingProfile) {
                            OutlinedButton(
                                onClick = {
                                    usbDialectContradiction = null
                                    // Soltar o card é parte de responder de novo. `daCandidata` é
                                    // `doCard ?: respondido` — o card vence, de propósito —, então
                                    // sem esta linha a pessoa responderia "Diebold Procomp" e o fio
                                    // continuaria em ESC/POS, com a tela aceitando a resposta e
                                    // jogando fora. Quem desdiz o card fica sem card.
                                    selectedProfileId = null
                                    newPrinterDialect = null
                                    temporaryDiscoveryProfile = null
                                    setupPath = PrinterSetupPath.NEW_PROFILE_DIALECT
                                },
                                modifier =
                                    Modifier
                                        .fillMaxWidth()
                                        .testTag("thermal-printer.usb-dialect-reanswer"),
                            ) {
                                Text("Responder de novo")
                            }
                        }
                        // A saída para quem está com a impressora na mão e sabe que o descritor
                        // mente — um conversor, um hub que reescreve o nome. Ela existe, e é um
                        // `TextButton` e não um `Button`: não é o caminho que a tela sugere.
                        TextButton(
                            onClick = {
                                usbDialectContradiction = null
                                val selected = SelectedSearchCandidate.Usb(candidateId)
                                selectedSearchCandidate = selected
                                runPreliminaryTest(PendingPreliminaryTest.Candidate(selected))
                            },
                            enabled = !busyHere && !preliminaryTestInProgress && !awaitingConfirmation,
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .testTag("thermal-printer.usb-dialect-anyway"),
                        ) {
                            Text("Imprimir mesmo assim")
                        }
                    }
                    UsbCandidateRows(
                        candidates = listedCandidates.usb,
                        selectedId =
                            (selectedSearchCandidate as? SelectedSearchCandidate.Usb)?.id,
                        enabled = !busyHere && !preliminaryTestInProgress && !awaitingConfirmation,
                        theme = theme,
                        onSelect = { candidate ->
                            // O descritor confirma e não nega: ele só interrompe quando **discorda**
                            // da resposta. Sem discordância, nada muda no fluxo de antes.
                            val aviso =
                                discoveryDialect?.let { escolhido ->
                                    DialetoNoBalcao.avisoDeSuspeitaContrariada(
                                        escolhido = escolhido,
                                        suspeita = candidate.dialectSuspicion,
                                        nomeDeclarado = candidate.label,
                                    )
                                }
                            if (aviso != null) {
                                // Nada foi enviado a ela, e não vai ser enquanto este aviso estiver
                                // na tela.
                                usbDialectContradiction = candidate.id to aviso
                            } else {
                                usbDialectContradiction = null
                                val selected = SelectedSearchCandidate.Usb(candidate.id)
                                selectedSearchCandidate = selected
                                runPreliminaryTest(PendingPreliminaryTest.Candidate(selected))
                            }
                        },
                    )
                    WifiCandidateRows(
                        candidates = listedCandidates.wifi,
                        selectedId =
                            (selectedSearchCandidate as? SelectedSearchCandidate.Wifi)?.id,
                        enabled = !busyHere && !preliminaryTestInProgress && !awaitingConfirmation,
                        theme = theme,
                        onSelect = { candidateId ->
                            val selected = SelectedSearchCandidate.Wifi(candidateId)
                            selectedSearchCandidate = selected
                            runPreliminaryTest(PendingPreliminaryTest.Candidate(selected))
                        },
                    )
                    if (connection?.isWifi == true) {
                        OutlinedButton(
                            onClick = {
                                showAdvancedAddress = !showAdvancedAddress
                                if (!showAdvancedAddress) {
                                    advancedAddress = ""
                                    advancedPort = connectionProfile?.tcpPort?.toString().orEmpty()
                                }
                            },
                            enabled = connectionProfile != null && !busyHere && !awaitingConfirmation,
                            modifier =
                                Modifier.fillMaxWidth().testTag("thermal-printer.advanced-toggle"),
                        ) {
                            Text(
                                if (showAdvancedAddress) {
                                    "Fechar opções avançadas"
                                } else {
                                    "Informar endereço"
                                },
                            )
                        }
                    }
                    if (showAdvancedAddress && connection?.isWifi == true && connectionProfile != null) {
                        AdvancedAddressForm(
                            address = advancedAddress,
                            port = advancedPort,
                            onAddressChange = { value ->
                                advancedAddress =
                                    value.filter { it.isDigit() || it == '.' }
                                        .take(MAX_IPV4_TEXT_LENGTH)
                            },
                            onPortChange = { value ->
                                advancedPort = value.filter(Char::isDigit).take(MAX_PORT_TEXT_LENGTH)
                            },
                            onTest = {
                                val enteredPort = advancedPort.toIntOrNull()
                                if (enteredPort == null || enteredPort !in MIN_TCP_PORT..MAX_TCP_PORT) {
                                    localNotice =
                                        LocalNotice(
                                            "Porta inválida",
                                            "Informe uma porta válida para este modelo.",
                                            NoticeTone.WARNING,
                                        )
                                } else {
                                    val currentPrinter = printer
                                    if (currentPrinter == null) {
                                        unavailableNotice()
                                    } else {
                                        val test =
                                            PendingPreliminaryTest.ManualAddress(
                                                profileId = connectionProfile.id,
                                                address = advancedAddress,
                                                port = enteredPort,
                                            )
                                        runPreliminaryTest(test)
                                    }
                                }
                            },
                            enabled = !busyHere && !awaitingConfirmation,
                            theme = theme,
                        )
                    }
                    Text(
                        "Não apareceu? Tente conectar de outro jeito.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(
                        onClick = ::returnToPreviousSetupScreen,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .testTag("thermal-printer.search-back"),
                    ) {
                        Text("Trocar a forma de conectar")
                    }
                }
            }
        }
    }

    connectingPrinter?.let { installed ->
        AlertDialog(
            // Sem dispensa: a operação é curta e fechar o aviso não a interromperia — só devolveria
            // a sensação de tela travada que ele existe para evitar.
            onDismissRequest = {},
            modifier = Modifier.testTag("thermal-printer.connecting"),
            title = { Text("Conectando…") },
            text = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(28.dp))
                    Text(
                        "Procurando ${installed.displayName} por perto. " +
                            "Isso pode levar alguns segundos.",
                    )
                }
            },
            confirmButton = {},
        )
    }

    printerToRemove?.let { installed ->
        AlertDialog(
            onDismissRequest = { printerToRemove = null },
            modifier = Modifier.testTag("thermal-printer.remove-printer"),
            title = { Text("Excluir ${installed.displayName}?") },
            text = {
                Text(
                    "A impressora deixará de aparecer como instalada neste celular. " +
                        "A conexão e a configuração medida dela também serão removidas deste aparelho.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val currentPrinter = printer
                        printerToRemove = null
                        if (currentPrinter == null) return@TextButton
                        scope.launch {
                            val result =
                                installed.installationId?.let { installationId ->
                                    runPrinterCall {
                                        currentPrinter.removeInstallation(installationId)
                                    }
                                } ?: runPrinterCall {
                                    currentPrinter.removePrinter(installed.transport)
                                }
                            localNotice =
                                if (result.isSuccess) {
                                    LocalNotice(
                                        title = "Impressora excluída",
                                        body = "${installed.displayName} saiu das impressoras instaladas.",
                                        tone = NoticeTone.INFO,
                                    )
                                } else {
                                    LocalNotice(
                                        title = "Não foi possível excluir",
                                        body = "A impressora continua instalada neste celular. Tente de novo.",
                                        tone = NoticeTone.WARNING,
                                    )
                                }
                        }
                    },
                    modifier = Modifier.testTag("thermal-printer.remove-printer.confirm"),
                ) {
                    Text("Excluir")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { printerToRemove = null },
                    modifier = Modifier.testTag("thermal-printer.remove-printer.dismiss"),
                ) {
                    Text("Cancelar")
                }
            },
        )
    }

    profileToForget?.let { measured ->
        AlertDialog(
            // Apagar medição é irreversível e não tem desfazer: o disco é a única cópia. O
            // diálogo mostra o que vai embora — nome e geometria — porque foi exatamente a
            // geometria errada que fez esta saída existir.
            onDismissRequest = { profileToForget = null },
            modifier = Modifier.testTag("thermal-printer.forget-profile"),
            title = { Text("Apagar a medição de ${measured.displayName}?") },
            text = {
                Text(
                    "Some deste celular: ${measured.paperWidthMm} mm, " +
                        "${measured.printableColumns} colunas, ${measured.printableDots} dots. " +
                        "Se esta impressora estiver em uso, ela é solta junto e volta a precisar " +
                        "de medição. Não dá para desfazer.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val currentHost = homologationHost
                        profileToForget = null
                        if (currentHost == null) return@TextButton
                        scope.launch {
                            val result = runPrinterCall { currentHost.forgetMeasuredProfile(measured.id) }
                            localNotice =
                                if (result.isSuccess) {
                                    onProfilesChanged()
                                    LocalNotice(
                                        title = "Medição apagada",
                                        body =
                                            "${measured.displayName} saiu da lista. Meça de novo " +
                                                "quando quiser usá-la.",
                                        tone = NoticeTone.INFO,
                                    )
                                } else {
                                    LocalNotice(
                                        title = "Não foi possível apagar",
                                        body = "A medição continua neste celular. Tente de novo.",
                                        tone = NoticeTone.WARNING,
                                    )
                                }
                        }
                    },
                    modifier = Modifier.testTag("thermal-printer.forget-profile.confirm"),
                ) {
                    Text("Apagar")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { profileToForget = null },
                    modifier = Modifier.testTag("thermal-printer.forget-profile.dismiss"),
                ) {
                    Text("Cancelar")
                }
            },
        )
    }

    if (showLocalWifiConsent) {
        AlertDialog(
            onDismissRequest = {
                showLocalWifiConsent = false
                showSearchAgain = true
            },
            modifier = Modifier.testTag("thermal-printer.local-wifi-consent"),
            title = { Text("Usar a rede Wi-Fi local?") },
            text = {
                Text(
                    "A busca verifica possíveis impressoras na rede Wi-Fi atual. Use uma rede " +
                        "privada e confiável, nunca pública ou de convidados. Confirme o papel " +
                        "antes de selecionar a impressora e desative a VPN antes de buscar.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showLocalWifiConsent = false
                        searchLocalWifi()
                    },
                    modifier =
                        Modifier.testTag("thermal-printer.local-wifi-consent.confirm"),
                ) {
                    Text("Continuar")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showLocalWifiConsent = false
                        showSearchAgain = true
                    },
                    modifier =
                        Modifier.testTag("thermal-printer.local-wifi-consent.dismiss"),
                ) {
                    Text("Cancelar")
                }
            },
        )
    }

    if (showConfirmation) {
        AlertDialog(
            // Voltar ou tocar fora não prova nada sobre o papel. No caminho A, as três respostas
            // adotam, preservam para medição ou descartam. No caminho B, a candidata fica intacta
            // para o assistente e só “Não saiu” a descarta.
            onDismissRequest = {},
            modifier = Modifier.testTag("thermal-printer.confirmation"),
            title = {
                Text(
                    if (creatingProfileForConfirmation) {
                        "O teste saiu no papel?"
                    } else {
                        "Como saiu o comprovante de teste?"
                    },
                )
            },
            text = {
                Text(
                    if (creatingProfileForConfirmation) {
                        "Esta busca apenas encontrou o aparelho. Agora o assistente mede acentos, " +
                            "corte e tamanho antes de salvar a impressora."
                    } else {
                        "A impressora só será selecionada após uma confirmação humana no papel. " +
                            "Se houver qualquer problema, configure um perfil novo."
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (creatingProfileForConfirmation) {
                            // Não confirma nem descarta: o alvo efêmero é o que torna possível
                            // medir sem persistir endereço ou identificador técnico.
                            // O comprovante inicial já confirmou o transporte, mas a próxima tela
                            // ainda oferece tanto as sondas quanto a configuração manual baseada
                            // no papel que a pessoa já possui.
                            onHomologationRequested(false)
                            return@TextButton
                        }
                        if (!awaitingConfirmation || confirmationResolutionInProgress) {
                            return@TextButton
                        }
                        val currentPrinter = printer ?: return@TextButton
                        confirmationResolutionInProgress = true
                        localNotice = null
                        scope.launch {
                            val result =
                                runPrinterCall { currentPrinter.confirmSearchedPrinter() }
                            if (
                                result.isFailure ||
                                    currentPrinter.state.value is
                                        ThermalPrinterState.SearchConfirmationRequired
                            ) {
                                confirmationResolutionInProgress = false
                                localNotice =
                                    LocalNotice(
                                        "Confirmação pendente",
                                        "Não foi possível confirmar esta impressora. Tente " +
                                            "responder novamente.",
                                        NoticeTone.WARNING,
                                    )
                            } else {
                                // Confirmar encerra a busca: a impressora está instalada e a rota
                                // de procura não tem mais o que oferecer. Sem esta volta, a tela
                                // ficava no cartão "Pronta" com um único botão — "Trocar a forma de
                                // conectar" —, que desfaz o que a pessoa acabou de conseguir. Visto
                                // no A75 em 17/08: o comprovante saiu, ela respondeu que saiu, e a
                                // impressora recém-instalada estava a uma rota de distância sem
                                // link nenhum.
                                selectedSearchCandidate = null
                                showSearchAgain = false
                                setupPath = PrinterSetupPath.PROFILE_LIST
                                localNotice =
                                    LocalNotice(
                                        "Impressora instalada",
                                        "Ela já recebe os cupons. Na lista dá para testá-la de " +
                                            "novo, configurar ou escolher qual é a padrão.",
                                        NoticeTone.INFO,
                                    )
                            }
                        }
                    },
                    modifier = Modifier.testTag("thermal-printer.confirmation.correct"),
                ) {
                    Text(if (creatingProfileForConfirmation) "Saiu no papel" else "Saiu certo")
                }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!creatingProfileForConfirmation) {
                        TextButton(
                            onClick = {
                                // Não confirma nem descarta: a candidata precisa chegar intacta à
                                // sessão de homologação fornecida pelo host.
                                onHomologationRequested(false)
                            },
                            modifier = Modifier.testTag("thermal-printer.confirmation.problem"),
                        ) {
                            Text("Saiu com problema")
                        }
                    }
                    TextButton(
                        onClick = ::discardPendingSearch,
                        modifier = Modifier.testTag("thermal-printer.confirmation.not-printed"),
                    ) {
                        Text("Não saiu")
                    }
                }
            },
        )
    }
}

@Composable
private fun AdoptedPrinterRows(
    adopted: List<AdoptedPrinter>,
    /** O que cada unidade aceita neste instante. Ver [PrinterUnitAvailability]. */
    activityOf: (AdoptedPrinter) -> PrinterUnitActivity,
    /** A unidade cujo comprovante está a caminho, quando há uma. */
    testing: AdoptedPrinter?,
    theme: ThermalPrinterTheme,
    onActivate: (AdoptedPrinter) -> Unit,
    onTest: (AdoptedPrinter) -> Unit,
    onEdit: (AdoptedPrinter) -> Unit,
    onRemove: (AdoptedPrinter) -> Unit,
) {
    if (adopted.isEmpty()) return
    adopted.forEach { entry ->
        val activity = activityOf(entry)
        val slug = entry.transport.name.lowercase()
        val tagSuffix =
            if (adopted.count { it.transport == entry.transport } == 1) {
                slug
            } else {
                // Por instalação: duas unidades do mesmo modelo teriam o mesmo perfil e
                // colidiriam a tag de teste, que é como a suíte identifica cada linha.
                "$slug-${entry.installationId ?: entry.displayName.hashCode()}"
            }
        val warning = entry.warning
        if (warning != null) {
            NoticeCard(
                title = "Configuração temporária · ${entry.transportLabel}",
                body = warning,
                tone = NoticeTone.WARNING,
                theme = theme,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.temporary-warning-$slug"),
            )
        } else {
            if (theme.usesPrintherLayout) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(
                        onClick = { onActivate(entry) },
                        enabled = PrinterUnitAvailability.allowsActivation(activity),
                        modifier = Modifier.weight(1f).height(92.dp).testTag("thermal-printer.adopted-$tagSuffix"),
                        border = BorderStroke(if (entry.active) 2.dp else 1.dp, if (entry.active) theme.accentColor else theme.outlineColor),
                    ) {
                        Icon(Icons.Outlined.Print, contentDescription = null, modifier = Modifier.size(38.dp))
                        Spacer(Modifier.width(16.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(entry.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            Text(entry.transportLabel, color = theme.cardContentColor.copy(alpha = .68f))
                        }
                        if (entry.active) {
                            Icon(Icons.Outlined.CheckCircle, contentDescription = "Selecionada", tint = theme.accentColor)
                        }
                    }
                    IconButton(
                        onClick = { onEdit(entry) },
                        enabled = PrinterUnitAvailability.allowsConfiguration(activity),
                        modifier = Modifier.testTag("thermal-printer.edit-$tagSuffix"),
                    ) {
                        Icon(
                            Icons.Outlined.Settings,
                            contentDescription = "Editar ${entry.displayName}",
                        )
                    }
                    IconButton(
                        onClick = { onRemove(entry) },
                        // Nunca desabilita: foi a lixeira cinza que deixou a pessoa sem saída
                        // quando a ativa estava desligada.
                        enabled = PrinterUnitAvailability.allowsRemoval(activity),
                        modifier = Modifier.testTag("thermal-printer.remove-$tagSuffix"),
                    ) {
                        Icon(
                            Icons.Outlined.DeleteOutline,
                            contentDescription = "Excluir ${entry.displayName}",
                        )
                    }
                }
                return@forEach
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = { onActivate(entry) },
                    enabled = PrinterUnitAvailability.allowsActivation(activity),
                    modifier =
                        Modifier
                            .weight(1f)
                            .testTag("thermal-printer.adopted-$tagSuffix"),
                ) {
                    Text(
                        if (entry.active) {
                            "● ${entry.displayName} · ${entry.transportLabel}"
                        } else {
                            "○ ${entry.displayName} · ${entry.transportLabel}"
                        },
                    )
                }
                val testingThis =
                    testing != null &&
                        testing.installationId == entry.installationId &&
                        testing.transport == entry.transport
                OutlinedButton(
                    onClick = { onTest(entry) },
                    // Nenhum outro card **deste transporte** aceita toque enquanto um comprovante
                    // está a caminho por ele: o teste da unidade parada mexe na conexão em memória,
                    // que é uma só por rádio. A do outro transporte não tem nada com isso.
                    enabled = PrinterUnitAvailability.allowsTest(activity),
                    modifier = Modifier.testTag("thermal-printer.test-$tagSuffix"),
                ) {
                    if (testingThis) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (testingThis) "Enviando…" else "Testar")
                }
                IconButton(
                    onClick = { onEdit(entry) },
                    enabled = PrinterUnitAvailability.allowsConfiguration(activity),
                    modifier = Modifier.testTag("thermal-printer.edit-$tagSuffix"),
                ) {
                    Icon(
                        Icons.Outlined.Settings,
                        contentDescription = "Editar ${entry.displayName}",
                    )
                }
                IconButton(
                    onClick = { onRemove(entry) },
                    // Nunca desabilita, pelo mesmo motivo do outro layout.
                    enabled = PrinterUnitAvailability.allowsRemoval(activity),
                    modifier = Modifier.testTag("thermal-printer.remove-$tagSuffix"),
                ) {
                    Icon(
                        Icons.Outlined.DeleteOutline,
                        contentDescription = "Excluir ${entry.displayName}",
                    )
                }
            }
        }
    }
}

@Composable
private fun PrinterProfileList(
    profiles: List<ConfigurationPrinterProfile>,
    theme: ThermalPrinterTheme,
    activeDisplayName: String? = null,
    onSelect: (ConfigurationPrinterProfile) -> Unit,
    onForget: ((MeasuredProfile) -> Unit)? = null,
) {
    if (profiles.isEmpty()) {
        NoticeCard(
            title = "Você ainda não escolheu uma impressora",
            body = "Escolha o modelo da sua impressora ou adicione uma nova.",
            tone = NoticeTone.INFO,
            theme = theme,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.empty.no-profile-chosen"),
        )
    }

    profiles.forEach { profile ->
        val active = theme.usesPrintherLayout && profile.driver.displayName == activeDisplayName
        val profileContent: @Composable () -> Unit = {
            Row(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(if (theme.usesPrintherLayout) 104.dp else 60.dp)
                        .padding(horizontal = if (theme.usesPrintherLayout) 14.dp else 0.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(if (theme.usesPrintherLayout) 10.dp else 16.dp),
            ) {
                if (theme.usesPrintherLayout) {
                    Icon(Icons.Outlined.Print, contentDescription = null, modifier = Modifier.size(38.dp))
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(profile.driver.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(profile.summary, style = MaterialTheme.typography.bodyMedium, color = theme.cardContentColor.copy(alpha = .68f))
                }
                if (theme.usesPrintherLayout) {
                    Surface(
                        color = if (profile.source == PrinterProfileSource.BUNDLED) theme.successContainerColor else Color(0xFFF0F0F0),
                        contentColor = if (profile.source == PrinterProfileSource.BUNDLED) theme.onSuccessContainerColor else theme.cardContentColor,
                        shape = MaterialTheme.shapes.small,
                    ) {
                        Text(profile.badge, Modifier.padding(horizontal = 10.dp, vertical = 7.dp), style = MaterialTheme.typography.labelMedium)
                    }
                    if (active) {
                        Icon(
                            Icons.Outlined.CheckCircle,
                            contentDescription = "Impressora ativa",
                            tint = theme.accentColor,
                            modifier = Modifier.size(30.dp),
                        )
                    }
                } else {
                    Text(profile.badge, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
        if (theme.usesPrintherLayout) {
            Card(
                onClick = { onSelect(profile) },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.profile-${profile.driver.id}"),
                colors = CardDefaults.cardColors(containerColor = theme.cardContainerColor),
                border = BorderStroke(if (active) 1.5.dp else 1.dp, if (active) theme.accentColor else theme.outlineColor),
            ) {
                profileContent()
            }
        } else {
            OutlinedButton(
                onClick = { onSelect(profile) },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.profile-${profile.driver.id}"),
            ) {
                profileContent()
            }
        }
        // Só medição local se apaga. A embutida veio da bancada e não é desta pessoa; apagá-la
        // seria remover uma impressora suportada, não desfazer uma medição.
        val measured = profile.measuredProfile
        if (!theme.usesPrintherLayout && onForget != null && measured != null) {
            TextButton(
                onClick = { onForget(measured) },
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .testTag("thermal-printer.profile-${profile.driver.id}.forget"),
            ) {
                Text("Apagar medição")
            }
        }
    }
}

@Composable
private fun SearchButton(
    choice: PrinterConnectionChoice?,
    state: ThermalPrinterState?,
    enabled: Boolean,
    theme: ThermalPrinterTheme,
    searchLocalWifi: () -> Unit,
    searchUsb: () -> Unit,
    searchBluetooth: () -> Unit,
) {
    val tag =
        when (choice) {
            PrinterConnectionChoice.USB -> "thermal-printer.search-usb"
            PrinterConnectionChoice.BLUETOOTH -> "thermal-printer.search-bluetooth"
            PrinterConnectionChoice.DIRECT_WIFI,
            PrinterConnectionChoice.LOCAL_NETWORK,
            -> "thermal-printer.search-local-wifi"
            null -> "thermal-printer.search-unavailable"
        }
    Button(
        onClick = {
            when (choice) {
                PrinterConnectionChoice.USB -> searchUsb()
                PrinterConnectionChoice.BLUETOOTH -> searchBluetooth()
                PrinterConnectionChoice.DIRECT_WIFI,
                PrinterConnectionChoice.LOCAL_NETWORK,
                -> searchLocalWifi()
                null -> Unit
            }
        },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag(tag),
        colors =
            ButtonDefaults.buttonColors(
                containerColor = theme.accentColor,
                contentColor = theme.onAccentColor,
            ),
    ) {
        if (state.isBusy()) {
            CircularProgressIndicator(color = theme.onAccentColor, strokeWidth = 2.dp)
        } else {
            Icon(Icons.Outlined.Print, contentDescription = null)
            Text(
                if (choice == PrinterConnectionChoice.BLUETOOTH) {
                    "Procurar por Bluetooth"
                } else {
                    "Procurar impressora"
                },
            )
        }
    }
}

@Composable
private fun BluetoothSearchProgress(
    count: Int,
    finished: Boolean,
    theme: ThermalPrinterTheme,
) {
    Card(
        modifier =
            Modifier
                .fillMaxWidth()
                .testTag(
                    if (finished) {
                        "thermal-printer.bluetooth-search-finished"
                    } else {
                        "thermal-printer.bluetooth-search-progress"
                    },
                ),
        colors = CardDefaults.cardColors(containerColor = theme.cardContainerColor),
        border = BorderStroke(1.dp, theme.outlineColor),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (!finished) {
                CircularProgressIndicator(
                    color = theme.accentColor,
                    strokeWidth = 2.dp,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    if (finished) "Busca Bluetooth concluída" else "Procurando por Bluetooth…",
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    "$count ${bluetoothDeviceCountLabel(count)}" +
                        if (finished) "." else " até agora",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

private fun bluetoothDeviceCountLabel(count: Int): String =
    if (count == 1) "aparelho encontrado" else "aparelhos encontrados"

@Composable
private fun BluetoothCandidateRows(
    candidates: List<br.com.thermalprinterkit.BluetoothPrinterCandidate>,
    likelyCandidateIds: Set<Long>,
    selectedId: Long?,
    enabled: Boolean,
    theme: ThermalPrinterTheme,
    onSelect: (br.com.thermalprinterkit.BluetoothPrinterCandidate) -> Unit,
    /**
     * Ação da candidata escolhida, desenhada logo abaixo dela.
     *
     * Visto na bancada com 30 aparelhos na lista: com o botão só no fim, escolher a impressora e
     * ter de rolar por todo o resto para continuar. A ação nasce onde o dedo acabou de tocar.
     */
    selectedAction: @Composable () -> Unit = {},
) {
    if (candidates.isEmpty()) return
    val (likelyPrinters, otherDevices) = orderBluetoothCandidates(candidates, likelyCandidateIds)

    if (likelyPrinters.isNotEmpty()) {
        NoticeCard(
            title = "Prováveis impressoras Bluetooth",
            body = "Escolha uma linha para enviar somente o comprovante de teste.",
            tone = NoticeTone.INFO,
            theme = theme,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.bluetooth-likely-heading"),
        )
    }
    likelyPrinters.forEach { candidate ->
        BluetoothCandidateButton(candidate, selectedId, enabled, onSelect)
        if (candidate.id == selectedId) selectedAction()
    }

    if (otherDevices.isNotEmpty()) {
        NoticeCard(
            title = "Outros aparelhos encontrados",
            body =
                "Eles não anunciaram um serviço conhecido de impressão. Os que informam o " +
                    "próprio nome vêm primeiro. Você ainda pode escolher um para testar.",
            tone = NoticeTone.INFO,
            theme = theme,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.bluetooth-other-heading"),
        )
    }
    otherDevices.forEach { candidate ->
        BluetoothCandidateButton(candidate, selectedId, enabled, onSelect)
        if (candidate.id == selectedId) selectedAction()
    }
}

/** As três listas da busca, já reduzidas ao transporte que a pessoa escolheu. */
internal data class ListedSearchCandidates<out B, out U, out W>(
    val bluetooth: List<B>,
    val usb: List<U>,
    val wifi: List<W>,
)

/**
 * Cada lista só existe para o seu próprio transporte.
 *
 * As três eram desenhadas sem condição nenhuma, e cada `*CandidateRows` só se cala quando a lista
 * está vazia — então o resultado de uma busca anterior sobrevivia à troca de conexão. Na bancada,
 * escolher Wi-Fi, rede local ou USB continuava mostrando as candidatas de Bluetooth, sob o título
 * "Procurando por Wi-Fi da impressora". A busca não estava errada; a tela é que mentia sobre o que
 * tinha achado.
 */
internal fun <B, U, W> candidatesOfSelectedConnection(
    connection: PrinterConnectionChoice?,
    bluetooth: List<B>,
    usb: List<U>,
    wifi: List<W>,
): ListedSearchCandidates<B, U, W> =
    ListedSearchCandidates(
        bluetooth = if (connection == PrinterConnectionChoice.BLUETOOTH) bluetooth else emptyList(),
        usb = if (connection == PrinterConnectionChoice.USB) usb else emptyList(),
        wifi = if (connection?.isWifi == true) wifi else emptyList(),
    )

/**
 * Três camadas, na ordem de utilidade decrescente para quem procura a própria impressora: quem
 * anunciou serviço de impressão, depois quem ao menos se identificou, e por último o que não diz o
 * próprio nome.
 *
 * Medido na bancada: de 28 candidatas num ambiente comum, só três tinham nome — e eram exatamente
 * as impressoras. Nenhuma das oito anunciou serviço conhecido, então o nome é o sinal que sobra.
 */
internal fun orderBluetoothCandidates(
    candidates: List<br.com.thermalprinterkit.BluetoothPrinterCandidate>,
    likelyCandidateIds: Set<Long>,
): Pair<List<br.com.thermalprinterkit.BluetoothPrinterCandidate>, List<br.com.thermalprinterkit.BluetoothPrinterCandidate>> {
    val (likelyPrinters, remaining) =
        candidates.partition { candidate -> candidate.id in likelyCandidateIds }
    val (named, unnamed) = remaining.partition { it.named }
    return likelyPrinters to (named + unnamed)
}

@Composable
private fun BluetoothCandidateButton(
    candidate: br.com.thermalprinterkit.BluetoothPrinterCandidate,
    selectedId: Long?,
    enabled: Boolean,
    onSelect: (br.com.thermalprinterkit.BluetoothPrinterCandidate) -> Unit,
) {
    OutlinedButton(
        onClick = { onSelect(candidate) },
        enabled = enabled,
        modifier =
            Modifier
                .fillMaxWidth()
                .testTag("thermal-printer.bluetooth-candidate-${candidate.id}"),
    ) {
        Text(if (candidate.id == selectedId) "● ${candidate.label}" else candidate.label)
    }
}

@Composable
private fun UsbCandidateRows(
    candidates: List<br.com.thermalprinterkit.UsbPrinterCandidate>,
    selectedId: Long?,
    enabled: Boolean,
    theme: ThermalPrinterTheme,
    // A candidata inteira, e não o id: quem decide se pode imprimir precisa da suspeita de
    // dialeto que veio no descritor, e ela não cabe num `Long`.
    onSelect: (br.com.thermalprinterkit.UsbPrinterCandidate) -> Unit,
) {
    if (candidates.isEmpty()) return
    NoticeCard(
        title = "Impressoras USB conectadas",
        body = "Escolha uma linha. O Android solicitará acesso antes do teste.",
        tone = NoticeTone.INFO,
        theme = theme,
        modifier = Modifier.fillMaxWidth(),
    )
    candidates.forEach { candidate ->
        OutlinedButton(
            onClick = { onSelect(candidate) },
            enabled = enabled,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.usb-candidate-${candidate.id}"),
        ) {
            Text(if (candidate.id == selectedId) "● ${candidate.label}" else candidate.label)
        }
    }
}

@Composable
private fun WifiCandidateRows(
    candidates: List<br.com.thermalprinterkit.LocalWifiPrinterCandidate>,
    selectedId: Long?,
    enabled: Boolean,
    theme: ThermalPrinterTheme,
    onSelect: (Long) -> Unit,
) {
    if (candidates.isEmpty()) return
    NoticeCard(
        title = "Impressoras encontradas",
        body = "Escolha uma linha para enviar somente o comprovante de teste.",
        tone = NoticeTone.INFO,
        theme = theme,
        modifier = Modifier.fillMaxWidth(),
    )
    candidates.forEach { candidate ->
        OutlinedButton(
            onClick = { onSelect(candidate.id) },
            enabled = enabled,
            modifier =
                Modifier
                    .fillMaxWidth()
                    .testTag("thermal-printer.candidate-${candidate.id}"),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(if (candidate.id == selectedId) "● ${candidate.label}" else candidate.label)
                // O endereço é efêmero e serve somente para esta escolha visual.
                Text(
                    "IP: ${candidate.ipAddress}",
                    style = MaterialTheme.typography.bodySmall,
                    color = theme.cardContentColor.copy(alpha = 0.72f),
                )
            }
        }
    }
}

@Composable
private fun AdvancedAddressForm(
    address: String,
    port: String,
    onAddressChange: (String) -> Unit,
    onPortChange: (String) -> Unit,
    onTest: () -> Unit,
    enabled: Boolean,
    theme: ThermalPrinterTheme,
) {
    Card(
        modifier = Modifier.fillMaxWidth().testTag("thermal-printer.advanced-form"),
        colors = CardDefaults.cardColors(containerColor = Color.Transparent),
        border = BorderStroke(1.dp, theme.outlineColor),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Endereço da impressora", style = MaterialTheme.typography.titleSmall)
            Text(
                "Use somente se você recebeu o IP e a porta. Eles ficam apenas em memória " +
                    "durante esta configuração.",
                color = theme.cardContentColor.copy(alpha = 0.78f),
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedTextField(
                value = address,
                onValueChange = onAddressChange,
                modifier =
                    Modifier.fillMaxWidth().testTag("thermal-printer.advanced-address"),
                enabled = enabled,
                singleLine = true,
                label = { Text("IP da impressora") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            OutlinedTextField(
                value = port,
                onValueChange = onPortChange,
                modifier = Modifier.fillMaxWidth().testTag("thermal-printer.advanced-port"),
                enabled = enabled,
                singleLine = true,
                label = { Text("Porta") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Button(
                onClick = onTest,
                enabled = enabled,
                modifier = Modifier.fillMaxWidth().testTag("thermal-printer.advanced-test"),
            ) {
                Text("Conectar e testar")
            }
        }
    }
}

@Composable
internal fun SectionHeading(
    title: String,
    supportingText: String,
    theme: ThermalPrinterTheme,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            title,
            style = if (theme.usesPrintherLayout) MaterialTheme.typography.headlineLarge else MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            color = theme.cardContentColor,
        )
        if (supportingText.isNotEmpty()) {
            Text(
                supportingText,
                style = if (theme.usesPrintherLayout) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
                color = theme.cardContentColor.copy(alpha = 0.76f),
            )
        }
    }
}

@Composable
private fun PrinterSearchRadar(theme: ThermalPrinterTheme) {
    Box(
        modifier = Modifier.fillMaxWidth().height(240.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(230.dp)) {
            listOf(1f, .72f, .44f).forEachIndexed { index, ratio ->
                drawCircle(
                    color = theme.accentColor.copy(alpha = if (index == 2) .09f else .06f),
                    radius = size.minDimension * ratio / 2f,
                )
            }
        }
        Surface(shape = CircleShape, color = theme.cardContainerColor) {
            Icon(
                Icons.Outlined.Print,
                contentDescription = null,
                tint = theme.accentColor,
                modifier = Modifier.padding(18.dp).size(42.dp),
            )
        }
    }
}

@Composable
private fun KnownPrinterGrid(
    profiles: List<ConfigurationPrinterProfile>,
    theme: ThermalPrinterTheme,
    onSelect: (ConfigurationPrinterProfile) -> Unit,
    onNew: () -> Unit,
    onBack: () -> Unit,
) {
    SectionHeading(
        title = "Qual é a sua impressora?",
        supportingText = "Toque na que mais parece com a sua.",
        theme = theme,
    )
    profiles.chunked(3).forEachIndexed { index, rowProfiles ->
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            rowProfiles.forEach { profile ->
                KnownPrinterCard(
                    profile = profile,
                    theme = theme,
                    onClick = { onSelect(profile) },
                    modifier = Modifier.weight(1f),
                )
            }
            if (index == profiles.lastIndex / 3 && rowProfiles.size == 2) {
                NewPrinterGridCard(theme = theme, onClick = onNew, modifier = Modifier.weight(1f))
            } else {
                repeat(3 - rowProfiles.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
    if (profiles.size % 3 == 0) {
        Row(modifier = Modifier.fillMaxWidth()) {
            NewPrinterGridCard(theme = theme, onClick = onNew, modifier = Modifier.weight(1f))
            Spacer(Modifier.weight(2f))
        }
    }
    TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Voltar") }
}

@Composable
private fun NewPrinterGridCard(
    theme: ThermalPrinterTheme,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier.testTag("thermal-printer.model.new"),
        colors = CardDefaults.cardColors(containerColor = theme.cardContainerColor),
        border = BorderStroke(1.dp, theme.outlineColor),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().height(215.dp).padding(8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = theme.accentColor, modifier = Modifier.size(54.dp))
            Text("Nova impressora", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun KnownPrinterCard(
    profile: ConfigurationPrinterProfile,
    theme: ThermalPrinterTheme,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier.testTag("thermal-printer.model.${profile.driver.id}"),
        colors = CardDefaults.cardColors(containerColor = theme.cardContainerColor),
        border = BorderStroke(1.dp, theme.outlineColor),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().height(215.dp).padding(horizontal = 6.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val resource = theme.printerImageResources[profile.driver.id]
            if (resource != null) {
                Image(
                    painter = painterResource(resource),
                    contentDescription = theme.printerDisplayNames[profile.driver.id] ?: profile.driver.displayName,
                    modifier = Modifier.fillMaxWidth().height(120.dp),
                    contentScale = ContentScale.Fit,
                )
            } else {
                Icon(Icons.Outlined.Print, contentDescription = null, modifier = Modifier.size(96.dp))
            }
            Text(
                theme.printerDisplayNames[profile.driver.id] ?: profile.driver.displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 3,
                minLines = 3,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
internal fun NoticeCard(
    title: String,
    body: String,
    tone: NoticeTone,
    theme: ThermalPrinterTheme,
    modifier: Modifier = Modifier,
) {
    val colors = tone.colors(theme)
    Surface(
        modifier = modifier,
        color = colors.container,
        contentColor = colors.content,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(body, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun StatusPill(
    tone: NoticeTone,
    label: String,
    theme: ThermalPrinterTheme,
) {
    val colors = tone.colors(theme)
    Surface(color = colors.container, contentColor = colors.content, shape = CircleShape) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

internal enum class NoticeTone {
    INFO,
    SUCCESS,
    WARNING,
    DANGER,
}

private data class ToneColors(
    val container: Color,
    val content: Color,
)

private fun NoticeTone.colors(theme: ThermalPrinterTheme): ToneColors =
    when (this) {
        NoticeTone.INFO -> ToneColors(theme.infoContainerColor, theme.onInfoContainerColor)
        NoticeTone.SUCCESS ->
            ToneColors(theme.successContainerColor, theme.onSuccessContainerColor)
        NoticeTone.WARNING ->
            ToneColors(theme.warningContainerColor, theme.onWarningContainerColor)
        NoticeTone.DANGER -> ToneColors(theme.dangerContainerColor, theme.onDangerContainerColor)
    }

private data class LocalNotice(
    val title: String,
    val body: String,
    val tone: NoticeTone,
)

private data class PrinterPresentation(
    val tone: NoticeTone,
    val label: String,
    val message: String,
)

private fun ThermalPrinterState?.isBusy(): Boolean =
    this is ThermalPrinterState.Connecting ||
        this is ThermalPrinterState.LocalWifiSearching ||
        this is ThermalPrinterState.UsbSearching ||
        this is ThermalPrinterState.BluetoothSearching ||
        this is ThermalPrinterState.Printing

/**
 * A pílula e a mensagem pertencem ao transporte escolhido.
 *
 * O estado do kit é um só, e o de uma busca anterior sobrevive à troca de conexão: a tela do Wi-Fi
 * anunciava "Escolha uma Bluetooth" e "29 aparelhos encontrados" logo abaixo de "Procurando por
 * Wi-Fi da impressora". Estado de busca de outro transporte volta a ser espera.
 */
private fun ThermalPrinterState?.printerPresentation(
    connection: PrinterConnectionChoice?,
): PrinterPresentation =
    if (belongsToSearchOf(connection)) printerPresentation() else AWAITING_SEARCH_PRESENTATION

/**
 * Estado que não é de busca — `Pronta`, `Imprimindo`, falha — vale em qualquer transporte. Wi-Fi
 * direto e rede do local compartilham o mesmo estado de busca, porque compartilham a porta 9100.
 */
internal fun ThermalPrinterState?.belongsToSearchOf(
    connection: PrinterConnectionChoice?,
): Boolean =
    when (this) {
        is ThermalPrinterState.BluetoothCandidatesFound,
        ThermalPrinterState.BluetoothSearching,
        -> connection == PrinterConnectionChoice.BLUETOOTH
        is ThermalPrinterState.UsbCandidatesFound,
        ThermalPrinterState.UsbSearching,
        -> connection == PrinterConnectionChoice.USB
        is ThermalPrinterState.LocalWifiCandidatesFound,
        ThermalPrinterState.LocalWifiSearching,
        -> connection?.isWifi == true
        else -> true
    }

private val AWAITING_SEARCH_PRESENTATION =
    PrinterPresentation(
        NoticeTone.INFO,
        "Aguardando",
        "Toque em Procurar para achar uma impressora por este caminho.",
    )

private fun ThermalPrinterState?.printerPresentation(): PrinterPresentation =
    when (this) {
        ThermalPrinterState.PrinterNotSelected ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Aguardando",
                "Toque em Procurar para achar uma impressora por este caminho.",
            )
        ThermalPrinterState.Ready ->
            PrinterPresentation(
                NoticeTone.SUCCESS,
                "Pronta",
                "A impressora selecionada está pronta para receber envios.",
            )
        is ThermalPrinterState.LocalWifiCandidatesFound ->
            PrinterPresentation(NoticeTone.INFO, "Escolha uma", message)
        is ThermalPrinterState.UsbCandidatesFound ->
            PrinterPresentation(NoticeTone.INFO, "Escolha uma USB", message)
        is ThermalPrinterState.BluetoothCandidatesFound ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Escolha uma Bluetooth",
                "${candidates.size} ${bluetoothDeviceCountLabel(candidates.size)}. " +
                    "Escolha uma impressora para testar.",
            )
        ThermalPrinterState.BluetoothSearching ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Procurando Bluetooth",
                "Procurando impressoras pelo caminho escolhido.",
            )
        ThermalPrinterState.SearchConfirmationRequired ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Confirme no papel",
                "Confira o comprovante antes de selecionar esta impressora.",
            )
        ThermalPrinterState.Connecting ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Verificando",
                "Verificando a conexão da impressora.",
            )
        ThermalPrinterState.LocalWifiSearching ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Procurando no Wi-Fi",
                "Procurando possíveis impressoras na rede Wi-Fi local.",
            )
        ThermalPrinterState.UsbSearching ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Procurando USB",
                "Procurando impressoras conectadas por cabo ou hub USB com dados.",
            )
        ThermalPrinterState.Printing ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Imprimindo",
                "Aguarde a impressão terminar.",
            )
        ThermalPrinterState.LocalWifiUnavailable ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Wi-Fi local não disponível",
                "Conecte este aparelho a uma rede Wi-Fi privada, sem VPN, e tente novamente.",
            )
        ThermalPrinterState.LocalWifiPrinterUnavailable ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Impressora não encontrada",
                "Confira se ela está ligada e conectada ao mesmo roteador Wi-Fi.",
            )
        ThermalPrinterState.LocalWifiAddressInvalid ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Endereço não disponível",
                "Confira o IP, a porta e o modelo informados para esta rede Wi-Fi.",
            )
        ThermalPrinterState.UsbPermissionDenied ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Acesso USB não permitido",
                "Autorize o acesso à impressora USB para enviar o teste.",
            )
        ThermalPrinterState.UsbUnavailable ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "USB não disponível",
                "Confira o cabo, o hub de dados e se a impressora está ligada.",
            )
        ThermalPrinterState.BluetoothPermissionDenied ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Acesso Bluetooth não permitido",
                "Autorize o acesso a dispositivos por perto para usar a impressora.",
            )
        ThermalPrinterState.BluetoothLeUnavailableByHostPolicy ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Bluetooth LE indisponível",
                "A política do app hospedeiro não permite esta varredura. Use Wi-Fi, USB ou " +
                    "uma impressora SPP já pareada.",
            )
        ThermalPrinterState.BluetoothUnavailable ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Bluetooth não disponível",
                AndroidPrinterUiPolicy.NO_BLUETOOTH_PRINTER_MESSAGE,
            )
        ThermalPrinterState.PaperOut ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Sem papel",
                "Coloque papel e feche a tampa antes de imprimir.",
            )
        ThermalPrinterState.CoverOpen ->
            PrinterPresentation(
                NoticeTone.WARNING,
                "Tampa aberta",
                "Feche a tampa da impressora antes de imprimir.",
            )
        // DANGER, e não WARNING: tampa aberta e falta de papel a pessoa resolve e repete; esta
        // não tem repetição que resolva. Insistir é o comportamento perigoso — na bancada, o
        // caminho ESC/POS numa impressora de outro dialeto travou o aparelho.
        ThermalPrinterState.DialectNotSupported ->
            PrinterPresentation(
                NoticeTone.DANGER,
                "Impressora incompatível",
                "Esta impressora usa outro conjunto de comandos. Nada foi enviado a ela.",
            )
        is ThermalPrinterState.Failed ->
            PrinterPresentation(NoticeTone.DANGER, title, message)
        null ->
            PrinterPresentation(
                NoticeTone.INFO,
                "Aguardando",
                "A configuração de impressora ainda não está disponível neste aparelho.",
            )
    }

private suspend fun <T> runPrinterCall(block: suspend () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

private fun Result<ThermalPrintResult>.searchNotice(
    success: String,
    thrownFailure: String,
): LocalNotice =
    when {
        isFailure -> LocalNotice("Busca interrompida", thrownFailure, NoticeTone.WARNING)
        getOrNull() == ThermalPrintResult.Printed ->
            LocalNotice("Busca concluída", success, NoticeTone.INFO)
        else -> (getOrNull() as? ThermalPrintResult.Failed).failureNotice()
    }

private fun Result<ThermalPrintResult>.printNotice(
    success: String,
    thrownFailure: String,
): LocalNotice =
    when {
        isFailure -> LocalNotice("Teste não enviado", thrownFailure, NoticeTone.WARNING)
        getOrNull() == ThermalPrintResult.Printed ->
            LocalNotice("Confira o papel", success, NoticeTone.INFO)
        else -> (getOrNull() as? ThermalPrintResult.Failed).failureNotice()
    }

private fun ThermalPrintResult.Failed?.failureNotice(): LocalNotice =
    if (this == null) {
        LocalNotice(
            "Operação não concluída",
            "Não foi possível concluir a operação.",
            NoticeTone.WARNING,
        )
    } else {
        LocalNotice(state.title, message, NoticeTone.WARNING)
    }

private fun Context.grantedBluetoothPermissions(): Set<String> =
    if (Build.VERSION.SDK_INT < AndroidPrinterUiPolicy.ANDROID_12_API) {
        emptySet()
    } else {
        buildSet {
            if (
                ContextCompat.checkSelfPermission(
                    this@grantedBluetoothPermissions,
                    Manifest.permission.BLUETOOTH_CONNECT,
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                add(AndroidPrinterUiPolicy.BLUETOOTH_CONNECT_PERMISSION)
            }
            if (
                ContextCompat.checkSelfPermission(
                    this@grantedBluetoothPermissions,
                    Manifest.permission.BLUETOOTH_SCAN,
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                add(AndroidPrinterUiPolicy.BLUETOOTH_SCAN_PERMISSION)
            }
        }
    }

internal data class ConfigurationPrinterProfile(
    val driver: PrinterDriverProfile,
    val source: PrinterProfileSource,
    val paperWidthMm: Int,
    val measuredProfile: MeasuredProfile? = null,
) {
    init {
        require((source == PrinterProfileSource.MEASURED) == (measuredProfile != null))
    }

    val badge: String
        get() =
            when (source) {
                PrinterProfileSource.MEASURED -> "Só neste celular"
                PrinterProfileSource.BUNDLED -> "Homologar novamente"
                PrinterProfileSource.TEMPORARY -> error("Temporário não entra na lista.")
            }

    val summary: String
        get() =
            if (source == PrinterProfileSource.BUNDLED) {
                "$paperWidthMm mm · configuração pendente"
            } else {
                "$paperWidthMm mm · " +
                    if (driver.hasCutter) "corta o papel" else "sem guilhotina"
            }
}

internal fun configurationPrinterProfileChoices(
    measuredProfiles: List<MeasuredProfile>,
    bundledProfiles: List<PrinterDriverProfile>,
): List<ConfigurationPrinterProfile> {
    val measured =
        measuredProfiles
            .filter { it.source == PrinterProfileSource.MEASURED }
            .map { profile ->
                ConfigurationPrinterProfile(
                    driver = profile.toDriverProfile(),
                    source = PrinterProfileSource.MEASURED,
                    paperWidthMm = profile.paperWidthMm,
                    measuredProfile = profile,
                )
            }

    val bundled =
        bundledProfiles.map { profile ->
            ConfigurationPrinterProfile(
                driver = profile,
                source = PrinterProfileSource.BUNDLED,
                paperWidthMm =
                    if (profile.id == BundledPrinterDrivers.portable58mm.id) 58 else 80,
            )
        }
    // A medição local vence uma colisão; o restante vem exclusivamente da bancada embutida.
    return (measured + bundled).distinctBy { it.driver.id }
}

/** Medições locais vencem no picker; temporários nunca vêm do store nem entram nesta lista. */
internal fun configurationPrinterProfiles(
    measuredProfiles: List<MeasuredProfile>,
    bundledProfiles: List<PrinterDriverProfile>,
): List<PrinterDriverProfile> =
    configurationPrinterProfileChoices(
        measuredProfiles = measuredProfiles,
        bundledProfiles = bundledProfiles,
    ).map(ConfigurationPrinterProfile::driver)

internal enum class PrinterSetupPath {
    PROFILE_LIST,
    READY_PROFILE_CONNECTION,

    /**
     * A pergunta de dialeto, e **só** para quem chegou por "Nova impressora".
     *
     * Quem escolheu um card do catálogo já respondeu sem saber: o card carrega o dialeto. Quem
     * entrou sem card não respondeu nada, e até 09/09/2026 essa ausência virava `EPSON_COMPATIBLE`
     * em silêncio — três `?:` nesta tela. Numa Diebold IM453H isso não é papel torto: a primeira
     * tira da medição leva `ESC @` e uma régua em `GS v 0`, e essa sequência travou o aparelho na
     * bancada em 23/08/2026, com a tecla de avanço morta e recuperação só no desligar e ligar.
     *
     * Ela vem **antes** da escolha de conexão de propósito, e não depois: é a partir dali que o
     * perfil temporário nasce, e é o dialeto dele que decide o prólogo do transporte.
     */
    NEW_PROFILE_DIALECT,
    NEW_PROFILE_CONNECTION,
    MANUAL_CONFIGURATION,
    MODEL_GRID,
    SEARCH,
}

private sealed interface SelectedSearchCandidate {
    val transport: PrinterTransport

    data class Bluetooth(
        val candidate: br.com.thermalprinterkit.BluetoothPrinterCandidate,
    ) : SelectedSearchCandidate {
        override val transport: PrinterTransport
            get() =
                if (candidate.origin == BluetoothCandidateOrigin.SPP) {
                    PrinterTransport.BLUETOOTH
                } else {
                    PrinterTransport.BLUETOOTH_LE
                }
    }

    data class Usb(val id: Long) : SelectedSearchCandidate {
        override val transport: PrinterTransport = PrinterTransport.USB
    }

    data class Wifi(val id: Long) : SelectedSearchCandidate {
        override val transport: PrinterTransport = PrinterTransport.LOCAL_WIFI
    }
}

private sealed interface PendingPreliminaryTest {
    val transport: PrinterTransport

    data class Candidate(val candidate: SelectedSearchCandidate) : PendingPreliminaryTest {
        override val transport: PrinterTransport = candidate.transport
    }

    data class ManualAddress(
        val profileId: String,
        val address: String,
        val port: Int,
    ) : PendingPreliminaryTest {
        override val transport: PrinterTransport = PrinterTransport.LOCAL_WIFI
    }
}

/** Wi-Fi direto e rede local são escolhas visuais; ambos continuam `LOCAL_WIFI` até a Fase 6. */
internal enum class PrinterConnectionChoice(
    val slug: String,
    val title: String,
    val explanation: String,
    val searchLabel: String,
) {
    USB(
        slug = "usb",
        title = "Cabo USB",
        explanation = "Ela fica ligada por cabo neste celular",
        searchLabel = "cabo USB",
    ),
    BLUETOOTH(
        slug = "bluetooth",
        title = "Bluetooth",
        explanation = "Sem fio, pertinho do celular",
        searchLabel = "Bluetooth",
    ),
    DIRECT_WIFI(
        slug = "wifi-direto",
        title = "Wi-Fi da impressora",
        explanation = "O celular se conecta direto nela",
        searchLabel = "Wi-Fi da impressora",
    ),
    LOCAL_NETWORK(
        slug = "rede-local",
        title = "Rede do local",
        explanation = "Ela está no mesmo Wi-Fi ou no cabo de rede",
        searchLabel = "rede do local",
    ),
    ;

    val isWifi: Boolean
        get() = this == DIRECT_WIFI || this == LOCAL_NETWORK

    fun supports(
        profile: PrinterDriverProfile,
        apiLevel: Int,
    ): Boolean =
        when (this) {
            USB -> profile.supports(PrinterTransport.USB)
            BLUETOOTH ->
                profile.supports(PrinterTransport.BLUETOOTH) ||
                    apiLevel >= AndroidPrinterUiPolicy.ANDROID_12_API &&
                    profile.supports(PrinterTransport.BLUETOOTH_LE)
            DIRECT_WIFI, LOCAL_NETWORK -> profile.supports(PrinterTransport.LOCAL_WIFI)
        }

    fun discoveryTransport(): PrinterTransport =
        when (this) {
            USB -> PrinterTransport.USB
            // O perfil inicial é SPP; a busca única prepara também o perfil BLE quando permitido.
            BLUETOOTH -> PrinterTransport.BLUETOOTH
            DIRECT_WIFI, LOCAL_NETWORK -> PrinterTransport.LOCAL_WIFI
        }
}

/** A pessoa escolhe Bluetooth; a versão do Android decide quais transportes podem ser procurados. */
internal fun configurationTransportSummary(apiLevel: Int): String {
    require(apiLevel >= Build.VERSION_CODES.O)
    return "Configure por Wi-Fi, USB ou Bluetooth."
}

private const val MAX_IPV4_TEXT_LENGTH = 15
private const val MAX_PORT_TEXT_LENGTH = 5
private const val MIN_TCP_PORT = 1
private const val MAX_TCP_PORT = 65_535
private const val CONSERVATIVE_DISCOVERY_PAPER_WIDTH_MM = 58

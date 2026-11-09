package br.com.thermalprinterkit

import android.bluetooth.BluetoothAdapter
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Estado efêmero da única busca Bluetooth apresentada pelo app. */
sealed interface BluetoothDiscoveryState {
    data object Idle : BluetoothDiscoveryState

    data class Searching(
        val candidates: List<BluetoothPrinterCandidate>,
        val likelyCandidateIds: Set<Long> = emptySet(),
    ) : BluetoothDiscoveryState {
        override fun toString(): String = "Searching(count=${candidates.size})"
    }

    data class Finished(
        val candidates: List<BluetoothPrinterCandidate>,
        val pairedFailure: ThermalPrinterState? = null,
        val bleFailure: ThermalPrinterState? = null,
        val likelyCandidateIds: Set<Long> = emptySet(),
        /**
         * Por que o lado SPP voltou vazio — rádio desligado, nada pareado, pareadas sem impressão.
         *
         * Campo novo com padrão nulo, e não um [ThermalPrinterState] novo: ver a mesma decisão, e o
         * mesmo motivo de compilação, em [ThermalPrintResult.Failed.causa].
         */
        val pairedCausa: CausaDaBuscaVazia? = null,
        /** O mesmo para o lado BLE. */
        val bleCausa: CausaDaBuscaVazia? = null,
    ) : BluetoothDiscoveryState {
        override fun toString(): String =
            "Finished(count=${candidates.size}, pairedFailure=${pairedFailure?.javaClass?.simpleName}, " +
                "bleFailure=${bleFailure?.javaClass?.simpleName}, " +
                "pairedCausa=${pairedCausa?.javaClass?.simpleName}, " +
                "bleCausa=${bleCausa?.javaClass?.simpleName})"
    }
}

/** Ponte neutra para a tela mesclar SPP e BLE sem escolher transporte em nome da pessoa. */
interface BluetoothDiscoveryHost {
    val bluetoothDiscovery: StateFlow<BluetoothDiscoveryState>

    suspend fun searchBluetoothPrinters(
        pairedProfileId: String?,
        bleProfileId: String?,
        scanBle: Boolean,
    ): ThermalPrintResult
}

/** Consulta o nome somente enquanto monta a busca; a instalação guarda o endereço separadamente. */
@Suppress("DEPRECATION")
private fun BluetoothPrinterHandle.withEphemeralSystemName(fallbackNumber: Int): BluetoothPrinterHandle {
    val systemName =
        discoveryAddress
            ?.let { address ->
                runCatching {
                    BluetoothAdapter.getDefaultAdapter()
                        ?.getRemoteDevice(address)
                        ?.name
                }.getOrNull()
            }?.trim()
            ?.takeIf(String::isNotEmpty)
    val declaredName = systemName ?: label.trim().takeIf(String::isNotEmpty)
    // Sem nome, o rótulo não pode chamar o aparelho de impressora: a lista mostra tudo o que o
    // rádio encontrou, e a maior parte não é impressora nenhuma.
    val visibleLabel = declaredName ?: "Aparelho sem nome $fallbackNumber"
    return BluetoothPrinterHandle(id, visibleLabel, discoveryAddress, named = declaredName != null)
}

/**
 * Impressão TCP/ESC-POS somente pela Wi-Fi local confirmada. Cada socket é aberto pela
 * [android.net.Network] Wi-Fi escolhida e fechado ao fim de cada trabalho. QR e token nunca são
 * persistidos. O perfil guarda capacidades; a instalação criptografada guarda a identidade física
 * necessária para reencontrar a impressora confirmada.
 */
class LocalWifiThermalPrinter(
    private val port: LocalWifiThermalPort,
    private val usbPort: UsbThermalPort? = null,
    private val bluetoothPort: BluetoothThermalPort? = null,
    private val blePort: BleThermalPort? = null,
    private val discovery: LocalWifiPrinterDiscovery,
    private val networkProvider: LocalWifiNetworkProvider,
    private val driverProfiles: List<PrinterDriverProfile> = BundledPrinterDrivers.all,
    private val selectionStore: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
    override val profileStore: PrinterProfileStore = InMemoryPrinterProfileStore(),
    private val bluetoothLeScanPolicy: BluetoothLeScanPolicy = BluetoothLeScanPolicy.ALLOW,
    /**
     * Cabeçalho e rodapé do app hospedeiro, aplicados a todo cupom que sai por qualquer transporte.
     *
     * Default `null`: quem não passa nada imprime o que sempre imprimiu. Ver [ReceiptDecoration].
     */
    private val receiptDecoration: ReceiptDecoration? = null,
    private val zoneId: ZoneId = ZoneId.systemDefault(),
    private val monotonicNanos: () -> Long = System::nanoTime,
    /**
     * O mesmo quadro de medição que o hospedeiro entregou às portas, republicado para a tela.
     *
     * O kit não constrói um por conta própria: sem quadro, o transporte não mede e a tela não mostra
     * painel nenhum — que é exatamente o estado de quem nunca pediu medição.
     */
    override val transportTelemetry: TransportTelemetry? = null,
    /**
     * Altura de banda do raster, sobrescrita enquanto o app está rodando; `null` mantém o padrão.
     *
     * Ponto de injeção neutro, do mesmo feitio do teto de vazão das portas, e pelo mesmo motivo: só
     * a bancada precisa dele, e o kit não lê preferência nenhuma. Quem oferece o controle é o app
     * hospedeiro, no build de depuração dele. Sem sobrescrita, o cupom sai com os bytes de sempre.
     *
     * É lido **a cada cupom**, e não uma vez na composição: trocar a altura e mandar imprimir em
     * seguida precisa valer no papel seguinte, que é o laço inteiro da medição.
     */
    private val rasterStripeHeightOverride: () -> Int? = { null },
    /**
     * O que o hospedeiro prefere para os códigos daquela impressora; `null` mantém o padrão.
     *
     * Ponto de injeção neutro, do mesmo feitio de [rasterStripeHeightOverride] e do teto de vazão
     * das portas: **o kit não lê preferência nenhuma**, e esta assinatura não sabe que existe uma
     * tela de ajustes do outro lado. Recebe o `profileId` porque a escolha é por impressora — um
     * ajuste global seria um segundo cadastro.
     *
     * Também é lido **a cada cupom**, e pelo mesmo motivo: a pessoa troca o ajuste e manda imprimir
     * em seguida, e o papel seguinte precisa sair pelo modo que ela acabou de escolher.
     *
     * O que chega aqui ainda passa pela trava de [ReceiptLayout.from]: preferência que a capacidade
     * medida não sustenta cai no padrão antes de virar byte.
     */
    private val codeEmissionOverride: (String) -> ThermalCodeEmissionPreferences? = { null },
) :
    ThermalPrinter,
    PrinterHomologationHost,
    TemporaryPrinterDiscoveryProfileHost,
    TransportTelemetryHost,
    BluetoothDiscoveryHost {
    private val mutex = Mutex()

    /**
     * O layout deste cupom, com a decoração do hospedeiro e a altura de banda que vale agora.
     *
     * Existe para que a sobrescrita de bancada não precise ser lembrada em cada um dos pontos que
     * montam cupom — esquecer um deles faria a medição sair certa por um caminho e errada por outro,
     * que é a pior forma de errar numa bancada.
     */
    private fun receiptLayout(profile: PrinterDriverProfile): ReceiptLayout =
        ReceiptLayout.from(
            profile,
            receiptDecoration,
            rasterStripeHeightOverride() ?: DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
            codeEmissionOverride(profile.id) ?: ThermalCodeEmissionPreferences.DEFAULT,
        )
    private val mutableState = MutableStateFlow<ThermalPrinterState>(ThermalPrinterState.PrinterNotSelected)
    private var candidatePool: CandidatePool? = null
    private var pendingSelection: PendingSelection? = null
    private var confirmedSelection: ConfirmedSelection? = null
    private var usbCandidates: List<UsbPrinterHandle> = emptyList()
    private var usbCandidateProfile: PrinterDriverProfile? = null
    private var pendingUsbSelection: PendingUsbSelection? = null
    private var confirmedUsbSelection: ConfirmedUsbSelection? = null
    private var bluetoothCandidates: List<BluetoothPrinterHandle> = emptyList()
    private var bluetoothCandidateProfile: PrinterDriverProfile? = null
    private var pendingBluetoothSelection: PendingBluetoothSelection? = null
    private var confirmedBluetoothSelection: ConfirmedBluetoothSelection? = null
    private var bleCandidates: List<BlePrinterHandle> = emptyList()
    private var bleCandidateProfile: PrinterDriverProfile? = null
    private var pendingBleSelection: PendingBleSelection? = null
    private var confirmedBleSelection: ConfirmedBleSelection? = null
    @Volatile private var unifiedBluetoothTargets: Map<Long, UnifiedBluetoothTarget> = emptyMap()
    private var nextCandidateId = 1L

    /** Perfis locais são relidos no começo de cada busca ou restauração. */
    private var availableDriverProfiles: List<PrinterDriverProfile> = driverProfiles
    private val temporaryDiscoveryProfiles = ConcurrentHashMap<String, PrinterDriverProfile>()

    // Declarado antes do `init`: ele chama `publishAdopted()` na construção.
    private val mutableAdopted = MutableStateFlow<List<AdoptedPrinter>>(emptyList())
    private val mutableBluetoothDiscovery =
        MutableStateFlow<BluetoothDiscoveryState>(BluetoothDiscoveryState.Idle)

    init {
        require(driverProfiles.isNotEmpty()) { "É necessário ao menos um perfil de impressora." }
        require(driverProfiles.map(PrinterDriverProfile::id).distinct().size == driverProfiles.size) {
            "Os perfis de impressora precisam ter identificadores únicos."
        }
        // A readoção NÃO acontece aqui. Ela varre BLE, o que leva segundos, e um construtor que
        // bloqueia a thread chamadora é uma armadilha para quem instancia isto na inicialização
        // do app. Chame `restore()` de dentro de uma corrotina.
        publishAdopted()
    }

    override val state: StateFlow<ThermalPrinterState> = mutableState.asStateFlow()

    override val adoptedPrinters: StateFlow<List<AdoptedPrinter>> = mutableAdopted.asStateFlow()

    override val bluetoothDiscovery: StateFlow<BluetoothDiscoveryState> =
        mutableBluetoothDiscovery.asStateFlow()

    override fun prepareTemporaryDiscoveryProfile(
        transport: PrinterTransport,
        paperWidthMm: Int,
        displayName: String?,
        dialect: EscPosDialect,
    ): PrinterDriverProfile =
        MeasuredProfile
            .temporary(
                transport = transport,
                paperWidthMm = paperWidthMm,
                displayName = displayName,
                dialect = dialect,
            )
            .toDriverProfile()
            .also { profile -> temporaryDiscoveryProfiles[profile.id] = profile }

    override fun hasPendingTemporaryDiscoveryProfile(): Boolean =
        pendingTemporaryDiscoveryProfileId() != null

    /**
     * Reaplica a largura à candidata já selecionada, trocando o perfil temporário dela.
     *
     * Só mexe em quem carrega perfil temporário: candidata com perfil medido ou empacotado tem
     * largura própria, e sobrescrevê-la aqui seria decidir por uma medição que já existe.
     */
    override suspend fun forgetMeasuredProfile(profileId: String) {
        mutex.withLock {
            // A conta de quem apontava para o perfil vem **antes** de apagar. Depois da remoção o
            // perfil já não resolve, e a seleção órfã se apresentaria como o conservador — que é
            // exatamente o que ela não pode virar sem ninguém pedir.
            //
            // Aqui `withoutProfile` é o certo, e não `withoutInstallation`: quem esquece uma
            // medição escolheu apagar o **perfil**, não uma unidade. Duas MTP-II irmãs que
            // compartilham a medição perdem as duas instalações porque nenhuma delas tem mais
            // capacidade guardada para reencontrar. Guardar a irmã seria guardar um vínculo que
            // aponta para nada. É o oposto do caso de `removeInstallation`, onde o perfil
            // sobrevive justamente porque a irmã ainda o usa.
            val stored = selectionStore.read()
            val remaining = stored.withoutProfile(profileId)
            selectionStore.save(remaining)
            withContext(Dispatchers.IO) { profileStore.remove(profileId) }
            confirmedSelection = confirmedSelection?.takeIf { it.selection.profile.id != profileId }
            confirmedUsbSelection = confirmedUsbSelection?.takeIf { it.profile.id != profileId }
            confirmedBluetoothSelection =
                confirmedBluetoothSelection?.takeIf { it.profile.id != profileId }
            confirmedBleSelection = confirmedBleSelection?.takeIf { it.profile.id != profileId }
            refreshAvailableDriverProfiles()
            publishAdopted(remaining)
        }
    }

    override suspend fun applyTemporaryDiscoveryPaperWidth(paperWidthMm: Int) {
        mutex.withLock {
            fun retarget(
                profile: PrinterDriverProfile,
                transport: PrinterTransport,
            ): PrinterDriverProfile =
                if (temporaryDiscoveryProfiles.containsKey(profile.id)) {
                    // O dialeto vem do perfil que esta sendo trocado, e nao do padrao: aqui so se
                    // reaplica **largura**. Sem esta linha, tocar em "58 mm" devolvia a candidata
                    // Procomp para ESC/POS sem nada na tela dizer isso.
                    prepareTemporaryDiscoveryProfile(
                        transport,
                        paperWidthMm,
                        profile.displayName,
                        profile.dialect,
                    )
                } else {
                    profile
                }

            pendingSelection =
                pendingSelection?.let { pending ->
                    pending.copy(
                        selection =
                            pending.selection.copy(
                                profile = retarget(pending.selection.profile, PrinterTransport.LOCAL_WIFI),
                            ),
                    )
                }
            confirmedSelection =
                confirmedSelection?.let { confirmed ->
                    confirmed.copy(
                        selection =
                            confirmed.selection.copy(
                                profile = retarget(confirmed.selection.profile, PrinterTransport.LOCAL_WIFI),
                            ),
                    )
                }
            pendingUsbSelection =
                pendingUsbSelection?.let { it.copy(profile = retarget(it.profile, PrinterTransport.USB)) }
            confirmedUsbSelection =
                confirmedUsbSelection?.let { it.copy(profile = retarget(it.profile, PrinterTransport.USB)) }
            pendingBluetoothSelection =
                pendingBluetoothSelection?.let {
                    it.copy(profile = retarget(it.profile, PrinterTransport.BLUETOOTH))
                }
            confirmedBluetoothSelection =
                confirmedBluetoothSelection?.let {
                    it.copy(profile = retarget(it.profile, PrinterTransport.BLUETOOTH))
                }
            pendingBleSelection =
                pendingBleSelection?.let {
                    it.copy(profile = retarget(it.profile, PrinterTransport.BLUETOOTH_LE))
                }
            confirmedBleSelection =
                confirmedBleSelection?.let {
                    it.copy(profile = retarget(it.profile, PrinterTransport.BLUETOOTH_LE))
                }
        }
    }

    override suspend fun applyPendingDiscoveryProfile(profileId: String) {
        mutex.withLock {
            refreshAvailableDriverProfiles()
            val profile = profileFor(profileId) ?: error("Perfil de impressora não encontrado.")
            pendingSelection = pendingSelection?.let { it.copy(selection = it.selection.copy(profile = profile)) }
            confirmedSelection = confirmedSelection?.let { it.copy(selection = it.selection.copy(profile = profile)) }
            pendingUsbSelection = pendingUsbSelection?.copy(profile = profile)
            confirmedUsbSelection = confirmedUsbSelection?.copy(profile = profile)
            if (usbCandidates.isNotEmpty()) usbCandidateProfile = profile
            pendingBluetoothSelection = pendingBluetoothSelection?.copy(profile = profile)
            confirmedBluetoothSelection = confirmedBluetoothSelection?.copy(profile = profile)
            if (bluetoothCandidates.isNotEmpty()) bluetoothCandidateProfile = profile
            pendingBleSelection = pendingBleSelection?.copy(profile = profile)
            confirmedBleSelection = confirmedBleSelection?.copy(profile = profile)
            if (bleCandidates.isNotEmpty()) bleCandidateProfile = profile
            unifiedBluetoothTargets = unifiedBluetoothTargets.mapValues { (_, target) ->
                when (target) {
                    is UnifiedBluetoothTarget.Spp -> target.copy(profile = profile)
                    is UnifiedBluetoothTarget.Ble -> target.copy(profile = profile)
                }
            }
            candidatePool = candidatePool?.copy(profile = profile)
        }
    }

    override suspend fun activatePrinter(transport: PrinterTransport) {
        mutex.withLock {
            selectionStore.save(selectionStore.read().activatedAt(transport))
            publishAdopted()
        }
    }

    override suspend fun activateInstalledPrinter(profileId: String) {
        mutex.withLock {
            val stored = selectionStore.read()
            val selected = stored.ofProfile(profileId) ?: return@withLock
            selectionStore.save(stored.activatedProfile(selected))
            // A escolha publica antes da reconexão: o restore varre BLE por segundos e, segurando
            // a publicação até o fim dele, o check fica congelado na unidade anterior — na bancada
            // isso foi lido como "não dá para selecionar a outra".
            publishAdopted()
            when (selected.transport) {
                PrinterTransport.LOCAL_WIFI -> clearWifiSelections()
                PrinterTransport.USB -> clearUsbSelections()
                PrinterTransport.BLUETOOTH -> clearBluetoothSelections()
                PrinterTransport.BLUETOOTH_LE -> clearBleSelections()
            }
            withContext(Dispatchers.IO) { restoreOne(selected) }
        }
    }

    override suspend fun activateInstallation(installationId: String) {
        mutex.withLock {
            val stored = selectionStore.read()
            val selected = stored.ofInstallation(installationId) ?: return@withLock
            selectionStore.save(stored.activatedProfile(selected))
            // Mesma ordem do caminho por perfil: primeiro a escolha aparece, depois reconecta.
            publishAdopted()
            clearSelectionsOf(selected.transport)
            withContext(Dispatchers.IO) { restoreOne(selected) }
        }
    }

    override suspend fun removeInstallation(installationId: String) {
        mutex.withLock { removeInstallationLocked(installationId) }
    }

    /** O corpo compartilhado; o `Mutex` do Kotlin não é reentrante e cada chamador já o segura. */
    private suspend fun removeInstallationLocked(installationId: String) {
        val stored = selectionStore.read()
        val removed = stored.ofInstallation(installationId) ?: return
        val wasActive = stored.activeSelection?.installationId == installationId
        val remaining = stored.withoutInstallation(installationId)
        // O perfil medido só é apagado quando nenhuma outra unidade ainda o usa. Duas MTP-II
        // compartilham a medição, e remover uma não pode levar a capacidade da outra — perfil
        // medido pelo usuário nunca se perde por efeito colateral.
        if (remaining.selections.none { it.profileId == removed.profileId }) {
            withContext(Dispatchers.IO) { profileStore.remove(removed.profileId) }
        }
        selectionStore.save(remaining)
        if (wasActive) {
            clearSelectionsOf(removed.transport)
            remaining.activeSelection?.let { selected ->
                withContext(Dispatchers.IO) { restoreOne(selected) }
            }
        }
        publishAdopted(remaining)
        if (remaining.selections.isEmpty()) {
            mutableState.value = ThermalPrinterState.PrinterNotSelected
        }
    }

    private fun clearSelectionsOf(transport: PrinterTransport) {
        when (transport) {
            PrinterTransport.LOCAL_WIFI -> clearWifiSelections()
            PrinterTransport.USB -> clearUsbSelections()
            PrinterTransport.BLUETOOTH -> clearBluetoothSelections()
            PrinterTransport.BLUETOOTH_LE -> clearBleSelections()
        }
    }

    /**
     * Exclui **uma** impressora: a instalação ativa daquele transporte.
     *
     * Antes usava `without(transport)`, que apagava todas as instalações do meio físico de uma vez.
     * Isso era coerente quando cada transporte só cabia uma impressora; com duas BLE no balcão,
     * excluir a T210 levava junto a MTP-II que ninguém mandou excluir.
     *
     * A API sobrevive porque a superfície ainda a usa como fallback: `AdoptedPrinter.installationId`
     * é opcional no contrato, e a tela de exclusão cai aqui quando ele vem nulo. Contra o
     * `LocalWifiThermalPrinter` esse caso não ocorre — ele sempre preenche o id —, mas o contrato
     * permite outra implementação sem ele, e um fallback que apaga demais é pior que um que apaga
     * uma. Quem sabe qual unidade excluir deve chamar [removeInstallation].
     */
    override suspend fun removePrinter(transport: PrinterTransport) {
        mutex.withLock {
            // `of` já prefere a ativa daquele transporte e só então a primeira encontrada.
            val alvo = selectionStore.read().of(transport) ?: return@withLock
            removeInstallationLocked(alvo.installationId)
        }
    }

    override suspend fun removeInstalledPrinter(profileId: String) {
        mutex.withLock {
            val stored = selectionStore.read()
            val removed = stored.ofProfile(profileId) ?: return@withLock
            val wasActive = stored.activeSelection?.profileId == profileId
            val remaining = stored.withoutProfile(profileId)
            withContext(Dispatchers.IO) { profileStore.remove(profileId) }
            selectionStore.save(remaining)
            if (wasActive) {
                when (removed.transport) {
                    PrinterTransport.LOCAL_WIFI -> clearWifiSelections()
                    PrinterTransport.USB -> clearUsbSelections()
                    PrinterTransport.BLUETOOTH -> clearBluetoothSelections()
                    PrinterTransport.BLUETOOTH_LE -> clearBleSelections()
                }
                remaining.activeSelection?.let { selected ->
                    withContext(Dispatchers.IO) { restoreOne(selected) }
                }
            }
            publishAdopted(remaining)
            if (remaining.selections.isEmpty()) {
                mutableState.value = ThermalPrinterState.PrinterNotSelected
            }
        }
    }

    /** Reconstrói a lista a partir do que está guardado; a fonte da verdade é o armazenamento. */
    private fun publishAdopted(
        stored: PersistedPrinterSelections = selectionStore.read(),
    ) {
        mutableAdopted.value = adoptedPresentation(stored)
    }

    private fun adoptedPresentation(stored: PersistedPrinterSelections): List<AdoptedPrinter> =
        stored.selections.map { selection ->
            val resolved = resolvedProfileFor(selection)
            AdoptedPrinter(
                transport = selection.transport,
                displayName = resolved.profile.displayName,
                // Por unidade, não por perfil: com duas iguais instaladas, comparar perfil
                // marcaria as duas como ativas.
                active = selection.installationId == stored.activeSelection?.installationId,
                warning = resolved.warning,
                profileId = selection.profileId,
                installationId = selection.installationId,
            )
        }

    override suspend fun searchUsb(profileId: String): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        refreshAvailableDriverProfiles()
                        val activePort = usbPort
                            ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                        val profile = profileFor(profileId)
                            ?: return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        // Procurar não desinstala. O handle em memória cai porque a enumeração vai
                        // refazê-lo, mas o vínculo persistido continua: `selectionForNextUsbJob`
                        // recompõe a partir do store quando alguém imprimir de novo.
                        //
                        // Medido no A75 em 17/08: a TM-T20X-II foi instalada, a tela de adicionar
                        // impressora abriu a busca sozinha, e a instalação sumiu antes de qualquer
                        // candidata aparecer — o perfil medido ficou no store e a lista de
                        // instalações voltou vazia. Desinstalar era resto de quando cada transporte
                        // só cabia uma impressora.
                        publishAdopted()
                        confirmedUsbSelection = null
                        usbCandidates = emptyList()
                        mutableState.value = ThermalPrinterState.UsbSearching
                        val discovered = activePort.discover(profile)
                        currentCoroutineContext().ensureActive()
                        if (discovered.isEmpty()) {
                            fail(ThermalPrinterState.UsbUnavailable)
                        } else {
                            usbCandidates = discovered
                            usbCandidateProfile = profile
                            mutableState.value = usbCandidatesPresentation()
                            ThermalPrintResult.Printed
                        }
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun bindSearchedUsbPrinter(candidateId: Long): Boolean =
        mutex.withLock {
            val handle = usbCandidates.firstOrNull { it.id == candidateId } ?: return@withLock false
            val profile = usbCandidateProfile ?: return@withLock false
            // Nenhum byte sai daqui. O alvo efêmero passa a existir para as ferramentas de
            // diagnóstico, e o estado **não** vira `SearchConfirmationRequired`: não há
            // comprovante para confirmar, e fingir que há seria abrir a porta da adoção sem papel.
            pendingUsbSelection = PendingUsbSelection(handle = handle, profile = profile)
            true
        }

    override suspend fun testSearchedUsbPrinter(candidateId: Long): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        val activePort = usbPort
                            ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                        val handle = usbCandidates.firstOrNull { it.id == candidateId }
                            ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                        val profile = usbCandidateProfile
                            ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                        val result = runUsbTest(activePort, handle, profile)
                        if (result == ThermalPrintResult.Printed) {
                            pendingUsbSelection =
                                PendingUsbSelection(
                                    handle = handle,
                                    profile = profile,
                                )
                            mutableState.value = ThermalPrinterState.SearchConfirmationRequired
                        }
                        result
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    /**
     * Inicia o scan BLE em paralelo à consulta instantânea dos vínculos SPP. A chave de endereço
     * nunca entra no estado público: ela existe somente no mapa local e morre ao fim desta busca.
     */
    override suspend fun searchBluetoothPrinters(
        pairedProfileId: String?,
        bleProfileId: String?,
        scanBle: Boolean,
    ): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        refreshAvailableDriverProfiles()
                        val pairedProfile = pairedProfileId?.let(::profileFor)
                        val bleProfile = bleProfileId?.let(::profileFor)
                        if (pairedProfileId != null && pairedProfile == null) {
                            return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        }
                        if (scanBle && bleProfileId != null && bleProfile == null) {
                            return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        }

                        // Procurar não desinstala; ver a mesma decisão em `searchUsb`. Esta busca
                        // nasceu depois daquele conserto e repetiu o padrão que ele tinha tirado
                        // dos outros transportes: `withoutActiveAt` + `save` na **porta** da busca.
                        //
                        // Medido no A07, duas vezes: a MTP-II estava instalada e ativa em BLE, o
                        // usuário tocou em adicionar a T210 — também BLE — e a MTP-II sumiu da
                        // lista antes de qualquer candidata aparecer. Cancelar não devolvia nada,
                        // porque a perda já tinha acontecido na entrada. Só a confirmação humana
                        // grava, e `with()` já entra por unidade: a segunda T210 cabe ao lado da
                        // MTP-II sem apagá-la.
                        //
                        // O confirmado em memória cai porque a busca vai reabrir o rádio e refazer
                        // os handles; o vínculo persistido continua e `restore()` o traz de volta.
                        if (pairedProfile != null) {
                            confirmedBluetoothSelection = null
                            bluetoothCandidates = emptyList()
                            bluetoothCandidateProfile = pairedProfile
                        }
                        if (scanBle && bleProfile != null) {
                            confirmedBleSelection = null
                            bleCandidates = emptyList()
                            bleCandidateProfile = bleProfile
                        }
                        publishAdopted()
                        unifiedBluetoothTargets = emptyMap()
                        mutableState.value = ThermalPrinterState.BluetoothSearching
                        mutableBluetoothDiscovery.value =
                            BluetoothDiscoveryState.Searching(emptyList())

                        coroutineScope {
                            val mergeLock = Any()
                            val merged = linkedMapOf<String, UnifiedBluetoothTarget>()

                            // Escritas de dentro do `async` e do trecho SPP; lidas só depois do
                            // `await`, que estabelece a ordem de acontecimento entre as duas.
                            var pairedCausa: CausaDaBuscaVazia? = null
                            var bleCausa: CausaDaBuscaVazia? = null

                            fun discoverySnapshot(): BluetoothCandidatesSnapshot =
                                synchronized(mergeLock) {
                                    val ordered =
                                        merged.values.sortedByDescending(
                                            UnifiedBluetoothTarget::isLikelyPrinter,
                                        )
                                    BluetoothCandidatesSnapshot(
                                        candidates =
                                            ordered.map { target ->
                                                BluetoothPrinterCandidate(
                                                    id = target.presentationId,
                                                    label = target.label,
                                                    origin = target.origin,
                                                    named = target.named,
                                                )
                                            },
                                        likelyCandidateIds =
                                            ordered
                                                .filter(UnifiedBluetoothTarget::isLikelyPrinter)
                                                .mapTo(linkedSetOf(), UnifiedBluetoothTarget::presentationId),
                                    )
                                }

                            fun publishProgress() {
                                val snapshot = discoverySnapshot()
                                synchronized(mergeLock) {
                                    unifiedBluetoothTargets =
                                        merged.values.associateBy(UnifiedBluetoothTarget::presentationId)
                                }
                                mutableBluetoothDiscovery.value =
                                    BluetoothDiscoveryState.Searching(
                                        candidates = snapshot.candidates,
                                        likelyCandidateIds = snapshot.likelyCandidateIds,
                                    )
                            }

                            fun addBle(handle: BlePrinterHandle) {
                                synchronized(mergeLock) {
                                    val key =
                                        handle.discoveryAddress?.let { "address:$it" }
                                            ?: "ble:${handle.id}"
                                    when (val previous = merged[key]) {
                                        null ->
                                            merged[key] =
                                                UnifiedBluetoothTarget.Ble(
                                                    presentationId = nextCandidateId(),
                                                    handle = handle,
                                                    profile = requireNotNull(bleProfile),
                                                )
                                        is UnifiedBluetoothTarget.Ble ->
                                            merged[key] = previous.copy(handle = handle)
                                        is UnifiedBluetoothTarget.Spp -> Unit
                                    }
                                }
                                publishProgress()
                            }

                            val bleSearch =
                                if (scanBle && bleProfile != null) {
                                    async(Dispatchers.IO) {
                                        if (
                                            bluetoothLeScanPolicy.availability() ==
                                                BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
                                        ) {
                                            bleCausa = CausaDaVarreduraLeVazia.BloqueadaPeloHospedeiro
                                            return@async ThermalPrinterState
                                                .BluetoothLeUnavailableByHostPolicy
                                        }
                                        val activePort = blePort
                                        if (activePort == null) {
                                            bleCausa = CausaDaVarreduraLeVazia.KitSemPortaBluetooth
                                            return@async ThermalPrinterState.BluetoothUnavailable
                                        }
                                        try {
                                            when (
                                                val varredura =
                                                    activePort.varrer(bleProfile, ::addBle)
                                            ) {
                                                is ResultadoDaVarreduraLe.Vazia -> {
                                                    bleCandidates = emptyList()
                                                    bleCausa = varredura.causa
                                                }
                                                is ResultadoDaVarreduraLe.Encontradas ->
                                                    bleCandidates = varredura.anunciantes
                                            }
                                            null
                                        } catch (error: CancellationException) {
                                            throw error
                                        } catch (error: Throwable) {
                                            bleCausa =
                                                CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada
                                                    .takeIf {
                                                        (error as? ThermalPortException)?.failure ==
                                                            ThermalPortFailure.BluetoothPermissionDenied
                                                    }
                                            bluetoothStateFor(error, false)
                                        }
                                    }
                                } else {
                                    null
                                }

                            val pairedFailure =
                                if (pairedProfile == null) {
                                    null
                                } else {
                                    val activePort = bluetoothPort
                                    if (activePort == null) {
                                        pairedCausa = CausaDaBuscaPareadaVazia.KitSemPortaBluetooth
                                        ThermalPrinterState.BluetoothUnavailable
                                    } else {
                                        try {
                                            bluetoothCandidates =
                                                when (
                                                    val busca =
                                                        activePort.buscarPareadas(pairedProfile)
                                                ) {
                                                    is ResultadoDaBuscaPareada.Vazia -> {
                                                        pairedCausa = busca.causa
                                                        emptyList()
                                                    }
                                                    is ResultadoDaBuscaPareada.Encontradas ->
                                                        busca.pareadas
                                                }
                                            synchronized(mergeLock) {
                                                bluetoothCandidates.forEachIndexed { index, handle ->
                                                    val visibleHandle =
                                                        handle.withEphemeralSystemName(index + 1)
                                                    val key =
                                                        handle.discoveryAddress?.let { "address:$it" }
                                                            ?: "spp:${handle.id}"
                                                    val previousId = merged[key]?.presentationId
                                                    // SPP vence o duplicado: já está pareado e não
                                                    // exige reencontrar o anúncio a cada uso.
                                                    merged[key] =
                                                        UnifiedBluetoothTarget.Spp(
                                                            presentationId =
                                                                previousId ?: nextCandidateId(),
                                                            handle = visibleHandle,
                                                            profile = pairedProfile,
                                                        )
                                                }
                                            }
                                            publishProgress()
                                            null
                                        } catch (error: CancellationException) {
                                            throw error
                                        } catch (error: Throwable) {
                                            pairedCausa =
                                                CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada
                                                    .takeIf {
                                                        (error as? ThermalPortException)?.failure ==
                                                            ThermalPortFailure.BluetoothPermissionDenied
                                                    }
                                            bluetoothStateFor(error, false)
                                        }
                                    }
                                }

                            val bleFailure = bleSearch?.await()
                            val snapshot = discoverySnapshot()
                            val candidates = snapshot.candidates
                            synchronized(mergeLock) {
                                unifiedBluetoothTargets =
                                    merged.values.associateBy(UnifiedBluetoothTarget::presentationId)
                            }
                            // Os dois estados finais viram variáveis porque são lidos duas vezes: em
                            // `Finished`, um por campo, e na escolha do estado único lá embaixo.
                            // `estadoDaBuscaVazia` no lugar do literal `BluetoothUnavailable` é o
                            // mesmo conserto dos outros dois pontos de entrada — a tela de
                            // `:printher` decide o aviso de acesso parcial comparando estes dois
                            // campos com `BluetoothPermissionDenied`, e com o literal a comparação
                            // nunca mais seria verdadeira.
                            val pairedFinal =
                                pairedFailure
                                    ?: estadoDaBuscaVazia(pairedCausa)
                                        .takeIf {
                                            pairedProfile != null &&
                                                bluetoothCandidates.isEmpty()
                                        }
                            val bleFinal =
                                bleFailure
                                    ?: estadoDaBuscaVazia(bleCausa)
                                        .takeIf {
                                            scanBle && bleProfile != null && bleCandidates.isEmpty()
                                        }
                            mutableBluetoothDiscovery.value =
                                BluetoothDiscoveryState.Finished(
                                    candidates = candidates,
                                    likelyCandidateIds = snapshot.likelyCandidateIds,
                                    pairedFailure = pairedFinal,
                                    bleFailure = bleFinal,
                                    pairedCausa = pairedCausa,
                                    bleCausa = bleCausa,
                                )
                            if (candidates.isNotEmpty()) {
                                mutableState.value =
                                    ThermalPrinterState.BluetoothCandidatesFound(candidates)
                                ThermalPrintResult.Printed
                            } else {
                                // Com as duas metades vazias existem duas causas, e o resultado
                                // único só carrega uma. Escolhe-se **o lado**, e dele saem estado e
                                // causa juntos; as duas continuam publicadas em `Finished`, cada
                                // uma no seu campo, que é como a tela precisa lê-las.
                                //
                                // Antes o lado era decidido por `failure === bleFailure` depois de
                                // o estado já ter sido escolhido. `BluetoothUnavailable` é `data
                                // object`: quando o lado escolhido era o do SPP e o do BLE calhava
                                // de ser o mesmo objeto, a identidade dizia "veio do BLE" e a causa
                                // do SPP era jogada fora. Medido em 04/09/2026 com dublês: SPP
                                // `Vazia(NenhumaPareada)` + BLE que lança `BluetoothDisconnected`
                                // saía com `causa = null`, que pelo contrato do campo significa
                                // "esta porta não distingue" — e era mentira.
                                val (failure, causaDoLado) =
                                    when {
                                        pairedFinal ==
                                            ThermalPrinterState.BluetoothPermissionDenied ->
                                            pairedFinal to pairedCausa
                                        bleFinal ==
                                            ThermalPrinterState.BluetoothPermissionDenied ->
                                            bleFinal to bleCausa
                                        bleFinal ==
                                            ThermalPrinterState
                                                .BluetoothLeUnavailableByHostPolicy ->
                                            bleFinal to bleCausa
                                        // Fora os impedimentos, o SPP fala primeiro: é o lado que a
                                        // pessoa do balcão tem como agir (parear nos Ajustes).
                                        pairedCausa != null ->
                                            (pairedFinal
                                                ?: ThermalPrinterState.BluetoothUnavailable) to
                                                pairedCausa
                                        else ->
                                            (bleFinal
                                                ?: ThermalPrinterState.BluetoothUnavailable) to
                                                bleCausa
                                    }
                                fail(
                                    failure,
                                    causa = causaDoLado,
                                )
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    unifiedBluetoothTargets = emptyMap()
                    mutableBluetoothDiscovery.value = BluetoothDiscoveryState.Idle
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun searchBluetooth(profileId: String): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        refreshAvailableDriverProfiles()
                        val activePort = bluetoothPort
                            ?: return@withContext fail(
                                ThermalPrinterState.BluetoothUnavailable,
                                causa = CausaDaBuscaPareadaVazia.KitSemPortaBluetooth,
                            )
                        val profile = profileFor(profileId)
                            ?: return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        // Procurar não desinstala; ver a mesma decisão em `searchUsb`.
                        publishAdopted()
                        confirmedBluetoothSelection = null
                        bluetoothCandidates = emptyList()
                        unifiedBluetoothTargets = emptyMap()
                        mutableBluetoothDiscovery.value = BluetoothDiscoveryState.Idle
                        mutableState.value = ThermalPrinterState.BluetoothSearching
                        val busca =
                            try {
                                activePort.buscarPareadas(profile)
                            } catch (error: ThermalPortException) {
                                // Permissão negada não é "nenhuma impressora pareada": a tela
                                // precisa pedir a permissão, não mandar parear de novo.
                                //
                                // Este `catch` é para as portas de integração que ainda lançam. A
                                // porta Android **não** passa mais por aqui: ela devolve
                                // `Vazia(PermissaoDeConexaoNegada)`, e quem faz a mesma tradução
                                // para ela é `estadoDaBuscaVazia`, no ramo `Vazia` logo abaixo. Os
                                // dois caminhos precisam continuar dizendo a mesma coisa.
                                return@withContext fail(
                                    bluetoothStateFor(error, false),
                                    causa =
                                        CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada.takeIf {
                                            (error.failure) ==
                                                ThermalPortFailure.BluetoothPermissionDenied
                                        },
                                )
                            }
                        currentCoroutineContext().ensureActive()
                        when (busca) {
                            // O estado sai de `estadoDaBuscaVazia`, e não do literal
                            // `BluetoothUnavailable` que estava aqui: a porta Android deixou de
                            // lançar por permissão negada e passou a devolver
                            // `Vazia(PermissaoDeConexaoNegada)`, então o literal mandava autorizar
                            // virar "ligue o Bluetooth". Fora a permissão, o estado continua o
                            // mesmo de propósito — trocá-lo por um estado por causa quebraria o
                            // `when` exaustivo da tela, que é de outro módulo. A distinção fina
                            // viaja no campo, verificável pelo compilador.
                            is ResultadoDaBuscaPareada.Vazia ->
                                fail(estadoDaBuscaVazia(busca.causa), causa = busca.causa)
                            is ResultadoDaBuscaPareada.Encontradas -> {
                                bluetoothCandidates = busca.pareadas
                                bluetoothCandidateProfile = profile
                                mutableState.value = bluetoothCandidatesPresentation()
                                ThermalPrintResult.Printed
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun testSearchedBluetoothPrinter(candidateId: Long): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        val activePort = bluetoothPort
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val unifiedTarget =
                            unifiedBluetoothTargets[candidateId] as? UnifiedBluetoothTarget.Spp
                        val handle =
                            unifiedTarget?.handle
                                ?: bluetoothCandidates.firstOrNull { it.id == candidateId }
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val profile = unifiedTarget?.profile ?: bluetoothCandidateProfile
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val result = runBluetoothTest(activePort, handle, profile)
                        if (result == ThermalPrintResult.Printed) {
                            pendingBluetoothSelection =
                                PendingBluetoothSelection(
                                    handle = handle,
                                    profile = profile,
                                )
                            mutableState.value = ThermalPrinterState.SearchConfirmationRequired
                        }
                        result
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun searchBluetoothLe(profileId: String): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        refreshAvailableDriverProfiles()
                        if (
                            bluetoothLeScanPolicy.availability() ==
                                BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
                        ) {
                            return@withContext fail(
                                ThermalPrinterState.BluetoothLeUnavailableByHostPolicy,
                                causa = CausaDaVarreduraLeVazia.BloqueadaPeloHospedeiro,
                            )
                        }
                        val activePort = blePort
                            ?: return@withContext fail(
                                ThermalPrinterState.BluetoothUnavailable,
                                causa = CausaDaVarreduraLeVazia.KitSemPortaBluetooth,
                            )
                        val profile = profileFor(profileId)
                            ?: return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        // Procurar não desinstala; ver a mesma decisão em `searchUsb`.
                        publishAdopted()
                        confirmedBleSelection = null
                        bleCandidates = emptyList()
                        unifiedBluetoothTargets = emptyMap()
                        mutableBluetoothDiscovery.value = BluetoothDiscoveryState.Idle
                        mutableState.value = ThermalPrinterState.BluetoothSearching
                        val varredura =
                            try {
                                activePort.varrer(profile)
                            } catch (error: ThermalPortException) {
                                // A chamada estava **nua** aqui, ao contrário da irmã em
                                // `searchBluetooth`, que tem este mesmo catch desde sempre. Uma
                                // porta BLE que lançasse — permissão, e agora também rádio
                                // desligado — atravessava `withContext` e `mutex.withLock` e saía
                                // desta função suspensa como exceção, em vez de virar `Failed`.
                                return@withContext fail(
                                    bluetoothStateFor(error, false),
                                    causa =
                                        CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada.takeIf {
                                            (error.failure) ==
                                                ThermalPortFailure.BluetoothPermissionDenied
                                        },
                                )
                            }
                        currentCoroutineContext().ensureActive()
                        when (varredura) {
                            // Ver o irmão em `searchBluetooth`: `PermissaoDeVarreduraNegada` chega
                            // por aqui desde que `AndroidBleThermalPort.varrer` parou de lançar.
                            is ResultadoDaVarreduraLe.Vazia ->
                                fail(
                                    estadoDaBuscaVazia(varredura.causa),
                                    causa = varredura.causa,
                                )
                            is ResultadoDaVarreduraLe.Encontradas -> {
                                bleCandidates = varredura.anunciantes
                                bleCandidateProfile = profile
                                mutableState.value = bleCandidatesPresentation()
                                ThermalPrintResult.Printed
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun testSearchedBluetoothLePrinter(candidateId: Long): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        val activePort = blePort
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val unifiedTarget =
                            unifiedBluetoothTargets[candidateId] as? UnifiedBluetoothTarget.Ble
                        val handle =
                            unifiedTarget?.handle
                                ?: bleCandidates.firstOrNull { it.id == candidateId }
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val profile = unifiedTarget?.profile ?: bleCandidateProfile
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        mutableState.value = ThermalPrinterState.Connecting
                        val receipt =
                            testReceiptBytes(
                                receiptLayout(profile),
                                profile,
                                via = deviceLabel("Bluetooth BLE", handle.label),
                            )
                        mutableState.value = ThermalPrinterState.Printing
                        val result = runBleReceiptBytes(activePort, handle, profile, receipt)
                        if (result == ThermalPrintResult.Printed) {
                            pendingBleSelection =
                                PendingBleSelection(
                                    handle = handle,
                                    profile = profile,
                                )
                            mutableState.value = ThermalPrinterState.SearchConfirmationRequired
                        }
                        result
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun searchLocalWifi(
        profileId: String,
        attachment: PrinterNetworkAttachment,
    ): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        refreshAvailableDriverProfiles()
                        val profile = profileFor(profileId)
                            ?: return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        // Recusa antes de qualquer socket: um perfil que não declara Wi-Fi não tem
                        // porta TCP, e a descoberta que a exigisse estouraria em vez de responder.
                        // A verificação fica aqui além de na descoberta porque a implementação de
                        // descoberta é injetada, e esta é a fronteira que o kit controla.
                        if (!profile.supports(PrinterTransport.LOCAL_WIFI)) {
                            return@withContext fail(
                                ThermalPrinterState.LocalWifiPrinterUnavailable,
                                causa = CausaDaBuscaWifiVazia.ModeloNaoFalaWifi,
                            )
                        }
                        // Procurar não desinstala; ver a mesma decisão em `searchUsb`.
                        publishAdopted()
                        confirmedSelection = null
                        candidatePool = null
                        mutableState.value = ThermalPrinterState.LocalWifiSearching
                        when (val result = discovery.findCandidates(profile, attachment)) {
                            LocalWifiPrinterDiscoveryResult.WifiUnavailable ->
                                fail(ThermalPrinterState.LocalWifiUnavailable)
                            is LocalWifiPrinterDiscoveryResult.NaoEncontrada ->
                                fail(
                                    ThermalPrinterState.LocalWifiPrinterUnavailable,
                                    causa = result.causa,
                                )
                            is LocalWifiPrinterDiscoveryResult.Candidates -> {
                                if (!result.network.stillAvailable()) {
                                    return@withContext fail(ThermalPrinterState.LocalWifiUnavailable)
                                }
                                currentCoroutineContext().ensureActive()
                                val pool =
                                    CandidatePool(
                                        profile = profile,
                                        network = result.network,
                                        networkKey = result.network.selectionKey,
                                        entries =
                                            result.endpoints.mapIndexed { index, endpoint ->
                                                CandidateEntry(
                                                    id = nextCandidateId(),
                                                    discoveryOrder = index + 1,
                                                    endpoint = endpoint,
                                                )
                                            },
                                        expiresAtNanos =
                                            monotonicNanos() + CANDIDATE_LIST_TTL_NANOS,
                                    )
                                candidatePool = pool
                                mutableState.value = pool.presentation()
                                ThermalPrintResult.Printed
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun testSearchedLocalWifiPrinter(candidateId: Long): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        val pool = activeCandidatePool()
                            ?: return@withContext fail(stateWithoutCandidatePool())
                        val entry = pool.entries.firstOrNull { it.id == candidateId }
                            ?: return@withContext fail(pool.presentation())
                        val selection =
                            PrinterSelection(
                                endpoint = entry.endpoint,
                                profile = pool.profile,
                                network = pool.network,
                                networkKey = pool.networkKey,
                            )
                        val result = runTest(selection)
                        if (result == ThermalPrintResult.Printed) {
                            currentCoroutineContext().ensureActive()
                            pendingSelection = pending(selection, candidateId)
                            mutableState.value = ThermalPrinterState.SearchConfirmationRequired
                            currentCoroutineContext().ensureActive()
                        }
                        result
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun testLocalWifiAddress(
        profileId: String,
        address: String,
        port: Int,
    ): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                try {
                    withContext(Dispatchers.IO) {
                        refreshAvailableDriverProfiles()
                        val profile = profileFor(profileId)
                            ?: return@withContext fail(ThermalPrinterState.PrinterNotSelected)
                        // Testar um endereço digitado também não desinstala nada — e este apagava
                        // o store inteiro, inclusive USB e Bluetooth, que não têm relação nenhuma
                        // com o endereço em teste.
                        val network = currentNetwork()
                            ?: return@withContext fail(ThermalPrinterState.LocalWifiUnavailable)
                        val endpoint = LocalWifiPrinterEndpoint.parseIpv4Literal(address, port)
                        if (
                            endpoint == null ||
                                !network.subnet.isSelectableEndpoint(endpoint) ||
                                !profile.acceptsTcpPort(endpoint.port)
                        ) {
                            return@withContext fail(ThermalPrinterState.LocalWifiAddressInvalid)
                        }
                        candidatePool = null
                        confirmedSelection = null
                        val selection =
                            PrinterSelection(
                                endpoint = endpoint,
                                profile = profile,
                                network = network,
                                networkKey = network.selectionKey,
                            )
                        val result = runTest(selection)
                        if (result == ThermalPrintResult.Printed) {
                            currentCoroutineContext().ensureActive()
                            pendingSelection = pending(selection, candidateId = null)
                            mutableState.value = ThermalPrinterState.SearchConfirmationRequired
                            currentCoroutineContext().ensureActive()
                        }
                        result
                    }
                } catch (error: CancellationException) {
                    clearCancelledOperation()
                    throw error
                }
            }
        }

    override suspend fun confirmSearchedPrinter() {
        mutex.withLock {
            check(pendingTemporaryDiscoveryProfileId() == null) {
                "Perfil temporário precisa ser medido antes de confirmar a impressora."
            }
            pendingBleSelectionOrNull()?.let { pending ->
                confirmedBleSelection =
                    ConfirmedBleSelection(pending.handle, pending.profile, Long.MAX_VALUE)
                pendingBleSelection = null
                bleCandidates = emptyList()
                bleCandidateProfile = null
                selectionStore.save(
                    selectionStore.read().with(
                        PersistedPrinterSelection.BluetoothLe(
                            pending.profile.id,
                            blePort?.persistenceAddress(pending.handle),
                        ),
                    ),
                )
                publishAdopted()
                mutableState.value = ThermalPrinterState.Ready
                return@withLock
            }
            pendingBluetoothSelectionOrNull()?.let { pending ->
                confirmedBluetoothSelection =
                    ConfirmedBluetoothSelection(
                        handle = pending.handle,
                        profile = pending.profile,
                        expiresAtNanos = Long.MAX_VALUE,
                    )
                pendingBluetoothSelection = null
                bluetoothCandidates = emptyList()
                bluetoothCandidateProfile = null
                selectionStore.save(
                    selectionStore.read().with(
                        PersistedPrinterSelection.Bluetooth(
                            pending.profile.id,
                            bluetoothPort?.persistenceAddress(pending.handle),
                        ),
                    ),
                )
                publishAdopted()
                mutableState.value = ThermalPrinterState.Ready
                return@withLock
            }
            pendingUsbSelectionOrNull()?.let { pending ->
                confirmedUsbSelection =
                    ConfirmedUsbSelection(
                        handle = pending.handle,
                        profile = pending.profile,
                        expiresAtNanos = Long.MAX_VALUE,
                    )
                pendingUsbSelection = null
                usbCandidates = emptyList()
                usbCandidateProfile = null
                selectionStore.save(
                    selectionStore.read().with(
                        PersistedPrinterSelection.Usb(
                            pending.profile.id,
                            usbPort?.persistenceIdentity(pending.handle),
                        ),
                    ),
                )
                publishAdopted()
                mutableState.value = ThermalPrinterState.Ready
                return@withLock
            }
            val pending = pendingSelectionOrNull() ?: return
            val selection = pending.selection
            if (!selection.network.matchesSelectionKey(selection.networkKey)) {
                pendingSelection = null
                candidatePool = null
                mutableState.value = ThermalPrinterState.LocalWifiUnavailable
                return
            }
            confirmedSelection =
                ConfirmedSelection(
                    selection = selection,
                    expiresAtNanos = Long.MAX_VALUE,
                )
            pendingSelection = null
            candidatePool = null
            selectionStore.save(
                selectionStore.read().with(
                    PersistedPrinterSelection.LocalWifi(
                        profileId = selection.profile.id,
                        endpoint =
                            PersistedNetworkEndpoint(
                                selection.endpoint.displayAddress(),
                                selection.endpoint.port,
                            ),
                    ),
                ),
            )
            publishAdopted()
            mutableState.value = ThermalPrinterState.Ready
        }
    }

    override suspend fun discardSearchedPrinter() {
        mutex.withLock {
            pendingBleSelectionOrNull()?.let { pending ->
                pendingBleSelection = null
                bleCandidates = bleCandidates.filterNot { candidate -> candidate.id == pending.handle.id }
                if (bleCandidates.isEmpty()) bleCandidateProfile = null
                mutableState.value =
                    if (bleCandidates.isEmpty()) {
                        ThermalPrinterState.BluetoothUnavailable
                    } else {
                        bleCandidatesPresentation()
                    }
                return@withLock
            }
            pendingBluetoothSelectionOrNull()?.let { pending ->
                pendingBluetoothSelection = null
                bluetoothCandidates =
                    bluetoothCandidates.filterNot { candidate -> candidate.id == pending.handle.id }
                if (bluetoothCandidates.isEmpty()) bluetoothCandidateProfile = null
                mutableState.value =
                    if (bluetoothCandidates.isEmpty()) {
                        ThermalPrinterState.BluetoothUnavailable
                    } else {
                        bluetoothCandidatesPresentation()
                    }
                return@withLock
            }
            pendingUsbSelectionOrNull()?.let { pending ->
                pendingUsbSelection = null
                usbCandidates = usbCandidates.filterNot { candidate -> candidate.id == pending.handle.id }
                if (usbCandidates.isEmpty()) usbCandidateProfile = null
                mutableState.value =
                    if (usbCandidates.isEmpty()) {
                        ThermalPrinterState.UsbUnavailable
                    } else {
                        usbCandidatesPresentation()
                    }
                return@withLock
            }
            val pending = pendingSelectionOrNull() ?: return@withLock
            pendingSelection = null
            discovery.reject(pending.selection.network, pending.selection.endpoint)
            val remainingPool =
                candidatePool
                    ?.takeIf { it.matches(pending.selection) }
                    ?.without(pending.candidateId)
            candidatePool = remainingPool
            mutableState.value =
                remainingPool?.presentation() ?: ThermalPrinterState.LocalWifiPrinterUnavailable
        }
    }

    override suspend fun returnToSearchedPrinters(transport: PrinterTransport) {
        mutex.withLock {
            when (transport) {
                PrinterTransport.LOCAL_WIFI -> {
                    pendingSelection = null
                    mutableState.value =
                        candidatePool?.presentation()
                            ?: ThermalPrinterState.LocalWifiPrinterUnavailable
                }
                PrinterTransport.USB -> {
                    pendingUsbSelection = null
                    mutableState.value =
                        if (usbCandidates.isEmpty()) {
                            ThermalPrinterState.UsbUnavailable
                        } else {
                            usbCandidatesPresentation()
                        }
                }
                PrinterTransport.BLUETOOTH -> {
                    pendingBluetoothSelection = null
                    mutableState.value =
                        if (bluetoothCandidates.isEmpty()) {
                            ThermalPrinterState.BluetoothUnavailable
                        } else {
                            bluetoothCandidatesPresentation()
                        }
                }
                PrinterTransport.BLUETOOTH_LE -> {
                    pendingBleSelection = null
                    mutableState.value =
                        if (bleCandidates.isEmpty()) {
                            ThermalPrinterState.BluetoothUnavailable
                        } else {
                            bleCandidatesPresentation()
                        }
                }
            }
        }
    }

    /**
     * Sem transporte ativo não há palpite: chutar `LOCAL_WIFI` fazia o comprovante sair por um
     * caminho que ninguém escolheu, e "não escolhi impressora" ficava indistinguível de "a Wi-Fi
     * falhou". Visto na bancada com a T210, em que o USB não estava adotável e o teste saiu pelo
     * Bluetooth ativo sem a tela dizer isso.
     */
    override suspend fun testSelectedPrinter(): ThermalPrintResult {
        val active = activeTransport() ?: return mutex.withLock {
            fail(ThermalPrinterState.PrinterNotSelected)
        }
        return testPrinter(active)
    }

    /**
     * Testa uma impressora adotada sem trocar quem recebe as senhas. No balcão, diagnosticar
     * uma impressora não pode custar a troca da que está em uso.
     */
    override suspend fun testPrinter(transport: PrinterTransport): ThermalPrintResult =
        mutex.withLock { testPrinterLocked(transport) }

    /**
     * Testa a unidade que **este transporte** está servindo.
     *
     * O corpo compartilhado com [testInstallation]; o `Mutex` do Kotlin não é reentrante e cada
     * chamador já o segura.
     */
    private suspend fun testPrinterLocked(transport: PrinterTransport): ThermalPrintResult =
        run {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                withContext(Dispatchers.IO) {
                    val active = transport
                    if (active == PrinterTransport.BLUETOOTH_LE) {
                        val selection = selectionForNextBleJob()
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val activePort = blePort
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runBleReceiptBytes(
                            activePort,
                            selection.handle,
                            selection.profile,
                            testReceiptBytes(
                                receiptLayout(selection.profile),
                                selection.profile,
                                via = deviceLabel("Bluetooth BLE", selection.handle.label),
                            ),
                        )
                    }
                    if (active == PrinterTransport.BLUETOOTH) {
                        val selection = selectionForNextBluetoothJob()
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        val activePort = bluetoothPort
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runBluetoothReceiptBytes(
                            activePort,
                            selection.handle,
                            selection.profile,
                            testReceiptBytes(
                                receiptLayout(selection.profile),
                                selection.profile,
                                via = deviceLabel("Bluetooth pareado (SPP)", selection.handle.label),
                            ),
                        )
                    }
                    if (active == PrinterTransport.USB) {
                        val selection = selectionForNextUsbJob()
                            ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                        val activePort = usbPort
                            ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runUsbReceiptBytes(
                            activePort,
                            selection.handle,
                            selection.profile,
                            testReceiptBytes(
                                receiptLayout(selection.profile),
                                selection.profile,
                                via = "cabo USB",
                            ),
                        )
                    }
                    val selection = selectionForNextJob()
                        ?: return@withContext fail(stateWithoutConfirmedSelection())
                    mutableState.value = ThermalPrinterState.Printing
                    runReceiptBytes(
                        selection,
                        testReceiptBytes(
                            receiptLayout(selection.profile),
                            selection.profile,
                            via = "rede Wi-Fi",
                        ),
                    )
                }
            }
        }

    /**
     * Testa **a unidade do card tocado**, e não uma impressora qualquer daquele meio físico.
     *
     * O transporte guarda uma conexão só: a que está servindo. Com duas portáteis instaladas,
     * pedir o comprovante da que está parada alcançava a irmã conectada, e o papel saía na
     * impressora que ninguém pediu — medido no iPhone 7 em 20/08, e este caminho é o mesmo.
     *
     * A mira volta para quem estava servindo assim que o teste termina, saindo ou não papel:
     * conferir uma impressora não é escolher impressora.
     */
    override suspend fun testInstallation(installationId: String): ThermalPrintResult =
        mutex.withLock {
            val stored = selectionStore.read()
            val alvo =
                stored.ofInstallation(installationId)
                    ?: return@withLock fail(ThermalPrinterState.PrinterNotSelected)
            val mirado = stored.of(alvo.transport)
            // O transporte já está nesta unidade — inclusive quando ela é a ativa. Caminho de
            // sempre, byte a byte, sem varredura extra.
            if (mirado?.installationId == installationId) return@withLock testPrinterLocked(alvo.transport)
            if (hasPendingSelection()) return@withLock fail(ThermalPrinterState.SearchConfirmationRequired)

            val resultado =
                if (retargetTo(alvo)) {
                    testPrinterLocked(alvo.transport)
                } else {
                    // Recusa nomeada e zero papel. Cair na ativa aqui seria o defeito de origem.
                    fail(
                        ThermalPrinterState.Failed(
                            "${resolvedProfileFor(alvo).profile.displayName} não respondeu — " +
                                "confira se ela está ligada.",
                        ),
                    )
                }
            // A escolha da pessoa não muda por causa de um teste, e a conexão em memória da ativa
            // é devolvida mesmo quando o teste a derrubou.
            mirado?.let { retargetTo(it) }
            resultado
        }

    /**
     * Aponta o transporte para **esta** unidade e diz se ela respondeu.
     *
     * Limpar antes de reabrir é o que impede o comprovante de cair na irmã: sem isso, uma unidade
     * que não respondesse deixaria viva a conexão anterior, e o envio seguinte usaria essa.
     */
    private suspend fun retargetTo(selected: PersistedPrinterSelection): Boolean {
        refreshAvailableDriverProfiles()
        clearSelectionsOf(selected.transport)
        withContext(Dispatchers.IO) { restoreOne(selected) }
        return runtimeTargets(selected)
    }

    /** A unidade que ficou em memória é mesmo a pedida? */
    private fun runtimeTargets(selected: PersistedPrinterSelection): Boolean =
        when (selected) {
            // Bluetooth, BLE e USB são reabertos só quando a identidade guardada bate — sem ela,
            // só quando a candidata é única. A retomada Wi-Fi é a que ainda aceita "a que
            // respondeu" quando o endpoint não serve, e é por isso que aqui o endereço é
            // conferido: a que respondeu pode ser justamente a irmã.
            is PersistedPrinterSelection.LocalWifi ->
                confirmedSelection?.selection?.endpoint?.let { atual ->
                    val guardado =
                        selected.endpoint?.let {
                            LocalWifiPrinterEndpoint.parseIpv4Literal(it.ipv4Address, it.port)
                        }
                    guardado == null || atual == guardado
                } ?: false
            is PersistedPrinterSelection.Usb -> confirmedUsbSelection != null
            is PersistedPrinterSelection.Bluetooth -> confirmedBluetoothSelection != null
            is PersistedPrinterSelection.BluetoothLe -> confirmedBleSelection != null
        }

    override suspend fun print(payload: ThermalReceiptPayload): ThermalPrintResult =
        try {
            printInternal(payload)
        } finally {
            // Zera o material sensível do cupom mesmo se a impressão falhar no meio.
            payload.clear()
        }

    private suspend fun printInternal(payload: ThermalReceiptPayload): ThermalPrintResult =
        mutex.withLock {
            if (hasPendingSelection()) {
                fail(ThermalPrinterState.SearchConfirmationRequired)
            } else {
                withContext(Dispatchers.IO) {
                    val active = activeTransport()
                    if (active == PrinterTransport.BLUETOOTH_LE) {
                        val selection = selectionForNextBleJob()
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runBleReceipt(selection, payload)
                    }
                    if (active == PrinterTransport.BLUETOOTH) {
                        val selection = selectionForNextBluetoothJob()
                            ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runBluetoothReceipt(selection, payload)
                    }
                    if (active != PrinterTransport.USB) {
                        val selection = selectionForNextJob()
                            ?: return@withContext fail(stateWithoutConfirmedSelection())
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runReceipt(selection, payload)
                    }
                    selectionForNextUsbJob()?.let { selection ->
                        mutableState.value = ThermalPrinterState.Printing
                        return@withContext runUsbReceipt(selection, payload)
                    }
                    // USB ativo nunca cai para a seleção Wi-Fi. Com várias USB após reiniciar o
                    // processo, só existe perfil persistido — autorização e endereço enumerado não
                    // identificam qual periférico a pessoa escolheu. A tela precisa pedir a USB,
                    // não tentar outra conexão em silêncio.
                    fail(stateWithoutConfirmedUsbSelection())
                }
            }
        }

    /** Transporte sempre; nome do aparelho só quando ele se identificou e não é técnico. */
    private fun deviceLabel(
        transport: String,
        label: String?,
        // O separador é hífen, não `·`. Medido no papel da LUOGAO em 12/08: o ponto médio não
        // existe em nenhuma das tabelas do kit, a dobra conservadora o troca por `?`, e a tira saiu
        // "Bluetooth pareado (SPP) ? KPrinter" — que parece pergunta, ou defeito.
    ): String = label?.takeIf(::isAcceptableProfileName)?.let { "$transport - $it" } ?: transport

    private fun runTest(selection: PrinterSelection): ThermalPrintResult {
        mutableState.value = ThermalPrinterState.Connecting
        val receipt =
            testReceiptBytes(
                receiptLayout(selection.profile),
                selection.profile,
                via = "rede Wi-Fi",
            )
        mutableState.value = ThermalPrinterState.Printing
        return runReceiptBytes(selection, receipt)
    }

    private suspend fun runBleReceiptBytes(
        activePort: BleThermalPort,
        handle: BlePrinterHandle,
        profile: PrinterDriverProfile,
        receipt: ByteArray,
    ): ThermalPrintResult {
        // A recusa vem antes de abrir a porta: dialeto sem composição não alcança o fio de jeito
        // nenhum. Ver [EscPosDialectGate] — na IM453H, byte errado travou o aparelho.
        if (!EscPosDialectGate.composesReceipt(profile.dialect)) {
            return fail(ThermalPrinterState.DialectNotSupported)
        }
        var receiptWriteStarted = false
        try {
            activePort.open(handle, profile)
            // A pergunta de status e o prologo saem do dialeto, e nao mais fixos: `DLE EOT` e
            // `ESC @` sao ESC/POS, e numa firmware que nao os conhece o `ESC @` ja foi parar no
            // papel como "@". Ver [EscPosDialectGate].
            if (EscPosDialectGate.usesEscPosStatusQueries(profile.dialect)) {
                when {
                    activePort.coverStatus() == ThermalCoverStatus.OPEN ->
                        return fail(ThermalPrinterState.CoverOpen)
                    activePort.paperStatus() == ThermalPaperStatus.OUT ->
                        return fail(ThermalPrinterState.PaperOut)
                }
            }
            activePort.write(EscPosDialectGate.prologue(profile.dialect))
            receiptWriteStarted = true
            activePort.write(receipt)
            mutableState.value = ThermalPrinterState.Ready
            return ThermalPrintResult.Printed
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            confirmedBleSelection = null
            val delivery =
                if (receiptWriteStarted) {
                    ThermalPrintDelivery.INDETERMINATE
                } else {
                    ThermalPrintDelivery.NOT_SENT
                }
            return fail(bluetoothStateFor(error, receiptWriteStarted), delivery)
        } finally {
            receipt.fill(0)
            activePort.close()
        }
    }

    private suspend fun runBleReceipt(
        selection: ConfirmedBleSelection,
        payload: ThermalReceiptPayload,
    ): ThermalPrintResult =
        runCatching { decoratedReceiptBytes(selection.profile, payload) }
            .fold(
                onSuccess = { receipt ->
                    val activePort = blePort
                        ?: return@fold fail(ThermalPrinterState.BluetoothUnavailable)
                    runBleReceiptBytes(activePort, selection.handle, selection.profile, receipt)
                },
                onFailure = { fail(ThermalPrinterState.Failed("Não foi possível preparar o cupom.")) },
            )

    private suspend fun runBluetoothTest(
        activePort: BluetoothThermalPort,
        handle: BluetoothPrinterHandle,
        profile: PrinterDriverProfile,
    ): ThermalPrintResult {
        mutableState.value = ThermalPrinterState.Connecting
        val receipt =
            testReceiptBytes(
                receiptLayout(profile),
                profile,
                via = deviceLabel("Bluetooth pareado (SPP)", handle.label),
            )
        mutableState.value = ThermalPrinterState.Printing
        return runBluetoothReceiptBytes(activePort, handle, profile, receipt)
    }

    private suspend fun runBluetoothReceipt(
        selection: ConfirmedBluetoothSelection,
        payload: ThermalReceiptPayload,
    ): ThermalPrintResult =
        runCatching { decoratedReceiptBytes(selection.profile, payload) }
            .fold(
                onSuccess = { receipt ->
                    val activePort = bluetoothPort
                        ?: return@fold fail(ThermalPrinterState.BluetoothUnavailable)
                    runBluetoothReceiptBytes(activePort, selection.handle, selection.profile, receipt)
                },
                onFailure = { fail(ThermalPrinterState.Failed("Não foi possível preparar o cupom.")) },
            )

    private suspend fun runBluetoothReceiptBytes(
        activePort: BluetoothThermalPort,
        handle: BluetoothPrinterHandle,
        profile: PrinterDriverProfile,
        receipt: ByteArray,
    ): ThermalPrintResult {
        // A recusa vem antes de abrir a porta: dialeto sem composição não alcança o fio de jeito
        // nenhum. Ver [EscPosDialectGate] — na IM453H, byte errado travou o aparelho.
        if (!EscPosDialectGate.composesReceipt(profile.dialect)) {
            return fail(ThermalPrinterState.DialectNotSupported)
        }
        var receiptWriteStarted = false
        try {
            activePort.open(handle, profile)
            // A pergunta de status e o prologo saem do dialeto, e nao mais fixos: `DLE EOT` e
            // `ESC @` sao ESC/POS, e numa firmware que nao os conhece o `ESC @` ja foi parar no
            // papel como "@". Ver [EscPosDialectGate].
            if (EscPosDialectGate.usesEscPosStatusQueries(profile.dialect)) {
                when {
                    activePort.coverStatus() == ThermalCoverStatus.OPEN ->
                        return fail(ThermalPrinterState.CoverOpen)
                    activePort.paperStatus() == ThermalPaperStatus.OUT ->
                        return fail(ThermalPrinterState.PaperOut)
                }
            }
            activePort.write(EscPosDialectGate.prologue(profile.dialect))
            receiptWriteStarted = true
            activePort.write(receipt)
            // Antes de qualquer coisa que feche o socket: `write` entrega ao rádio, não ao papel.
            activePort.drain()
            mutableState.value = ThermalPrinterState.Ready
            return ThermalPrintResult.Printed
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            confirmedBluetoothSelection = null
            // Só o caminho de falha fecha. Numa venda de cinco cervejas o canal fica aberto entre as
            // cinco cupons: reabrir RFCOMM a cada um punha um intervalo visível entre eles. O
            // socket segue vivo até dar erro, trocar de impressora ou iniciar nova busca.
            activePort.close()
            val delivery =
                if (receiptWriteStarted) {
                    ThermalPrintDelivery.INDETERMINATE
                } else {
                    ThermalPrintDelivery.NOT_SENT
                }
            return fail(bluetoothStateFor(error, receiptWriteStarted), delivery)
        } finally {
            receipt.fill(0)
        }
    }

    private fun bluetoothStateFor(
        error: Throwable,
        receiptWriteStarted: Boolean,
    ): ThermalPrinterState =
        when ((error as? ThermalPortException)?.failure) {
            ThermalPortFailure.BluetoothPermissionDenied ->
                ThermalPrinterState.BluetoothPermissionDenied
            ThermalPortFailure.BluetoothNotPaired ->
                ThermalPrinterState.Failed(
                    "Esta impressora ainda não está pareada. Abra os Ajustes de Bluetooth, " +
                        "pareie e volte para procurar de novo.",
                )
            ThermalPortFailure.BluetoothDisconnected,
            ThermalPortFailure.BluetoothUnavailable,
            ThermalPortFailure.PrinterUnavailable,
            -> ThermalPrinterState.BluetoothUnavailable
            ThermalPortFailure.WriteInterrupted ->
                if (receiptWriteStarted) {
                    ThermalPrinterState.Failed("A conexão Bluetooth foi interrompida durante o envio.")
                } else {
                    ThermalPrinterState.BluetoothUnavailable
                }
            ThermalPortFailure.LocalWifiDisconnected,
            ThermalPortFailure.UsbDisconnected,
            ThermalPortFailure.UsbPermissionDenied,
            null,
            -> ThermalPrinterState.Failed("Não foi possível imprimir por Bluetooth.")
        }

    private suspend fun runUsbTest(
        activePort: UsbThermalPort,
        handle: UsbPrinterHandle,
        profile: PrinterDriverProfile,
    ): ThermalPrintResult {
        mutableState.value = ThermalPrinterState.Connecting
        val receipt =
            testReceiptBytes(receiptLayout(profile), profile, via = "cabo USB")
        mutableState.value = ThermalPrinterState.Printing
        return runUsbReceiptBytes(activePort, handle, profile, receipt)
    }

    /**
     * O teste imprime o comprovante do perfil adotado, não duas linhas genéricas.
     *
     * Antes saía "Thermal Printer Kit / Impressora pronta" — o que só provava que o cabo, o
     * Bluetooth ou o socket funcionam. Uma impressora pode receber bytes e mesmo assim errar
     * acento, cortar em cima do texto ou não fazer QR. O comprovante repete o que foi medido e
     * imprime as três coisas que costumam falhar depois: acento, guilhotina e raster.
     *
     * A frase acentuada não é enfeite: em CP850 e em UTF-8 ela sai igual na leitura e diferente no
     * fio, então ela é a prova de que o perfil relido é o que a bancada mediu.
     *
     * O rodapé do hospedeiro já entrava por [ReceiptLayout.finish]; o cabeçalho entra aqui, pelo
     * mesmo motivo de produto: **este é o papel onde a pessoa vê o próprio logotipo sair** antes de
     * confiar no recurso, e um comprovante de teste sem carimbo prova a impressora e não prova o
     * app. A tira de homologação continua sem nada — ela é instrumento de medida.
     */
    private fun testReceiptBytes(
        layout: ReceiptLayout,
        profile: PrinterDriverProfile,
        via: String,
    ): ByteArray {
        val codificacao =
            (layout.textEncoding ?: profile.textEncoding).receiptLabel
        return receiptBytes(
            listOfNotNull(
                // Vem do layout, e não do campo da classe, para que o cabeçalho e o rodapé deste
                // papel saiam sempre da mesma decoração: os oito chamadores já montam o layout com
                // ela, e ler daqui impede que um deles decore só metade do comprovante.
                layout.decoration?.header(layout),
                layout.text(
                    "COMPROVANTE DE TESTE\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.BOLD,
                    ThermalTextSize.NORMAL,
                ),
                profile.displayName
                    .takeUnless { profile.id.startsWith("temporary.") }
                    ?.let {
                        layout.text(
                            layout.wrap(it) + "\n\n",
                            ThermalTextAlignment.CENTER,
                            ThermalTextStyle.NORMAL,
                            ThermalTextSize.NORMAL,
                        )
                    },
                layout.text(
                    // Nome do perfil e aparelho que recebeu são coisas diferentes, e com seis
                    // impressoras na mesa o papel precisa dizer as duas. Medido na bancada: um
                    // comprovante do perfil da T210 saiu na MTP-II, e não havia como saber lendo a
                    // tira — ela só trazia o nome do perfil.
                    "Saiu por: $via\n" +
                        "Em: ${PrinterHomologationProbes.localTimestamp(null)}\n" +
                        "${profile.printableColumns} colunas | ${profile.printableDots} dots\n" +
                        // Tabela e corte saem na língua do layout, e não no formato do perfil.
                        // Ver [linhasDoDialetoNoComprovante]: num papel Procomp estas três linhas
                        // afirmavam três medições que ninguém fez.
                        linhasDoDialetoNoComprovante(profile, codificacao) +
                        // Este papel já lista capacidades, e a compensação vertical é uma delas —
                        // a que muda os bytes do QR logo abaixo. Sai do layout, e não do perfil,
                        // porque é o layout que decide o raster deste comprovante; o iOS lê do
                        // mesmo lugar.
                        PrinterHomologationProbes.verticalRasterScaleLine(layout.verticalRasterScale) +
                        // As duas capacidades da sonda de código nativo saem aqui pelo mesmo
                        // argumento: é este o papel que a pessoa tem na mão quando decide se o
                        // ajuste de emissão vale. Saem do **perfil**, e não do layout: depois de
                        // construído, um layout rasterizado não distingue "é o padrão" de "foi o
                        // máximo que a medição permitiu", e é justamente essa diferença que estas
                        // duas linhas relatam.
                        PrinterHomologationProbes.nativeQrLine(profile.nativeQrHonored) +
                        PrinterHomologationProbes.nativeBarcodeLine(profile.nativeBarcodeHonored) +
                        "Acentos: ação, opção, São João\n",
                    ThermalTextAlignment.LEFT,
                    ThermalTextStyle.NORMAL,
                    ThermalTextSize.NORMAL,
                ),
                // O QR prova o raster, e leva o mesmo endereço do comprovante de homologação: o
                // identificador do perfil não vai para o papel, porque papel circula.
                layout.qrRaster(PrinterHomologationProbes.FINAL_RECEIPT_QR),
                layout.finish(),
            ),
        )
    }

    /**
     * Monta o cupom com a decoração do hospedeiro. É o único lugar que chama
     * [ThermalReceiptPayload.receiptBytes]: os quatro transportes passam por aqui, e é isso que
     * impede um ponto de entrada de escapar do rodapé.
     *
     * O cabeçalho é prepended porque o payload é opaco para o kit — o rodapé, esse, entra dentro de
     * `finish()`, antes do corte.
     */
    private fun decoratedReceiptBytes(
        profile: PrinterDriverProfile,
        payload: ThermalReceiptPayload,
    ): ByteArray {
        val layout = receiptLayout(profile)
        val corpo = payload.receiptBytes(layout)
        val cabecalho = receiptDecoration?.header(layout) ?: return corpo
        // `receiptBytes` zera os intermediários: o cabeçalho pode ser raster de logo, e cópia viva
        // no heap é exatamente o que o contrato de `clear()` existe para evitar.
        return receiptBytes(listOf(cabecalho, corpo))
    }

    private fun runReceipt(
        selection: PrinterSelection,
        payload: ThermalReceiptPayload,
    ): ThermalPrintResult =
        runCatching { decoratedReceiptBytes(selection.profile, payload) }
            .fold(
                onSuccess = { receipt -> runReceiptBytes(selection, receipt) },
                onFailure = { fail(ThermalPrinterState.Failed("Não foi possível preparar o cupom.")) },
            )

    private suspend fun runUsbReceipt(
        selection: ConfirmedUsbSelection,
        payload: ThermalReceiptPayload,
    ): ThermalPrintResult =
        runCatching { decoratedReceiptBytes(selection.profile, payload) }
            .fold(
                onSuccess = { receipt ->
                    val activePort = usbPort
                        ?: return@fold fail(ThermalPrinterState.UsbUnavailable)
                    runUsbReceiptBytes(activePort, selection.handle, selection.profile, receipt)
                },
                onFailure = { fail(ThermalPrinterState.Failed("Não foi possível preparar o cupom.")) },
            )

    private suspend fun runUsbReceiptBytes(
        activePort: UsbThermalPort,
        handle: UsbPrinterHandle,
        profile: PrinterDriverProfile,
        receipt: ByteArray,
    ): ThermalPrintResult {
        // A recusa vem antes de abrir a porta: dialeto sem composição não alcança o fio de jeito
        // nenhum. Ver [EscPosDialectGate] — na IM453H, byte errado travou o aparelho.
        if (!EscPosDialectGate.composesReceipt(profile.dialect)) {
            return fail(ThermalPrinterState.DialectNotSupported)
        }
        var currentHandle = handle
        var rediscoveryAttempted = false
        try {
            while (true) {
                var receiptWriteStarted = false
                try {
                    activePort.open(currentHandle, profile)
                    if (EscPosDialectGate.usesEscPosStatusQueries(profile.dialect)) {
                        when {
                            activePort.coverStatus() == ThermalCoverStatus.OPEN ->
                                return fail(ThermalPrinterState.CoverOpen)
                            activePort.paperStatus() == ThermalPaperStatus.OUT ->
                                return fail(ThermalPrinterState.PaperOut)
                        }
                    }
                    activePort.write(EscPosDialectGate.prologue(profile.dialect))
                    receiptWriteStarted = true
                    activePort.write(receipt)
                    mutableState.value = ThermalPrinterState.Ready
                    return ThermalPrintResult.Printed
                } catch (error: Throwable) {
                    if (error is CancellationException) throw error
                    val failure = (error as? ThermalPortException)?.failure
                    val replacement =
                        if (
                            !receiptWriteStarted &&
                            !rediscoveryAttempted &&
                            failure in setOf(
                                ThermalPortFailure.UsbDisconnected,
                                ThermalPortFailure.PrinterUnavailable,
                            )
                        ) {
                            rediscoveryAttempted = true
                            rediscoverUsbForRetry(activePort, currentHandle, profile)
                        } else {
                            null
                        }
                    if (replacement != null) {
                        currentHandle = replacement
                        continue
                    }

                    confirmedUsbSelection = null
                    val delivery =
                        if (receiptWriteStarted) {
                            ThermalPrintDelivery.INDETERMINATE
                        } else {
                            ThermalPrintDelivery.NOT_SENT
                        }
                    return fail(usbStateFor(error, receiptWriteStarted), delivery)
                } finally {
                    activePort.close()
                }
            }
        } finally {
            receipt.fill(0)
        }
    }

    /**
     * O Android pode enumerar de novo o mesmo periférico depois que o app perde o foco ou o hub
     * oscila. O handle anterior é deliberadamente efêmero e deixa de abrir, embora a impressora
     * continue conectada. Reencontrá-la antes do primeiro byte do cupom é seguro: ainda não existe
     * impressão para duplicar.
     *
     * Com mais de uma candidata, o vínculo criptografado vence. O nome efêmero é apenas a
     * compatibilidade para stores em memória sem identidade física.
     */
    private fun rediscoverUsbForRetry(
        activePort: UsbThermalPort,
        previousHandle: UsbPrinterHandle,
        profile: PrinterDriverProfile,
    ): UsbPrinterHandle? {
        val wasConfirmed = confirmedUsbSelection?.let { selection ->
            selection.handle == previousHandle && selection.profile.id == profile.id
        } == true
        val discovered = activePort.discover(profile)
        // **A identidade instalada só vale quando é ela que está sendo repetida.**
        //
        // Medido no A75 em 17/08: o assistente procurou a MTP-5, o Android demorou na autorização,
        // o `open` da candidata falhou — e a retomada leu a identidade da instalação ativa, que era
        // a i9, achou a i9 no barramento e imprimiu o comprovante da MTP-5 nela. Uma candidata que
        // ninguém instalou não tem identidade guardada, e pegar a de outra impressora é escolher o
        // aparelho errado com a confiança de quem conferiu o vínculo.
        //
        // A busca por perfil, e não por "a USB ativa", é a outra metade: com duas USB instaladas, a
        // ativa pode não ser a que este envio está repetindo.
        val persistedIdentity =
            if (wasConfirmed) {
                (selectionStore.read().ofProfile(profile.id) as? PersistedPrinterSelection.Usb)
                    ?.identity
            } else {
                null
            }
        val replacement =
            persistedIdentity
                ?.let { identity ->
                    discovered.singleOrNull { handle ->
                        activePort.matchesPersistedIdentity(handle, identity)
                    }
                }
                ?: discovered.singleOrNull()
                ?: previousHandle.takeIf(UsbPrinterHandle::named)?.let { previous ->
                    discovered.singleOrNull { candidate ->
                        candidate.named && candidate.label == previous.label
                    }
                }
        if (replacement != null && wasConfirmed) {
            confirmedUsbSelection =
                ConfirmedUsbSelection(replacement, profile, Long.MAX_VALUE)
        }
        return replacement
    }

    private fun runReceiptBytes(
        selection: PrinterSelection,
        receipt: ByteArray,
    ): ThermalPrintResult {
        // A recusa vem antes de abrir a porta: dialeto sem composição não alcança o fio de jeito
        // nenhum. Ver [EscPosDialectGate] — na IM453H, byte errado travou o aparelho.
        if (!EscPosDialectGate.composesReceipt(selection.profile.dialect)) {
            return fail(ThermalPrinterState.DialectNotSupported)
        }
        var receiptWriteStarted = false
        try {
            if (!selection.network.matchesSelectionKey(selection.networkKey)) {
                invalidateConfirmedSelection(selection)
                return fail(ThermalPrinterState.LocalWifiUnavailable)
            }
            port.open(selection.network, selection.endpoint, selection.profile)
            if (EscPosDialectGate.usesEscPosStatusQueries(selection.profile.dialect)) {
                unavailableState()?.let { unavailable -> return fail(unavailable) }
            }
            port.write(EscPosDialectGate.prologue(selection.profile.dialect))
            receiptWriteStarted = true
            port.write(receipt)
            port.finish()
            mutableState.value = ThermalPrinterState.Ready
            return ThermalPrintResult.Printed
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            invalidateConfirmedSelection(selection)
            val delivery =
                if (receiptWriteStarted) {
                    ThermalPrintDelivery.INDETERMINATE
                } else {
                    ThermalPrintDelivery.NOT_SENT
                }
            return fail(stateFor(error, receiptWriteStarted), delivery)
        } finally {
            receipt.fill(0)
            port.close()
        }
    }

    private fun unavailableState(): ThermalPrinterState? =
        when {
            port.coverStatus() == ThermalCoverStatus.OPEN -> ThermalPrinterState.CoverOpen
            port.paperStatus() == ThermalPaperStatus.OUT -> ThermalPrinterState.PaperOut
            else -> null
        }

    private suspend fun selectionForNextJob(): PrinterSelection? {
        if (confirmedSelection == null) restoreConfirmedSelection(PrinterTransport.LOCAL_WIFI)
        val current = confirmedSelection ?: return null
        val selection = current.selection
        if (
            monotonicNanos() < current.expiresAtNanos &&
                selection.network.matchesSelectionKey(selection.networkKey)
        ) {
            return selection
        }
        confirmedSelection = null
        return null
    }

    /**
     * Depois que o comprovante saiu, só a resposta humana ou a perda real da conexão encerra a
     * candidata. A lista ainda expira; conferir o papel não tem cronômetro.
     */
    private fun pendingSelectionOrNull(): PendingSelection? {
        val pending = pendingSelection ?: return null
        if (pending.selection.network.matchesSelectionKey(pending.selection.networkKey)) {
            return pending
        }
        pendingSelection = null
        candidatePool = null
        mutableState.value = ThermalPrinterState.LocalWifiUnavailable
        return null
    }

    private fun pendingUsbSelectionOrNull(): PendingUsbSelection? = pendingUsbSelection

    private fun pendingBluetoothSelectionOrNull(): PendingBluetoothSelection? =
        pendingBluetoothSelection

    private fun pendingBleSelectionOrNull(): PendingBleSelection? = pendingBleSelection

    private fun bleCandidatesPresentation(): ThermalPrinterState.BluetoothCandidatesFound =
        ThermalPrinterState.BluetoothCandidatesFound(
            bleCandidates.map { candidate ->
                BluetoothPrinterCandidate(
                    candidate.id,
                    candidate.label,
                    BluetoothCandidateOrigin.BLE,
                    named = candidate.named,
                )
            },
        )

    private suspend fun selectionForNextBleJob(): ConfirmedBleSelection? {
        if (confirmedBleSelection == null) restoreConfirmedSelection(PrinterTransport.BLUETOOTH_LE)
        val current = confirmedBleSelection ?: return null
        if (monotonicNanos() < current.expiresAtNanos) return current
        confirmedBleSelection = null
        return null
    }

    private fun hasPendingSelection(): Boolean =
        pendingSelectionOrNull() != null ||
            pendingUsbSelectionOrNull() != null ||
            pendingBluetoothSelectionOrNull() != null ||
            pendingBleSelectionOrNull() != null

    /** Leitura sem efeitos colaterais; o gate de confirmação a chama antes de qualquer mutação. */
    private fun pendingTemporaryDiscoveryProfileId(): String? =
        listOfNotNull(
            pendingSelection?.selection?.profile?.id,
            pendingUsbSelection?.profile?.id,
            pendingBluetoothSelection?.profile?.id,
            pendingBleSelection?.profile?.id,
        ).firstOrNull(temporaryDiscoveryProfiles::containsKey)

    private fun activeCandidatePool(): CandidatePool? {
        val pool = candidatePool ?: return null
        if (
            monotonicNanos() < pool.expiresAtNanos &&
                pool.network.matchesSelectionKey(pool.networkKey)
        ) {
            return pool
        }
        candidatePool = null
        mutableState.value =
            if (pool.network.matchesSelectionKey(pool.networkKey)) {
                ThermalPrinterState.PrinterNotSelected
            } else {
                ThermalPrinterState.LocalWifiUnavailable
            }
        return null
    }

    private fun pending(
        selection: PrinterSelection,
        candidateId: Long?,
    ): PendingSelection =
        PendingSelection(
            selection = selection,
            candidateId = candidateId,
        )

    private fun clearCancelledOperation() {
        pendingSelection = null
        pendingUsbSelection = null
        candidatePool = null
        usbCandidates = emptyList()
        usbCandidateProfile = null
        usbPort?.close()
        pendingBluetoothSelection = null
        bluetoothCandidates = emptyList()
        bluetoothCandidateProfile = null
        bluetoothPort?.close()
        pendingBleSelection = null
        bleCandidates = emptyList()
        bleCandidateProfile = null
        blePort?.close()
        mutableState.value =
            if (currentNetwork() == null) {
                ThermalPrinterState.LocalWifiUnavailable
            } else {
                ThermalPrinterState.PrinterNotSelected
            }
    }

    private fun invalidateConfirmedSelection(selection: PrinterSelection) {
        if (confirmedSelection?.selection === selection) {
            confirmedSelection = null
        }
    }

    private fun fail(
        state: ThermalPrinterState,
        delivery: ThermalPrintDelivery = ThermalPrintDelivery.NOT_SENT,
        causa: CausaDaBuscaVazia? = null,
    ): ThermalPrintResult.Failed {
        mutableState.value = state
        return ThermalPrintResult.Failed(
            message =
                if (delivery == ThermalPrintDelivery.INDETERMINATE) {
                    "A conexão foi interrompida. Confira se o comprovante saiu antes de imprimir novamente."
                } else {
                    state.message
                },
            state = state,
            delivery = delivery,
            causa = causa,
        )
    }

    private fun stateFor(
        error: Throwable,
        receiptWriteStarted: Boolean,
    ): ThermalPrinterState =
        when ((error as? ThermalPortException)?.failure) {
            ThermalPortFailure.LocalWifiDisconnected -> ThermalPrinterState.LocalWifiUnavailable
            ThermalPortFailure.PrinterUnavailable -> ThermalPrinterState.LocalWifiPrinterUnavailable
            ThermalPortFailure.WriteInterrupted ->
                if (receiptWriteStarted) {
                    ThermalPrinterState.Failed(
                        "A conexão foi interrompida enquanto o cupom era enviado.",
                    )
                } else {
                    ThermalPrinterState.LocalWifiPrinterUnavailable
                }
            ThermalPortFailure.BluetoothNotPaired,
            ThermalPortFailure.UsbDisconnected,
            ThermalPortFailure.UsbPermissionDenied,
            -> ThermalPrinterState.Failed("A conexão USB não está disponível.")
            ThermalPortFailure.BluetoothPermissionDenied,
            ThermalPortFailure.BluetoothDisconnected,
            ThermalPortFailure.BluetoothUnavailable,
            -> ThermalPrinterState.Failed("A conexão Bluetooth não está disponível.")
            null -> ThermalPrinterState.Failed("Não foi possível imprimir. Tente novamente.")
        }

    private fun usbStateFor(
        error: Throwable,
        receiptWriteStarted: Boolean,
    ): ThermalPrinterState =
        when ((error as? ThermalPortException)?.failure) {
            ThermalPortFailure.UsbPermissionDenied -> ThermalPrinterState.UsbPermissionDenied
            ThermalPortFailure.UsbDisconnected,
            ThermalPortFailure.PrinterUnavailable,
            -> ThermalPrinterState.UsbUnavailable
            ThermalPortFailure.WriteInterrupted ->
                if (receiptWriteStarted) {
                    ThermalPrinterState.Failed("A conexão USB foi interrompida durante o envio.")
                } else {
                    ThermalPrinterState.UsbUnavailable
                }
            ThermalPortFailure.LocalWifiDisconnected,
            ThermalPortFailure.BluetoothPermissionDenied,
            ThermalPortFailure.BluetoothDisconnected,
            ThermalPortFailure.BluetoothNotPaired,
            ThermalPortFailure.BluetoothUnavailable,
            -> ThermalPrinterState.Failed("Não foi possível imprimir por USB.")
            // `null` aqui **não** é falha de porta: é exceção que não veio do transporte, e a
            // mensagem genérica escondia isso. Medido na Tomate MDK-082, cujo comprovante final
            // por USB falhou duas vezes com o timeout já ampliado — sinal de que o cabo nunca foi
            // o problema. O tipo da exceção é o bastante para achar a origem e não carrega
            // endereço, identificador nem conteúdo do cupom.
            // `null` aqui **não** é falha de porta: é exceção que não veio do transporte. A
            // mensagem genérica escondia isso e me fez consertar timeout duas vezes no lugar
            // errado. Classe, método e linha do nosso código não carregam endereço, identificador
            // nem conteúdo do cupom — e foi o que apontou `discardPending:260` em dois toques.
            null ->
                ThermalPrinterState.Failed(
                    buildString {
                        append("Falha inesperada ao preparar o envio USB (")
                        append(error::class.java.simpleName)
                        error.stackTrace.firstOrNull { it.className.startsWith("br.com.thermalprinterkit") }
                            ?.let { append(" em ${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}") }
                        append(").")
                    },
                )
        }

    private fun stateWithoutCandidatePool(): ThermalPrinterState =
        if (currentNetwork() == null) {
            ThermalPrinterState.LocalWifiUnavailable
        } else {
            ThermalPrinterState.PrinterNotSelected
        }

    private fun stateWithoutConfirmedSelection(): ThermalPrinterState =
        if (currentNetwork() == null) {
            ThermalPrinterState.LocalWifiUnavailable
        } else {
            ThermalPrinterState.PrinterNotSelected
        }

    private fun stateWithoutConfirmedUsbSelection(): ThermalPrinterState =
        if (usbCandidates.isEmpty()) {
            ThermalPrinterState.UsbUnavailable
        } else {
            usbCandidatesPresentation()
        }

    private fun currentNetwork(): LocalWifiNetwork? =
        networkProvider.localWifiNetwork()?.takeIf(LocalWifiNetwork::stillAvailable)

    private fun refreshAvailableDriverProfiles() {
        // A homologação pode salvar durante esta mesma instância. Relê-la evita exigir reinício do
        // app, enquanto os embutidos continuam sendo a única autoridade distribuída pelo binário.
        availableDriverProfiles =
            (profileStore.read().map(MeasuredProfile::toDriverProfile) + driverProfiles)
                .distinctBy(PrinterDriverProfile::id)
    }

    private fun profileFor(profileId: String): PrinterDriverProfile? =
        availableDriverProfiles.firstOrNull { profile -> profile.id == profileId }
            ?: temporaryDiscoveryProfiles[profileId]

    /**
     * Recompõe decisões operacionais sem alterar o registro persistido. Um ID que chegou sem seu
     * perfil (por exemplo, depois de importar a seleção entre sandboxes) usa capacidades seguras
     * somente em memória e fica marcado com aviso para a interface pedir homologação em papel.
     */
    private fun resolvedProfileFor(selection: PersistedPrinterSelection): ResolvedPrinterProfile =
        PrinterProfileCatalog(
            store = profileStore,
            bundledProfiles = driverProfiles,
        ).resolve(
            PrinterProfileLookup(
                profileId = selection.profileId,
                capabilityKey = null,
                transport = selection.transport,
                paperWidthMm = defaultPaperWidthFor(selection.transport),
            ),
        )

    private fun defaultPaperWidthFor(transport: PrinterTransport): Int =
        when (transport) {
            PrinterTransport.LOCAL_WIFI,
            PrinterTransport.USB,
            -> 80
            PrinterTransport.BLUETOOTH,
            PrinterTransport.BLUETOOTH_LE,
            -> 58
        }

    private fun nextCandidateId(): Long {
        val id = nextCandidateId
        nextCandidateId = if (id == Long.MAX_VALUE) 1L else id + 1L
        return id
    }

    private fun usbCandidatesPresentation(): ThermalPrinterState.UsbCandidatesFound =
        ThermalPrinterState.UsbCandidatesFound(
            usbCandidates.map { candidate ->
                UsbPrinterCandidate(
                    id = candidate.id,
                    label = candidate.label,
                    dialectSuspicion = candidate.dialectSuspicion,
                )
            },
        )

    private suspend fun selectionForNextUsbJob(): ConfirmedUsbSelection? {
        if (confirmedUsbSelection == null) restoreConfirmedSelection(PrinterTransport.USB)
        val current = confirmedUsbSelection ?: return null
        if (monotonicNanos() < current.expiresAtNanos) return current
        confirmedUsbSelection = null
        return null
    }

    private fun bluetoothCandidatesPresentation(): ThermalPrinterState.BluetoothCandidatesFound =
        ThermalPrinterState.BluetoothCandidatesFound(
            bluetoothCandidates.map { candidate ->
                BluetoothPrinterCandidate(
                    candidate.id,
                    candidate.label,
                    named = candidate.named,
                )
            },
        )

    private suspend fun selectionForNextBluetoothJob(): ConfirmedBluetoothSelection? {
        if (confirmedBluetoothSelection == null) restoreConfirmedSelection(PrinterTransport.BLUETOOTH)
        val current = confirmedBluetoothSelection ?: return null
        if (monotonicNanos() < current.expiresAtNanos) return current
        confirmedBluetoothSelection = null
        return null
    }

    private fun clearBluetoothSelections() {
        bluetoothCandidates = emptyList()
        bluetoothCandidateProfile = null
        pendingBluetoothSelection = null
        confirmedBluetoothSelection = null
        bluetoothPort?.close()
    }

    private fun clearBleSelections() {
        bleCandidates = emptyList()
        bleCandidateProfile = null
        pendingBleSelection = null
        confirmedBleSelection = null
        blePort?.close()
    }

    private fun clearWifiSelections() {
        candidatePool = null
        pendingSelection = null
        confirmedSelection = null
    }

    private fun clearUsbSelections() {
        usbCandidates = emptyList()
        usbCandidateProfile = null
        pendingUsbSelection = null
        confirmedUsbSelection = null
        usbPort?.close()
    }

    /** Retoma todas as impressoras guardadas: o balcão pode ter a de rede e a portátil. */
    override suspend fun restore() {
        mutex.withLock {
            withContext(Dispatchers.IO) { restoreConfirmedSelection() }
            publishAdopted()
        }
    }

    /**
     * Reabre somente a unidade pedida. Nada é escrito, nada mais é varrido.
     *
     * O caminho de [restore] percorre `PrinterTransport.values()` e chega ao BLE mesmo quando o
     * trabalho é numa USB: são segundos de varredura gastos por uma impressora que ninguém pediu.
     * Num processo que existe só para atender um trabalho de impressão — o print service do
     * Android, a API de terceiros — isso é o oposto do contrato: trabalho que a pessoa não pediu,
     * num transporte que ela não escolheu.
     *
     * A lista publicada é reemitida no fim porque o estado do transporte mudou; o conteúdo dela vem
     * do store, que esta operação não altera.
     */
    override suspend fun restoreInstallation(installationId: String) {
        mutex.withLock {
            val stored = selectionStore.read()
            val selected = stored.ofInstallation(installationId) ?: return@withLock
            refreshAvailableDriverProfiles()
            withContext(Dispatchers.IO) { restoreOne(selected) }
            publishAdopted(stored)
        }
    }

    private suspend fun restoreConfirmedSelection(only: PrinterTransport? = null) {
        refreshAvailableDriverProfiles()
        val storedSelections = selectionStore.read()
        val selections =
            PrinterTransport.values()
                .filter { only == null || it == only }
                .mapNotNull(storedSelections::of)
        val bleBlocked =
            selections.any { it is PersistedPrinterSelection.BluetoothLe } &&
                bluetoothLeScanPolicy.availability() ==
                BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
        selections.forEach { stored ->
            if (!(bleBlocked && stored is PersistedPrinterSelection.BluetoothLe)) restoreOne(stored)
        }
        if (bleBlocked) mutableState.value = ThermalPrinterState.BluetoothLeUnavailableByHostPolicy
    }

    /** Transporte que recebe as senhas. Sem escolha guardada, nada é impresso em silêncio. */
    private fun activeTransport(): PrinterTransport? = selectionStore.read().active

    private suspend fun restoreOne(stored: PersistedPrinterSelection) {
        when (stored) {
            is PersistedPrinterSelection.Usb -> {
                val profile = resolvedProfileFor(stored).profile.toDriverProfile()
                val activePort = usbPort
                if (activePort == null) {
                    mutableState.value = ThermalPrinterState.UsbUnavailable
                    return
                }
                val discovered = activePort.discover(profile)
                // Autorização USB prova acesso, não identidade. Com várias impressoras no hub, ela
                // não basta para associar o perfil persistido a uma delas depois que o processo
                // perdeu o handle efêmero — especialmente porque o Android recicla endereços USB.
                val restoredHandle =
                    stored.identity
                        ?.let { identity ->
                            discovered.filter { handle -> activePort.matchesPersistedIdentity(handle, identity) }
                        }
                        ?.singleOrNull()
                        ?: discovered.singleOrNull().takeIf { stored.identity == null }
                if (restoredHandle != null) {
                    confirmedUsbSelection =
                        ConfirmedUsbSelection(restoredHandle, profile, Long.MAX_VALUE)
                    mutableState.value = ThermalPrinterState.Ready
                } else if (discovered.size > 1) {
                    usbCandidates = discovered
                    usbCandidateProfile = profile
                    mutableState.value = usbCandidatesPresentation()
                } else {
                    mutableState.value = ThermalPrinterState.UsbUnavailable
                }
            }
            is PersistedPrinterSelection.BluetoothLe -> {
                val profile = resolvedProfileFor(stored).profile.toDriverProfile()
                val activePort = blePort
                if (activePort == null) {
                    mutableState.value = ThermalPrinterState.BluetoothUnavailable
                    return
                }
                // A candidata BLE é reencontrada pelo anúncio; só há adoção sem ambiguidade.
                // Esta varredura leva segundos — é a razão de `restore()` ser suspensa.
                val discovered = activePort.discover(profile)
                val restored =
                    stored.address
                        ?.let { address -> discovered.singleOrNull { it.discoveryAddress == address } }
                        ?: discovered.singleOrNull().takeIf { stored.address == null }
                when {
                    restored != null -> {
                        confirmedBleSelection =
                            ConfirmedBleSelection(restored, profile, Long.MAX_VALUE)
                        mutableState.value = ThermalPrinterState.Ready
                    }
                    discovered.size > 1 -> {
                        bleCandidates = discovered
                        bleCandidateProfile = profile
                        mutableState.value = bleCandidatesPresentation()
                    }
                    else -> mutableState.value = ThermalPrinterState.BluetoothUnavailable
                }
            }
            is PersistedPrinterSelection.Bluetooth -> {
                val profile = resolvedProfileFor(stored).profile.toDriverProfile()
                val activePort = bluetoothPort
                if (activePort == null) {
                    mutableState.value = ThermalPrinterState.BluetoothUnavailable
                    return
                }
                val discovered = activePort.discover(profile)
                val restored =
                    stored.address
                        ?.let { address -> discovered.singleOrNull { it.discoveryAddress == address } }
                        ?: discovered.singleOrNull().takeIf { stored.address == null }
                if (restored != null) {
                    confirmedBluetoothSelection =
                        ConfirmedBluetoothSelection(restored, profile, Long.MAX_VALUE)
                    mutableState.value = ThermalPrinterState.Ready
                } else if (discovered.size > 1) {
                    bluetoothCandidates = discovered
                    bluetoothCandidateProfile = profile
                    mutableState.value = bluetoothCandidatesPresentation()
                } else {
                    mutableState.value = ThermalPrinterState.BluetoothUnavailable
                }
            }
            is PersistedPrinterSelection.LocalWifi -> {
                val profile = resolvedProfileFor(stored).profile.toDriverProfile()
                val persistedEndpoint =
                    stored.endpoint?.let { endpoint ->
                        LocalWifiPrinterEndpoint.parseIpv4Literal(endpoint.ipv4Address, endpoint.port)
                    }
                val currentNetwork = networkProvider.localWifiNetwork()
                if (
                    persistedEndpoint != null &&
                    currentNetwork != null &&
                    currentNetwork.stillAvailable() &&
                    currentNetwork.subnet.isSelectableEndpoint(persistedEndpoint) &&
                    profile.acceptsTcpPort(persistedEndpoint.port)
                ) {
                    confirmedSelection =
                        ConfirmedSelection(
                            PrinterSelection(
                                endpoint = persistedEndpoint,
                                profile = profile,
                                network = currentNetwork,
                                networkKey = currentNetwork.selectionKey,
                            ),
                            Long.MAX_VALUE,
                        )
                    mutableState.value = ThermalPrinterState.Ready
                    return
                }
                // O endereço confirmado morreu com o processo de propósito: IP não vai para disco.
                // O perfil permite repetir a busca, mas só uma candidata pode ser retomada sem
                // pedir nova confirmação humana; duas impressoras abertas seriam ambíguas.
                // O modo de conexão não vai para disco. Na retomada, o gateway é tentado antes:
                // é uma sondagem só, e é onde a impressora de Wi-Fi direto está.
                val retomada =
                    discovery
                        .findCandidates(profile, PrinterNetworkAttachment.DIRECT_AP)
                        .takeIf { it is LocalWifiPrinterDiscoveryResult.Candidates }
                        ?: discovery.findCandidates(profile, PrinterNetworkAttachment.ROUTER_LAN)
                when (val result = retomada) {
                    LocalWifiPrinterDiscoveryResult.WifiUnavailable ->
                        mutableState.value = ThermalPrinterState.LocalWifiUnavailable
                    is LocalWifiPrinterDiscoveryResult.NaoEncontrada ->
                        mutableState.value = ThermalPrinterState.LocalWifiPrinterUnavailable
                    is LocalWifiPrinterDiscoveryResult.Candidates -> {
                        if (!result.network.stillAvailable()) {
                            mutableState.value = ThermalPrinterState.LocalWifiUnavailable
                            return
                        }
                        if (result.endpoints.size == 1) {
                            val network = result.network
                            val selection =
                                PrinterSelection(
                                    endpoint = result.endpoints.single(),
                                    profile = profile,
                                    network = network,
                                    networkKey = network.selectionKey,
                                )
                            confirmedSelection = ConfirmedSelection(selection, Long.MAX_VALUE)
                            mutableState.value = ThermalPrinterState.Ready
                        } else {
                            val pool =
                                CandidatePool(
                                    profile = profile,
                                    network = result.network,
                                    networkKey = result.network.selectionKey,
                                    entries =
                                        result.endpoints.mapIndexed { index, endpoint ->
                                            CandidateEntry(
                                                id = nextCandidateId(),
                                                discoveryOrder = index + 1,
                                                endpoint = endpoint,
                                            )
                                        },
                                    expiresAtNanos = monotonicNanos() + CANDIDATE_LIST_TTL_NANOS,
                                )
                            candidatePool = pool
                            mutableState.value = pool.presentation()
                        }
                    }
                }
            }
        }
    }

    private fun text(
        value: String,
        alignment: ThermalTextAlignment,
        style: ThermalTextStyle,
        size: Int,
    ): ByteArray = EscPosThermalCommands.text(value, alignment, style, size)

    private fun advance(lines: Int): ByteArray =
        requireNotNull(EscPosThermalCommands.advance(lines)) { "Avanço de papel inválido." }

    override suspend fun openHomologationTarget(
        transport: PrinterTransport?,
    ): PrinterHomologationTarget? =
        mutex.withLock {
            val target = pendingProbeTarget(transport) ?: adoptedProbeTarget(transport)
                ?: return@withLock null
            PrinterHomologationTarget(
                transport = target.transport,
                // O nome declarado pelo aparelho vence o genérico do perfil de descoberta, e a
                // pessoa ainda pode trocar no fim. Passa pela validação do MeasuredProfile, que
                // recusa nome com cara de identificador técnico.
                displayName =
                    target.declaredName
                        ?.takeIf(::isAcceptableProfileName)
                        ?: target.profile.displayName,
                profileId = target.profile.id,
                paperWidthMm = if (target.profile.printableColumns <= 32) 58 else 80,
                dialect = target.profile.dialect,
                defaultStore = profileStore,
                sender = { bytes -> sendHomologationProbe(target, bytes) },
                adopter = { profile -> adoptHomologatedTarget(target, profile) },
                identityReader = { readHomologationIdentity(target) },
                // Alcança só o comprovante final; as tiras saem cruas pelo mesmo `sender`.
                receiptDecoration = receiptDecoration,
            )
        }

    /** Abre o mesmo alvo efêmero; BLE não entra porque a porta não possui notify de leitura. */
    private suspend fun readHomologationIdentity(target: ProbeTarget): PrinterDeclaredIdentity? =
        mutex.withLock {
            withContext(Dispatchers.IO) {
                when (target) {
                    is ProbeTarget.Wifi -> {
                        val selection = target.selection
                        try {
                            port.open(selection.network, selection.endpoint, selection.profile)
                            port.readIdentity()
                        } finally {
                            port.close()
                        }
                    }
                    is ProbeTarget.Usb -> {
                        val activePort = usbPort ?: return@withContext null
                        try {
                            activePort.open(target.handle, target.profile)
                            activePort.readIdentity()
                        } finally {
                            activePort.close()
                        }
                    }
                    is ProbeTarget.Bluetooth -> {
                        val activePort = bluetoothPort ?: return@withContext null
                        activePort.open(target.handle, target.profile)
                        activePort.readIdentity()
                    }
                    is ProbeTarget.Ble -> null
                }
            }
        }

    private fun pendingProbeTarget(transport: PrinterTransport?): ProbeTarget? =
        when (transport) {
            PrinterTransport.LOCAL_WIFI -> pendingSelectionOrNull()?.let { ProbeTarget.Wifi(it.selection) }
            PrinterTransport.USB -> pendingUsbSelectionOrNull()?.let { ProbeTarget.Usb(it.handle, it.profile) }
            PrinterTransport.BLUETOOTH ->
                pendingBluetoothSelectionOrNull()?.let { ProbeTarget.Bluetooth(it.handle, it.profile) }
            PrinterTransport.BLUETOOTH_LE ->
                pendingBleSelectionOrNull()?.let { ProbeTarget.Ble(it.handle, it.profile) }
            null ->
                pendingBleSelectionOrNull()?.let { ProbeTarget.Ble(it.handle, it.profile) }
                    ?: pendingBluetoothSelectionOrNull()?.let {
                        ProbeTarget.Bluetooth(it.handle, it.profile)
                    }
                    ?: pendingUsbSelectionOrNull()?.let { ProbeTarget.Usb(it.handle, it.profile) }
                    ?: pendingSelectionOrNull()?.let { ProbeTarget.Wifi(it.selection) }
        }

    private fun adoptedProbeTarget(transport: PrinterTransport?): ProbeTarget? =
        when (transport ?: selectionStore.read().active) {
            PrinterTransport.LOCAL_WIFI -> confirmedSelection?.let { ProbeTarget.Wifi(it.selection) }
            PrinterTransport.USB -> confirmedUsbSelection?.let { ProbeTarget.Usb(it.handle, it.profile) }
            PrinterTransport.BLUETOOTH -> confirmedBluetoothSelection?.let {
                ProbeTarget.Bluetooth(it.handle, it.profile)
            }
            PrinterTransport.BLUETOOTH_LE -> confirmedBleSelection?.let {
                ProbeTarget.Ble(it.handle, it.profile)
            }
            null -> null
        }

    private suspend fun sendHomologationProbe(
        target: ProbeTarget,
        bytes: ByteArray,
    ): ThermalPrintResult =
        mutex.withLock {
            val result =
                withContext(Dispatchers.IO) {
                    mutableState.value = ThermalPrinterState.Printing
                    when (target) {
                        is ProbeTarget.Wifi -> runReceiptBytes(target.selection, bytes)
                        is ProbeTarget.Usb -> {
                            val activePort = usbPort
                                ?: return@withContext fail(ThermalPrinterState.UsbUnavailable)
                            runUsbReceiptBytes(activePort, target.handle, target.profile, bytes)
                        }
                        is ProbeTarget.Bluetooth -> {
                            val activePort = bluetoothPort
                                ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                            runBluetoothReceiptBytes(activePort, target.handle, target.profile, bytes)
                        }
                        is ProbeTarget.Ble -> {
                            if (
                                bluetoothLeScanPolicy.availability() ==
                                    BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
                            ) {
                                return@withContext fail(
                                    ThermalPrinterState.BluetoothLeUnavailableByHostPolicy,
                                )
                            }
                            val activePort = blePort
                                ?: return@withContext fail(ThermalPrinterState.BluetoothUnavailable)
                            runBleReceiptBytes(activePort, target.handle, target.profile, bytes)
                        }
                    }
                }
            // O callback real terminou. A candidata continua pendente durante todas as sondas e
            // só deixa esse estado quando a confirmação final adota o perfil.
            if (result == ThermalPrintResult.Printed) {
                mutableState.value =
                    if (hasPendingSelection()) {
                        ThermalPrinterState.SearchConfirmationRequired
                    } else if (selectionStore.read().of(target.transport) != null) {
                        ThermalPrinterState.Ready
                    } else {
                        ThermalPrinterState.PrinterNotSelected
                    }
            }
            result
        }

    private suspend fun adoptHomologatedTarget(
        target: ProbeTarget,
        profile: MeasuredProfile,
    ) {
        mutex.withLock {
            require(profile.supports(target.transport)) {
                "O perfil medido não aceita o transporte da candidata."
            }
            val driver = profile.toDriverProfile()
            // Persiste e relê antes de tocar nos handles em memória. Se o store falhar, restaura o
            // snapshot anterior e a candidata continua pendente para nova tentativa consciente.
            val previousSelections = selectionStore.read()
            val newSelection =
                when (target) {
                    is ProbeTarget.Wifi ->
                        PersistedPrinterSelection.LocalWifi(
                            driver.id,
                            PersistedNetworkEndpoint(
                                target.selection.endpoint.displayAddress(),
                                target.selection.endpoint.port,
                            ),
                        )
                    is ProbeTarget.Usb ->
                        PersistedPrinterSelection.Usb(
                            driver.id,
                            usbPort?.persistenceIdentity(target.handle),
                        )
                    is ProbeTarget.Bluetooth ->
                        PersistedPrinterSelection.Bluetooth(
                            driver.id,
                            bluetoothPort?.persistenceAddress(target.handle),
                        )
                    is ProbeTarget.Ble ->
                        PersistedPrinterSelection.BluetoothLe(
                            driver.id,
                            blePort?.persistenceAddress(target.handle),
                        )
                }
            val updatedSelections = previousSelections.with(newSelection)
            // Tudo que ainda pode consultar/validar stores acontece antes de qualquer mutação de
            // seleção ou handle. Depois da releitura confirmada restam apenas atribuições locais.
            val updatedAdopted = adoptedPresentation(updatedSelections)
            try {
                selectionStore.save(updatedSelections)
                check(selectionStore.read() == updatedSelections) {
                    "O store não confirmou a seleção homologada."
                }
            } catch (error: Throwable) {
                try {
                    selectionStore.save(previousSelections)
                } catch (rollback: Throwable) {
                    error.addSuppressed(rollback)
                }
                mutableState.value =
                    if (hasPendingSelection()) {
                        ThermalPrinterState.SearchConfirmationRequired
                    } else if (previousSelections.of(target.transport) != null) {
                        ThermalPrinterState.Ready
                    } else {
                        ThermalPrinterState.PrinterNotSelected
                    }
                throw error
            }
            when (target) {
                is ProbeTarget.Wifi -> {
                    confirmedSelection =
                        ConfirmedSelection(target.selection.copy(profile = driver), Long.MAX_VALUE)
                    pendingSelection = null
                    candidatePool = null
                }
                is ProbeTarget.Usb -> {
                    confirmedUsbSelection = ConfirmedUsbSelection(target.handle, driver, Long.MAX_VALUE)
                    pendingUsbSelection = null
                    usbCandidates = emptyList()
                    usbCandidateProfile = null
                }
                is ProbeTarget.Bluetooth -> {
                    confirmedBluetoothSelection =
                        ConfirmedBluetoothSelection(target.handle, driver, Long.MAX_VALUE)
                    pendingBluetoothSelection = null
                    bluetoothCandidates = emptyList()
                    bluetoothCandidateProfile = null
                }
                is ProbeTarget.Ble -> {
                    confirmedBleSelection = ConfirmedBleSelection(target.handle, driver, Long.MAX_VALUE)
                    pendingBleSelection = null
                    bleCandidates = emptyList()
                    bleCandidateProfile = null
                }
            }
            mutableAdopted.value = updatedAdopted
            mutableState.value = ThermalPrinterState.Ready
        }
    }

    private data class PrinterSelection(
        val endpoint: LocalWifiPrinterEndpoint,
        val profile: PrinterDriverProfile,
        val network: LocalWifiNetwork,
        val networkKey: LocalWifiNetworkSelectionKey,
    ) {
        override fun toString(): String = "PrinterSelection(endpoint=[REDACTED], network=[REDACTED])"
    }

    private sealed interface ProbeTarget {
        val transport: PrinterTransport
        val profile: PrinterDriverProfile

        /**
         * Nome que o aparelho declarou na busca, quando houve.
         *
         * O perfil medido nascia com o nome do perfil de descoberta — "Impressora temporária" no
         * Caminho B — mesmo quando o Bluetooth já tinha dito `T210_D0E9`. Quem se identificou tem
         * nome melhor que o nosso genérico.
         */
        val declaredName: String? get() = null

        data class Wifi(val selection: PrinterSelection) : ProbeTarget {
            override val transport = PrinterTransport.LOCAL_WIFI
            override val profile: PrinterDriverProfile = selection.profile
        }

        data class Usb(
            val handle: UsbPrinterHandle,
            override val profile: PrinterDriverProfile,
        ) : ProbeTarget {
            override val transport = PrinterTransport.USB
            override val declaredName = handle.label.takeIf { handle.named }
        }

        data class Bluetooth(
            val handle: BluetoothPrinterHandle,
            override val profile: PrinterDriverProfile,
        ) : ProbeTarget {
            override val transport = PrinterTransport.BLUETOOTH
            override val declaredName = handle.label.takeIf { handle.named }
        }

        data class Ble(
            val handle: BlePrinterHandle,
            override val profile: PrinterDriverProfile,
        ) : ProbeTarget {
            override val transport = PrinterTransport.BLUETOOTH_LE
            override val declaredName = handle.label.takeIf { handle.named }
        }
    }

    /** Alvo da lista mesclada; não contém nem descreve o endereço usado na correlação. */
    private sealed interface UnifiedBluetoothTarget {
        val presentationId: Long
        val profile: PrinterDriverProfile
        val origin: BluetoothCandidateOrigin
        val label: String
        val isLikelyPrinter: Boolean

        /** Quem não se identifica vai para o fim da lista; ver `BluetoothPrinterCandidate.named`. */
        val named: Boolean

        data class Spp(
            override val presentationId: Long,
            val handle: BluetoothPrinterHandle,
            override val profile: PrinterDriverProfile,
        ) : UnifiedBluetoothTarget {
            override val origin = BluetoothCandidateOrigin.SPP
            override val label = handle.label
            override val isLikelyPrinter = true
            override val named = handle.named

            override fun toString(): String = "UnifiedBluetoothTarget.Spp(id=$presentationId)"
        }

        data class Ble(
            override val presentationId: Long,
            val handle: BlePrinterHandle,
            override val profile: PrinterDriverProfile,
        ) : UnifiedBluetoothTarget {
            override val origin = BluetoothCandidateOrigin.BLE
            override val label = handle.label
            override val isLikelyPrinter = handle.isLikelyPrinter
            override val named = handle.named

            override fun toString(): String = "UnifiedBluetoothTarget.Ble(id=$presentationId)"
        }
    }

    private data class BluetoothCandidatesSnapshot(
        val candidates: List<BluetoothPrinterCandidate>,
        val likelyCandidateIds: Set<Long>,
    )

    private data class CandidateEntry(
        val id: Long,
        val discoveryOrder: Int,
        val endpoint: LocalWifiPrinterEndpoint,
    ) {
        override fun toString(): String = "CandidateEntry(id=$id, endpoint=[REDACTED])"
    }

    private data class CandidatePool(
        val profile: PrinterDriverProfile,
        val network: LocalWifiNetwork,
        val networkKey: LocalWifiNetworkSelectionKey,
        val entries: List<CandidateEntry>,
        val expiresAtNanos: Long,
    ) {
        fun presentation(): ThermalPrinterState.LocalWifiCandidatesFound =
            ThermalPrinterState.LocalWifiCandidatesFound(
                entries.map { entry ->
                    LocalWifiPrinterCandidate(
                        id = entry.id,
                        label = "Impressora encontrada ${entry.discoveryOrder}",
                        ipAddress = entry.endpoint.displayAddress(),
                    )
                },
            )

        fun matches(selection: PrinterSelection): Boolean =
            networkKey == selection.networkKey && network.matchesSelectionKey(networkKey)

        fun without(candidateId: Long?): CandidatePool? =
            candidateId?.let { id ->
                entries.filterNot { entry -> entry.id == id }
                    .takeIf(List<CandidateEntry>::isNotEmpty)
                    ?.let { remaining -> copy(entries = remaining) }
            }

        override fun toString(): String = "CandidatePool(count=${entries.size}, network=[REDACTED])"
    }

    private data class ConfirmedSelection(
        val selection: PrinterSelection,
        val expiresAtNanos: Long,
    ) {
        override fun toString(): String = "ConfirmedSelection(selection=[REDACTED])"
    }

    private data class PendingSelection(
        val selection: PrinterSelection,
        val candidateId: Long?,
    ) {
        override fun toString(): String = "PendingSelection(selection=[REDACTED])"
    }

    private data class PendingBleSelection(
        val handle: BlePrinterHandle,
        val profile: PrinterDriverProfile,
    ) {
        override fun toString(): String = "PendingBleSelection(handle=[REDACTED])"
    }

    private data class ConfirmedBleSelection(
        val handle: BlePrinterHandle,
        val profile: PrinterDriverProfile,
        val expiresAtNanos: Long,
    ) {
        override fun toString(): String = "ConfirmedBleSelection(handle=[REDACTED])"
    }

    private data class PendingBluetoothSelection(
        val handle: BluetoothPrinterHandle,
        val profile: PrinterDriverProfile,
    ) {
        override fun toString(): String = "PendingBluetoothSelection(handle=[REDACTED])"
    }

    private data class ConfirmedBluetoothSelection(
        val handle: BluetoothPrinterHandle,
        val profile: PrinterDriverProfile,
        val expiresAtNanos: Long,
    ) {
        override fun toString(): String = "ConfirmedBluetoothSelection(handle=[REDACTED])"
    }

    private data class PendingUsbSelection(
        val handle: UsbPrinterHandle,
        val profile: PrinterDriverProfile,
    ) {
        override fun toString(): String = "PendingUsbSelection(handle=[REDACTED])"
    }

    private data class ConfirmedUsbSelection(
        val handle: UsbPrinterHandle,
        val profile: PrinterDriverProfile,
        val expiresAtNanos: Long,
    ) {
        override fun toString(): String = "ConfirmedUsbSelection(handle=[REDACTED])"
    }

    private companion object {
        const val NORMAL_SIZE = 0
        const val CANDIDATE_LIST_TTL_NANOS = 2L * 60 * 1_000_000_000
    }
}

/** Factory para a única instância do app, sem SDK ou estado estático de fornecedor. */
fun createLocalWifiThermalPrinter(
    localWifiNetworkProvider: LocalWifiNetworkProvider,
    usbThermalPort: UsbThermalPort? = null,
    bluetoothThermalPort: BluetoothThermalPort? = null,
    bleThermalPort: BleThermalPort? = null,
    selectionStore: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
    profileStore: PrinterProfileStore = InMemoryPrinterProfileStore(),
    bluetoothLeScanPolicy: BluetoothLeScanPolicy = BluetoothLeScanPolicy.ALLOW,
    receiptDecoration: ReceiptDecoration? = null,
    /**
     * O quadro de medição do transporte, a **mesma** instância entregue às portas.
     *
     * Sem ele nada muda: as portas não medem e a tela de diagnóstico não mostra painel. Ver
     * [TransportMeasurement].
     */
    transportTelemetry: TransportTelemetry? = null,
    /**
     * Sobrescreve a altura de banda do raster enquanto o app está rodando; `null` mantém o padrão.
     *
     * Só a bancada usa, e só em depuração: ver o campo de mesmo nome em [LocalWifiThermalPrinter].
     */
    rasterStripeHeightOverride: () -> Int? = { null },
    /**
     * Como o hospedeiro quer os códigos daquela impressora; `{ null }` mantém o padrão de sempre.
     *
     * Ver o campo de mesmo nome em [LocalWifiThermalPrinter]: quem guarda a escolha é o app, e o
     * kit só recebe o resultado — e ainda assim confronta com a capacidade medida antes de emitir.
     */
    codeEmissionOverride: (String) -> ThermalCodeEmissionPreferences? = { null },
): ThermalPrinter =
    LocalWifiThermalPrinter(
        port = LocalWifiEscPosThermalPort(localWifiNetworkProvider),
        usbPort = usbThermalPort,
        bluetoothPort = bluetoothThermalPort,
        blePort = bleThermalPort,
        discovery = DefaultLocalWifiPrinterDiscovery(localWifiNetworkProvider),
        networkProvider = localWifiNetworkProvider,
        // Medições são relidas do store a cada operação; colocá-las também nesta lista criaria um
        // snapshot obsoleto depois que a pessoa removesse ou refizesse uma homologação.
        driverProfiles = BundledPrinterDrivers.all,
        selectionStore = selectionStore,
        profileStore = profileStore,
        bluetoothLeScanPolicy = bluetoothLeScanPolicy,
        receiptDecoration = receiptDecoration,
        transportTelemetry = transportTelemetry,
        rasterStripeHeightOverride = rasterStripeHeightOverride,
        codeEmissionOverride = codeEmissionOverride,
    )

/**
 * Tabela e corte, ditos na língua do layout.
 *
 * No dialeto ESC/POS são as três linhas de sempre — página, codificação e o protocolo de corte
 * escolhido —, porque lá as três descrevem escolhas que a impressora realmente faz.
 *
 * No Procomp elas eram falsas, e o gêmeo iOS tinha o mesmo defeito: não há `ESC t` nesta
 * firmware (o texto sai em ABICOMP, tabela de fábrica, provada em papel em 23/08/2026), e
 * nenhum byte `GS` chega a esta impressora — `procompFinish` emite `ESC w` sem consultar
 * `cutProtocol`. Imprimir `Corte: GS V 1` aqui faria alguém transcrever para um cadastro, um
 * mês depois, uma medição que nunca houve; o argumento é o de
 * [ProcompHomologationProbes.profileLines], e vale mais neste papel do que lá, porque este é o
 * que qualquer pessoa alcança tocando em "imprimir teste", sem passar por homologação nenhuma.
 *
 * **Sem prova de bancada:** que a frase corresponda ao que sai. `procompFinish` é o único fecho
 * deste dialeto e o corte por `ESC w` foi medido; a correspondência entre as duas coisas
 * continua garantida por leitura de código.
 */
internal fun linhasDoDialetoNoComprovante(
    profile: PrinterDriverProfile,
    codificacao: String,
): String =
    when (profile.dialect) {
        EscPosDialect.EPSON_COMPATIBLE ->
            "Página: " + (profile.codePage?.name ?: "Nenhuma") + "\n" +
                "Codificação: $codificacao\n" +
                "Corte: ${profile.cutProtocol.capabilityName} | avanço ${profile.cutFeedLines}\n"
        EscPosDialect.PROCOMP_ESC_P ->
            "Tabela: ABICOMP (fábrica)\n" +
                if (profile.hasCutter) {
                    "Corte: ESC w (parcial) | avanço ${profile.cutFeedLines}\n"
                } else {
                    "Corte: sem guilhotina\n"
                }
    }

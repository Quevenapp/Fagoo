package br.com.thermalprinterkit

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Capacidade adicional; [ThermalPrinter] produtiva continua intacta. */
interface PrinterHomologationHost {
    val profileStore: PrinterProfileStore

    /** Candidata pendente tem precedência; sem ela, usa a impressora adotada solicitada ou ativa. */
    suspend fun openHomologationTarget(
        transport: PrinterTransport? = null,
    ): PrinterHomologationTarget?

    /**
     * Apaga uma medição deste aparelho e solta a impressora que apontava para ela.
     *
     * A regra "perfil medido nunca é sobrescrito" continua valendo: ela protege medição contra
     * acidente, não contra vontade. Medição errada existe — a T210 foi gravada com 80 mm porque a
     * largura da busca atravessou de outra impressora —, e sem uma saída explícita o único caminho
     * seria limpar os dados do app inteiro. Apagar é irreversível, e por isso é sempre uma ação
     * pedida, com confirmação, nunca uma consequência de outra coisa.
     *
     * Soltar a seleção é parte do apagar: uma impressora adotada que aponta para um perfil que não
     * existe mais imprimiria pelo perfil conservador sem ninguém pedir.
     */
    suspend fun forgetMeasuredProfile(profileId: String) = Unit
}

/**
 * Capacidade opcional para procurar uma impressora ainda sem perfil medido.
 *
 * O perfil conservador existe somente em memória: não escolhe página de código nem guilhotina e
 * nunca entra no store ou na lista de perfis. Separar esta capacidade mantém implementações existentes de
 * [PrinterHomologationHost] compatíveis e permite à interface reconhecer uma candidata temporária
 * depois de uma recomposição.
 */
interface TemporaryPrinterDiscoveryProfileHost {
    /**
     * @param dialect o idioma do card escolhido no catalogo, ou o respondido por quem entrou sem
     *   card. Ver [MeasuredProfile.temporary]: e o unico campo do perfil temporario que **nao** e
     *   conservador de proposito, porque dialeto errado trava a impressora em vez de so estragar o
     *   papel.
     *
     *   **Sem padrao desde 09/09/2026.** Este e o ponto de entrada do dialeto na descoberta: o que
     *   entrar aqui decide o prologo do transporte e a serie de sondas da medicao inteira. Um
     *   `= EPSON_COMPATIBLE` neste lugar nao e um valor de conveniencia, e a resposta a uma
     *   pergunta que ninguem fez.
     */
    fun prepareTemporaryDiscoveryProfile(
        transport: PrinterTransport,
        paperWidthMm: Int,
        displayName: String? = null,
        dialect: EscPosDialect,
    ): PrinterDriverProfile

    fun hasPendingTemporaryDiscoveryProfile(): Boolean

    /**
     * Reaplica a largura escolhida à candidata que já foi selecionada.
     *
     * Sem isso existiam duas verdades sobre a mesma coisa. O perfil temporário é criado no momento
     * da busca, com a largura daquele instante, e a candidata guarda **esse** perfil; tocar em
     * "58 mm" depois só trocava o que a tela mostrava. Medido em papel na LUOGAO em 12/08: a tela
     * marcava 58 e o comprovante saía "Impressora temporária 80 mm", 48 colunas e 576 dots — e a
     * homologação inteira seguia em 80, porque a largura dela vem do perfil da candidata.
     */
    suspend fun applyTemporaryDiscoveryPaperWidth(paperWidthMm: Int)

    /** Troca somente o perfil da candidata efêmera; handle/endereço continuam privados no host. */
    suspend fun applyPendingDiscoveryProfile(profileId: String)
}

class PrinterHomologationTarget internal constructor(
    val transport: PrinterTransport,
    val displayName: String,
    val profileId: String,
    val paperWidthMm: Int = 58,
    /**
     * O idioma da candidata, para a adocao nao perde-lo. Ver [MeasuredProfile.createLocal].
     *
     * Sem padrao: e ele que escolhe a serie de sondas em [printerHomologationProbeSet] e o que
     * [PrinterProbeSession.send] compara com o dialeto dos bytes antes de deixar a tira sair.
     */
    val dialect: EscPosDialect,
    private val defaultStore: PrinterProfileStore,
    private val sender: suspend (ByteArray) -> ThermalPrintResult,
    private val adopter: suspend (MeasuredProfile) -> Unit,
    private val identityReader: suspend () -> PrinterDeclaredIdentity? = { null },
    /**
     * Decoração do hospedeiro, e **só para o comprovante final**.
     *
     * As tiras saem por [PrinterProbeSession.send], que despacha bytes de
     * [PrinterHomologationProbes] montados sem layout nenhum: elas não têm por onde receber
     * decoração, e é assim que fica. Tira é instrumento de medida — um raster do hospedeiro no meio
     * da régua de geometria desloca o que ela mede, e uma linha a mais na tira de avanço muda a
     * distância que ela existe para medir. O comprovante final não mede nada: é o recibo da
     * instalação concluída. Ver [ReceiptDecoration].
     */
    internal val receiptDecoration: ReceiptDecoration? = null,
) {
    fun openSession(): PrinterProbeSession = PrinterProbeSession(this, sender)

    /** Mesma sessão, com o relógio no lugar da suíte: ninguém dorme para provar uma vazão. */
    internal fun openSession(nowMicros: () -> Long): PrinterProbeSession =
        PrinterProbeSession(this, sender, nowMicros)

    /**
     * Fluxo público seguro. Diferente de [openSession], ele pode adotar, mas somente depois do
     * callback real e da confirmação humana do comprovante final.
     */
    fun openHomologation(store: PrinterProfileStore = defaultStore): PrinterHomologationFlow =
        PrinterHomologationFlow(
            target = this,
            probeSession = openSession(),
            store = store,
            adopter = adopter,
        )

    /**
     * Salva uma configuração informada pela pessoa sem enviar novas sondas.
     *
     * Esta rota é explícita para quem já tem o comprovante anterior em mãos. Ela preserva todas as
     * validações de perfil, a confirmação de escrita do store e a adoção do vínculo físico; a única
     * coisa que não faz é afirmar que houve uma nova prova em papel.
     *
     * Como ela não mede sonda nenhuma, também não apaga o que a sonda mediu: ver
     * [preservingLateMeasurements].
     */
    suspend fun saveManualConfiguration(profile: MeasuredProfile) {
        require(profile.source == PrinterProfileSource.MEASURED) {
            "Configuração manual precisa produzir um perfil local."
        }
        require(profile.supports(transport)) {
            "O perfil manual não aceita o transporte da impressora."
        }
        val previous = defaultStore.read().firstOrNull { it.id == profile.id }
        val preserved = profile.preservingLateMeasurements(previous)
        try {
            defaultStore.save(preserved)
            check(defaultStore.read().any { it == preserved }) {
                "O store não confirmou a configuração manual."
            }
            // Quem adota reconstrói o layout pelo perfil adotado: mandar a declaração crua aqui
            // faria o cupom seguinte sair sem compensação com o disco correto, e sem erro nenhum.
            adopter(preserved)
        } catch (error: CancellationException) {
            rollbackManualProfile(preserved.id, previous, error)
            throw error
        } catch (error: Throwable) {
            rollbackManualProfile(preserved.id, previous, error)
            throw error
        }
    }

    /**
     * A declaração, com os quatro campos medidos tardios do perfil anterior onde ela não declara
     * nada: o declarado vence quando existe, e o ausente vem de [previous].
     *
     * **Por que a garantia é da superfície do kit, e não de quem chama.** A mesma preservação já
     * existia na tela do `:printher` e dentro do kit do iOS; no Android ela ficava só na tela, e
     * esta função — que é o ponto de entrada do kit para a rota declarada — sobrescrevia o perfil
     * inteiro. Quem chamasse a API sem passar por aquela tela apagava `verticalRasterScale` em
     * silêncio: foto, logotipo e QR da T210 voltavam a sair ~20% mais curtos, o cupom continuava
     * saindo e a `capabilityKey` de um perfil já medido se movia. Em 21/08/2026 nenhum app chamava
     * isto fora do `:printher` — era superfície que **permitia** a perda, não defeito em app
     * publicado —, e é justamente por isso que a trava mora aqui: hospedeiro que ainda não existe
     * não tem como saber que precisa fundir antes.
     *
     * **Por que preservar, se o parâmetro é um perfil completo.** Esta rota recebe perfil, não
     * declaração, então ela não distingue "o chamador quis apagar" de "o chamador não sabia". Os
     * dois erros não custam o mesmo. Nenhuma tela declara estes quatro campos — quem os produz é a
     * bancada, pela régua da sonda e pela tira de código nativo —, então "veio nulo" é quase sempre
     * "não sabia"; e perder o fator é silencioso, porque o cupom continua saindo enquanto o raster
     * encolhe. O erro oposto — manter um fator que alguém queria fora — aparece no papel no cupom
     * seguinte e tem duas saídas explícitas: declarar o valor novo, que vence, ou
     * [PrinterHomologationHost.forgetMeasuredProfile], que apaga a medição inteira com confirmação.
     *
     * **Por que isto não alcança a rota da sonda.** Homologação não passa por aqui: ela persiste em
     * [PrinterHomologationFlow.persistAndAdopt], depois do comprovante em papel e da confirmação
     * humana. Lá a ausência é medida — régua que conclui `>= 0,97` grava `null` de propósito — e
     * precisa continuar podendo gravar ausência.
     *
     * Fundir duas vezes dá o mesmo resultado: quem já fundiu chega com os quatro preenchidos, e
     * `?:` sobre valor presente é identidade. A tela do `:printher` continua fundindo antes de
     * chamar sem que isso mude nada aqui.
     */
    private fun MeasuredProfile.preservingLateMeasurements(
        previous: MeasuredProfile?,
    ): MeasuredProfile =
        if (previous == null) {
            this
        } else {
            copy(
                maxRasterBytesPerSecond = maxRasterBytesPerSecond ?: previous.maxRasterBytesPerSecond,
                verticalRasterScale = verticalRasterScale ?: previous.verticalRasterScale,
                nativeQrHonored = nativeQrHonored ?: previous.nativeQrHonored,
                nativeBarcodeHonored = nativeBarcodeHonored ?: previous.nativeBarcodeHonored,
            )
        }

    private fun rollbackManualProfile(
        profileId: String,
        previous: MeasuredProfile?,
        original: Throwable,
    ) {
        try {
            if (previous == null) defaultStore.remove(profileId) else defaultStore.save(previous)
        } catch (rollback: Throwable) {
            original.addSuppressed(rollback)
        }
    }

    /**
     * Pergunta a identidade declarada — e **não pergunta** a quem não fala a língua da pergunta.
     *
     * `GS I` é comando `GS`, e a IM453H não tem **nenhum**. O leitor de identidade dos transportes
     * manda as três consultas sem olhar perfil nenhum, então habilitar a homologação para o dialeto
     * Procomp sem esta trava mandaria `GS I` para a impressora cuja firmware trava com byte solto —
     * exatamente o defeito que [EscPosDialectGate] existe para não repetir, e por um caminho que
     * nem passa pelas sondas.
     *
     * `null` aqui é "não perguntada", e a folha final do dialeto Procomp diz isso em letra em vez de
     * "não respondeu". Ver [ProcompHomologationProbes.profileLines].
     */
    internal suspend fun readIdentity(): PrinterDeclaredIdentity? =
        if (EscPosDialectGate.usesEscPosIdentityQuery(dialect)) identityReader() else null

    override fun toString(): String =
        "PrinterHomologationTarget(transport=$transport, profileId=$profileId)"
}

enum class PrinterProbeSessionState {
    READY,
    SENDING,
    CLOSED,
}

/**
 * Sessão efêmera ligada ao handle/endpoint que permanece privado no host.
 *
 * Esta classe só envia bytes. A persistência fica privada em [PrinterHomologationFlow], para uma
 * sessão de baixo nível nunca conseguir contornar o comprovante final e a confirmação humana.
 */
class PrinterProbeSession internal constructor(
    val target: PrinterHomologationTarget,
    private val sender: suspend (ByteArray) -> ThermalPrintResult,
    private val nowMicros: () -> Long = { System.nanoTime() / 1_000 },
) : AutoCloseable {
    private val mutex = Mutex()

    var state: PrinterProbeSessionState = PrinterProbeSessionState.READY
        private set

    /**
     * Vazão real do último envio concluído, em bytes por segundo, ou `null` quando não deu para
     * medir.
     *
     * É o mínimo que o transporte precisava expor, e é medido onde o transporte realmente começa e
     * termina: do instante em que os bytes são entregues a ele até o desfecho que ele devolve.
     * Nenhuma sonda supõe vazão — a sonda de vazão lê **este** número.
     *
     * **O que ele inclui, e por que isso é o lado seguro.** A janela de dreno do BLE e a pausa de
     * 20 ms por bloco do SPP contam como tempo de envio, então o número sai igual ou **menor** que
     * a taxa instantânea do enlace. Teto medido para baixo imprime devagar; medido para cima
     * devolve o descarte de linha.
     */
    var lastSendBytesPerSecond: Int? = null
        private set

    /**
     * Envia uma sonda da homologação — e **recusa quando os bytes não falam a língua do alvo**.
     *
     * **A pergunta mudou em 26/08/2026, e a antiga acertava por acaso.** Até então o portão olhava
     * só o alvo: "esta impressora fala ESC/POS?". Com uma série de sondas só, isso bastava — todo
     * byte de homologação era ESC/POS, então recusar o alvo era recusar os bytes. Com duas séries a
     * pergunta certa é outra: **estes bytes falam a língua desta impressora?** A anterior teria
     * recusado a série Procomp pelo mesmo portão que existe para protegê-la, e deixaria a série
     * ESC/POS alcançar uma IM453H se alguém trocasse o portão de lugar.
     *
     * O que a recusa continua evitando é o que a bobina de 24/08/2026 pagou: numa firmware sem
     * **nenhum** comando `GS`, a régua raster do passo de geometria sai como dois metros de código e
     * o aparelho para de responder até desligar e ligar. Não é papel: é a impressora parada até
     * alguém ir fisicamente até ela.
     *
     * O outro `send`, o de bytes crus, **não** passa por esta recusa de propósito: ele existe para
     * as sondas de bancada, que são montadas no dialeto certo por quem as escreve.
     */
    suspend fun send(probe: PrinterProbe): ThermalPrintResult =
        if (probe.dialect != target.dialect) {
            ThermalPrintResult.Failed(
                message =
                    "Esta sonda foi montada em outro dialeto e não sai para esta impressora. " +
                        "Nada foi enviado a ela.",
                state = ThermalPrinterState.DialectNotSupported,
                delivery = ThermalPrintDelivery.NOT_SENT,
            )
        } else {
            send(probe.bytes())
        }

    suspend fun send(bytes: ByteArray): ThermalPrintResult =
        mutex.withLock {
            check(state == PrinterProbeSessionState.READY) { "Sessão de sonda não está pronta." }
            state = PrinterProbeSessionState.SENDING
            val copy = bytes.copyOf()
            val size = copy.size
            val startedAt = nowMicros()
            lastSendBytesPerSecond = null
            try {
                sender(copy).also { result ->
                    val elapsed = nowMicros() - startedAt
                    if (result == ThermalPrintResult.Printed && elapsed > 0 && size > 0) {
                        lastSendBytesPerSecond =
                            (size.toLong() * MICROS_PER_SECOND / elapsed)
                                .coerceAtMost(Int.MAX_VALUE.toLong())
                                .toInt()
                    }
                }
            } finally {
                copy.fill(0)
                if (state != PrinterProbeSessionState.CLOSED) state = PrinterProbeSessionState.READY
            }
        }

    private companion object {
        const val MICROS_PER_SECOND = 1_000_000L
    }

    override fun close() {
        state = PrinterProbeSessionState.CLOSED
    }
}

enum class PrinterHomologationFlowPhase {
    MEASURING,
    FINAL_RECEIPT_READY,
    SENDING_FINAL_RECEIPT,
    AWAITING_FINAL_CONFIRMATION,
    ADOPTING,
    FAILED,
    FINISHED,
}

enum class PrinterHomologationFailurePoint {
    PROBE,
    FINAL_RECEIPT,
    ADOPTION,
}

data class PrinterHomologationFlowFailure(
    val point: PrinterHomologationFailurePoint,
    val message: String,
    val delivery: ThermalPrintDelivery,
)

data class PrinterHomologationFlowState(
    val machineState: PrinterHomologationState,
    val phase: PrinterHomologationFlowPhase,
    /**
     * A geometria escolhida faz parte do estado publicado, e não só da máquina.
     *
     * Sem ela aqui, trocar 58 por 80 produzia um estado **igual** ao anterior, o `StateFlow`
     * descartava a emissão e a tela nunca redesenhava: o papel mudava por baixo e o botão
     * continuava marcando 58 mm. Visto na bancada, ao tentar medir a GoldenSky de 80 mm.
     */
    val geometry: PrinterGeometry = MeasuredProfile.geometryDefaults(58),
    val path: PrinterHomologationPath = PrinterHomologationPath.SHORT,
    val cutStage: PrinterCutProbeStage = PrinterCutProbeStage.ASKING_PRESENCE,
    val cutProbeProtocol: CutProtocol? = null,
    val successfulCutProtocols: List<CutProtocol> = emptyList(),
    val attemptedCutProtocols: List<CutProtocol> = emptyList(),
    val cutMeasurementFailed: Boolean = false,
    val cutProtocol: CutProtocol = CutProtocol.NONE,
    val cutFeedChoices: List<Int> = listOf(0),
    val requiresCutFeedBenchConfirmation: Boolean = false,
    /** Vazão que a tira de vazão mediu no transporte; `null` enquanto ela não saiu. */
    val measuredRasterBytesPerSecond: Int? = null,
    /**
     * Fator que a régua produziu, e que o perfil vai gravar. `null` é o raster de sempre.
     *
     * Era o teto de vazão até 20/08. A tira e a pergunta continuam as mesmas; a conclusão mudou
     * porque a bancada mediu e refutou a hipótese de vazão.
     */
    val verticalRasterScale: Double? = null,
    /**
     * O que a tira de código nativo mediu, ou `null` enquanto ninguém respondeu.
     *
     * São dois campos porque `GS ( k` e `GS k` são dois comandos, e uma firmware pode honrar um e
     * não o outro. `null` é "ninguém perguntou", e a tela precisa dessa distinção para dizer
     * "remedir" em vez de "a impressora não sabe".
     */
    val nativeQrHonored: Boolean? = null,
    val nativeBarcodeHonored: Boolean? = null,
    /** Habilita o "Voltar" da etapa: há decisão anterior, e nada em voo para atrapalhar. */
    val canGoBack: Boolean = false,
    /** Etapa que o "Voltar" reabre, para a tela dizer para onde o toque leva. */
    val previousStep: PrinterHomologationStep? = null,
    /** Avisa antes do toque que refazer a etapa reaberta manda tiras ao papel de novo. */
    val backReprintsProbes: Boolean = false,
    val failure: PrinterHomologationFlowFailure? = null,
    val measuredProfile: MeasuredProfile? = null,
    /** Falha tardia exige inspeção do papel; nunca autoriza repetição automática. */
    val finalReceiptWarning: String? = null,
    /** Resultado saneado de `GS I`; `null` também é resultado normal após [identityReadCompleted]. */
    val declaredIdentity: PrinterDeclaredIdentity? = null,
    val identityReadCompleted: Boolean = false,
) {
    init {
        require((phase == PrinterHomologationFlowPhase.FAILED) == (failure != null)) {
            "Falha do fluxo de homologação inconsistente."
        }
        require(
            phase in setOf(
                PrinterHomologationFlowPhase.MEASURING,
                PrinterHomologationFlowPhase.FAILED,
            ) || measuredProfile != null,
        ) {
            "Comprovante final sem perfil medido."
        }
        require(
            finalReceiptWarning == null ||
                phase == PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
        ) {
            "Aviso de entrega final fora da confirmação humana."
        }
    }
}

/**
 * Orquestrador público que fecha o gate de adoção no core.
 *
 * Não expõe relógio, endpoint ou identificador técnico. [confirmFinalReceipt] é a única operação
 * que alcança a persistência, e só fica válida após o callback real de [sendFinalReceipt].
 */
class PrinterHomologationFlow internal constructor(
    val target: PrinterHomologationTarget,
    private val probeSession: PrinterProbeSession,
    private val store: PrinterProfileStore,
    private val adopter: suspend (MeasuredProfile) -> Unit,
    private val nowEpochMillis: () -> Long = System::currentTimeMillis,
) : AutoCloseable {
    private var machine = PrinterHomologationMachine(target.paperWidthMm, target.dialect)
    private var measuredProfile: MeasuredProfile? = null
    private var phase = PrinterHomologationFlowPhase.MEASURING
    private var failure: PrinterHomologationFlowFailure? = null
    private var finalReceiptWarning: String? = null
    private var declaredIdentity: PrinterDeclaredIdentity? = null
    private var identityReadCompleted = false
    private val mutableState = MutableStateFlow(snapshot())
    private val adoptionMutex = Mutex()

    val state: StateFlow<PrinterHomologationFlowState> = mutableState.asStateFlow()

    val currentGeometry: PrinterGeometry
        get() = machine.currentGeometry

    val currentCutProtocol: CutProtocol
        get() = machine.currentCutProtocol

    val currentPath: PrinterHomologationPath
        get() = machine.currentPath

    val currentCutStage: PrinterCutProbeStage
        get() = machine.currentCutStage

    val currentCutProbeProtocol: CutProtocol?
        get() = machine.currentCutProbeProtocol

    val successfulAdvancedCutProtocols: List<CutProtocol>
        get() = machine.successfulAdvancedCutProtocols

    val didFailToMeasureCut: Boolean
        get() = machine.didFailToMeasureCut

    val currentCutFeedChoices: List<Int>
        get() = machine.currentCutFeedChoices

    val requiresCutFeedBenchConfirmation: Boolean
        get() = machine.requiresCutFeedBenchConfirmation

    /**
     * O retrocesso vale enquanto a instalação não foi confirmada.
     *
     * Medir e conferir o comprovante final são a mesma decisão vista de dois lados: a letra de
     * acento escolhida na tira só se prova no comprovante, e quem lê ali que escolheu errado
     * precisa poder corrigir **antes** de responder "saiu certo". Depois da confirmação não volta —
     * instalação concluída é concluída, e o perfil já está no disco. Envio no ar e falha pendente
     * continuam de fora: primeiro se decide sobre o papel que talvez tenha saído.
     */
    val canGoBack: Boolean
        get() = phase in BACKTRACKABLE_PHASES && machine.canGoBack

    val previousStep: PrinterHomologationStep?
        get() = machine.previousStep

    val backReprintsProbes: Boolean
        get() = machine.backReprintsProbes

    /**
     * Desfaz uma decisão da medição, na máquina, sem mandar byte nenhum.
     *
     * A reimpressão das tiras da etapa reaberta acontece quando a pessoa avançar por ela de novo,
     * pelo caminho normal — voltar nunca imprime sozinho.
     *
     * Voltar do comprovante final descarta o rascunho junto: ele foi montado a partir da resposta
     * que está sendo desfeita, e mantê-lo faria a próxima passagem por DONE reaproveitar o perfil
     * antigo — [prepareFinalReceiptIfDone] só monta quando não há um. Nada foi persistido até aqui,
     * então não há o que desfazer no disco.
     */
    fun goBack() {
        check(canGoBack) { "Não há etapa anterior para reabrir." }
        machine.goBack()
        measuredProfile = null
        phase = PrinterHomologationFlowPhase.MEASURING
        failure = null
        finalReceiptWarning = null
        publish()
    }

    fun choosePaperWidth(paperWidthMm: Int) {
        requireMeasuring()
        machine.choosePaperWidth(paperWidthMm)
        publish()
    }

    fun choosePaperWidthFromPrintedRulers(paperWidthMm: Int) {
        requireMeasuring()
        machine.choosePaperWidthFromPrintedRulers(paperWidthMm)
        publish()
    }

    fun chooseNoPaperWidthFromPrintedRulers() {
        requireMeasuring()
        machine.chooseNoPaperWidthFromPrintedRulers()
        publish()
    }

    fun acceptDefaultGeometry() {
        requireMeasuring()
        machine.acceptDefaultGeometry()
        publish()
    }

    fun startAdvancedPath() {
        requireMeasuring()
        machine.startAdvancedPath()
        publish()
    }

    suspend fun sendCurrentProbe(): ThermalPrintResult {
        requireMeasuring()
        val probe = machine.beginSending()
        publish()
        val result = sendSafely(probe)
        // A vazão vem do transporte, do envio que acabou de terminar. A máquina não tem relógio e
        // não inventa número nenhum: ela recebe o que foi medido, ou `null`.
        machine.finishSending(result, probeSession.lastSendBytesPerSecond)
        if (result is ThermalPrintResult.Failed) {
            phase = PrinterHomologationFlowPhase.FAILED
            failure =
                PrinterHomologationFlowFailure(
                    point = PrinterHomologationFailurePoint.PROBE,
                    message = result.message,
                    delivery = result.delivery,
                )
        }
        publish()
        return result
    }

    suspend fun sendPaperWidthRulers(): ThermalPrintResult {
        requireMeasuring()
        val probe = machine.beginPaperWidthRulers()
        publish()
        val result = sendSafely(probe)
        machine.finishSending(result)
        if (result is ThermalPrintResult.Failed) phase = PrinterHomologationFlowPhase.FAILED
        publish()
        return result
    }

    fun retryProbe() {
        check(
            phase == PrinterHomologationFlowPhase.FAILED &&
                failure?.point == PrinterHomologationFailurePoint.PROBE,
        ) {
            "Não há falha de sonda aguardando nova tentativa."
        }
        machine.retry()
        phase = PrinterHomologationFlowPhase.MEASURING
        failure = null
        publish()
    }

    /**
     * Imprime todos os dialetos de corte, um payload por vez, e só então abre a escolha.
     *
     * Cada comando continua sozinho no seu envio — é isso que faz uma falha identificar qual
     * dialeto quebrou —, mas não há mais pergunta entre as tiras: quem escolhe precisa das tiras
     * lado a lado. Uma falha interrompe a série e nada avança sozinho.
     */
    suspend fun sendAllCutProbes(): ThermalPrintResult {
        requireMeasuring()
        var result: ThermalPrintResult = ThermalPrintResult.Printed
        while (machine.state.step == PrinterHomologationStep.CUT_PROTOCOL &&
            machine.currentCutStage == PrinterCutProbeStage.PROBING &&
            machine.state.phase == PrinterHomologationPhase.READY
        ) {
            result = sendCurrentProbe()
            if (result is ThermalPrintResult.Failed) return result
            machine.advanceCutProbe()
            publish()
        }
        return result
    }

    fun skipCutFeedMeasurement() {
        requireMeasuring()
        machine.skipCutFeedMeasurement()
        prepareFinalReceiptIfDone()
        publish()
    }

    suspend fun confirmCutFeedBenchAndSend(): ThermalPrintResult {
        requireMeasuring()
        machine.confirmCutFeedBenchReady()
        publish()
        return sendCurrentProbe()
    }

    fun answer(answer: PrinterHomologationAnswer) {
        requireMeasuring()
        machine.answer(answer)
        prepareFinalReceiptIfDone()
        publish()
    }

    /** "Usar padrão": sem régua, sem medida e sem fator — o raster de hoje, sem regressão. */
    fun skipRasterThroughputMeasurement() {
        requireMeasuring()
        machine.skipRasterThroughputMeasurement()
        prepareFinalReceiptIfDone()
        publish()
    }

    /** "Não consigo dizer": a tira saiu, ninguém soube ler, e o perfil fica sem as duas respostas. */
    fun skipNativeCodeMeasurement() {
        requireMeasuring()
        machine.skipNativeCodeMeasurement()
        prepareFinalReceiptIfDone()
        publish()
    }

    /** "Saiu do tamanho certo": a leitura nominal da tira, sem régua na mão. */
    fun answerRasterThroughputPrintedInFull() {
        requireMeasuring()
        machine.answerRasterThroughputPrintedInFull()
        prepareFinalReceiptIfDone()
        publish()
    }

    fun acceptAutomaticCutFeed() {
        requireMeasuring()
        machine.acceptAutomaticCutFeed()
        prepareFinalReceiptIfDone()
        publish()
    }

    fun answerCutterPresence(presence: PrinterCutterPresence) {
        requireMeasuring()
        machine.answerCutterPresence(presence)
        prepareFinalReceiptIfDone()
        publish()
    }

    fun chooseCutProtocol(protocol: CutProtocol) {
        requireMeasuring()
        machine.chooseCutProtocol(protocol)
        prepareFinalReceiptIfDone()
        publish()
    }

    suspend fun sendFinalReceipt(): ThermalPrintResult {
        check(phase == PrinterHomologationFlowPhase.FINAL_RECEIPT_READY) {
            "O comprovante final não está pronto para envio."
        }
        requireNotNull(measuredProfile) { "O perfil medido não existe." }
        phase = PrinterHomologationFlowPhase.SENDING_FINAL_RECEIPT
        failure = null
        finalReceiptWarning = null
        publish()
        readIdentityOnce()
        val finalProfile = requireNotNull(measuredProfile)
        val result =
            sendSafely(
                printerHomologationProbeSet(target.dialect).finalReceipt(
                    finalProfile,
                    declaredIdentity,
                    target.transport,
                    // O comprovante final é a assinatura da instalação concluída, e sai carimbado
                    // como qualquer cupom do app. As sondas acima, não: elas medem.
                    target.receiptDecoration,
                ),
            )
        when (result) {
            ThermalPrintResult.Printed -> {
                phase = PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION
                failure = null
                finalReceiptWarning = null
            }
            is ThermalPrintResult.Failed -> {
                if (result.delivery == ThermalPrintDelivery.INDETERMINATE) {
                    phase = PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION
                    failure = null
                    finalReceiptWarning = FINAL_RECEIPT_INDETERMINATE_WARNING
                } else {
                    phase = PrinterHomologationFlowPhase.FAILED
                    failure =
                        PrinterHomologationFlowFailure(
                            point = PrinterHomologationFailurePoint.FINAL_RECEIPT,
                            message = result.message,
                            delivery = result.delivery,
                        )
                    finalReceiptWarning = null
                }
            }
        }
        publish()
        return result
    }

    /** Falha final nunca reenvia sozinha; esta ação apenas volta ao estado pronto. */
    fun retryFinalReceipt() {
        check(
            phase == PrinterHomologationFlowPhase.FAILED &&
                failure?.point == PrinterHomologationFailurePoint.FINAL_RECEIPT,
        ) {
            "Não há falha final aguardando nova tentativa."
        }
        phase = PrinterHomologationFlowPhase.FINAL_RECEIPT_READY
        failure = null
        finalReceiptWarning = null
        publish()
    }

    /** “Saiu com problema” invalida o rascunho sem persistir e reinicia a medição. */
    fun restartAfterFinalProblem() {
        check(phase == PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION) {
            "O comprovante final não aguarda resposta."
        }
        // **O dialeto vem junto, e esquecê-lo aqui seria pior que na abertura.** Uma máquina nova
        // sem ele volta para a série ESC/POS, e quem chega a este ponto é justamente quem já viu um
        // comprovante sair errado — a próxima tira mandaria `GS v 0` para a impressora que trava
        // com ele, no momento em que a pessoa está tentando consertar.
        machine = PrinterHomologationMachine(machine.currentGeometry.paperWidthMm, target.dialect)
        measuredProfile = null
        phase = PrinterHomologationFlowPhase.MEASURING
        failure = null
        finalReceiptWarning = null
        publish()
    }

    /** “Não saiu” autoriza preparar, mas não iniciar, um novo envio final. */
    fun prepareFinalReceiptRetryAfterNotPrinted() {
        check(phase == PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION) {
            "O comprovante final não aguarda resposta."
        }
        phase = PrinterHomologationFlowPhase.FINAL_RECEIPT_READY
        failure = null
        finalReceiptWarning = null
        publish()
    }

    /** O perfil que será adotado, para a tela mostrar e os testes conferirem antes da gravação. */
    fun previewFinalProfile(): MeasuredProfile =
        requireNotNull(measuredProfile) { "O perfil medido não existe." }

    /**
     * Troca somente o nome local do perfil preparado antes da adoção.
     *
     * Nomear no fim é deliberado: é quando a pessoa acabou de ver o comprovante sair daquela
     * impressora. Nome vazio mantém o anterior, e reconstruir por [MeasuredProfile.copy] preserva
     * a validação que recusa endpoint e identificador técnico.
     */
    fun renameFinalProfile(name: String) {
        check(
            phase == PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION ||
                (phase == PrinterHomologationFlowPhase.FAILED &&
                    failure?.point == PrinterHomologationFailurePoint.ADOPTION),
        ) {
            "A renomeação exige a confirmação humana do comprovante final."
        }
        val cleanedName = name.trim()
        if (cleanedName.isEmpty()) return
        measuredProfile = previewFinalProfile().copy(displayName = cleanedName)
        publish()
    }

    suspend fun confirmFinalReceipt() =
        adoptionMutex.withLock {
            check(
                phase == PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION ||
                    (phase == PrinterHomologationFlowPhase.FAILED &&
                        failure?.point == PrinterHomologationFailurePoint.ADOPTION),
            ) {
                "A adoção exige o callback e a confirmação humana do comprovante final."
            }
            val profile = requireNotNull(measuredProfile) { "O perfil medido não existe." }
            val warningBeforeAdoption = finalReceiptWarning
            phase = PrinterHomologationFlowPhase.ADOPTING
            failure = null
            finalReceiptWarning = null
            publish()
            try {
                persistAndAdopt(profile)
                phase = PrinterHomologationFlowPhase.FINISHED
                failure = null
                publish()
            } catch (error: CancellationException) {
                phase = PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION
                failure = null
                finalReceiptWarning = warningBeforeAdoption
                publish()
                throw error
            } catch (_: Throwable) {
                phase = PrinterHomologationFlowPhase.FAILED
                failure =
                    PrinterHomologationFlowFailure(
                        point = PrinterHomologationFailurePoint.ADOPTION,
                        message = "Não foi possível salvar e selecionar o perfil medido.",
                        delivery = ThermalPrintDelivery.NOT_SENT,
                    )
                publish()
            }
        }

    override fun close() = probeSession.close()

    private fun prepareFinalReceiptIfDone() {
        if (machine.state.step != PrinterHomologationStep.DONE || measuredProfile != null) return
        measuredProfile =
            machine.buildMeasuredProfile(
                displayName = target.displayName,
                transports = setOf(target.transport),
                measuredAtEpochMillis = nowEpochMillis().coerceAtLeast(1),
            )
        phase = PrinterHomologationFlowPhase.FINAL_RECEIPT_READY
        failure = null
        finalReceiptWarning = null
    }

    /** Silêncio e lixo não são falha da homologação e a tentativa não se repete no retry final. */
    private suspend fun readIdentityOnce() {
        if (identityReadCompleted) return
        declaredIdentity =
            try {
                target.readIdentity()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                null
            }
        identityReadCompleted = true
        val identity = declaredIdentity
        if (identity != null) {
            val current = requireNotNull(measuredProfile)
            val named = identity.displayNameOr(current.displayName)
            measuredProfile =
                runCatching {
                    current.copy(
                        displayName = named,
                        firmwareVersion = identity.firmwareVersion,
                    )
                }.getOrElse {
                    // Modelo que se pareça com identificador técnico não usa displayName como
                    // atalho; ainda é seguro preservar somente o firmware saneado.
                    current.copy(firmwareVersion = identity.firmwareVersion)
                }
        }
        publish()
    }

    /** A única rota de persistência do core; chamada somente pelo gate de confirmação acima. */
    private suspend fun persistAndAdopt(profile: MeasuredProfile) {
        require(profile.source == PrinterProfileSource.MEASURED) {
            "Somente medição concluída pode ser adotada."
        }
        require(profile.supports(target.transport)) {
            "O perfil medido não aceita o transporte da sessão."
        }
        val previous = store.read().firstOrNull { it.id == profile.id }
        try {
            store.save(profile)
            check(
                store.read().any { persisted -> persisted == profile },
            ) {
                "O store não confirmou o perfil medido."
            }
            adopter(profile)
        } catch (error: CancellationException) {
            rollbackProfile(profile.id, previous, error)
            throw error
        } catch (error: Throwable) {
            rollbackProfile(profile.id, previous, error)
            throw error
        }
    }

    private fun rollbackProfile(
        profileId: String,
        previous: MeasuredProfile?,
        original: Throwable,
    ) {
        try {
            if (previous == null) store.remove(profileId) else store.save(previous)
        } catch (rollback: Throwable) {
            original.addSuppressed(rollback)
        }
    }

    private fun requireMeasuring() {
        check(phase == PrinterHomologationFlowPhase.MEASURING) {
            "O fluxo não está medindo capacidades."
        }
    }

    private suspend fun sendSafely(probe: PrinterProbe): ThermalPrintResult =
        try {
            probeSession.send(probe)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            val message = "Não foi possível concluir o envio da sonda."
            ThermalPrintResult.Failed(
                message = message,
                state = ThermalPrinterState.Failed(message),
                delivery = ThermalPrintDelivery.NOT_SENT,
            )
        }

    private fun publish() {
        mutableState.value = snapshot()
    }

    private fun snapshot(): PrinterHomologationFlowState =
        PrinterHomologationFlowState(
            machineState = machine.state,
            phase = phase,
            geometry = machine.currentGeometry,
            path = machine.currentPath,
            cutStage = machine.currentCutStage,
            cutProbeProtocol = machine.currentCutProbeProtocol,
            successfulCutProtocols = machine.successfulAdvancedCutProtocols,
            attemptedCutProtocols = machine.attemptedCutProtocols,
            cutMeasurementFailed = machine.didFailToMeasureCut,
            cutProtocol = machine.currentCutProtocol,
            cutFeedChoices = machine.currentCutFeedChoices,
            requiresCutFeedBenchConfirmation = machine.requiresCutFeedBenchConfirmation,
            measuredRasterBytesPerSecond = machine.currentMeasuredRasterBytesPerSecond,
            verticalRasterScale = machine.currentVerticalRasterScale,
            nativeQrHonored = machine.currentNativeQrHonored,
            nativeBarcodeHonored = machine.currentNativeBarcodeHonored,
            canGoBack = canGoBack,
            previousStep = machine.previousStep,
            backReprintsProbes = machine.backReprintsProbes,
            failure = failure,
            measuredProfile = measuredProfile,
            finalReceiptWarning = finalReceiptWarning,
            declaredIdentity = declaredIdentity,
            identityReadCompleted = identityReadCompleted,
        )

    private companion object {
        /**
         * Fases em que o retrocesso ainda é possível: a medição aberta e as duas do comprovante
         * final anteriores à confirmação humana. `SENDING_FINAL_RECEIPT`, `ADOPTING`, `FAILED` e
         * `FINISHED` ficam de fora — há bytes no ar, gravação em curso, decisão pendente sobre
         * papel, ou instalação concluída.
         */
        val BACKTRACKABLE_PHASES =
            setOf(
                PrinterHomologationFlowPhase.MEASURING,
                PrinterHomologationFlowPhase.FINAL_RECEIPT_READY,
                PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
            )

        const val FINAL_RECEIPT_INDETERMINATE_WARNING =
            "O envio pode ter chegado ao papel. Confira a impressora antes de decidir; não reenvie sem inspeção humana."
    }
}

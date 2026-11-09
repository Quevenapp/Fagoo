package br.com.thermalprinterkit

enum class PrinterHomologationStep {
    WIDTH,
    GEOMETRY,
    /**
     * Mede quanto raster esta impressora aguenta receber por segundo.
     *
     * Vem **depois** da geometria porque a tira precisa da largura imprimível medida: o defeito só
     * aparece em largura cheia, e uma tira mais estreita mediria outra impressora. Vem **antes** do
     * corte porque não depende de guilhotina nenhuma e porque uma tira que não corta é entregue
     * pela serrilha, como as outras sondas antes do corte medido.
     */
    RASTER_THROUGHPUT,
    /**
     * Mede se a firmware desenha o QR e o código de barras quando o comando nativo pede.
     *
     * Vem **depois** da vazão pela mesma dependência que põe a vazão depois da geometria: a largura
     * de módulo sai da área imprimível medida, e um símbolo mais largo que o papel sai truncado —
     * truncamento é indistinguível de "a firmware não entendeu", que é justamente o que esta etapa
     * existe para distinguir. Vem **antes** do corte porque não depende de guilhotina nenhuma, e a
     * tira é entregue pela serrilha como as outras sondas anteriores ao corte medido. Não pode vir
     * depois de `CODE_PAGE`, que conclui a máquina.
     */
    NATIVE_CODE,
    CUT_PROTOCOL,
    CUT_FEED,
    /**
     * Mede modelo de codificação e página na mesma tira.
     *
     * A etapa `TEXT_ENCODING` saiu em 12/08. Ela perguntava "byte único, UTF-8 ou sem acentos?"
     * antes desta, e a pergunta não é respondível com o papel na mão: quem está na frente da
     * impressora sabe qual linha saiu legível, não qual modelo de codificação quer. Os três
     * viraram as três primeiras linhas desta tira.
     */
    CODE_PAGE,
    DONE,
}

enum class PrinterHomologationPath {
    SHORT,
    ADVANCED,
}

enum class PrinterCutterPresence {
    YES,
    NO,
    UNKNOWN,
}

enum class PrinterCutProbeStage {
    ASKING_PRESENCE,
    PROBING,
    SELECTING_ADVANCED_RESULT,
}

enum class PrinterHomologationPhase {
    READY,
    SENDING,
    AWAITING_RESPONSE,
    FAILED,
    DONE,
}

data class PrinterHomologationFailure(
    val message: String,
    val delivery: ThermalPrintDelivery,
)

data class PrinterHomologationState(
    val step: PrinterHomologationStep,
    val phase: PrinterHomologationPhase,
    val failure: PrinterHomologationFailure? = null,
) {
    init {
        require((phase == PrinterHomologationPhase.FAILED) == (failure != null)) {
            "Falha de homologação inconsistente."
        }
        require((step == PrinterHomologationStep.DONE) == (phase == PrinterHomologationPhase.DONE)) {
            "Conclusão de homologação inconsistente."
        }
    }
}

sealed interface PrinterHomologationAnswer {
    data class Geometry(
        val paperWidthMm: Int,
        val printableColumns: Int,
        val printableDots: Int,
    ) : PrinterHomologationAnswer

    /** Letra da primeira linha certa na tira única; `null` quando nenhuma candidata serviu. */
    data class CodePage(val letter: Char?) : PrinterHomologationAnswer

    /**
     * [deliveredMode] é o que **saiu no papel**, não o que o comando pede.
     *
     * A GoldenSky obedeceu aos sete comandos e cortou sempre parcial, inclusive nos que pedem
     * total. Sem esta segunda pergunta o perfil registraria "corte total" numa impressora que
     * nunca solta a tira. `null` quando não houve corte.
     */
    data class Cut(
        val protocol: CutProtocol,
        val deliveredMode: CutMode? = null,
    ) : PrinterHomologationAnswer

    data class CutFeed(val lines: Int) : PrinterHomologationAnswer

    /**
     * Quantos milímetros a tira de vazão mediu na régua — a leitura, não a conclusão.
     *
     * É a mesma pergunta das etapas de geometria: quem está na frente da impressora responde o que
     * viu no papel. A conta que decide se existe teto, e qual, é da máquina.
     */
    data class RasterThroughput(val printedLengthMm: Int) : PrinterHomologationAnswer

    /**
     * O que saiu em cada um dos dois blocos da tira de código nativo.
     *
     * **Dois campos, e não um.** `GS ( k` e `GS k` são comandos diferentes, de gerações diferentes,
     * e nada obriga uma firmware a atender os dois: o `GS k` é ESC/POS de 1992 e está em quase toda
     * portátil, o `GS ( k` é da geração 2D e falta em muitas das mesmas portáteis. Um campo só
     * teria de resolver o conflito, e as duas formas são ruins — com "E" lógico uma impressora que
     * desenha barras perfeitamente perderia o recurso por causa do QR; com "OU" o app ofereceria QR
     * nativo numa firmware que só provou o `GS k`.
     *
     * `true` é "saiu figura"; `false` é "saiu texto, ou não saiu nada" — as duas significam a mesma
     * coisa para o perfil, que o comando não produziu código. Quem não consegue dizer não responde
     * esta sonda: usa [PrinterHomologationMachine.skipNativeCodeMeasurement], que grava a ausência.
     */
    data class NativeCode(
        val qrHonored: Boolean,
        val barcodeHonored: Boolean,
    ) : PrinterHomologationAnswer
}

/**
 * Máquina de homologação sem UI, transporte ou cronômetro.
 *
 * Resultado sobre papel só é aceito após [finishSending] confirmar que o envio acabou. A pergunta
 * prévia sobre a existência de guilhotina não responde uma sonda nem vira perfil. Falhas ficam
 * paradas até [retry] explícito; a máquina nunca repete uma sonda por conta própria.
 */
class PrinterHomologationMachine(
    initialPaperWidthMm: Int = 58,
    /**
     * O idioma do alvo, e o que decide **qual série de tiras** esta medição envia.
     *
     * Nasce ESC/POS para que toda homologação já existente continue byte a byte igual. Quem o passa
     * é [PrinterHomologationFlow], a partir do dialeto da candidata — porque só ele sabe qual
     * impressora está do outro lado do fio. Ver [PrinterHomologationProbeSet].
     */
    private val dialect: EscPosDialect = EscPosDialect.EPSON_COMPATIBLE,
) {
    private val probes = printerHomologationProbeSet(dialect)

    private var geometry = MeasuredProfile.geometryDefaults(initialPaperWidthMm)
    private var textEncoding: ThermalTextEncoding = ThermalTextEncoding.ASCII
    private var codePage: ThermalCodePage? = null
    private var codePageSelector: Int? = null
    private var cutModeHonored: Boolean = false
    private var cutProtocol: CutProtocol = CutProtocol.NONE
    private var cutFeedLines: Int = 0
    private var cutFeedBenchReady = false
    private var path = PrinterHomologationPath.SHORT
    private var cutProbeCandidates = emptyList<CutProtocol>()
    private var cutProbeIndex = 0
    private val successfulCutProtocols = mutableListOf<CutProtocol>()
    private var cutStage = PrinterCutProbeStage.ASKING_PRESENCE
    private var cutMeasurementFailed = false
    private var classifyWidthFromFullRuler = false

    /**
     * Vazão real do último envio da tira de vazão, em bytes por segundo, ou `null` se não deu para
     * medir. Chega por [finishSending]: quem cronometra é o transporte, nunca esta máquina.
     */
    private var measuredRasterBytesPerSecond: Int? = null

    /**
     * Fator que a régua da tira produziu, ou `null` quando não há o que compensar.
     *
     * Foi `maxRasterBytesPerSecond` até 20/08. A tira e a pergunta continuam as mesmas; o que
     * mudou é a conclusão, porque a hipótese de vazão foi medida e refutada. Ver
     * [answerRasterThroughput].
     */
    private var verticalRasterScale: Double? = null

    /**
     * O que a tira de código nativo mediu, ou `null` enquanto ninguém respondeu.
     *
     * `null` não é "não": é "ninguém perguntou". A distinção existe porque Ajustes precisa mandar
     * remedir em vez de dizer que a impressora não sabe — e porque um `false` por padrão ficaria
     * indistinguível de uma medição negativa no comprovante, que é a informação que o comprovante
     * existe para carregar.
     */
    private var nativeQrHonored: Boolean? = null
    private var nativeBarcodeHonored: Boolean? = null

    var state: PrinterHomologationState =
        PrinterHomologationState(
            step = PrinterHomologationStep.WIDTH,
            phase = PrinterHomologationPhase.READY,
        )
        private set

    /**
     * Fotografias das etapas já respondidas, da primeira até a que está aberta agora.
     *
     * Cada uma é a máquina inteira no instante em que aquela etapa abriu, antes da resposta dela.
     * [goBack] restaura a última: o que foi medido de lá para frente some, porque foi medido contra
     * a premissa que está sendo corrigida, e o que veio antes fica intacto. O retrocesso mora aqui,
     * e não na tela, porque estado paralelo na interface seria uma segunda verdade sobre o que a
     * impressora já disse no papel.
     */
    private val previousSteps = mutableListOf<StepEntry>()
    private var stepEntry = captureStepEntry()

    val currentGeometry: PrinterGeometry
        get() = geometry

    val currentCutProtocol: CutProtocol
        get() = cutProtocol

    val currentPath: PrinterHomologationPath
        get() = path

    val currentCutStage: PrinterCutProbeStage
        get() = cutStage

    val currentCutProbeProtocol: CutProtocol?
        get() = cutProbeCandidates.getOrNull(cutProbeIndex)

    /** Dialetos que a pessoa marcou como bons depois de ver as tiras. */
    val successfulAdvancedCutProtocols: List<CutProtocol>
        get() = successfulCutProtocols.toList()

    /** Todos os dialetos tentados nesta sonda, na ordem em que saíram no papel. */
    val attemptedCutProtocols: List<CutProtocol>
        get() = cutProbeCandidates.toList()

    val didFailToMeasureCut: Boolean
        get() = cutMeasurementFailed

    /** Vazão medida na tira de vazão, para a tela mostrar o que foi medido em vez de supor. */
    val currentMeasuredRasterBytesPerSecond: Int?
        get() = measuredRasterBytesPerSecond

    /** Fator que a resposta da régua produziu; `null` é o raster de sempre, sem compensação. */
    val currentVerticalRasterScale: Double?
        get() = verticalRasterScale

    /** O que a tira de código nativo mediu para o `GS ( k`; `null` é "ninguém perguntou". */
    val currentNativeQrHonored: Boolean?
        get() = nativeQrHonored

    /** O mesmo para o `GS k`. São dois comandos, e por isso são duas respostas. */
    val currentNativeBarcodeHonored: Boolean?
        get() = nativeBarcodeHonored

    val currentCutFeedChoices: List<Int>
        get() =
            when {
                cutProtocol == CutProtocol.NONE || cutProtocol in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED ->
                    listOf(0)
                // A etapa existe para medir a distância entre a cabeça e a lâmina, e essa distância
                // é física de cada impressora. O caminho curto chegava com 5 pré-escolhido — valor
                // medido na P80 e na Tomate — e pedia confirmação: quem respondesse "não comeu
                // texto" gravava o 5 sem ter medido nada. A régua inteira custa oito tiras e
                // devolve o menor avanço que serve nesta impressora. Decidido em 12/08.
                else -> PrinterHomologationProbes.cutFeedChoices(cutProtocol)
            }

    val requiresCutFeedBenchConfirmation: Boolean
        get() =
            state.step == PrinterHomologationStep.CUT_FEED &&
                state.phase == PrinterHomologationPhase.READY &&
                currentCutFeedChoices.size > 1 &&
                !cutFeedBenchReady

    /** Etapa que [goBack] reabre, ou `null` quando não há decisão anterior para desfazer. */
    val previousStep: PrinterHomologationStep?
        get() = previousSteps.lastOrNull()?.state?.step

    /**
     * Só volta quem tem etapa anterior e não está no meio de um envio nem de uma falha.
     *
     * A primeira etapa não volta porque não há premissa anterior. DONE volta: a medição acabou, mas
     * o comprovante final ainda não foi confirmado, e quem escolheu a letra errada de acento precisa
     * corrigir antes de dizer que o papel saiu certo. Quem decide se a confirmação já foi dada é
     * [PrinterHomologationFlow], que conhece o comprovante; a máquina só sabe que a etapa DONE ainda
     * tem premissa anterior para desfazer. Falha pendente resolve-se primeiro — [retry] ou nova
     * tentativa —, para o retrocesso nunca ser a resposta a uma tira que talvez tenha saído.
     */
    val canGoBack: Boolean
        get() =
            previousSteps.isNotEmpty() &&
                state.phase != PrinterHomologationPhase.SENDING &&
                state.phase != PrinterHomologationPhase.FAILED

    /**
     * Verdadeiro quando avançar de novo pela etapa reaberta manda tiras ao papel outra vez.
     *
     * Voltar sozinho não imprime nada; a reimpressão acontece quando a pessoa refizer a etapa pelo
     * caminho normal dela. Isto existe para a tela poder anunciar o custo antes do toque, e é
     * deliberadamente conservador em CUT_PROTOCOL: responder "Não" ali não gasta papel, mas
     * prometer papel a mais é o erro barato — prometer a menos é o que a regra proíbe.
     */
    val backReprintsProbes: Boolean
        get() = previousSteps.lastOrNull()?.let(::reprintsProbes) ?: false

    /**
     * Desfaz uma decisão: reabre a etapa anterior com as respostas dela em diante já descartadas.
     *
     * Nenhum byte sai daqui. Medido no iPhone 7 em 20/08: quem escolhia 58 mm numa impressora de 80
     * não tinha como corrigir, e a única saída era recomeçar a homologação inteira.
     */
    fun goBack() {
        check(canGoBack) { "Não há etapa anterior para reabrir." }
        restore(previousSteps.removeAt(previousSteps.lastIndex))
    }

    fun acceptDefaultGeometry() {
        check(state.step == PrinterHomologationStep.WIDTH && state.phase == PrinterHomologationPhase.READY) {
            "A largura padrão só pode ser aceita no início da homologação."
        }
        advanceAfterGeometry()
    }

    fun startAdvancedPath() {
        check(state.step == PrinterHomologationStep.WIDTH && state.phase == PrinterHomologationPhase.READY) {
            "O caminho avançado só pode ser escolhido antes da primeira sonda."
        }
        path = PrinterHomologationPath.ADVANCED
        classifyWidthFromFullRuler = false
        enterStep(PrinterHomologationStep.GEOMETRY)
    }

    fun choosePaperWidth(paperWidthMm: Int) {
        check(state.step == PrinterHomologationStep.GEOMETRY) {
            "A largura do papel só muda durante GEOMETRY."
        }
        check(state.phase == PrinterHomologationPhase.READY) {
            "Não é possível trocar a largura durante um envio."
        }
        geometry = MeasuredProfile.geometryDefaults(paperWidthMm)
    }

    fun choosePaperWidthFromPrintedRulers(paperWidthMm: Int) {
        check(state.step == PrinterHomologationStep.WIDTH && state.phase == PrinterHomologationPhase.AWAITING_RESPONSE) {
            "A largura só pode ser escolhida depois que as duas réguas saírem."
        }
        geometry = MeasuredProfile.geometryDefaults(paperWidthMm)
        advanceAfterGeometry()
    }

    fun chooseNoPaperWidthFromPrintedRulers() {
        check(state.step == PrinterHomologationStep.WIDTH && state.phase == PrinterHomologationPhase.AWAITING_RESPONSE) {
            "A régua completa só pode ser escolhida depois que a comparação sair."
        }
        path = PrinterHomologationPath.ADVANCED
        classifyWidthFromFullRuler = true
        geometry = MeasuredProfile.geometryDefaults(80)
        enterStep(PrinterHomologationStep.GEOMETRY)
    }

    fun beginPaperWidthRulers(): PrinterProbe {
        check(state.step == PrinterHomologationStep.WIDTH && state.phase == PrinterHomologationPhase.READY) {
            "As réguas de largura só podem abrir a homologação."
        }
        state = state.copy(phase = PrinterHomologationPhase.SENDING)
        return probes.paperWidthRulers()
    }

    fun beginSending(): PrinterProbe {
        check(state.phase == PrinterHomologationPhase.READY) { "A etapa não está pronta para envio." }
        if (state.step == PrinterHomologationStep.WIDTH) {
            startAdvancedPath()
        }
        if (state.step == PrinterHomologationStep.CUT_FEED && currentCutFeedChoices.size > 1) {
            check(cutFeedBenchReady) {
                "Confirme que a bancada está pronta; poderão sair oito tiras."
            }
            // A confirmação vale para um envio. Falha e retry exigem nova decisão consciente.
            cutFeedBenchReady = false
        }
        val probe =
            when (state.step) {
                PrinterHomologationStep.WIDTH -> error("A largura não imprime sonda.")
                PrinterHomologationStep.GEOMETRY ->
                    probes.fullGeometry()
                PrinterHomologationStep.RASTER_THROUGHPUT ->
                    probes.rasterThroughput(geometry.printableDots)
                // A largura de módulo sai da área imprimível medida: é a dependência que decide a
                // posição desta etapa na sequência.
                PrinterHomologationStep.NATIVE_CODE ->
                    requireNotNull(probes.nativeCode(geometry.printableDots)) {
                        "Esta série não mede código nativo, e a etapa não deveria ter aberto."
                    }
                PrinterHomologationStep.CODE_PAGE ->
                    requireNotNull(probes.codePages(cutProtocol, cutFeedLines)) {
                        "Esta série não mede página, e a etapa não deveria ter aberto."
                    }
                PrinterHomologationStep.CUT_PROTOCOL ->
                    probes.isolatedCut(
                        requireNotNull(currentCutProbeProtocol) {
                            "Escolha sobre guilhotina não imprime sonda."
                        },
                    )
                PrinterHomologationStep.CUT_FEED -> probes.cutFeed(cutProtocol)
                PrinterHomologationStep.DONE -> error("Homologação já concluída.")
            }
        state = state.copy(phase = PrinterHomologationPhase.SENDING)
        return probe
    }

    /**
     * @param measuredBytesPerSecond vazão real do envio que acabou de terminar — bytes entregues ao
     *   transporte divididos pelo tempo que ele levou —, ou `null` quando o chamador não mediu.
     *   Só a etapa de vazão a guarda, e ela nunca é suposta: sem medida não há teto, porque inventar
     *   um número seria a heurística por modelo que este campo existe para não ser.
     */
    fun finishSending(
        result: ThermalPrintResult,
        measuredBytesPerSecond: Int? = null,
    ) {
        check(state.phase == PrinterHomologationPhase.SENDING) { "Nenhum envio está em andamento." }
        if (state.step == PrinterHomologationStep.RASTER_THROUGHPUT) {
            measuredRasterBytesPerSecond =
                measuredBytesPerSecond?.takeIf { result == ThermalPrintResult.Printed && it > 0 }
        }
        state =
            when (result) {
                ThermalPrintResult.Printed ->
                    state.copy(phase = PrinterHomologationPhase.AWAITING_RESPONSE)
                is ThermalPrintResult.Failed ->
                    state.copy(
                        phase = PrinterHomologationPhase.FAILED,
                        failure = PrinterHomologationFailure(result.message, result.delivery),
                    )
            }
    }

    fun retry() {
        check(state.phase == PrinterHomologationPhase.FAILED) { "Não há falha aguardando nova tentativa." }
        state = state.copy(phase = PrinterHomologationPhase.READY, failure = null)
    }

    /**
     * Pula a régua e grava o palpite da bancada, sem fingir que ele foi medido.
     *
     * Oito tiras é o preço da medição, e nem toda hora é hora de pagá-lo. O valor que entra é o
     * mesmo cinco que a P80 e a Tomate mediram — a diferença é que agora ele é uma escolha
     * explícita de quem está na frente da impressora, e não o que a etapa já trazia marcado. O
     * comprovante final imprime o avanço, então o número fica à vista de quem quiser conferir.
     */
    fun skipCutFeedMeasurement() {
        check(
            state.step == PrinterHomologationStep.CUT_FEED &&
                state.phase == PrinterHomologationPhase.READY &&
                currentCutFeedChoices.size > 1,
        ) {
            "Só há o que pular quando a régua de avanço seria impressa."
        }
        cutFeedLines = UNMEASURED_CUT_FEED_LINES
        enterStep(PrinterHomologationStep.CODE_PAGE)
    }

    fun confirmCutFeedBenchReady() {
        check(
            state.step == PrinterHomologationStep.CUT_FEED &&
                state.phase == PrinterHomologationPhase.READY &&
                currentCutFeedChoices.size > 1,
        ) {
            "A confirmação de bancada só pertence à sonda CUT_FEED de oito tiras."
        }
        cutFeedBenchReady = true
    }

    fun answer(answer: PrinterHomologationAnswer) {
        check(state.phase == PrinterHomologationPhase.AWAITING_RESPONSE) {
            "A resposta só é aceita depois que a sonda termina de enviar."
        }
        when (state.step) {
            PrinterHomologationStep.WIDTH -> error("A largura não aceita resposta de sonda.")
            PrinterHomologationStep.GEOMETRY -> answerGeometry(answer)
            PrinterHomologationStep.RASTER_THROUGHPUT -> answerRasterThroughput(answer)
            PrinterHomologationStep.NATIVE_CODE -> answerNativeCode(answer)
            PrinterHomologationStep.CODE_PAGE -> answerCodePage(answer)
            PrinterHomologationStep.CUT_PROTOCOL -> answerCutProtocol(answer)
            PrinterHomologationStep.CUT_FEED -> answerCutFeed(answer)
            PrinterHomologationStep.DONE -> error("Homologação já concluída.")
        }
    }

    /**
     * NONE e `GS V 65/66` não imprimem a sonda de oito tiras. A etapa continua explícita na
     * sequência, mas já aguarda a confirmação do zero medido.
     */
    fun acceptAutomaticCutFeed() {
        check(state.step == PrinterHomologationStep.CUT_FEED) { "A etapa atual não é CUT_FEED." }
        check(state.phase == PrinterHomologationPhase.AWAITING_RESPONSE) {
            "O avanço automático não está aguardando confirmação."
        }
        answer(PrinterHomologationAnswer.CutFeed(0))
    }

    /** Todos os dialetos com comando; a escolha vem depois que todos saíram. */
    val remainingCutProbes: Int
        get() = (cutProbeCandidates.size - cutProbeIndex).coerceAtLeast(0)

    fun answerCutterPresence(presence: PrinterCutterPresence) {
        // Esta decisão gratuita antecede qualquer payload e só escolhe se vale gastar papel. O
        // protocolo persistido continua vindo de uma sonda com callback, ou NONE quando não há
        // guilhotina declarada; a resposta em si nunca entra no perfil.
        check(
            state.step == PrinterHomologationStep.CUT_PROTOCOL &&
                state.phase == PrinterHomologationPhase.READY &&
                cutStage == PrinterCutProbeStage.ASKING_PRESENCE,
        ) {
            "A pergunta de guilhotina não está disponível."
        }
        if (presence == PrinterCutterPresence.NO) {
            finishWithoutCut(measurementFailed = false)
            return
        }
        // Quem decide quantos comandos saem é a série, e o porquê está com ela: a de ESC/POS manda
        // os seis antes de qualquer pergunta — parar no primeiro que corta esconde o que a
        // impressora faz nos outros, e foi assim que a MP-4200 quase passou como "corta parcial e
        // pronto", medido em 12/08 —, e a Procomp manda um só, porque os dois cortes medidos
        // naquela firmware cortam igual e o emissor manda `ESC w` de qualquer jeito.
        cutProbeCandidates = probes.cutCandidates
        cutProbeIndex = 0
        cutStage = PrinterCutProbeStage.PROBING
    }

    /**
     * Registra que a tira do dialeto atual terminou de sair e prepara a próxima.
     *
     * Não há pergunta entre as tiras: o papel é que responde, e ele responde melhor com todos os
     * cortes lado a lado. Depois da última, a etapa fica aguardando a escolha.
     */
    fun advanceCutProbe() {
        check(
            state.step == PrinterHomologationStep.CUT_PROTOCOL &&
                state.phase == PrinterHomologationPhase.AWAITING_RESPONSE &&
                cutStage == PrinterCutProbeStage.PROBING,
        ) {
            "A sonda de corte só avança depois do callback do transporte."
        }
        cutProbeIndex += 1
        if (cutProbeIndex < cutProbeCandidates.size) {
            state = PrinterHomologationState(PrinterHomologationStep.CUT_PROTOCOL, PrinterHomologationPhase.READY)
            return
        }
        cutStage = PrinterCutProbeStage.SELECTING_ADVANCED_RESULT
        state =
            PrinterHomologationState(
                PrinterHomologationStep.CUT_PROTOCOL,
                PrinterHomologationPhase.AWAITING_RESPONSE,
            )
    }

    /**
     * Escolhe o corte à vista das tiras, ou `NONE` quando nenhuma cortou.
     *
     * A lista oferecida é a dos dialetos tentados, não a dos que "deram certo": quem viu o papel
     * sabe qual corte quer, e perguntar tira a tira antes disso era pedir um julgamento sobre uma
     * tira só.
     */
    fun chooseCutProtocol(protocol: CutProtocol) {
        check(
            state.step == PrinterHomologationStep.CUT_PROTOCOL &&
                state.phase == PrinterHomologationPhase.AWAITING_RESPONSE &&
                cutStage == PrinterCutProbeStage.SELECTING_ADVANCED_RESULT,
        ) {
            "A escolha do corte não está disponível."
        }
        require(protocol == CutProtocol.NONE || protocol in cutProbeCandidates) {
            "O protocolo escolhido não foi tentado nesta sonda."
        }
        if (protocol == CutProtocol.NONE) {
            finishWithoutCut(measurementFailed = true)
        } else {
            successfulCutProtocols += protocol
            selectCutProtocol(protocol)
        }
    }

    fun buildMeasuredProfile(
        displayName: String,
        transports: Set<PrinterTransport>,
        measuredAtEpochMillis: Long,
        id: String = java.util.UUID.randomUUID().toString(),
    ): MeasuredProfile {
        check(state == PrinterHomologationState(PrinterHomologationStep.DONE, PrinterHomologationPhase.DONE)) {
            "O perfil só existe depois de DONE."
        }
        return MeasuredProfile.createLocal(
            id = id,
            displayName = displayName,
            transports = transports,
            paperWidthMm = geometry.paperWidthMm,
            printableColumns = geometry.printableColumns,
            printableDots = geometry.printableDots,
            codePage = codePage,
            textEncoding = textEncoding,
            codePageSelector = codePageSelector,
            cutModeHonored = cutModeHonored,
            cutProtocol = cutProtocol,
            cutFeedLines = cutFeedLines,
            measuredAtEpochMillis = measuredAtEpochMillis,
            // **O dialeto atravessa a medição, e até 26/08/2026 ele não atravessava.** Este era o
            // quarto lugar do mesmo defeito que a busca, a largura e a configuração manual já
            // tinham tapado: `createLocal` ganhou o parâmetro em 24/08, e este chamador continuou
            // sem passá-lo — invisível, porque a homologação recusava o único dialeto em que a
            // diferença aparece. Com a série Procomp existindo, homologar a IM453H salvaria um
            // perfil ESC/POS, e o **primeiro cupom depois de salvar** travaria o aparelho, longe
            // da causa. Dialeto não tem padrão razoável; ele tem dono, e o dono é a candidata.
            dialect = dialect,
            // Só a régua desta impressora produz este fator. Perfil homologado antes da sonda
            // continua sem compensação até ser remedido; nada aqui completa a lacuna por conta
            // própria. O teto de vazão não é mais concluído por sonda nenhuma desde 20/08, e por
            // isso nem aparece aqui: perfil novo nasce sem teto.
            verticalRasterScale = verticalRasterScale,
            // Só a tira desta impressora produz estes dois campos. Perfil homologado antes da sonda
            // continua com os dois ausentes até ser remedido, e nada aqui — marca, modelo, firmware
            // ou dialeto — completa a lacuna por conta própria.
            nativeQrHonored = nativeQrHonored,
            nativeBarcodeHonored = nativeBarcodeHonored,
        )
    }

    private fun answerGeometry(answer: PrinterHomologationAnswer) {
        require(answer is PrinterHomologationAnswer.Geometry) { "Resposta incompatível com GEOMETRY." }
        val classifiedWidth =
            if (classifyWidthFromFullRuler) classifyPaperWidth(answer.printableColumns, answer.printableDots)
            else answer.paperWidthMm
        // Constrói um perfil temporário equivalente apenas para reutilizar todas as defesas de QR.
        require(answer.printableDots in 256..640 && answer.printableDots % 32 == 0) {
            "Largura raster não pertence à sonda enviada."
        }
        require(answer.printableColumns in 24..64) { "Largura textual medida inválida." }
        if (!classifyWidthFromFullRuler) {
            val lastPrintedColumn = if (geometry.paperWidthMm == 58) 48 else 64
            require(answer.printableColumns <= lastPrintedColumn) {
                "Largura textual não pertence à sonda enviada."
            }
            require(answer.printableDots in MeasuredProfile.printableDotCandidates(geometry.paperWidthMm)) {
                "Largura raster não pertence à sonda enviada."
            }
        }
        require(
            MeasuredProfile.qrWidthDots(answer.printableColumns, answer.printableDots) >=
                MeasuredProfile.MIN_SAFE_RASTER_QR_DOTS,
        ) {
            "Área imprimível abaixo do mínimo seguro para QR raster."
        }
        geometry = PrinterGeometry(classifiedWidth, answer.printableColumns, answer.printableDots)
        advanceAfterGeometry()
    }

    /**
     * A resposta rápida da tira: "saiu do tamanho certo".
     *
     * É literalmente a leitura nominal, e não um atalho que pula a conta. Existe porque exigir a
     * régua de quem já viu a tira sair inteira é cobrar trabalho para confirmar o caso comum — e
     * porque uma leitura apressada de 46 em vez de 48 mm gravaria compensação numa impressora que
     * não precisa dela, esticando a foto dela em 4%.
     */
    fun answerRasterThroughputPrintedInFull() {
        answer(
            PrinterHomologationAnswer.RasterThroughput(
                PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM,
            ),
        )
    }

    /**
     * Sai da etapa sem medida, e o perfil fica **sem compensação** — o raster de hoje, inteiro.
     *
     * Esta é a única etapa do assistente que pede uma régua **de fora**: as outras se leem na
     * própria tira, comparando o que saiu com o que a tira anuncia. Quem não tem régua na mão não
     * pode ficar preso aqui, e muito menos ser empurrado a chutar um número — um chute vira fator
     * gravado, e fator errado deforma toda imagem daquela impressora.
     *
     * **Nulo é nulo.** Não existe valor "padrão" numérico nem marcador dizendo que alguém pulou: o
     * perfil que sai daqui é indistinguível, campo a campo, de um perfil que nunca viu esta sonda.
     * É o mesmo princípio do item que mantém perfil já homologado sem fator até ser remedido. Quem
     * quiser o número depois remede a impressora.
     *
     * Diferente de [skipCutFeedMeasurement], que grava o palpite de outra bancada: ali o campo é
     * obrigatório e um valor precisa existir; aqui a ausência **é** a resposta.
     */
    fun skipRasterThroughputMeasurement() {
        check(
            state.step == PrinterHomologationStep.RASTER_THROUGHPUT &&
                state.phase == PrinterHomologationPhase.AWAITING_RESPONSE,
        ) {
            "O padrão da imagem só pode ser escolhido depois que a tira sair."
        }
        verticalRasterScale = null
        advanceAfterRasterThroughput()
    }

    /**
     * Sai da etapa sem medida, e o perfil fica com os **dois** campos ausentes.
     *
     * É o "não consigo dizer" da tira: quem não sabe se aquilo era um código ou um monte de letras
     * não pode ser empurrado a escolher, porque um palpite vira capacidade gravada — e capacidade
     * gravada errada faz o app oferecer o comando nativo numa firmware que imprime o payload como
     * texto no meio do cupom.
     *
     * **Nulo é nulo**, como em [skipRasterThroughputMeasurement]: o perfil que sai daqui é
     * indistinguível, campo a campo, de um perfil que nunca viu esta sonda. Não existe marcador de
     * "alguém pulou", e a ausência **é** a resposta.
     */
    fun skipNativeCodeMeasurement() {
        check(
            state.step == PrinterHomologationStep.NATIVE_CODE &&
                state.phase == PrinterHomologationPhase.AWAITING_RESPONSE,
        ) {
            "O código nativo só pode ser dispensado depois que a tira sair."
        }
        nativeQrHonored = null
        nativeBarcodeHonored = null
        prepareCutProtocolStep()
    }

    /**
     * Grava o que a pessoa viu em cada bloco, um campo por comando.
     *
     * Nada é inferido do outro bloco, nem de marca, modelo, `firmwareVersion` ou dialeto: o único
     * produtor destes dois campos é esta resposta.
     */
    private fun answerNativeCode(answer: PrinterHomologationAnswer) {
        require(answer is PrinterHomologationAnswer.NativeCode) {
            "Resposta incompatível com NATIVE_CODE."
        }
        nativeQrHonored = answer.qrHonored
        nativeBarcodeHonored = answer.barcodeHonored
        prepareCutProtocolStep()
    }

    /**
     * Traduz régua em fator de compensação vertical, sem consultar marca nem modelo.
     *
     * A proporção entre o que saiu e a altura declarada da tira é **quanto do raster esta firmware
     * imprime**. Se saiu inteira, não há o que compensar e o perfil segue `null` — byte a byte como
     * sempre foi. Se encolheu, é essa proporção que o perfil grava, e o emissor passa a mandar
     * `1/proporção` linhas para o papel sair na altura pretendida.
     *
     * **Por que a conclusão mudou em 20/08.** Até aquela tarde esta conta produzia um teto de
     * vazão. A bancada mediu e refutou: a mesma imagem de 45,7 KB sai com 97 mm na GoldenSky MTP-II
     * e com 80 mm na Inico T210, pelo mesmo caminho e no mesmo aparelho, e mudar o teto — sem teto,
     * 32 KB/s, 4 KB/s — não mudou nem a velocidade nem o defeito. Cobertura, banda, MTU e modo de
     * escrita caíram do mesmo jeito, um a um. O que sobrou é uma firmware que encolhe raster largo
     * por um fator constante, e fator constante se compensa. A tira e a pergunta não mudaram: mudou
     * o que se conclui delas.
     *
     * **Os números, e por quê.**
     *
     * `0,97` é o piso do "saiu inteira". Numa tira de 48 mm ele cai em 46,6 mm, ou seja, tolera o
     * ±1 mm de quem lê uma régua comum sem tolerar o defeito, que encurta mais de dez milímetros.
     * Acima dele o perfil fica sem fator, e não com fator 0,98: compensação de 2% é ruído de régua
     * virando alteração permanente de imagem.
     *
     * **Não há margem de segurança, e a ausência é deliberada.** O teto tinha uma, de 0,90, porque
     * um teto errado para cima devolvia o defeito e errar para baixo só custava segundos. Aqui a
     * assimetria não existe: compensar 10% a mais estica a foto tanto quanto compensar 10% a menos
     * a encolhe. A compensação quer o fator **medido**, não um chute conservador.
     *
     * O `coerceIn` fecha a faixa aceita pelo campo do perfil, para uma leitura absurda parar aqui
     * em vez de derrubar a gravação lá no fim, depois de a pessoa ter gasto a bobina inteira.
     */
    private fun answerRasterThroughput(answer: PrinterHomologationAnswer) {
        require(answer is PrinterHomologationAnswer.RasterThroughput) {
            "Resposta incompatível com RASTER_THROUGHPUT."
        }
        val expectedMm = PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM
        require(answer.printedLengthMm in 1..expectedMm) {
            "Leitura fora da tira enviada: ela tem $expectedMm mm e não sai maior que isso."
        }
        val ratio = answer.printedLengthMm.toDouble() / expectedMm
        verticalRasterScale =
            if (ratio >= HEALTHY_RASTER_RATIO) null else ratio.coerceIn(VERTICAL_RASTER_SCALE_RANGE)
        advanceAfterRasterThroughput()
    }

    /**
     * Toda saída da vazão passa por aqui, e a próxima etapa é a do código nativo.
     *
     * Os dois campos são zerados na entrada pelo mesmo motivo que a vazão zera o fator: a etapa que
     * abre ainda não mediu nada, e um valor sobrevivente de uma passagem anterior seria medição de
     * outra tira.
     */
    private fun advanceAfterRasterThroughput() {
        nativeQrHonored = null
        nativeBarcodeHonored = null
        if (!probes.measuresNativeCode) {
            // Série sem tira de código nativo termina esta etapa **antes** de abri-la, e os dois
            // campos ficam ausentes — a mesma ausência de [skipNativeCodeMeasurement], que
            // significa que ninguém mediu. É o caso do dialeto Procomp: `ESC ( k` e `ESC | 0`
            // existem no manual da IM453H e nunca saíram em papel, e comando não medido nessa
            // impressora custa o aparelho travado, não uma tira torta.
            prepareCutProtocolStep()
            return
        }
        enterStep(PrinterHomologationStep.NATIVE_CODE)
    }

    private fun answerCodePage(answer: PrinterHomologationAnswer) {
        require(answer is PrinterHomologationAnswer.CodePage) { "Resposta incompatível com CODE_PAGE." }
        val candidate =
            answer.letter?.lowercaseChar()?.let { letter ->
                requireNotNull(PrinterHomologationProbes.codePageCandidates.firstOrNull { it.letter == letter }) {
                    "Letra fora da tira de página."
                }
            }
        // A candidata carrega a decisão inteira: modelo de codificação, tabela e endereço. Foram
        // três coisas decididas em dois lugares até 12/08, e o iOS já tinha divergido do Android
        // num deles. Sem letra — host antigo que ainda recusa a tira toda — vale a linha `a`, que é
        // exatamente a dobra ASCII conservadora.
        val resolved = candidate ?: PrinterHomologationProbes.codePageCandidates.first()
        textEncoding = resolved.textEncoding
        codePage = resolved.codePage
        // O endereço só é persistido nas candidatas `n=..`; um nome usa o canônico da própria
        // tabela. Foi esse campo que a T210 provou precisar atravessar o disco.
        codePageSelector = resolved.escT.takeIf { resolved.isAddress }
        finishMeasurement()
    }

    private fun answerCutProtocol(answer: PrinterHomologationAnswer) {
        require(answer is PrinterHomologationAnswer.Cut) { "Resposta incompatível com CUT_PROTOCOL." }
        // Compatibilidade da API: respostas diretas continuam válidas depois de uma sonda. A tela
        // nova usa chooseCutProtocol, porque não pergunta mais o modo prometido pelo comando.
        cutProtocol = answer.protocol
        // Sem resposta sobre o papel, o benefício da dúvida fica com o comando — é o
        // comportamento anterior. Com resposta, ela manda: se o modo que saiu não é o que o
        // comando pede, a firmware não honra a distinção e a troca de modo deixa de ser oferecida.
        cutModeHonored =
            answer.deliveredMode != null && answer.deliveredMode == answer.protocol.cutMode
        cutFeedLines = 0
        cutFeedBenchReady = false
        prepareCutFeedStep()
    }

    private fun answerCutFeed(answer: PrinterHomologationAnswer) {
        require(answer is PrinterHomologationAnswer.CutFeed) { "Resposta incompatível com CUT_FEED." }
        require(answer.lines in currentCutFeedChoices) { "Avanço não pertence à sonda enviada." }
        cutFeedLines = answer.lines
        // A partir daqui as sondas podem ser entregues pela lâmina sem um avanço provisório: o
        // valor que antecede cada corte veio do papel desta impressora, não da bancada de outra.
        enterCodePageStepOrFinish()
    }

    private fun prepareCutProtocolStep() {
        successfulCutProtocols.clear()
        cutProbeIndex = 0
        // Geometria mede papel, não guilhotina. O caminho avançado pulava a pergunta e enviava
        // seis cortes imediatamente; agora os dois caminhos pedem a decisão gratuita primeiro.
        cutProbeCandidates = emptyList()
        cutStage = PrinterCutProbeStage.ASKING_PRESENCE
        enterStep(PrinterHomologationStep.CUT_PROTOCOL)
    }

    /**
     * Toda saída da geometria passa por aqui, e a próxima etapa é a vazão.
     *
     * A tira de vazão precisa da largura imprimível medida, então este é o primeiro instante em que
     * ela pode existir — e é onde ela entra, para os três caminhos que resolvem geometria: a
     * largura aceita por padrão, a escolhida nas duas réguas e a classificada pela régua completa.
     */
    private fun advanceAfterGeometry() {
        measuredRasterBytesPerSecond = null
        verticalRasterScale = null
        enterStep(PrinterHomologationStep.RASTER_THROUGHPUT)
    }

    private fun classifyPaperWidth(columns: Int, dots: Int): Int =
        if (columns <= 32 && dots <= 384) 58 else 80

    private fun selectCutProtocol(protocol: CutProtocol) {
        cutProtocol = protocol
        cutMeasurementFailed = false
        cutModeHonored = false
        cutFeedLines = 0
        cutFeedBenchReady = false
        prepareCutFeedStep()
    }

    private fun finishWithoutCut(measurementFailed: Boolean) {
        cutProtocol = CutProtocol.NONE
        cutMeasurementFailed = measurementFailed
        cutModeHonored = false
        cutFeedLines = 0
        cutFeedBenchReady = false
        prepareCutFeedStep()
    }

    private fun prepareCutFeedStep() {
        if (
            cutProtocol == CutProtocol.NONE ||
                cutProtocol in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED
        ) {
            cutFeedLines = 0
            enterCodePageStepOrFinish()
        } else {
            enterStep(PrinterHomologationStep.CUT_FEED)
        }
    }

    /**
     * A etapa de página abre, ou a medição termina aqui.
     *
     * Série sem tira de página é série cujo emissor **não consulta a página do perfil** — hoje, o
     * dialeto Procomp, onde [procompText] codifica em ABICOMP, a tabela de fábrica provada em papel.
     * Perguntar ali produziria uma resposta que nenhum byte emitido lê, e o perfil sai com a
     * codificação que aquele dialeto já tem. Ver [PrinterHomologationProbeSet.codePages].
     */
    private fun enterCodePageStepOrFinish() {
        if (probes.measuresCodePage) {
            enterStep(PrinterHomologationStep.CODE_PAGE)
            return
        }
        finishMeasurement()
    }

    private fun finishMeasurement() {
        enterStep(PrinterHomologationStep.DONE, PrinterHomologationPhase.DONE)
    }

    /**
     * Único caminho de troca de etapa: publica o novo estado e guarda a etapa que fica para trás.
     *
     * Concentrar as transições aqui é o que garante que toda etapa alcançada tenha uma fotografia
     * anterior para [goBack] restaurar — inclusive as que uma resposta pula, como o avanço de quem
     * não tem guilhotina.
     */
    private fun enterStep(
        step: PrinterHomologationStep,
        phase: PrinterHomologationPhase = PrinterHomologationPhase.READY,
    ) {
        check(step != state.step) { "Uma transição de etapa precisa mudar de etapa." }
        val leaving = stepEntry
        state = PrinterHomologationState(step, phase)
        previousSteps += leaving
        stepEntry = captureStepEntry()
    }

    private fun captureStepEntry(): StepEntry =
        StepEntry(
            state = state,
            geometry = geometry,
            textEncoding = textEncoding,
            codePage = codePage,
            codePageSelector = codePageSelector,
            cutModeHonored = cutModeHonored,
            cutProtocol = cutProtocol,
            cutFeedLines = cutFeedLines,
            cutFeedBenchReady = cutFeedBenchReady,
            path = path,
            cutProbeCandidates = cutProbeCandidates,
            cutProbeIndex = cutProbeIndex,
            successfulCutProtocols = successfulCutProtocols.toList(),
            cutStage = cutStage,
            cutMeasurementFailed = cutMeasurementFailed,
            classifyWidthFromFullRuler = classifyWidthFromFullRuler,
            measuredRasterBytesPerSecond = measuredRasterBytesPerSecond,
            verticalRasterScale = verticalRasterScale,
            nativeQrHonored = nativeQrHonored,
            nativeBarcodeHonored = nativeBarcodeHonored,
        )

    private fun restore(entry: StepEntry) {
        state = entry.state
        geometry = entry.geometry
        textEncoding = entry.textEncoding
        codePage = entry.codePage
        codePageSelector = entry.codePageSelector
        cutModeHonored = entry.cutModeHonored
        cutProtocol = entry.cutProtocol
        cutFeedLines = entry.cutFeedLines
        // A fotografia é do instante em que a etapa abriu, quando a bancada ainda não tinha sido
        // confirmada: reabrir CUT_FEED volta a pedir a decisão sobre as oito tiras.
        cutFeedBenchReady = entry.cutFeedBenchReady
        path = entry.path
        cutProbeCandidates = entry.cutProbeCandidates
        cutProbeIndex = entry.cutProbeIndex
        successfulCutProtocols.clear()
        successfulCutProtocols += entry.successfulCutProtocols
        cutStage = entry.cutStage
        cutMeasurementFailed = entry.cutMeasurementFailed
        classifyWidthFromFullRuler = entry.classifyWidthFromFullRuler
        // A fotografia é do instante em que a etapa abriu, antes de a tira sair: reabrir a etapa
        // devolve a máquina sem medida e sem fator, e o número novo virá da tira nova.
        measuredRasterBytesPerSecond = entry.measuredRasterBytesPerSecond
        verticalRasterScale = entry.verticalRasterScale
        // Mesma regra: reabrir a etapa devolve a máquina sem as duas respostas, e as novas virão da
        // tira nova. Voltar não pode preservar a medição da premissa que está sendo corrigida.
        nativeQrHonored = entry.nativeQrHonored
        nativeBarcodeHonored = entry.nativeBarcodeHonored
        stepEntry = entry
    }

    private fun reprintsProbes(entry: StepEntry): Boolean =
        when (entry.state.step) {
            PrinterHomologationStep.WIDTH,
            PrinterHomologationStep.GEOMETRY,
            // A tira de vazão é a mais cara em papel de todas as que saem uma vez só: são 48 mm de
            // meio tom em largura cheia. Reabrir a etapa e avançar por ela de novo gasta outra.
            PrinterHomologationStep.RASTER_THROUGHPUT,
            // Uma tira com o QR e o código de barras nativos: reabrir a etapa e avançar por ela de
            // novo manda outra ao papel.
            PrinterHomologationStep.NATIVE_CODE,
            PrinterHomologationStep.CODE_PAGE,
            // "Sim" e "Não sei" mandam os seis dialetos de novo; só "Não" sai de graça.
            PrinterHomologationStep.CUT_PROTOCOL,
            -> true
            PrinterHomologationStep.CUT_FEED ->
                entry.cutProtocol != CutProtocol.NONE &&
                    entry.cutProtocol !in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED
            PrinterHomologationStep.DONE -> false
        }

    /** A máquina inteira no instante em que uma etapa abriu, antes de a resposta dela existir. */
    private data class StepEntry(
        val state: PrinterHomologationState,
        val geometry: PrinterGeometry,
        val textEncoding: ThermalTextEncoding,
        val codePage: ThermalCodePage?,
        val codePageSelector: Int?,
        val cutModeHonored: Boolean,
        val cutProtocol: CutProtocol,
        val cutFeedLines: Int,
        val cutFeedBenchReady: Boolean,
        val path: PrinterHomologationPath,
        val cutProbeCandidates: List<CutProtocol>,
        val cutProbeIndex: Int,
        val successfulCutProtocols: List<CutProtocol>,
        val cutStage: PrinterCutProbeStage,
        val cutMeasurementFailed: Boolean,
        val classifyWidthFromFullRuler: Boolean,
        val measuredRasterBytesPerSecond: Int?,
        val verticalRasterScale: Double?,
        val nativeQrHonored: Boolean?,
        val nativeBarcodeHonored: Boolean?,
    )

    private companion object {
        /** Palpite da P80 e da Tomate, usado só quando a pessoa pula a medição de propósito. */
        const val UNMEASURED_CUT_FEED_LINES = 5

        /** Piso do "saiu inteira": 0,97 de 48 mm são 46,6 mm, o ±1 mm de uma régua comum. */
        const val HEALTHY_RASTER_RATIO = 0.97
    }
}

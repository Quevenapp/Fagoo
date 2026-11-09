package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterHomologationMachineTest {
    @Test
    fun `toda geometria passa pela pergunta de guilhotina`() {
        val narrow = PrinterHomologationMachine()
        narrow.beginPaperWidthRulers()
        narrow.finishSending(ThermalPrintResult.Printed)
        narrow.choosePaperWidthFromPrintedRulers(58)
        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, narrow.state.step)
        narrow.passRasterThroughputProbe()
        narrow.passNativeCodeProbe()
        assertEquals(PrinterHomologationStep.CUT_PROTOCOL, narrow.state.step)
        assertEquals(PrinterCutProbeStage.ASKING_PRESENCE, narrow.currentCutStage)
        assertEquals(CutProtocol.NONE, narrow.currentCutProtocol)

        val unknown58 = PrinterHomologationMachine()
        unknown58.beginPaperWidthRulers()
        unknown58.finishSending(ThermalPrintResult.Printed)
        unknown58.chooseNoPaperWidthFromPrintedRulers()
        completeProbe(unknown58, PrinterHomologationAnswer.Geometry(80, 32, 384))
        assertEquals(58, unknown58.currentGeometry.paperWidthMm)
        unknown58.passRasterThroughputProbe()
        unknown58.passNativeCodeProbe()
        assertEquals(PrinterHomologationStep.CUT_PROTOCOL, unknown58.state.step)
        assertEquals(PrinterCutProbeStage.ASKING_PRESENCE, unknown58.currentCutStage)

        val unknown80 = PrinterHomologationMachine()
        unknown80.beginPaperWidthRulers()
        unknown80.finishSending(ThermalPrintResult.Printed)
        unknown80.chooseNoPaperWidthFromPrintedRulers()
        completeProbe(unknown80, PrinterHomologationAnswer.Geometry(58, 50, 576))
        assertEquals(80, unknown80.currentGeometry.paperWidthMm)
        unknown80.passRasterThroughputProbe()
        unknown80.passNativeCodeProbe()
        assertEquals(PrinterHomologationStep.CUT_PROTOCOL, unknown80.state.step)
    }

    @Test
    fun `as duas réguas antecedem a escolha de largura`() {
        val machine = PrinterHomologationMachine()

        val probe = machine.beginPaperWidthRulers()
        val text = probe.bytes().toString(Charsets.US_ASCII)
        assertTrue(text.contains("58mm"))
        assertTrue(text.contains("384 Dots"))
        assertTrue(text.contains("80mm"))
        assertTrue(text.contains("576 Dots"))
        assertEquals(PrinterHomologationPhase.SENDING, machine.state.phase)

        machine.finishSending(ThermalPrintResult.Printed)
        machine.choosePaperWidthFromPrintedRulers(80)

        assertEquals(80, machine.currentGeometry.paperWidthMm)
        // A geometria resolvida entrega a vazão, que é a primeira etapa que precisa da largura
        // imprimível medida.
        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, machine.state.step)
    }

    /**
     * A letra do endereço `n=08` sai da própria lista, nunca de uma constante escrita à mão.
     *
     * Quando a linha sem seleção entrou como primeira candidata, todas as letras andaram uma casa
     * e três testes passaram a medir o `n=09` achando que mediam o 8 — verdes, e errados.
     */
    private val letraN08 =
        PrinterHomologationProbes.codePageCandidates.single { it.isAddress && it.escT == 8 }.letter

    /** Primeiro nome da lista: mede a tabela, e por isso não grava seletor explícito. */
    private val letraDeNome =
        PrinterHomologationProbes.codePageCandidates
            .first { !it.isAddress && it.textEncoding == ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE }
            .letter

    /** A linha que sai sem o kit selecionar nada. */
    private val letraSemSelecao =
        PrinterHomologationProbes.codePageCandidates.single(CodePageProbeCandidate::isFirmwareDefault).letter

    /** A linha sem acento, que é o piso da tira e a resposta de quando nada mais serve. */
    private val letraSemAcentos =
        PrinterHomologationProbes.codePageCandidates
            .single { it.textEncoding == ThermalTextEncoding.ASCII }
            .letter

    /** A linha do modelo Unicode, medida na MTP-II. */
    private val letraUtf8 =
        PrinterHomologationProbes.codePageCandidates
            .single { it.textEncoding == ThermalTextEncoding.UTF_8 }
            .letter

    /** Cada linha da tira grava a decisão inteira: modelo, tabela e endereço. */
    private fun perfilPelaLetra(letra: Char?): MeasuredProfile {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
        completeProbe(machine, PrinterHomologationAnswer.Cut(CutProtocol.NONE))
        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letra))
        assertEquals(PrinterHomologationStep.DONE, machine.state.step)
        return machine.buildMeasuredProfile("de bancada", setOf(PrinterTransport.BLUETOOTH), 1)
    }

    /**
     * O UTF-8 é uma linha da tira, não uma pergunta de tela.
     *
     * "Byte único ou UTF-8?" não é respondível com o papel na mão. A MTP-II continua medida: a
     * linha dela sai em UTF-8 e, quando é a legível, o perfil sai sem página nenhuma.
     */
    @Test
    fun `a letra do UTF-8 grava o modelo Unicode sem página`() {
        val profile = perfilPelaLetra(letraUtf8)

        assertEquals(ThermalTextEncoding.UTF_8, profile.textEncoding)
        assertEquals(null, profile.codePage)
        assertEquals(null, profile.codePageSelector)
    }

    /**
     * A T210 mostrou que a tabela pode estar num endereço que ninguém adivinha: a letra do endereço
     * grava a página **e** o `n` medido, e é esse campo que atravessa o disco.
     */
    @Test
    fun `a letra do endereço grava página e seletor`() {
        val profile = perfilPelaLetra(letraN08)

        assertEquals(ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE, profile.textEncoding)
        assertEquals(ThermalCodePage.CP860, profile.codePage)
        assertEquals(8, profile.codePageSelector)
    }

    /** Nome mede a tabela e usa o canônico dela; nenhum seletor explícito é gravado. */
    @Test
    fun `a letra do nome não grava seletor explícito`() {
        val profile = perfilPelaLetra(letraDeNome)

        assertEquals(ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE, profile.textEncoding)
        assertEquals(null, profile.codePageSelector)
    }

    /**
     * A linha sem seleção é a que sai **sem** o kit mandar `ESC t`. Escolhê-la mede que a página
     * que a firmware liga sozinha já está certa — o caso da Tomate e da genérica LUOGAO, que
     * declaram `page 3` — e o perfil sai sem seletor nenhum.
     */
    @Test
    fun `a letra sem seleção grava a página padrão da firmware`() {
        val perfil = perfilPelaLetra(letraSemSelecao)

        assertEquals(ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE, perfil.textEncoding)
        assertEquals(ThermalCodePage.CP860, perfil.codePage)
        assertEquals(null, perfil.codePageSelector)

        // E o papel não leva `ESC t`: é a diferença inteira deste estado.
        val bytes =
            EscPosThermalCommands.text(
                "ação",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                codePage = perfil.codePage,
                textEncoding = perfil.textEncoding,
            )
        assertFalse(bytes.toList().windowed(2).any { it == listOf(0x1B.toByte(), 0x74.toByte()) })
    }

    /**
     * A linha `a` é a frase sem acento, e escolhê-la é a dobra ASCII conservadora. Sem letra —
     * host antigo que ainda manda `null` — vale a mesma linha, porque é a mesma decisão.
     */
    @Test
    fun `a letra sem acentos e a ausência de letra concluem em ASCII`() {
        listOf(letraSemAcentos, null).forEach { letra ->
            val profile = perfilPelaLetra(letra)
            assertEquals(ThermalTextEncoding.ASCII, profile.textEncoding)
            assertEquals(null, profile.codePage)
            assertEquals(null, profile.codePageSelector)
        }
    }

    @Test
    fun `sequência obrigatória chega a DONE sem cronômetro`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        val visited = mutableListOf(machine.state.step)

        completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
        visited += machine.state.step
        completeProbe(machine, PrinterHomologationAnswer.Cut(CutProtocol.ESC_M))
        visited += machine.state.step
        machine.confirmCutFeedBenchReady()
        completeProbe(machine, PrinterHomologationAnswer.CutFeed(4))
        visited += machine.state.step
        visited += machine.state.step
        completeProbe(machine, PrinterHomologationAnswer.CodePage('a'))
        visited += machine.state.step

        assertEquals(
            listOf(
                PrinterHomologationStep.WIDTH,
                // A geometria entrega a vazão, e a vazão entrega o corte.
                PrinterHomologationStep.RASTER_THROUGHPUT,
                PrinterHomologationStep.CUT_FEED,
                PrinterHomologationStep.CODE_PAGE,
                PrinterHomologationStep.CODE_PAGE,
                PrinterHomologationStep.DONE,
            ),
            visited,
        )
        assertEquals(PrinterHomologationPhase.DONE, machine.state.phase)
        val forbiddenClockNames = listOf("timer", "timeout", "deadline", "elapsed", "nano", "clock")
        assertFalse(
            PrinterHomologationMachine::class.java.declaredFields.any { field ->
                forbiddenClockNames.any { field.name.contains(it, ignoreCase = true) }
            },
        )
    }

    @Test
    fun `resposta é recusada antes da conclusão real do envio`() {
        val machine = PrinterHomologationMachine()
        val answer = PrinterHomologationAnswer.Geometry(58, 32, 384)

        assertThrows(IllegalStateException::class.java) { machine.answer(answer) }
        machine.beginSending()
        assertThrows(IllegalStateException::class.java) { machine.answer(answer) }
        machine.finishSending(ThermalPrintResult.Printed)
        machine.answer(answer)

        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, machine.state.step)
    }

    @Test
    fun `caminho curto assume geometria e sem guilhotina conclui sem sonda de corte`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 80)

        machine.acceptDefaultGeometry()
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        assertEquals(PrinterCutProbeStage.ASKING_PRESENCE, machine.currentCutStage)
        machine.answerCutterPresence(PrinterCutterPresence.NO)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(null))

        assertEquals(PrinterHomologationStep.DONE, machine.state.step)
        val profile =
            machine.buildMeasuredProfile(
                displayName = "Sem guilhotina",
                transports = setOf(PrinterTransport.USB),
                measuredAtEpochMillis = 1,
            )
        assertEquals(80, profile.paperWidthMm)
        assertEquals(48, profile.printableColumns)
        assertEquals(576, profile.printableDots)
        assertEquals(CutProtocol.NONE, profile.cutProtocol)
        assertEquals(0, profile.cutFeedLines)
        assertFalse(profile.cutModeHonored)
    }

    /**
     * Todos os dialetos saem antes de qualquer pergunta.
     *
     * Parar no primeiro que corta economizava papel e escondia o que a impressora faz nos outros.
     * Medido na LUOGAO em 12/08: com uma tira só não há com o que comparar, e a escolha vira um
     * palpite sobre a única coisa que saiu.
     */
    @Test
    fun `a sonda imprime os seis dialetos e só então abre a escolha`() {
        val machine = shortMachineAtCutQuestion()
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.UNKNOWN)

        val visited = mutableListOf<CutProtocol>()
        repeat(6) {
            val protocol = requireNotNull(machine.currentCutProbeProtocol)
            visited += protocol
            val comando = requireNotNull(PrinterHomologationProbes.commandFor(protocol))
            // Cada comando vai sozinho e é a última coisa do payload: é isso que faz o papel
            // responder só pela guilhotina.
            assertArrayEquals(comando, machine.beginSending().bytes().takeLast(comando.size).toByteArray())
            machine.finishSending(ThermalPrintResult.Printed)
            machine.advanceCutProbe()
        }

        assertEquals(
            listOf(
                CutProtocol.GS_V_0,
                CutProtocol.GS_V_1,
                CutProtocol.GS_V_65,
                CutProtocol.GS_V_66,
                CutProtocol.ESC_I,
                CutProtocol.ESC_M,
            ),
            visited,
        )
        assertEquals(PrinterCutProbeStage.SELECTING_ADVANCED_RESULT, machine.currentCutStage)
        assertEquals(visited, machine.attemptedCutProtocols)

        machine.chooseCutProtocol(CutProtocol.ESC_M)
        assertEquals(PrinterHomologationStep.CUT_FEED, machine.state.step)
        assertEquals(CutProtocol.ESC_M, machine.currentCutProtocol)
    }

    @Test
    fun `nenhuma cortou registra NONE e o aviso da medição`() {
        val machine = shortMachineAtCutQuestion()
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.YES)
        repeat(6) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.advanceCutProbe()
        }
        machine.chooseCutProtocol(CutProtocol.NONE)

        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)
        assertEquals(CutProtocol.NONE, machine.currentCutProtocol)
        assertTrue(machine.didFailToMeasureCut)
    }

    /**
     * A etapa de avanço não chega com valor escolhido.
     *
     * Ela abria com 5 — medido na P80 e na Tomate — e pedia confirmação: quem respondesse "não
     * comeu texto" gravava um número que não mediu. A distância entre a cabeça e a lâmina é física
     * de cada impressora, e é isso que a régua inteira mede, ao custo de oito tiras.
     */
    @Test
    fun `o avanço não chega pré-escolhido`() {
        val machine = shortMachineAtCutFeed()
        assertEquals(MeasuredProfile.CUT_FEED_CHOICES.toList(), machine.currentCutFeedChoices)
        assertTrue(machine.requiresCutFeedBenchConfirmation)

        machine.confirmCutFeedBenchReady()
        val tira = String(machine.beginSending().bytes(), Charsets.US_ASCII)
        MeasuredProfile.CUT_FEED_CHOICES.filter { it > 0 }.forEach { avanco ->
            assertTrue(">>> $avanco <<<", tira.contains(">>> $avanco <<<"))
        }
    }

    /**
     * Pular é decisão explícita, e o que entra é o palpite de outra bancada — sem fingir medição.
     * O comprovante final imprime o avanço, então o número fica à vista de quem quiser conferir.
     */
    @Test
    fun `pular o avanço grava o palpite e segue para o texto`() {
        val machine = shortMachineAtCutFeed()
        machine.skipCutFeedMeasurement()

        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraSemSelecao))
        assertEquals(5, machine.buildMeasuredProfile("pulou", setOf(PrinterTransport.USB), 1).cutFeedLines)
    }

    @Test
    fun `o caminho avançado percorre os mesmos seis e conclui pela escolha`() {
        val machine = PrinterHomologationMachine()
        machine.startAdvancedPath()
        completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.YES)

        repeat(6) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.advanceCutProbe()
        }
        machine.chooseCutProtocol(CutProtocol.ESC_M)

        assertEquals(PrinterHomologationStep.CUT_FEED, machine.state.step)
        assertEquals(MeasuredProfile.CUT_FEED_CHOICES.toList(), machine.currentCutFeedChoices)
        machine.confirmCutFeedBenchReady()
        completeProbe(machine, PrinterHomologationAnswer.CutFeed(4))
        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraSemSelecao))
        assertEquals(PrinterHomologationStep.DONE, machine.state.step)
    }

    @Test
    fun `falha para e só retry explícito permite novo envio`() {
        val machine = PrinterHomologationMachine()
        machine.beginSending()
        machine.finishSending(
            ThermalPrintResult.Failed(
                "Falha de bancada",
                ThermalPrinterState.Failed("Falha de bancada"),
                ThermalPrintDelivery.INDETERMINATE,
            ),
        )

        assertEquals(PrinterHomologationPhase.FAILED, machine.state.phase)
        assertEquals(ThermalPrintDelivery.INDETERMINATE, machine.state.failure?.delivery)
        assertThrows(IllegalStateException::class.java) { machine.beginSending() }
        machine.retry()
        assertEquals(PrinterHomologationPhase.READY, machine.state.phase)
        machine.beginSending()
        assertEquals(PrinterHomologationPhase.SENDING, machine.state.phase)
    }

    @Test
    fun `CUT FEED recusa envio sem confirmação explícita da bancada`() {
        val machine = machineAtCutFeed(CutProtocol.GS_V_1)

        assertTrue(machine.requiresCutFeedBenchConfirmation)
        assertThrows(IllegalStateException::class.java) { machine.beginSending() }
        machine.confirmCutFeedBenchReady()
        machine.beginSending()

        assertEquals(PrinterHomologationPhase.SENDING, machine.state.phase)
        assertFalse(machine.requiresCutFeedBenchConfirmation)
    }

    @Test
    fun `NONE segue para codificação com zero e não pede sonda de oito tiras`() {
        val machine = machineAfterCodePage(CutProtocol.NONE)

        assertEquals(PrinterHomologationPhase.DONE, machine.state.phase)
        assertEquals(listOf(0), machine.currentCutFeedChoices)
        assertThrows(IllegalStateException::class.java) { machine.beginSending() }

        assertEquals(PrinterHomologationStep.DONE, machine.state.step)
        val profile =
            machine.buildMeasuredProfile(
                id = "00000000-0000-4000-8000-000000000031",
                displayName = "Impressora homologada",
                transports = setOf(PrinterTransport.BLUETOOTH_LE),
                measuredAtEpochMillis = 1,
            )
        assertEquals(0, profile.cutFeedLines)
        assertEquals(PrinterStatusProtocol.NONE, profile.statusProtocol)
    }

    private fun machineAtCutFeed(protocol: CutProtocol): PrinterHomologationMachine =
        PrinterHomologationMachine().also { machine ->
            completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
            completeProbe(machine, PrinterHomologationAnswer.Cut(protocol))
        }

    private fun machineAfterCodePage(protocol: CutProtocol): PrinterHomologationMachine =
        PrinterHomologationMachine().also { machine ->
            completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
            completeProbe(machine, PrinterHomologationAnswer.Cut(protocol))
            if (protocol != CutProtocol.NONE && protocol !in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) {
                machine.confirmCutFeedBenchReady()
                completeProbe(machine, PrinterHomologationAnswer.CutFeed(4))
            }
            completeProbe(machine, PrinterHomologationAnswer.CodePage(null))
        }

    private fun shortMachineAtCutQuestion(): PrinterHomologationMachine =
        PrinterHomologationMachine().also { machine ->
            machine.acceptDefaultGeometry()
        }

    private fun shortMachineAtCutFeed(): PrinterHomologationMachine =
        shortMachineAtCutQuestion().also { machine ->
            machine.passRasterThroughputProbe()
            machine.passNativeCodeProbe()
            machine.answerCutterPresence(PrinterCutterPresence.YES)
            repeat(6) {
                machine.beginSending()
                machine.finishSending(ThermalPrintResult.Printed)
                machine.advanceCutProbe()
            }
            machine.chooseCutProtocol(CutProtocol.GS_V_1)
        }

    @Test
    fun `a tira única conclui tanto na recusa quanto no endereço`() {
        // A lista sempre leva a linha sem seleção, os nomes e os endereços no mesmo envio.
        // Recusar tudo é resposta legítima; a letra medida é a do `n=08` que a T210 provou no papel.
        val recusou = PrinterHomologationMachine(initialPaperWidthMm = 58)
        completeProbe(recusou, PrinterHomologationAnswer.Geometry(58, 32, 384))
        completeProbe(recusou, PrinterHomologationAnswer.Cut(CutProtocol.NONE))
        completeProbe(recusou, PrinterHomologationAnswer.CodePage(null))
        assertEquals(PrinterHomologationStep.DONE, recusou.state.step)

        val aceitou = PrinterHomologationMachine(initialPaperWidthMm = 58)
        completeProbe(aceitou, PrinterHomologationAnswer.Geometry(58, 32, 384))
        completeProbe(aceitou, PrinterHomologationAnswer.Cut(CutProtocol.NONE))
        completeProbe(aceitou, PrinterHomologationAnswer.CodePage(letraN08))
        val perfil = aceitou.buildMeasuredProfile("T210", setOf(PrinterTransport.BLUETOOTH), 1)
        assertEquals(ThermalCodePage.CP860, perfil.codePage)
        assertEquals(8, perfil.codePageSelector)
        assertEquals(PrinterHomologationStep.DONE, aceitou.state.step)
    }

    @Test
    fun `página aprovada por nome não grava seletor explícito`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
        completeProbe(machine, PrinterHomologationAnswer.Cut(CutProtocol.NONE))

        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraDeNome))

        assertEquals(PrinterHomologationStep.DONE, machine.state.step)
        assertEquals(
            null,
            machine.buildMeasuredProfile("por nome", setOf(PrinterTransport.BLUETOOTH), 1).codePageSelector,
        )
    }

    @Test
    fun `a letra do endereço vira página e seletor do perfil`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
        completeProbe(machine, PrinterHomologationAnswer.Cut(CutProtocol.NONE))
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraN08))

        val perfil =
            machine.buildMeasuredProfile(
                displayName = "T210 de bancada",
                transports = setOf(PrinterTransport.BLUETOOTH),
                measuredAtEpochMillis = 1,
            )

        assertEquals(ThermalCodePage.CP860, perfil.codePage)
        assertEquals(8, perfil.codePageSelector)
    }

    @Test
    fun `nenhuma linha certa mantém a página em nenhuma`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        completeProbe(machine, PrinterHomologationAnswer.Geometry(58, 32, 384))
        completeProbe(machine, PrinterHomologationAnswer.Cut(CutProtocol.NONE))
        completeProbe(machine, PrinterHomologationAnswer.CodePage(null))

        val perfil =
            machine.buildMeasuredProfile(
                displayName = "T210 de bancada",
                transports = setOf(PrinterTransport.BLUETOOTH),
                measuredAtEpochMillis = 1,
            )

        assertEquals(null, perfil.codePage)
        assertEquals(null, perfil.codePageSelector)
    }

    @Test
    fun `impressora que corta sempre parcial não oferece troca de modo`() {
        // Medido na bancada: a GoldenSky obedeceu aos sete comandos e cortou sempre parcial,
        // inclusive no `GS V 0`, que pede total. Registrar "corte total" nela seria prometer papel
        // solto que nunca vem.
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 80)
        completeProbe(machine, PrinterHomologationAnswer.Geometry(80, 48, 576))
        completeProbe(
            machine,
            PrinterHomologationAnswer.Cut(CutProtocol.GS_V_0, deliveredMode = CutMode.PARTIAL),
        )
        machine.confirmCutFeedBenchReady()
        completeProbe(machine, PrinterHomologationAnswer.CutFeed(4))
        completeProbe(machine, PrinterHomologationAnswer.CodePage('b'))

        val perfil =
            machine.buildMeasuredProfile(
                displayName = "GoldenSky de bancada",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                measuredAtEpochMillis = 1,
            )

        assertFalse(perfil.cutModeHonored)
        // A troca é recusada em vez de gravar uma promessa que a firmware não cumpre.
        assertEquals(perfil, perfil.withCutMode(CutMode.TOTAL))
    }

    @Test
    fun `modo confirmado no papel mantém a troca disponível`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 80)
        completeProbe(machine, PrinterHomologationAnswer.Geometry(80, 48, 576))
        completeProbe(
            machine,
            PrinterHomologationAnswer.Cut(CutProtocol.GS_V_0, deliveredMode = CutMode.TOTAL),
        )
        machine.confirmCutFeedBenchReady()
        completeProbe(machine, PrinterHomologationAnswer.CutFeed(4))
        completeProbe(machine, PrinterHomologationAnswer.CodePage('b'))

        val perfil =
            machine.buildMeasuredProfile(
                displayName = "Elgin de bancada",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                measuredAtEpochMillis = 1,
            )

        assertTrue(perfil.cutModeHonored)
        assertEquals(CutMode.PARTIAL, perfil.withCutMode(CutMode.PARTIAL).cutMode)
    }

    /**
     * O cheque de bancada do iPhone 7, em 20/08: 58 mm escolhido numa impressora de 80.
     *
     * Sem retrocesso a pessoa só tinha duas saídas, ambas ruins — seguir medindo contra a premissa
     * errada ou recomeçar do zero. Voltar reabre a etapa; as réguas saem de novo porque a pessoa
     * mandou imprimi-las, não porque o retrocesso imprimiu sozinho.
     */
    @Test
    fun `voltar corrige a largura errada e o perfil sai com a geometria nova`() {
        val machine = PrinterHomologationMachine()
        machine.beginPaperWidthRulers()
        machine.finishSending(ThermalPrintResult.Printed)
        machine.choosePaperWidthFromPrintedRulers(58)

        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, machine.state.step)
        assertTrue(machine.canGoBack)
        assertEquals(PrinterHomologationStep.WIDTH, machine.previousStep)
        assertTrue(machine.backReprintsProbes)

        machine.goBack()

        assertEquals(
            PrinterHomologationState(PrinterHomologationStep.WIDTH, PrinterHomologationPhase.READY),
            machine.state,
        )
        machine.beginPaperWidthRulers()
        machine.finishSending(ThermalPrintResult.Printed)
        machine.choosePaperWidthFromPrintedRulers(80)
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.NO)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(null))

        val perfil = machine.buildMeasuredProfile("corrigida", setOf(PrinterTransport.USB), 1)
        assertEquals(80, perfil.paperWidthMm)
        assertEquals(48, perfil.printableColumns)
        assertEquals(576, perfil.printableDots)
    }

    /**
     * Voltar desfaz uma decisão por toque: a etapa reaberta perde a resposta dela e as seguintes,
     * porque foram medidas contra a premissa que está sendo corrigida, e as anteriores ficam.
     */
    @Test
    fun `voltar de cada etapa desfaz só dali para frente`() {
        val machine = PrinterHomologationMachine()
        machine.beginPaperWidthRulers()
        machine.finishSending(ThermalPrintResult.Printed)
        machine.chooseNoPaperWidthFromPrintedRulers()
        completeProbe(machine, PrinterHomologationAnswer.Geometry(80, 50, 576))
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.YES)
        repeat(6) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.advanceCutProbe()
        }
        machine.chooseCutProtocol(CutProtocol.ESC_M)
        machine.confirmCutFeedBenchReady()
        completeProbe(machine, PrinterHomologationAnswer.CutFeed(4))
        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)

        // Do texto para o avanço: some o avanço medido, ficam largura, geometria e corte.
        assertEquals(PrinterHomologationStep.CUT_FEED, machine.previousStep)
        assertTrue(machine.backReprintsProbes)
        machine.goBack()
        assertEquals(PrinterHomologationStep.CUT_FEED, machine.state.step)
        assertEquals(PrinterHomologationPhase.READY, machine.state.phase)
        assertEquals(CutProtocol.ESC_M, machine.currentCutProtocol)
        assertEquals(80, machine.currentGeometry.paperWidthMm)
        assertEquals(50, machine.currentGeometry.printableColumns)
        // A bancada volta a ser perguntada: a confirmação anterior valeu para o envio anterior.
        assertTrue(machine.requiresCutFeedBenchConfirmation)

        // Do avanço para o corte: some o dialeto escolhido e as tiras tentadas, fica a geometria.
        machine.goBack()
        assertEquals(PrinterHomologationStep.CUT_PROTOCOL, machine.state.step)
        assertEquals(PrinterCutProbeStage.ASKING_PRESENCE, machine.currentCutStage)
        assertEquals(CutProtocol.NONE, machine.currentCutProtocol)
        assertEquals(emptyList<CutProtocol>(), machine.attemptedCutProtocols)
        assertEquals(80, machine.currentGeometry.paperWidthMm)
        assertEquals(50, machine.currentGeometry.printableColumns)

        // Do corte para o código nativo: somem as duas respostas, e o perfil volta a não saber se
        // aquela firmware desenha o que o comando nativo pede.
        machine.goBack()
        assertEquals(PrinterHomologationStep.NATIVE_CODE, machine.state.step)
        assertEquals(PrinterHomologationPhase.READY, machine.state.phase)
        assertEquals(null, machine.currentNativeQrHonored)
        assertEquals(null, machine.currentNativeBarcodeHonored)
        assertEquals(50, machine.currentGeometry.printableColumns)

        // Do código nativo para a imagem: some a leitura da régua externa, e o fator volta a não
        // existir.
        machine.goBack()
        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, machine.state.step)
        assertEquals(PrinterHomologationPhase.READY, machine.state.phase)
        assertEquals(null, machine.currentMeasuredRasterBytesPerSecond)
        assertEquals(null, machine.currentVerticalRasterScale)
        assertEquals(50, machine.currentGeometry.printableColumns)

        // Da imagem para a geometria: some a régua respondida, fica a decisão de medir a régua.
        machine.goBack()
        assertEquals(PrinterHomologationStep.GEOMETRY, machine.state.step)
        assertEquals(PrinterHomologationPath.ADVANCED, machine.currentPath)
        assertEquals(48, machine.currentGeometry.printableColumns)

        // Da geometria para a largura: some a recusa das duas réguas e a homologação está no zero.
        machine.goBack()
        assertEquals(PrinterHomologationStep.WIDTH, machine.state.step)
        assertEquals(PrinterHomologationPath.SHORT, machine.currentPath)
        assertEquals(58, machine.currentGeometry.paperWidthMm)

        // A primeira etapa não volta: não há premissa anterior para desfazer.
        assertFalse(machine.canGoBack)
        assertEquals(null, machine.previousStep)
        assertFalse(machine.backReprintsProbes)
        assertThrows(IllegalStateException::class.java) { machine.goBack() }
    }

    /** Voltar e responder outra coisa produz o perfil da resposta nova, não o da antiga. */
    @Test
    fun `voltar e responder de novo grava a resposta nova`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        machine.acceptDefaultGeometry()
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.YES)
        repeat(6) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.advanceCutProbe()
        }
        machine.chooseCutProtocol(CutProtocol.GS_V_1)
        assertEquals(PrinterHomologationStep.CUT_FEED, machine.state.step)

        machine.goBack()
        machine.answerCutterPresence(PrinterCutterPresence.NO)
        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraSemSelecao))

        val perfil = machine.buildMeasuredProfile("sem guilhotina", setOf(PrinterTransport.USB), 1)
        assertEquals(CutProtocol.NONE, perfil.cutProtocol)
        assertEquals(0, perfil.cutFeedLines)
        assertFalse(perfil.hasCutter)
    }

    /**
     * Voltar não imprime, e o retrocesso não pode custar nada em papel enquanto ninguém o pede.
     *
     * O aviso da tela vem daqui: a etapa reaberta que imprime é anunciada antes do toque, e a que
     * não imprime — avanço de quem não tem guilhotina — não promete tira nenhuma.
     */
    @Test
    fun `voltar não envia sonda e anuncia a etapa que reimprime`() {
        val semGuilhotina = PrinterHomologationMachine(initialPaperWidthMm = 58)
        semGuilhotina.acceptDefaultGeometry()
        semGuilhotina.passRasterThroughputProbe()
        semGuilhotina.passNativeCodeProbe()
        semGuilhotina.answerCutterPresence(PrinterCutterPresence.NO)
        assertEquals(PrinterHomologationStep.CODE_PAGE, semGuilhotina.state.step)
        assertEquals(PrinterHomologationStep.CUT_PROTOCOL, semGuilhotina.previousStep)

        semGuilhotina.goBack()
        // Voltar deixa a etapa pronta para a pessoa decidir de novo; nada foi enviado por ele.
        assertEquals(PrinterHomologationPhase.READY, semGuilhotina.state.phase)

        val comGuilhotina = shortMachineAtCutFeed()
        assertEquals(PrinterHomologationStep.CUT_FEED, comGuilhotina.state.step)
        assertTrue(comGuilhotina.backReprintsProbes)
    }

    /**
     * O alcance novo do retrocesso: DONE ainda tem premissa anterior para desfazer.
     *
     * A tira de acentos é a última medida, e a letra escolhida nela só se prova no comprovante
     * final. Quem escolheu a letra errada chegava a DONE sem saída: a máquina recusava o
     * retrocesso, e a única correção era recomeçar. A etapa reaberta é a de texto, e ela reimprime
     * — nada sai por causa do "Voltar" em si.
     */
    @Test
    fun `o comprovante final volta para os acentos e a resposta nova é a que grava`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        machine.acceptDefaultGeometry()
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.NO)
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraN08))

        assertEquals(PrinterHomologationStep.DONE, machine.state.step)
        assertTrue(machine.canGoBack)
        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.previousStep)
        assertTrue(machine.backReprintsProbes)

        machine.goBack()

        assertEquals(
            PrinterHomologationState(
                PrinterHomologationStep.CODE_PAGE,
                PrinterHomologationPhase.READY,
            ),
            machine.state,
        )
        completeProbe(machine, PrinterHomologationAnswer.CodePage(letraSemAcentos))

        val perfil = machine.buildMeasuredProfile("corrigida", setOf(PrinterTransport.USB), 1)
        assertEquals(ThermalTextEncoding.ASCII, perfil.textEncoding)
        assertEquals(null, perfil.codePage)
        assertEquals(null, perfil.codePageSelector)
    }

    /**
     * Regressão de neutralidade: quem não toca em "Voltar" continua vendo as mesmas tiras.
     *
     * O retrocesso acrescenta uma transição à máquina, e a única prova de que ele não mexeu no
     * papel é comparar os bytes de um roteiro completo com os payloads das sondas.
     */
    @Test
    fun `o roteiro sem voltar mantém as tiras byte a byte`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        machine.acceptDefaultGeometry()
        // A tira nova entra na mesma conferência das outras: os bytes que a máquina emite são os
        // do construtor da sonda, na largura imprimível medida, e nada além disso.
        assertArrayEquals(
            PrinterHomologationProbes.rasterThroughput(384).bytes(),
            machine.beginSending().bytes(),
        )
        machine.finishSending(ThermalPrintResult.Printed)
        machine.answerRasterThroughputPrintedInFull()
        assertArrayEquals(
            PrinterHomologationProbes.nativeCode(384).bytes(),
            machine.beginSending().bytes(),
        )
        machine.finishSending(ThermalPrintResult.Printed)
        machine.skipNativeCodeMeasurement()
        machine.answerCutterPresence(PrinterCutterPresence.YES)
        repeat(6) {
            val protocolo = requireNotNull(machine.currentCutProbeProtocol)
            assertArrayEquals(
                PrinterHomologationProbes.isolatedCut(protocolo).bytes(),
                machine.beginSending().bytes(),
            )
            machine.finishSending(ThermalPrintResult.Printed)
            machine.advanceCutProbe()
        }
        machine.chooseCutProtocol(CutProtocol.GS_V_1)
        machine.confirmCutFeedBenchReady()
        assertArrayEquals(
            PrinterHomologationProbes.cutFeed(CutProtocol.GS_V_1).bytes(),
            machine.beginSending().bytes(),
        )
        machine.finishSending(ThermalPrintResult.Printed)
        machine.answer(PrinterHomologationAnswer.CutFeed(4))
        assertArrayEquals(
            PrinterHomologationProbes.codePages(CutProtocol.GS_V_1, 4).bytes(),
            machine.beginSending().bytes(),
        )
        machine.finishSending(ThermalPrintResult.Printed)
        machine.answer(PrinterHomologationAnswer.CodePage(letraN08))

        val perfil = machine.buildMeasuredProfile("sem voltar", setOf(PrinterTransport.USB), 1)
        assertEquals(58, perfil.paperWidthMm)
        assertEquals(32, perfil.printableColumns)
        assertEquals(384, perfil.printableDots)
        assertEquals(CutProtocol.GS_V_1, perfil.cutProtocol)
        assertEquals(4, perfil.cutFeedLines)
        assertEquals(ThermalCodePage.CP860, perfil.codePage)
        assertEquals(8, perfil.codePageSelector)
    }

    /**
     * A resposta da sonda atravessa a máquina até o perfil, e a chave de capacidade **não se move**.
     *
     * As duas coisas são o contrato desta etapa. A primeira é óbvia: medição que não alcança o
     * perfil é bobina gasta à toa. A segunda é o que impede a frente de partir o catálogo — a chave
     * é identidade de capacidade, e duas impressoras com as mesmas capacidades têm de compartilhar
     * chave. Estes dois campos não mudam byte nenhum sozinhos: quem muda os bytes é a preferência de
     * quem usa, e ela não mora no perfil. É a razão exata do `cutModeHonored` estar fora.
     */
    @Test
    fun `a resposta do código nativo chega ao perfil sem mover a chave de capacidade`() {
        fun perfilCom(resposta: PrinterHomologationAnswer.NativeCode?): MeasuredProfile {
            val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
            machine.acceptDefaultGeometry()
            machine.passRasterThroughputProbe()
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            if (resposta == null) machine.skipNativeCodeMeasurement() else machine.answer(resposta)
            machine.answerCutterPresence(PrinterCutterPresence.NO)
            completeProbe(machine, PrinterHomologationAnswer.CodePage(null))
            return machine.buildMeasuredProfile(
                displayName = "de bancada",
                transports = setOf(PrinterTransport.BLUETOOTH),
                measuredAtEpochMillis = 1,
                id = "00000000-0000-4000-8000-0000000000c1",
            )
        }

        val medido = perfilCom(PrinterHomologationAnswer.NativeCode(qrHonored = true, barcodeHonored = false))
        assertEquals(true, medido.nativeQrHonored)
        assertEquals(false, medido.nativeBarcodeHonored)
        // E a capacidade alcança o driver: sem isso a trava do layout veria `null` e o modo nativo
        // nunca sairia — a medição existiria e não chegaria ao papel.
        assertEquals(true, medido.toDriverProfile().nativeQrHonored)
        assertEquals(false, medido.toDriverProfile().nativeBarcodeHonored)

        // "Não consigo dizer" grava a ausência nos dois, e não um "não".
        val semResposta = perfilCom(null)
        assertEquals(null, semResposta.nativeQrHonored)
        assertEquals(null, semResposta.nativeBarcodeHonored)

        // A chave é a mesma nos três estados: quem já contribuiu continua casando.
        val negativo = perfilCom(PrinterHomologationAnswer.NativeCode(qrHonored = false, barcodeHonored = false))
        assertEquals(semResposta.capabilityKey, medido.capabilityKey)
        assertEquals(semResposta.capabilityKey, negativo.capabilityKey)
    }

    private fun completeProbe(
        machine: PrinterHomologationMachine,
        answer: PrinterHomologationAnswer,
    ) {
        // A sonda de vazão é obrigatória e não é o assunto da maior parte destes testes. Quem não
        // vem responder por ela atravessa com a tira inteira — o caso sem teto, que é o
        // comportamento de sempre. Os testes da sonda respondem por ela explicitamente.
        if (
            machine.state.step == PrinterHomologationStep.RASTER_THROUGHPUT &&
                answer !is PrinterHomologationAnswer.RasterThroughput
        ) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.answerRasterThroughputPrintedInFull()
        }
        // A sonda de código nativo é obrigatória pelo mesmo motivo — firmware não se adivinha — e
        // também não é o assunto da maior parte destes testes. Quem não vem responder por ela
        // atravessa por "não consigo dizer", que grava a ausência nos dois campos: o perfil que sai
        // é campo a campo o que estes testes sempre conferiram.
        if (
            machine.state.step == PrinterHomologationStep.NATIVE_CODE &&
                answer !is PrinterHomologationAnswer.NativeCode
        ) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.skipNativeCodeMeasurement()
        }
        if (
            answer is PrinterHomologationAnswer.Cut &&
                machine.state.step == PrinterHomologationStep.CUT_PROTOCOL &&
                machine.currentCutStage == PrinterCutProbeStage.ASKING_PRESENCE
        ) {
            if (answer.protocol == CutProtocol.NONE) {
                machine.answerCutterPresence(PrinterCutterPresence.NO)
                return
            }
            machine.answerCutterPresence(PrinterCutterPresence.YES)
        }
        machine.beginSending()
        machine.finishSending(ThermalPrintResult.Printed)
        machine.answer(answer)
    }
}

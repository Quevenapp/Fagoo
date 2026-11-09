package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A homologação passa a existir para a Diebold IM453H, e o que ela promete é o que ela emite.
 *
 * **O que estava quebrado.** Desde 24/08/2026 o assistente **recusava** este dialeto: as 16 sondas
 * eram ESC/POS de ponta a ponta, e mandá-las à IM453H — firmware sem um único comando `GS` — fez a
 * régua raster sair como dois metros de código e o aparelho parar de responder. A impressora só
 * entrava pela configuração manual, que adota sem medir: os 576 dots continuavam sendo convenção de
 * 80 mm, o `verticalRasterScale` continuava nulo e o avanço 4 era palpite.
 *
 * Esta suíte prende a série que fecha isso, e ela prende as quatro coisas que o papel cobra:
 *
 * 1. **nenhum byte ESC/POS** sai nesta série — é o defeito de 24/08, e é o único que custa aparelho;
 * 2. **as etapas que não têm tira honesta não abrem** — código nativo e página;
 * 3. **o corte é o `ESC w` medido**, o mesmo que fecha todo cupom de venda;
 * 4. **o dialeto atravessa a adoção** — sem isso a impressora homologada voltava a ESC/POS ao ser
 *    salva, e só o cupom seguinte mostraria, longe da causa.
 */
class HomologacaoProcompTest {
    private val serie = printerHomologationProbeSet(EscPosDialect.PROCOMP_ESC_P)

    /** Toda tira que a série Procomp sabe montar, com a geometria de 80 mm da IM453H. */
    private fun todasAsTiras(): List<PrinterProbe> =
        listOf(
            ProcompHomologationProbes.paperWidthRulers(),
            ProcompHomologationProbes.fullGeometry(),
            ProcompHomologationProbes.rasterThroughput(576),
            ProcompHomologationProbes.isolatedCut(),
            ProcompHomologationProbes.cutFeed(),
            ProcompHomologationProbes.finalReceipt(perfilProcomp()),
        ) + ProcompHomologationProbes.cutFeedStrips().map { it.probe }

    private fun perfilProcomp(
        cutProtocol: CutProtocol = CutProtocol.GS_V_1,
        cutFeedLines: Int = 4,
    ): MeasuredProfile =
        MeasuredProfile.createLocal(
            displayName = "Diebold IM453H",
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = null,
            cutProtocol = cutProtocol,
            cutFeedLines = cutFeedLines,
            measuredAtEpochMillis = 1_700_000_000_000,
            dialect = EscPosDialect.PROCOMP_ESC_P,
        )

    @Test
    fun `nenhuma tira da serie Procomp carrega comando ESC POS`() {
        // Cada sequência abaixo é uma das que a IM453H recebeu em 23 e 24/08/2026. `ESC @` saiu
        // como um `@` impresso; `GS v 0` e as demais deixaram o aparelho travado, com a tecla de
        // avanço morta e recuperação só no desligar e ligar.
        val proibidas =
            mapOf(
                "ESC @" to byteArrayOf(0x1B, 0x40),
                "GS v 0" to byteArrayOf(0x1D, 0x76, 0x30),
                "GS V" to byteArrayOf(0x1D, 0x56),
                "GS !" to byteArrayOf(0x1D, 0x21),
                "GS ( k" to byteArrayOf(0x1D, 0x28, 0x6B),
                "GS k" to byteArrayOf(0x1D, 0x6B),
                "GS I" to byteArrayOf(0x1D, 0x49),
                "ESC a" to byteArrayOf(0x1B, 0x61),
                "DLE EOT" to byteArrayOf(0x10, 0x04),
            )

        todasAsTiras().forEach { tira ->
            val bytes = tira.bytes()
            proibidas.forEach { (nome, sequencia) ->
                assertFalse(
                    "A tira de ${tira.size} bytes carrega $nome, que trava esta impressora.",
                    bytes.contemA(sequencia),
                )
            }
        }
    }

    @Test
    fun `toda tira da serie se declara Procomp`() {
        // É este campo que o portão do envio lê. Uma tira sem ele seria recusada pela proteção que
        // existe para ela — ou pior, uma tira ESC/POS passaria por Procomp.
        todasAsTiras().forEach { tira ->
            assertEquals(EscPosDialect.PROCOMP_ESC_P, tira.dialect)
        }
    }

    @Test
    fun `o corte de toda tira que corta e o ESC w medido`() {
        val escW = ProcompEscP.cut(ProcompCutCommand.ESC_W)
        assertEquals(listOf<Byte>(0x1B, 0x77), escW.toList())

        assertTrue(
            "A tira isolada de corte não termina na lâmina.",
            ProcompHomologationProbes.isolatedCut().bytes().terminaEm(escW),
        )
        ProcompHomologationProbes.cutFeedStrips().forEach { tira ->
            assertTrue(
                "A tira de avanço ${tira.feedLines} não termina na lâmina.",
                tira.probe.bytes().terminaEm(escW),
            )
        }
    }

    @Test
    fun `a regua de avanco sai inteira, um corte por valor medido`() {
        val tiras = ProcompHomologationProbes.cutFeedStrips()

        assertEquals(MeasuredProfile.CUT_FEED_CHOICES.toList(), tiras.map { it.feedLines })
        // O envio único é a concatenação das oito, e não uma nona tira montada de outro jeito.
        assertEquals(
            tiras.sumOf { it.probe.size },
            ProcompHomologationProbes.cutFeed().size,
        )
    }

    @Test
    fun `o comprovante final fecha pelo mesmo corte do cupom de venda`() {
        val perfil = perfilProcomp(cutFeedLines = 4)
        val fecho = ReceiptLayout.from(perfil.toDriverProfile()).finish()

        val comprovante = ProcompHomologationProbes.finalReceipt(perfil).bytes()

        // `finish()` no dialeto Procomp é `procompFinish`: quatro `LF` e `ESC w`. Se este papel saiu
        // cortado, o cupom de amanhã sai cortado pelos mesmos bytes — não há segundo caminho.
        assertEquals(listOf<Byte>(0x0A, 0x0A, 0x0A, 0x0A, 0x1B, 0x77), fecho.toList())
        assertTrue("O comprovante não termina pelo fecho do cupom.", comprovante.terminaEm(fecho))
    }

    @Test
    fun `sem guilhotina o comprovante avanca e nao corta`() {
        val semCorte = perfilProcomp(cutProtocol = CutProtocol.NONE, cutFeedLines = 0)

        val comprovante = ProcompHomologationProbes.finalReceipt(semCorte).bytes()

        assertFalse(
            "Saiu comando de corte numa impressora sem guilhotina.",
            comprovante.contemA(ProcompEscP.cut(ProcompCutCommand.ESC_W)),
        )
        assertTrue(comprovante.decodeToString().contains("Corte: sem guilhotina"))
    }

    @Test
    fun `a certidao nao afirma medicao que ninguem fez nesta impressora`() {
        // A folha sai **em ABICOMP**, não em UTF-8, então a conferência é por bytes: procurar
        // "avanço" numa `String` decodificada não acharia nada. Encodar a frase esperada pelo
        // mesmo encoder da impressora é o que faz este teste medir o papel.
        val papel = ProcompHomologationProbes.finalReceipt(perfilProcomp()).bytes()

        // O `GS_V_1` do perfil é o lugar do corte no formato comum, não uma medição: nenhum byte
        // `GS` chega aqui. A folha diz o comando que saiu.
        assertFalse("A folha imprime o nome de um comando ESC/POS.", papel.contemOTexto("GS_V_1"))
        assertTrue(papel.contemOTexto("Corte: ESC w (parcial) | avanço 4"))
        // Não há `ESC t` neste caminho: o texto sai na tabela de fábrica.
        assertTrue(papel.contemOTexto("Tabela: ABICOMP"))
        assertFalse(papel.contemOTexto("Codificação:"))
        // `GS I` é comando `GS`. Ninguém perguntou, e "não respondeu" seria afirmar a pergunta.
        assertTrue(papel.contemOTexto(ProcompHomologationProbes.IDENTITY_UNASKED))
        assertFalse(papel.contemOTexto("não respondeu"))
        // As duas capacidades que a série não mede saem nomeadas como não medidas.
        assertTrue(papel.contemOTexto("QR nativo: não medido"))
        assertTrue(papel.contemOTexto("Barras nativas: não medido"))
    }

    @Test
    fun `a sequencia pula codigo nativo e pagina, e a ESC POS continua medindo os dois`() {
        val procomp = PrinterHomologationMachine(80, EscPosDialect.PROCOMP_ESC_P)
        procomp.acceptDefaultGeometry()
        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, procomp.state.step)
        procomp.passRasterThroughputProbe()

        // Sem tira honesta de código nativo, a etapa não abre — e os dois campos ficam ausentes.
        assertEquals(PrinterHomologationStep.CUT_PROTOCOL, procomp.state.step)
        assertNull(procomp.currentNativeQrHonored)
        assertNull(procomp.currentNativeBarcodeHonored)

        procomp.answerCutterPresence(PrinterCutterPresence.NO)

        // E sem tira de página a medição termina aqui, em vez de perguntar o que o emissor descarta.
        assertEquals(PrinterHomologationStep.DONE, procomp.state.step)

        // O mutante: a série ESC/POS continua atravessando as duas etapas.
        val escpos = PrinterHomologationMachine(58, EscPosDialect.EPSON_COMPATIBLE)
        escpos.acceptDefaultGeometry()
        escpos.passRasterThroughputProbe()
        assertEquals(PrinterHomologationStep.NATIVE_CODE, escpos.state.step)
        escpos.passNativeCodeProbe()
        escpos.answerCutterPresence(PrinterCutterPresence.NO)
        assertEquals(PrinterHomologationStep.CODE_PAGE, escpos.state.step)
    }

    @Test
    fun `a sonda de corte manda um comando, e nao os seis do ESC POS`() {
        // Os dois cortes medidos nesta firmware — `ESC w` e `ESC US` — cortaram igual, e
        // `procompFinish` emite `ESC w` de qualquer jeito. Uma tira por comando seria papel gasto
        // numa escolha que o produto ignora.
        assertEquals(listOf(CutProtocol.GS_V_1), serie.cutCandidates)
        assertEquals(
            6,
            printerHomologationProbeSet(EscPosDialect.EPSON_COMPATIBLE).cutCandidates.size,
        )
    }

    @Test
    fun `a serie declara o que mede, e o que ela declara e o que ela monta`() {
        // As duas respostas não podem divergir: a máquina decide se entra na etapa pelo booleano e
        // monta a tira pela função.
        listOf(EscPosDialect.EPSON_COMPATIBLE, EscPosDialect.PROCOMP_ESC_P).forEach { dialeto ->
            val conjunto = printerHomologationProbeSet(dialeto)
            assertEquals(
                "measuresNativeCode discorda de nativeCode() em $dialeto.",
                conjunto.measuresNativeCode,
                conjunto.nativeCode(576) != null,
            )
            assertEquals(
                "measuresCodePage discorda de codePages() em $dialeto.",
                conjunto.measuresCodePage,
                conjunto.codePages(CutProtocol.NONE, 0) != null,
            )
        }
    }

    @Test
    fun `o papel anunciado conta as tiras que esta serie realmente manda`() {
        // Piso: largura, vazão e comprovante final. Teto: mais a régua completa, a tira de corte e
        // as oito de avanço.
        assertEquals(3, PrinterHomologationPaperCost.minimumStrips(EscPosDialect.PROCOMP_ESC_P))
        assertEquals(13, PrinterHomologationPaperCost.maximumStrips(EscPosDialect.PROCOMP_ESC_P))
        // A conta da série ESC/POS não se move, e é ela que o iOS e o Mac fixam.
        assertEquals(5, PrinterHomologationPaperCost.minimumStrips(EscPosDialect.EPSON_COMPATIBLE))
        assertEquals(20, PrinterHomologationPaperCost.maximumStrips(EscPosDialect.EPSON_COMPATIBLE))
    }

    @Test
    fun `homologar a Diebold adota um perfil Procomp, e nao um ESC POS`() = runTest {
        val store = InMemoryPrinterProfileStore()
        val enviados = mutableListOf<ByteArray>()
        var identidadesLidas = 0
        val flow =
            fluxoProcomp(
                store = store,
                enviados = enviados,
                identityReader = {
                    identidadesLidas += 1
                    PrinterDeclaredIdentity("1.0", "Diebold", "IM453H")
                },
            )

        flow.sendPaperWidthRulers()
        flow.choosePaperWidthFromPrintedRulers(80)
        flow.passRasterThroughputProbe()
        flow.answerCutterPresence(PrinterCutterPresence.YES)
        flow.sendAllCutProbes()
        flow.chooseCutProtocol(CutProtocol.GS_V_1)
        flow.confirmCutFeedBenchAndSend()
        flow.answer(PrinterHomologationAnswer.CutFeed(4))

        assertEquals(PrinterHomologationFlowPhase.FINAL_RECEIPT_READY, flow.state.value.phase)
        flow.sendFinalReceipt()
        flow.confirmFinalReceipt()

        val adotado = store.read().single()
        assertEquals(
            "A impressora homologada voltaria a falar ESC/POS no primeiro cupom depois de salva.",
            EscPosDialect.PROCOMP_ESC_P,
            adotado.dialect,
        )
        assertEquals(80, adotado.paperWidthMm)
        assertEquals(4, adotado.cutFeedLines)
        assertTrue(adotado.hasCutter)

        // `GS I` nunca foi ao fio: o leitor de identidade não chega a ser chamado neste dialeto.
        assertEquals(0, identidadesLidas)

        // Quatro envios: réguas de largura, vazão, a tira de corte, as oito de avanço num envio, e
        // o comprovante final.
        assertEquals(5, enviados.size)
        assertTrue(
            "Saiu byte ESC/POS para a Diebold ao longo da homologação inteira.",
            enviados.none { it.contemA(byteArrayOf(0x1D, 0x76, 0x30)) || it.contemA(byteArrayOf(0x1B, 0x40)) },
        )
    }

    @Test
    fun `recomecar depois de um comprovante errado nao volta para ESC POS`() = runTest {
        // Quem chega aqui já viu um papel sair errado. Uma máquina nova sem o dialeto mandaria
        // `GS v 0` à Diebold no exato momento em que a pessoa tenta consertar.
        val store = InMemoryPrinterProfileStore()
        val enviados = mutableListOf<ByteArray>()
        val flow = fluxoProcomp(store = store, enviados = enviados)

        flow.sendPaperWidthRulers()
        flow.choosePaperWidthFromPrintedRulers(80)
        flow.passRasterThroughputProbe()
        flow.answerCutterPresence(PrinterCutterPresence.NO)
        flow.sendFinalReceipt()
        flow.restartAfterFinalProblem()
        enviados.clear()

        flow.sendPaperWidthRulers()

        assertEquals(1, enviados.size)
        assertFalse(
            "A homologação recomeçada voltou a falar ESC/POS com a Diebold.",
            enviados.single().contemA(byteArrayOf(0x1D, 0x76, 0x30)) ||
                enviados.single().contemA(byteArrayOf(0x1B, 0x40)),
        )
    }

    @Test
    fun `a regua completa de geometria existe nesta serie`() {
        // É a tira que resolve os 576 dots "de convenção" e as 48 colunas que só uma régua de
        // bancada tinha visto. Ela precisa cobrir a largura desta impressora de ponta a ponta.
        val papel = ProcompHomologationProbes.fullGeometry().bytes().decodeToString()

        assertTrue(papel.contains("REGUA TEXTUAL 24 A 64"))
        assertTrue(papel.contains("576 DOTS"))
        assertTrue(papel.contains("640 DOTS"))
        assertNotNull(ProcompHomologationProbes.rasterThroughput(576))
    }

    private fun fluxoProcomp(
        store: PrinterProfileStore,
        enviados: MutableList<ByteArray>,
        identityReader: suspend () -> PrinterDeclaredIdentity? = { null },
    ): PrinterHomologationFlow {
        val target =
            PrinterHomologationTarget(
                transport = PrinterTransport.USB,
                displayName = "Diebold IM453H",
                profileId = "diebold.im453h.procomp",
                paperWidthMm = 80,
                dialect = EscPosDialect.PROCOMP_ESC_P,
                defaultStore = store,
                sender = { bytes ->
                    enviados += bytes.copyOf()
                    ThermalPrintResult.Printed
                },
                adopter = { },
                identityReader = identityReader,
            )
        return PrinterHomologationFlow(
            target = target,
            probeSession = target.openSession(),
            store = store,
            adopter = { },
            nowEpochMillis = { 1_700_000_000_000 },
        )
    }
}

private fun ByteArray.contemA(sequencia: ByteArray): Boolean {
    if (sequencia.isEmpty() || sequencia.size > size) return false
    for (inicio in 0..size - sequencia.size) {
        if (sequencia.indices.all { this[inicio + it] == sequencia[it] }) return true
    }
    return false
}

/** A frase como ela sai da impressora: pelo encoder do dialeto, e não em UTF-8. */
private fun ByteArray.contemOTexto(frase: String): Boolean =
    contemA(ProcompEscP.encode(frase, ProcompCodeTable.ABICOMP))

private fun ByteArray.terminaEm(sufixo: ByteArray): Boolean =
    size >= sufixo.size && sufixo.indices.all { this[size - sufixo.size + it] == sufixo[it] }

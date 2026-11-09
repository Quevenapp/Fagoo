package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A sonda que dá o fator de compensação vertical.
 *
 * O defeito medido em 20/08 na Inico T210 é raster largo saindo com 80% da altura declarada,
 * coerente, só encolhido — a mesma imagem de 45,7 KB sai com 97 mm na GoldenSky MTP-II e com 80 mm
 * nela. Vazão, banda, MTU, modo de escrita e cobertura foram eliminados por medição, um a um; o que
 * sobra é uma firmware que encolhe por um fator constante. Nada no enlace denuncia isso. O
 * instrumento é uma tira de altura declarada saindo do outro lado e uma régua na mão, e a conta que
 * traduz régua em fator está aqui.
 *
 * A tira, a pergunta e a resposta humana não mudaram desde 20/08 pela manhã; a **conclusão** mudou.
 * O teto de vazão que esta conta produzia continua no código, testado, para a rajada de 18/08 —
 * mas nenhuma sonda o define mais.
 */
class RasterThroughputProbeTest {
    /**
     * Relógio da bancada: o envio "custa" um tempo proporcional ao tamanho, e nada dorme.
     *
     * [microsPorByte] é o inverso da vazão simulada — 100 µs por byte são 10.000 bytes por segundo.
     */
    private class Bancada(private val microsPorByte: Long) {
        var micros = 0L
            private set

        fun agora(): Long = micros

        fun gastar(bytes: Int) {
            // Nunca zero: mesmo o envio mais rápido consome uma marca do relógio, e é assim que a
            // suíte consegue exercer o caso de vazão absurda sem cair no "não deu para medir".
            micros += (bytes.toLong() * microsPorByte).coerceAtLeast(1)
        }
    }

    private val alturaMm = PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM

    @Test
    fun `a tira tem largura cheia, altura declarada e trama de meio tom`() {
        val bytes = PrinterHomologationProbes.rasterThroughput(384).bytes()

        // A instrução vai em ASCII, como nas outras tiras, e **não** diz quanto ela deveria medir:
        // esse número é a resposta da pergunta, e quem lê a resposta antes de medir mede menos.
        val texto = bytes.toString(Charsets.US_ASCII)
        assertTrue(texto.contains("SONDA DE VAZAO"))
        assertTrue(texto.contains("Meca a altura do bloco"))
        assertEquals(-1, texto.indexOf("$alturaMm MM"))
        assertEquals(-1, texto.indexOf("${PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_DOTS} DOTS"))

        // Dezesseis faixas de 24 dots: exatamente a forma de bytes que o emissor de foto produz.
        val faixas = cabecalhosDeFaixa(bytes)
        assertEquals(
            PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_DOTS /
                EscPosRasterEmitter.RASTER_STRIPE_HEIGHT_DOTS,
            faixas.size,
        )
        faixas.forEach { (larguraBytes, altura) ->
            assertEquals(384 / 8, larguraBytes)
            assertEquals(EscPosRasterEmitter.RASTER_STRIPE_HEIGHT_DOTS, altura)
        }

        // Cobertura perto de 50%: nem papel em branco, que não mediria nada, nem preto sólido, que
        // castiga a cabeça e aciona proteção térmica — um segundo fenômeno em cima da medida.
        val pixels = pixelsDasFaixas(bytes)
        val pretos = pixels.sumOf { Integer.bitCount(it.toInt() and 0xFF) }
        val proporcaoPreta = pretos.toDouble() / (pixels.size * 8)
        assertTrue("Cobertura fora do meio tom: $proporcaoPreta", proporcaoPreta in 0.45..0.60)

        // Nenhuma linha inteira de branco: uma tira sem tinta não teria borda para a régua.
        assertTrue(pixels.none { it == 0.toByte() })

        // **A mesma tira nas duas plataformas.** Instrumento de medida com duas versões mede duas
        // impressoras diferentes com a mesma pergunta: a leitura de 46 mm num aparelho deixaria de
        // significar o que significa no outro. O iOS fixa este mesmo par em
        // `RasterThroughputProbeTests`, e conferido byte a byte em 20/08.
        assertEquals(18_667, bytes.size)
        assertEquals(RASTER_THROUGHPUT_STRIP_SHA256, sha256(bytes))
    }

    /** Largura cheia quer dizer a medida desta impressora, não a de 58 mm de todo mundo. */
    @Test
    fun `a tira acompanha a largura imprimível medida`() {
        val estreita = PrinterHomologationProbes.rasterThroughput(384).size
        val larga = PrinterHomologationProbes.rasterThroughput(576).size

        assertTrue(larga > estreita)
        assertThrows(IllegalArgumentException::class.java) {
            PrinterHomologationProbes.rasterThroughput(100)
        }
    }

    /** A tira mede, não decora: ela nem tem por onde receber cabeçalho e rodapé do hospedeiro. */
    @Test
    fun `a tira da sonda sai sem decoração do hospedeiro`() = runTest {
        val comGancho = mutableListOf<ByteArray>()
        val semGancho = mutableListOf<ByteArray>()
        val comDecoracao = fluxo(decoration = carimbo(), registro = comGancho)
        val semDecoracao = fluxo(registro = semGancho)

        atéAVazão(comDecoracao)
        atéAVazão(semDecoracao)

        val tiraDecorada = comGancho.single()
        val tiraLimpa = semGancho.single()
        assertArrayEquals(
            PrinterHomologationProbes.rasterThroughput(384).bytes(),
            tiraLimpa,
        )
        assertArrayEquals("A tira de vazão saiu decorada.", tiraLimpa, tiraDecorada)
    }

    /**
     * Tira inteira, nenhum fator: `null` é o comportamento de sempre, byte a byte.
     *
     * O piso de 0,97 tolera o ±1 mm de uma régua comum sem tolerar o defeito, que numa tira de
     * 48 mm come mais de um centímetro. Acima do piso o perfil fica **sem** fator, e não com um
     * fator de 0,98: compensação de 2% é ruído de régua virando alteração permanente de imagem.
     */
    @Test
    fun `proporção alta não grava fator`() = runTest {
        listOf(alturaMm, alturaMm - 1, 47).distinct().forEach { medida ->
            val fluxo = fluxo(microsPorByte = 100)
            atéAVazão(fluxo)
            fluxo.answer(PrinterHomologationAnswer.RasterThroughput(medida))

            assertEquals("$medida mm", null, fluxo.state.value.verticalRasterScale)
        }

        // E a resposta rápida é a leitura nominal, com o mesmo desfecho.
        val rapida = fluxo(microsPorByte = 100)
        atéAVazão(rapida)
        rapida.answerRasterThroughputPrintedInFull()
        assertEquals(null, rapida.state.value.verticalRasterScale)
    }

    /**
     * Metade da tira, fator de metade — e **sem margem nenhuma**.
     *
     * O teto de vazão tinha uma margem de 0,90, porque errar para cima devolvia o defeito e errar
     * para baixo só custava segundos. Aqui a assimetria não existe: compensar 10% a mais estica a
     * foto tanto quanto compensar 10% a menos a encolhe. A compensação quer o fator **medido**.
     */
    @Test
    fun `proporção baixa grava o fator medido, sem margem`() = runTest {
        val fluxo = fluxo(microsPorByte = 100)
        atéAVazão(fluxo)

        fluxo.answer(PrinterHomologationAnswer.RasterThroughput(alturaMm / 2))

        assertEquals(0.5, fluxo.state.value.verticalRasterScale!!, 1e-9)

        // E a T210 da bancada: 48 mm declarados, 38 medidos, fator 0,79 — não 0,71 de uma margem.
        val t210 = fluxo(microsPorByte = 100)
        atéAVazão(t210)
        t210.answer(PrinterHomologationAnswer.RasterThroughput(38))
        assertEquals(38.0 / alturaMm, t210.state.value.verticalRasterScale!!, 1e-9)
    }

    /**
     * A conclusão não depende mais da vazão medida, e é isso que a bancada de 20/08 pediu.
     *
     * A vazão continua sendo medida e publicada — medir não é concluir —, mas a régua sozinha
     * decide o fator. Com e sem número de transporte, a mesma leitura dá o mesmo fator.
     */
    @Test
    fun `a régua decide sozinha, com ou sem vazão medida`() {
        fun fatorCom(vazao: Int?): Double? {
            val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
            machine.acceptDefaultGeometry()
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed, measuredBytesPerSecond = vazao)
            machine.answer(PrinterHomologationAnswer.RasterThroughput(alturaMm / 2))
            // A vazão entrega a sonda de código nativo, que é a etapa seguinte desde que ela
            // entrou: as duas dependem da largura imprimível medida e nenhuma depende de guilhotina.
            assertEquals(PrinterHomologationStep.NATIVE_CODE, machine.state.step)
            return machine.currentVerticalRasterScale
        }

        assertEquals(0.5, requireNotNull(fatorCom(null)), 1e-9)
        assertEquals(fatorCom(null), fatorCom(10_000))
        assertEquals(fatorCom(null), fatorCom(500))
    }

    /** O fator é uma capacidade do perfil, e chega ao disco e ao layout pelo caminho normal. */
    @Test
    fun `o fator medido atravessa o perfil até o driver`() = runTest {
        val store = InMemoryPrinterProfileStore()
        val fluxo = fluxo(store = store, microsPorByte = 100)
        atéAVazão(fluxo)
        fluxo.answer(PrinterHomologationAnswer.RasterThroughput(alturaMm / 2))
        fluxo.passNativeCodeProbe()
        fluxo.answerCutterPresence(PrinterCutterPresence.NO)
        fluxo.sendCurrentProbe()
        fluxo.answer(PrinterHomologationAnswer.CodePage(null))
        fluxo.sendFinalReceipt()
        fluxo.confirmFinalReceipt()

        val perfil = store.read().single()
        assertEquals(0.5, perfil.verticalRasterScale!!, 1e-9)
        assertEquals(0.5, perfil.toDriverProfile().verticalRasterScale!!, 1e-9)
        assertEquals(0.5, ReceiptLayout.from(perfil.toDriverProfile()).verticalRasterScale!!, 1e-9)

        // E o teto de vazão continua nulo: nenhuma sonda o define desde 20/08.
        assertEquals(null, perfil.maxRasterBytesPerSecond)
        assertEquals(null, perfil.toDriverProfile().maxRasterBytesPerSecond)
    }

    /** O campo tem faixa aceita, e a conta cai dentro dela em vez de recusar o perfil no fim. */
    @Test
    fun `o fator calculado é preso na faixa aceita pelo campo`() = runTest {
        // Um milímetro de 48 seriam 0,02: a imagem sairia com cinquenta vezes a altura pedida, e o
        // que está errado é a leitura. O piso do campo para isso aqui, e não na hora de salvar.
        val absurdo = fluxo(microsPorByte = 100)
        atéAVazão(absurdo)
        absurdo.answer(PrinterHomologationAnswer.RasterThroughput(1))
        assertEquals(
            VERTICAL_RASTER_SCALE_RANGE.start,
            absurdo.state.value.verticalRasterScale!!,
            1e-9,
        )

        // E a maior leitura que ainda conclui fator sai exata, sem encostar em teto nenhum.
        val quaseInteira = fluxo(microsPorByte = 100)
        atéAVazão(quaseInteira)
        quaseInteira.answer(PrinterHomologationAnswer.RasterThroughput(46))
        assertEquals(46.0 / alturaMm, quaseInteira.state.value.verticalRasterScale!!, 1e-9)
    }

    @Test
    fun `leitura inválida é recusada`() {
        listOf(0, -1, alturaMm + 1, 1_000).forEach { medida ->
            val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
            machine.acceptDefaultGeometry()
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed, measuredBytesPerSecond = 10_000)

            assertThrows("$medida mm", IllegalArgumentException::class.java) {
                machine.answer(PrinterHomologationAnswer.RasterThroughput(medida))
            }
            // E a etapa continua aberta, esperando uma leitura que caiba na tira enviada.
            assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, machine.state.step)
            assertEquals(PrinterHomologationPhase.AWAITING_RESPONSE, machine.state.phase)
        }
    }

    /** Resposta antes do callback do transporte continua recusada, como em toda sonda. */
    @Test
    fun `a leitura só é aceita depois do envio terminar`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        machine.acceptDefaultGeometry()

        assertThrows(IllegalStateException::class.java) {
            machine.answer(PrinterHomologationAnswer.RasterThroughput(alturaMm))
        }
        machine.beginSending()
        assertThrows(IllegalStateException::class.java) {
            machine.answer(PrinterHomologationAnswer.RasterThroughput(alturaMm))
        }
    }

    /**
     * "Usar padrão" existe porque esta é a única etapa que pede régua **de fora**.
     *
     * As outras se leem na própria tira. Sem saída, quem não tem régua chutaria um número — e chute
     * vira fator gravado, que deforma toda imagem daquela impressora.
     */
    @Test
    fun `usar padrão conclui sem fator e grava o mesmo perfil de quem não mediu`() = runTest {
        val store = InMemoryPrinterProfileStore()
        val semRegua = fluxo(store = store, microsPorByte = 100)
        atéAVazão(semRegua)
        semRegua.skipRasterThroughputMeasurement()

        assertEquals(null, semRegua.state.value.verticalRasterScale)
        assertEquals(
            PrinterHomologationStep.NATIVE_CODE,
            semRegua.state.value.machineState.step,
        )

        semRegua.passNativeCodeProbe()
        semRegua.answerCutterPresence(PrinterCutterPresence.NO)
        semRegua.sendCurrentProbe()
        semRegua.answer(PrinterHomologationAnswer.CodePage(null))
        semRegua.sendFinalReceipt()
        semRegua.confirmFinalReceipt()

        val perfil = store.read().single()
        assertEquals(null, perfil.verticalRasterScale)
        assertEquals(null, perfil.toDriverProfile().verticalRasterScale)

        // **Nulo é nulo.** O perfil de quem escolheu "Usar padrão" é indistinguível, campo a campo,
        // do perfil que nunca viu esta sonda: sem valor "padrão" numérico e sem marcador de que
        // alguém pulou. As duas máquinas percorrem o mesmo roteiro e recebem o mesmo id e a mesma
        // data, então a igualdade é a do dado inteiro, não a de um campo escolhido a dedo.
        val comSonda = maquinaAtéDone { it.skipRasterThroughputMeasurement() }
        val semSonda = maquinaAtéDone { it.answerRasterThroughputPrintedInFull() }
        assertEquals(semSonda, comSonda)
        assertEquals(semSonda.capabilityKey, comSonda.capabilityKey)
        assertEquals(null, comSonda.verticalRasterScale)
    }

    /** Voltar reabre a etapa e apaga a medida; a próxima tira é que traz o número novo. */
    @Test
    fun `voltar desfaz a etapa da imagem sem imprimir nada`() = runTest {
        var envios = 0
        val fluxo = fluxo(microsPorByte = 100, aoEnviar = { envios += 1 })
        atéAVazão(fluxo)
        fluxo.answer(PrinterHomologationAnswer.RasterThroughput(alturaMm / 2))

        assertEquals(0.5, fluxo.state.value.verticalRasterScale!!, 1e-9)
        assertEquals(PrinterHomologationStep.RASTER_THROUGHPUT, fluxo.state.value.previousStep)
        // Papel gasto se anuncia antes: refazer a etapa manda a tira ao papel de novo.
        assertTrue(fluxo.state.value.backReprintsProbes)
        val enviosAntes = envios
        val antes = fluxo.state.value

        fluxo.goBack()

        assertEquals(enviosAntes, envios)
        assertNotEquals(antes, fluxo.state.value)
        assertEquals(
            PrinterHomologationStep.RASTER_THROUGHPUT,
            fluxo.state.value.machineState.step,
        )
        assertEquals(PrinterHomologationPhase.READY, fluxo.state.value.machineState.phase)
        assertEquals(null, fluxo.state.value.measuredRasterBytesPerSecond)
        assertEquals(null, fluxo.state.value.verticalRasterScale)

        // E a tira nova é que decide de novo: agora ela sai inteira, e o fator some.
        atéAVazão(fluxo, jáEnviouGeometria = true)
        fluxo.answerRasterThroughputPrintedInFull()
        assertEquals(null, fluxo.state.value.verticalRasterScale)
    }

    /** O perfil homologado antes desta conclusão continua sem fator até ser remedido. */
    @Test
    fun `perfil sem a sonda continua sem fator`() {
        val herdado =
            MeasuredProfile.createLocal(
                displayName = "Homologada antes da sonda",
                transports = setOf(PrinterTransport.BLUETOOTH),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                codePage = null,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        assertEquals(null, herdado.verticalRasterScale)
        assertEquals(null, herdado.toDriverProfile().verticalRasterScale)
        assertEquals(null, ReceiptLayout.from(herdado.toDriverProfile()).verticalRasterScale)
    }

    /**
     * A régua atravessa a máquina, o disco e sai **escrita** no comprovante final.
     *
     * Este é o fio que sustenta reconstruir o milímetro a partir do fator em vez de guardá-lo num
     * campo novo: quem respondeu 38 na tira precisa ler 38 no papel, depois do arredondamento, da
     * gravação e da releitura. Se a conta perdesse o número, é aqui que apareceria.
     *
     * A T210 da bancada, 20/08: 38 mm de 48 na régua, fator 0,79 no perfil.
     */
    @Test
    fun `a leitura da régua sai escrita no comprovante final`() = runTest {
        suspend fun papelDe(naVazão: suspend (PrinterHomologationFlow) -> Unit): String {
            val store = InMemoryPrinterProfileStore()
            val fluxo = fluxo(store = store, microsPorByte = 100)
            atéAVazão(fluxo)
            naVazão(fluxo)
            fluxo.passNativeCodeProbe()
            fluxo.answerCutterPresence(PrinterCutterPresence.NO)
            fluxo.sendCurrentProbe()
            fluxo.answer(PrinterHomologationAnswer.CodePage(null))
            fluxo.sendFinalReceipt()
            fluxo.confirmFinalReceipt()
            // Do disco, e não do rascunho: é o perfil relido que o app usa daqui a um mês.
            val relido = store.read().single()
            return String(PrinterHomologationProbes.finalReceipt(relido).bytes(), Charsets.UTF_8)
        }

        // Sem página medida — a resposta `null` é a linha `a` da tira, o piso ASCII —, o encoder
        // dobra os acentos sozinho e a linha continua legível. É a outra metade da regra: nenhum
        // caractere que a página não tenha. Com CP850 ela sai acentuada, e isso está fixado em
        // `PrinterHomologationProbesTest`.
        val medida = papelDe { it.answer(PrinterHomologationAnswer.RasterThroughput(38)) }
        assertTrue(medida, medida.contains("Vazao: 38/48 mm | fator 0,79"))

        // "Usar padrão": nada a citar, e a linha continua saindo. É a MTP-II do cheque de papel.
        val semRegua = papelDe { it.skipRasterThroughputMeasurement() }
        assertTrue(semRegua, semRegua.contains("Vazao: sem compensacao"))
        assertFalse(semRegua.contains("fator"))
    }

    /** Carimbo do hospedeiro, o mesmo formato que o comprovante final recebe. */
    private fun carimbo(): ReceiptDecoration =
        object : ReceiptDecoration {
            override fun header(layout: ReceiptLayout): ByteArray =
                layout.text(
                    "Cabecalho do app\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.NORMAL,
                    ThermalTextSize.NORMAL,
                )

            override fun footer(layout: ReceiptLayout): ByteArray =
                layout.text(
                    "Rodape do app\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.NORMAL,
                    ThermalTextSize.NORMAL,
                )
        }

    private fun maquinaAtéDone(
        naVazão: (PrinterHomologationMachine) -> Unit,
    ): MeasuredProfile {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        machine.acceptDefaultGeometry()
        machine.beginSending()
        machine.finishSending(ThermalPrintResult.Printed, measuredBytesPerSecond = 10_000)
        naVazão(machine)
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.NO)
        machine.beginSending()
        machine.finishSending(ThermalPrintResult.Printed)
        machine.answer(PrinterHomologationAnswer.CodePage(null))
        return machine.buildMeasuredProfile(
            displayName = "Igual dos dois lados",
            transports = setOf(PrinterTransport.USB),
            measuredAtEpochMillis = 1,
            id = "00000000-0000-4000-8000-000000000042",
        )
    }

    /** Leva o fluxo até a tira de vazão já impressa, aguardando a leitura da régua. */
    private suspend fun atéAVazão(
        fluxo: PrinterHomologationFlow,
        jáEnviouGeometria: Boolean = false,
    ) {
        if (!jáEnviouGeometria) fluxo.acceptDefaultGeometry()
        fluxo.sendCurrentProbe()
    }

    private fun fluxo(
        store: PrinterProfileStore = InMemoryPrinterProfileStore(),
        microsPorByte: Long = 100,
        decoration: ReceiptDecoration? = null,
        registro: MutableList<ByteArray>? = null,
        aoEnviar: () -> Unit = {},
    ): PrinterHomologationFlow {
        val bancada = Bancada(microsPorByte)
        val target =
            PrinterHomologationTarget(
                transport = PrinterTransport.BLUETOOTH_LE,
                displayName = "Impressora de bancada",
                profileId = BundledPrinterDrivers.portable58mm.id,
                defaultStore = store,
                sender = { bytes ->
                    aoEnviar()
                    registro?.add(bytes.copyOf())
                    bancada.gastar(bytes.size)
                    ThermalPrintResult.Printed
                },
                adopter = {},
                receiptDecoration = decoration,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        return PrinterHomologationFlow(
            target = target,
            probeSession = target.openSession(bancada::agora),
            store = store,
            adopter = {},
            nowEpochMillis = { 1 },
        )
    }

    /** A tira de 384 dots, byte a byte, como as duas plataformas a emitem. */
    private val RASTER_THROUGHPUT_STRIP_SHA256 =
        "ef414daa4c4b5d3a4033ac755f4a3ed15daa2cb3a7b536b276a4a862a0e3a217"

    private fun sha256(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    /** Cabeçalhos `GS v 0` da tira: pares de (largura em bytes, altura em dots). */
    private fun cabecalhosDeFaixa(bytes: ByteArray): List<Pair<Int, Int>> =
        posicoesDasFaixas(bytes).map { inicio ->
            val larguraBytes = (bytes[inicio + 4].toInt() and 0xFF) or
                ((bytes[inicio + 5].toInt() and 0xFF) shl 8)
            val altura = (bytes[inicio + 6].toInt() and 0xFF) or
                ((bytes[inicio + 7].toInt() and 0xFF) shl 8)
            larguraBytes to altura
        }

    private fun pixelsDasFaixas(bytes: ByteArray): ByteArray {
        val saida = mutableListOf<Byte>()
        posicoesDasFaixas(bytes).forEach { inicio ->
            val larguraBytes = (bytes[inicio + 4].toInt() and 0xFF) or
                ((bytes[inicio + 5].toInt() and 0xFF) shl 8)
            val altura = (bytes[inicio + 6].toInt() and 0xFF) or
                ((bytes[inicio + 7].toInt() and 0xFF) shl 8)
            val corpo = inicio + 8
            saida += bytes.copyOfRange(corpo, corpo + larguraBytes * altura).toList()
        }
        return saida.toByteArray()
    }

    private fun posicoesDasFaixas(bytes: ByteArray): List<Int> {
        val posicoes = mutableListOf<Int>()
        var indice = 0
        while (indice + 8 <= bytes.size) {
            if (
                bytes[indice] == 0x1D.toByte() &&
                bytes[indice + 1] == 0x76.toByte() &&
                bytes[indice + 2] == 0x30.toByte() &&
                bytes[indice + 3] == 0x00.toByte()
            ) {
                val larguraBytes = (bytes[indice + 4].toInt() and 0xFF) or
                    ((bytes[indice + 5].toInt() and 0xFF) shl 8)
                val altura = (bytes[indice + 6].toInt() and 0xFF) or
                    ((bytes[indice + 7].toInt() and 0xFF) shl 8)
                posicoes += indice
                indice += 8 + larguraBytes * altura
            } else {
                indice += 1
            }
        }
        return posicoes
    }
}

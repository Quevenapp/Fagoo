package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterCutProbeStage
import br.com.thermalprinterkit.PrinterHomologationFlowPhase
import br.com.thermalprinterkit.PrinterHomologationPath
import br.com.thermalprinterkit.PrinterHomologationPhase
import br.com.thermalprinterkit.PrinterHomologationState
import br.com.thermalprinterkit.PrinterHomologationStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O "Voltar" da etapa não decide nada: ele só mostra o que a máquina respondeu.
 *
 * Estes testes fixam a habilitação por etapa e a frase que anuncia o papel — a parte da tela que dá
 * para provar sem pixel. Quem decide se há etapa anterior, e se refazê-la imprime, é a máquina de
 * homologação, e por isso o snapshot só carrega a resposta dela.
 */
class PrinterHomologationBackStepTest {
    @Test
    fun `a primeira etapa não oferece voltar`() {
        val naLargura =
            snapshot(
                step = PrinterHomologationStep.WIDTH,
                canGoBack = false,
                previousStep = null,
            )

        assertFalse(naLargura.offersBackStep)
        assertEquals(null, naLargura.backStepNotice())
    }

    @Test
    fun `cada etapa depois da primeira oferece voltar para a anterior`() {
        val etapas =
            listOf(
                PrinterHomologationStep.GEOMETRY to PrinterHomologationStep.WIDTH,
                PrinterHomologationStep.RASTER_THROUGHPUT to PrinterHomologationStep.GEOMETRY,
                // NATIVE_CODE entra aqui na máquina: depois da vazão, porque a largura de módulo
                // sai da área imprimível medida, e antes do corte, porque não depende de guilhotina.
                PrinterHomologationStep.NATIVE_CODE to PrinterHomologationStep.RASTER_THROUGHPUT,
                PrinterHomologationStep.CUT_PROTOCOL to PrinterHomologationStep.NATIVE_CODE,
                PrinterHomologationStep.CUT_FEED to PrinterHomologationStep.CUT_PROTOCOL,
                PrinterHomologationStep.CODE_PAGE to PrinterHomologationStep.CUT_FEED,
            )

        etapas.forEach { (atual, anterior) ->
            val snapshot = snapshot(step = atual, canGoBack = true, previousStep = anterior)

            assertTrue(atual.name, snapshot.offersBackStep)
            assertEquals(
                "Volta para ${anterior.uiLabel()} e apaga as respostas desta etapa em diante.",
                snapshot.backStepNotice(),
            )
        }
    }

    /** Papel gasto: anunciar antes. A frase sai antes do toque, não depois de a tira sair. */
    @Test
    fun `a etapa que reimprime é anunciada antes do toque`() {
        val comReimpressao =
            snapshot(
                step = PrinterHomologationStep.CUT_FEED,
                canGoBack = true,
                previousStep = PrinterHomologationStep.CUT_PROTOCOL,
                backReprintsProbes = true,
            )
        val semReimpressao =
            comReimpressao.copy(backReprintsProbes = false)

        assertEquals(
            "Volta para Corte e apaga as respostas desta etapa em diante. " +
                "As tiras desta etapa sairão de novo.",
            comReimpressao.backStepNotice(),
        )
        assertFalse(
            requireNotNull(semReimpressao.backStepNotice()).contains("sairão de novo"),
        )
    }

    /** Enquanto uma sonda está no ar, ou uma falha espera decisão, o retrocesso não aparece. */
    @Test
    fun `envio em curso e falha pendente não oferecem voltar`() {
        val enviando =
            snapshot(
                step = PrinterHomologationStep.CUT_FEED,
                phase = PrinterHomologationPhase.SENDING,
                canGoBack = false,
                previousStep = PrinterHomologationStep.CUT_PROTOCOL,
            )

        assertFalse(enviando.offersBackStep)
        assertEquals(null, enviando.backStepNotice())
    }

    /**
     * A tela do comprovante final oferece Voltar até a confirmação humana, e não depois dela.
     *
     * Quem decide é o fluxo, que conhece o comprovante; o snapshot só carrega a resposta. Aqui se
     * fixa que a tela pergunta a mesma coisa em DONE que perguntaria em qualquer etapa — e que o
     * aviso aponta para os acentos, a última medida antes do comprovante.
     */
    @Test
    fun `o comprovante final oferece voltar até a confirmação`() {
        val antesDaConfirmacao =
            snapshot(
                step = PrinterHomologationStep.DONE,
                phase = PrinterHomologationPhase.DONE,
                canGoBack = true,
                previousStep = PrinterHomologationStep.CODE_PAGE,
                backReprintsProbes = true,
                flowPhase = PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
            )

        assertTrue(antesDaConfirmacao.offersBackStep)
        assertEquals(
            "Volta para Texto e apaga as respostas desta etapa em diante. " +
                "As tiras desta etapa sairão de novo.",
            antesDaConfirmacao.backStepNotice(),
        )

        // Instalação concluída é concluída: o fluxo fecha o retrocesso e a tela obedece.
        val depoisDaConfirmacao =
            antesDaConfirmacao.copy(
                canGoBack = false,
                flowPhase = PrinterHomologationFlowPhase.FINISHED,
            )

        assertFalse(depoisDaConfirmacao.offersBackStep)
        assertEquals(null, depoisDaConfirmacao.backStepNotice())
    }

    @Test
    fun `o rótulo da etapa é o mesmo do roteiro de progresso`() {
        assertEquals("Largura", PrinterHomologationStep.WIDTH.uiLabel())
        assertEquals("Geometria avançada", PrinterHomologationStep.GEOMETRY.uiLabel())
        assertEquals(
            "Altura da imagem",
            PrinterHomologationStep.RASTER_THROUGHPUT.uiLabel(),
        )
        assertEquals("Código nativo", PrinterHomologationStep.NATIVE_CODE.uiLabel())
        assertEquals("Corte", PrinterHomologationStep.CUT_PROTOCOL.uiLabel())
        assertEquals("Avanço", PrinterHomologationStep.CUT_FEED.uiLabel())
        assertEquals("Texto", PrinterHomologationStep.CODE_PAGE.uiLabel())
    }

    private fun snapshot(
        step: PrinterHomologationStep,
        canGoBack: Boolean,
        previousStep: PrinterHomologationStep?,
        backReprintsProbes: Boolean = false,
        phase: PrinterHomologationPhase = PrinterHomologationPhase.READY,
        flowPhase: PrinterHomologationFlowPhase = PrinterHomologationFlowPhase.MEASURING,
    ): PrinterHomologationUiSnapshot =
        PrinterHomologationUiSnapshot(
            machineState = PrinterHomologationState(step, phase),
            geometry = MeasuredProfile.geometryDefaults(58),
            cutProtocol = CutProtocol.NONE,
            path = PrinterHomologationPath.SHORT,
            cutStage = PrinterCutProbeStage.ASKING_PRESENCE,
            cutProbeProtocol = null,
            successfulCutProtocols = emptyList(),
            attemptedCutProtocols = emptyList(),
            cutMeasurementFailed = false,
            cutFeedChoices = listOf(0),
            requiresCutFeedBenchConfirmation = false,
            measuredRasterBytesPerSecond = null,
            verticalRasterScale = null,
            canGoBack = canGoBack,
            previousStep = previousStep,
            backReprintsProbes = backReprintsProbes,
            flowPhase = flowPhase,
            failure = null,
            measuredProfile = null,
            finalReceiptWarning = null,
        )
}

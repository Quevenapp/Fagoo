package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Quantas tiras a etapa de corte gasta. Papel é o recurso escasso da bancada, e "quantas tiras isso
 * vai imprimir" precisa ter resposta fixa e verificável, não surpresa na mesa.
 */
class CutProbePaperCostTest {
    private fun tirasAteEscolherCorte(path: PrinterHomologationPath): Int {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        if (path == PrinterHomologationPath.ADVANCED) {
            machine.startAdvancedPath()
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            machine.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
            machine.passRasterThroughputProbe()
            machine.passNativeCodeProbe()
            machine.answerCutterPresence(PrinterCutterPresence.YES)
        } else {
            machine.acceptDefaultGeometry()
            machine.passRasterThroughputProbe()
            machine.passNativeCodeProbe()
            machine.answerCutterPresence(PrinterCutterPresence.YES)
        }
        var tiras = 0
        while (machine.state.step == PrinterHomologationStep.CUT_PROTOCOL &&
            machine.currentCutStage == PrinterCutProbeStage.PROBING
        ) {
            machine.beginSending()
            machine.finishSending(ThermalPrintResult.Printed)
            tiras += 1
            machine.advanceCutProbe()
        }
        return tiras
    }

    /**
     * Seis tiras nos dois caminhos, sempre.
     *
     * Parar no primeiro que corta gastava menos papel e escondia o que a impressora faz nos outros
     * — e deixava a escolha sem comparação. Decidido em 12/08, à vista das tiras da LUOGAO.
     */
    @Test
    fun `os dois caminhos imprimem os seis dialetos antes da escolha`() {
        assertEquals(6, PrinterHomologationProbes.cutProtocolCandidates.count { it.commandBytes() != null })
        assertEquals(6, tirasAteEscolherCorte(PrinterHomologationPath.SHORT))
        assertEquals(6, tirasAteEscolherCorte(PrinterHomologationPath.ADVANCED))
    }

    /** Sem guilhotina declarada, nenhuma tira sai: a pergunta gratuita continua valendo papel. */
    @Test
    fun `sem guilhotina a etapa não imprime nada`() {
        val machine = PrinterHomologationMachine(initialPaperWidthMm = 58)
        machine.acceptDefaultGeometry()
        machine.passRasterThroughputProbe()
        machine.passNativeCodeProbe()
        machine.answerCutterPresence(PrinterCutterPresence.NO)

        assertEquals(PrinterHomologationStep.CODE_PAGE, machine.state.step)
        assertEquals(CutProtocol.NONE, machine.currentCutProtocol)
    }
}

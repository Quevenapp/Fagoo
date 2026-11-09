package br.com.thermalprinterkit

/**
 * A sonda de vazão sai em toda homologação, e estes atalhos dizem o que ela significa nos testes
 * que medem outra coisa.
 *
 * A etapa é obrigatória porque o descarte de linha não avisa por marca: não há lista de modelos
 * afetados, há impressora medida. Os testes que já existiam medem geometria, corte, avanço e
 * página, e nenhum deles fala de vazão — então atravessam a etapa pelo caso comum, "saiu do tamanho
 * certo", que é exatamente o perfil sem teto que eles sempre conferiram. Quem mede vazão responde
 * pela régua na mão, sem passar por aqui.
 */
internal fun PrinterHomologationMachine.passRasterThroughputProbe() {
    check(state.step == PrinterHomologationStep.RASTER_THROUGHPUT) {
        "A máquina não está na sonda de vazão."
    }
    beginSending()
    finishSending(ThermalPrintResult.Printed)
    answerRasterThroughputPrintedInFull()
}

internal suspend fun PrinterHomologationFlow.passRasterThroughputProbe() {
    check(state.value.machineState.step == PrinterHomologationStep.RASTER_THROUGHPUT) {
        "O fluxo não está na sonda de vazão."
    }
    sendCurrentProbe()
    answerRasterThroughputPrintedInFull()
}

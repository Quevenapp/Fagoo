package br.com.thermalprinterkit

/**
 * A sonda de código nativo sai em toda homologação, e estes atalhos dizem o que ela significa nos
 * testes que medem outra coisa.
 *
 * A etapa é obrigatória porque firmware não se adivinha: não há lista de modelos que honram
 * `GS ( k`, há impressora medida. Os testes que já existiam medem geometria, vazão, corte, avanço e
 * página, e nenhum deles fala de código nativo — então atravessam a etapa por "não consigo dizer",
 * que grava a ausência nos dois campos e devolve **exatamente** o perfil que eles sempre
 * conferiram. Quem mede código nativo responde a sonda, sem passar por aqui.
 */
internal fun PrinterHomologationMachine.passNativeCodeProbe() {
    check(state.step == PrinterHomologationStep.NATIVE_CODE) {
        "A máquina não está na sonda de código nativo."
    }
    beginSending()
    finishSending(ThermalPrintResult.Printed)
    skipNativeCodeMeasurement()
}

internal suspend fun PrinterHomologationFlow.passNativeCodeProbe() {
    check(state.value.machineState.step == PrinterHomologationStep.NATIVE_CODE) {
        "O fluxo não está na sonda de código nativo."
    }
    sendCurrentProbe()
    skipNativeCodeMeasurement()
}

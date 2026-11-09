import Foundation
@testable import ThermalPrinterKit

/// A sonda de vazão sai em toda homologação, e este atalho diz o que ela significa nos testes que
/// medem outra coisa.
///
/// O passo é obrigatório porque o descarte de linha não avisa por marca: não há lista de modelos
/// afetados, há impressora medida. Os testes que já existiam medem geometria, corte, avanço e
/// página, e nenhum deles fala de vazão — então atravessam o passo pelo caso comum, "saiu do
/// tamanho certo", que é exatamente o perfil sem teto que eles sempre conferiram. Quem mede vazão
/// responde pela régua na mão, sem passar por aqui.
func passRasterThroughputProbe(_ machine: PrinterHomologationMachine) throws {
    _ = try machine.beginSending()
    try machine.sendingCompleted(success: true)
    try machine.answerRasterThroughputPrintedInFull()
}

/// A leitura nominal da tira, para os testes de sessão reutilizarem o `sendAndAnswer` deles.
let nominalRasterThroughputResponse = PrinterHomologationResponse.rasterThroughput(
    printedLengthMillimetres: PrinterProbePayloads.rasterThroughputStripMillimetres
)

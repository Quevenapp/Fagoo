import Foundation
@testable import ThermalPrinterKit

/// A sonda de código nativo sai em toda homologação, e este atalho diz o que ela significa nos
/// testes que medem outra coisa.
///
/// O passo é obrigatório porque firmware não se adivinha: não há lista de modelos que honram
/// `GS ( k`, há impressora medida. Os testes que já existiam medem geometria, vazão, corte, avanço e
/// página, e nenhum deles fala de código nativo — então atravessam o passo por "não consigo dizer",
/// que grava a ausência nos dois campos e devolve **exatamente** o perfil que eles sempre
/// conferiram. Quem mede código nativo responde a sonda, sem passar por aqui.
func passNativeCodeProbe(_ machine: PrinterHomologationMachine) throws {
    _ = try machine.beginSending()
    try machine.sendingCompleted(success: true)
    try machine.skipNativeCodeMeasurement()
}

/// A resposta afirmativa nos dois blocos, para os testes de sessão que precisam de um valor medido.
let bothNativeCodesDrawnResponse = PrinterHomologationResponse.nativeCode(
    qrHonored: true,
    barcodeHonored: true
)

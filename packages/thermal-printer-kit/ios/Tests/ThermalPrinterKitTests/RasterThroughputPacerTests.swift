import Foundation
import XCTest
@testable import ThermalPrinterKit

/**
 O ritmo do raster, exercido sem impressora e sem esperar de verdade.

 É o **mesmo** ``RasterThroughputPacer`` que o `CoreBluetoothPrinterTransport` usa. Uma cópia da
 regra aqui deixaria a suíte verde enquanto o transporte solta a foto na velocidade do enlace — que
 é o defeito medido na T210 em 20/08, com a foto de 28 KB saindo 22% mais curta e coerente.
 */
final class RasterThroughputPacerTests: XCTestCase {
    /// Um relógio que anda quando o teste manda, do jeito que o transporte andaria com `asyncAfter`.
    private struct Bancada {
        var agora: TimeInterval = 0
        var pacer: RasterThroughputPacer

        init(bytesPerSecond: Int?) {
            pacer = RasterThroughputPacer(bytesPerSecond: bytesPerSecond)
        }

        /// Um bloco do jeito que o `pump` o solta: espera o que o teto pedir e registra a saída.
        @discardableResult
        mutating func bloco(_ bytes: Int) -> TimeInterval {
            let espera = pacer.delay(at: agora)
            agora += espera
            pacer.recordChunk(bytes: bytes, at: agora)
            return espera
        }
    }

    func testSemTetoNinguemEspera() {
        var bancada = Bancada(bytesPerSecond: nil)

        for _ in 0..<200 { bancada.bloco(244) }

        XCTAssertFalse(bancada.pacer.paces)
        XCTAssertEqual(bancada.agora, 0)
    }

    func testOPrimeiroBlocoSaiNaHora() {
        var bancada = Bancada(bytesPerSecond: 8_192)

        XCTAssertEqual(bancada.bloco(244), 0)
    }

    /// A foto do cachorro, em blocos de MTU: bytes por segundo efetivos não podem passar do teto.
    func testAFotoInteiraRespeitaOTetoDeclarado() {
        let teto = 8_192
        let bloco = 244
        let blocos = 120
        var bancada = Bancada(bytesPerSecond: teto)

        for _ in 0..<blocos { bancada.bloco(bloco) }

        // O primeiro bloco não espera, então a taxa se mede sobre o que veio depois dele.
        let vazao = Double(bloco * (blocos - 1)) / bancada.agora
        XCTAssertLessThanOrEqual(vazao, Double(teto))
        XCTAssertGreaterThan(bancada.agora, 0)
    }

    /// Baixar o teto precisa custar tempo proporcional; é isso que a bancada vai enxergar no papel.
    func testMetadeDoTetoCustaODobroDoTempo() {
        var rapido = Bancada(bytesPerSecond: 16_384)
        var lento = Bancada(bytesPerSecond: 8_192)

        for _ in 0..<64 {
            rapido.bloco(256)
            lento.bloco(256)
        }

        XCTAssertEqual(lento.agora, 2 * rapido.agora, accuracy: 0.000_001)
    }

    /**
     Transporte já lento não vira crédito.

     Se o atraso do rádio fosse guardado como saldo, o bloco seguinte sairia em rajada — e rajada é
     o próprio defeito que o teto existe para conter.
     */
    func testAtrasoDoTransporteNaoViraRajadaDepois() {
        var bancada = Bancada(bytesPerSecond: 8_192)

        bancada.bloco(256)
        bancada.agora += 0.5 // o rádio demorou muito mais que os 31 ms do teto
        let depoisDoAtraso = bancada.bloco(256)
        let seguinte = bancada.bloco(256)

        XCTAssertEqual(depoisDoAtraso, 0)
        XCTAssertEqual(seguinte, 256.0 / 8_192.0, accuracy: 0.000_001)
    }

    /// Teto fora da faixa não vira espera absurda: quem recusa perfil é o tipo que valida
    /// capacidade, e ele já recusou antes de o valor chegar ao disco.
    func testTetoForaDaFaixaNaoFreiaNada() {
        XCTAssertFalse(RasterThroughputPacer(bytesPerSecond: 0).paces)
        XCTAssertFalse(RasterThroughputPacer(bytesPerSecond: -1).paces)
        XCTAssertTrue(RasterThroughputPacer(bytesPerSecond: 8_192).paces)
    }
}

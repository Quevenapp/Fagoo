import Foundation
import XCTest
@testable import ThermalPrinterKit

/// A lista do iOS numerava as candidatas — "Impressora Bluetooth 1" e "2" — e escolher entre duas
/// impressoras viradas para cima na mesa virava adivinhação. O Android já mostrava o nome real
/// anunciado; era divergência.
final class BluetoothCandidateLabelTests: XCTestCase {
    func testNomeAnunciadoVenceANumeracao() {
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.candidateLabel("MTP-II_BD7E", position: 1),
            "MTP-II_BD7E"
        )
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.candidateLabel("T210_D0E9", position: 2),
            "T210_D0E9"
        )
    }

    /// A numeração serve para a tela; para batizar um perfil, só o nome de verdade. Sem esta
    /// distinção o perfil medido nasceria "Impressora Bluetooth 1", que é pior que temporária.
    func testNumeracaoNaoBatizaPerfil() {
        XCTAssertNil(CoreBluetoothPrinterTransport.declaredName(nil))
        XCTAssertNil(CoreBluetoothPrinterTransport.declaredName("AA:BB:CC:DD:EE:FF"))
        XCTAssertEqual(CoreBluetoothPrinterTransport.declaredName("MTP-II_BD7E"), "MTP-II_BD7E")
    }

    func testSemNomeAceitavelSobraANumeracao() {
        for nome in [nil, "", "   ", "AA:BB:CC:DD:EE:FF", "192.168.1.150"] as [String?] {
            XCTAssertEqual(
                CoreBluetoothPrinterTransport.candidateLabel(nome, position: 3),
                "Impressora Bluetooth 3",
                nome ?? "nil"
            )
        }
    }

    /// A candidata leva o identificador do periférico para a adoção poder guardá-lo, e ele
    /// continua fora de tudo que alguém lê: rótulo, nome de perfil e `description`.
    func testIdentificadorDoPerifericoNaoAparaceNoQueSeLe() {
        let identidade = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let candidata = BluetoothPrinterCandidate(
            id: 2,
            label: CoreBluetoothPrinterTransport.candidateLabel("MTP-II_BD7E", position: 2),
            declaredName: CoreBluetoothPrinterTransport.declaredName("MTP-II_BD7E"),
            peripheralIdentifier: identidade
        )

        XCTAssertEqual(candidata.peripheralIdentifier, identidade)
        XCTAssertEqual(candidata.description, "BluetoothPrinterCandidate(id=2)")
        XCTAssertFalse(candidata.label.contains(identidade.uuidString))
        XCTAssertFalse(candidata.declaredName?.contains(identidade.uuidString) ?? false)
        XCTAssertFalse("\(candidata)".contains(identidade.uuidString))
    }

    /// Duas unidades do mesmo modelo anunciam o mesmo nome; o que as separa é o identificador.
    func testDuasUnidadesDoMesmoModeloSoSeDistinguemPeloIdentificador() {
        let uma = BluetoothPrinterCandidate(
            id: 1,
            label: "MTP-II_BD7E",
            peripheralIdentifier: UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")
        )
        let outra = BluetoothPrinterCandidate(
            id: 1,
            label: "MTP-II_BD7E",
            peripheralIdentifier: UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")
        )

        XCTAssertNotEqual(uma, outra)
        XCTAssertEqual(uma.label, outra.label)
    }
}

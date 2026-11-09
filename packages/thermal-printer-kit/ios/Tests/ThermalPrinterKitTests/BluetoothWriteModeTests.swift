import CoreBluetooth
import Foundation
import XCTest
@testable import ThermalPrinterKit

/// O iPhone 7 imprimiu metade do cachorro e o restante em códigos, com a mesma MTP-II que saiu
/// inteira pelo Android depois da correção. `canSendWriteWithoutResponse` fala pela fila do rádio
/// do iPhone; só a escrita confirmada fala pela impressora.
final class BluetoothWriteModeTests: XCTestCase {
    func testCaracteristicaQueConfirmaDitaORitmo() {
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.writeMode(for: [.write, .writeWithoutResponse]),
            .acknowledged
        )
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.writeMode(for: [.write]),
            .acknowledged
        )
    }

    /// Escolher um modo que a característica não declara é escrever no vazio, e a portátil que só
    /// aceita escrita sem resposta continua sendo impressora.
    func testSemConfirmacaoDeclaradaContinuaImprimindo() {
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.writeMode(for: [.writeWithoutResponse]),
            .unacknowledged
        )
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.writeMode(for: [.notify]),
            .unacknowledged
        )
    }
}

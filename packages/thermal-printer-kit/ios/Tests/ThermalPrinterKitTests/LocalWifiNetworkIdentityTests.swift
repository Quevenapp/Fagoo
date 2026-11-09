import Foundation
import XCTest
@testable import ThermalPrinterKit

/// Medido no iPhone 7 com a P80 em Wi-Fi direto: a busca achava a impressora e, ao iniciar o teste,
/// a tela voltava para o endereço manual. O controlador compara a rede da busca com a atual antes
/// de testar, e a igualdade sintetizada incluía o IP do próprio telefone — bastava o DHCP do AP da
/// impressora renovar para as candidatas serem descartadas.
final class LocalWifiNetworkIdentityTests: XCTestCase {
    func testTrocarDeIpNaMesmaRedeNaoTrocaARede() throws {
        let antes = try XCTUnwrap(LocalWifiPrinterSubnet(hostAddress: "10.10.100.150", prefixLength: 24))
        let depois = try XCTUnwrap(LocalWifiPrinterSubnet(hostAddress: "10.10.100.187", prefixLength: 24))

        XCTAssertEqual(antes, depois)
        XCTAssertEqual(
            LocalWifiPrinterNetwork(subnet: antes),
            LocalWifiPrinterNetwork(subnet: depois)
        )
    }

    func testOutraRedeContinuaSendoOutraRede() throws {
        let printerAp = try XCTUnwrap(LocalWifiPrinterSubnet(hostAddress: "10.10.100.150", prefixLength: 24))
        let casa = try XCTUnwrap(LocalWifiPrinterSubnet(hostAddress: "192.168.1.139", prefixLength: 24))
        let outroPrefixo = try XCTUnwrap(LocalWifiPrinterSubnet(hostAddress: "10.10.100.150", prefixLength: 25))

        XCTAssertNotEqual(printerAp, casa)
        XCTAssertNotEqual(printerAp, outroPrefixo)
    }
}

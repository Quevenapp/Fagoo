import Darwin
import Network
import XCTest
@testable import ThermalPrinterKit

/**
 As duas correções que o transporte TCP precisava para funcionar em Mac, e a prova de que o default
 de cada uma preserva o iOS.

 Nenhum destes testes prova papel. O que eles provam é socket: que um meio físico exigido e ausente
 bloqueia o `send` inteiro, e que a escolha de interface deixou de ser o literal `en0`.
 */
final class LocalWifiPrinterDesktopFixesTests: XCTestCase {

    // MARK: - Escolha de interface (LocalWifiPrinterTypes)

    /// Endereço/máscara em bytes, para as tabelas abaixo ficarem legíveis.
    private typealias Interface = (name: String, address: [UInt8], netmask: [UInt8])

    private static let mask24: [UInt8] = [255, 255, 255, 0]
    private static let mask16: [UInt8] = [255, 255, 0, 0]
    private static let mask8: [UInt8] = [255, 0, 0, 0]

    func testOPadraoContinuaSendoEn0EIgnoraAsOutrasInterfaces() {
        // Forma de iPhone: `en0` é a Wi-Fi, e é ela que o kit sempre escolheu. O default preserva
        // isso mesmo quando outra interface privada aparece antes na enumeração do sistema.
        let interfaces: [Interface] = [
            ("bridge0", [192, 168, 9, 2], Self.mask24),
            ("en0", [10, 0, 0, 5], Self.mask24),
        ]
        let network = SystemLocalWifiPrinterNetworkProvider.network(
            from: interfaces,
            acceptedNames: ["en0"]
        )
        XCTAssertEqual(network?.subnet, LocalWifiPrinterSubnet(hostAddress: "10.0.0.5", prefixLength: 24))
    }

    func testEmMacComEn0ForaDaRedeOPadraoNaoAchaNadaEEsseEODefeito() {
        // Forma de Mac: `en0` é a Thunderbolt sem rota, com link-local, e quem tem a rede da
        // impressora é `en5`. Procurar por nome fixo devolve nada — este teste existe para fixar
        // o defeito que o parâmetro conserta, não para aprová-lo.
        let interfaces: [Interface] = [
            ("en0", [169, 254, 189, 91], Self.mask16),
            ("en5", [192, 168, 1, 10], Self.mask24),
        ]
        XCTAssertNil(
            SystemLocalWifiPrinterNetworkProvider.network(from: interfaces, acceptedNames: ["en0"])
        )
    }

    func testSemListaDeNomesAInterfacePrivadaEAchadaEmQualquerNome() {
        let interfaces: [Interface] = [
            ("en0", [169, 254, 189, 91], Self.mask16),
            ("en5", [192, 168, 1, 10], Self.mask24),
        ]
        let network = SystemLocalWifiPrinterNetworkProvider.network(
            from: interfaces,
            acceptedNames: nil
        )
        XCTAssertEqual(network?.subnet, LocalWifiPrinterSubnet(hostAddress: "192.168.1.10", prefixLength: 24))
    }

    func testSemListaDeNomesOLoopbackEOLinkLocalContinuamDeFora() {
        // Aceitar qualquer nome não afrouxa nada: quem recusa é a validação RFC1918 com prefixo
        // /24 a /30, e ela recusa 127/8 e 169.254/16 sem conhecer nome nenhum.
        let interfaces: [Interface] = [
            ("lo0", [127, 0, 0, 1], Self.mask8),
            ("utun3", [169, 254, 84, 131], Self.mask16),
            ("en8", [172, 16, 4, 9], Self.mask24),
        ]
        let network = SystemLocalWifiPrinterNetworkProvider.network(
            from: interfaces,
            acceptedNames: nil
        )
        XCTAssertEqual(network?.subnet, LocalWifiPrinterSubnet(hostAddress: "172.16.4.9", prefixLength: 24))
    }

    func testAOrdemDaListaDeNomesManadaSobreAOrdemDoSistema() {
        // Quem pediu `["en5", "en0"]` quer `en5` mesmo que o sistema enumere `en0` primeiro.
        let interfaces: [Interface] = [
            ("en0", [10, 0, 0, 5], Self.mask24),
            ("en5", [192, 168, 1, 10], Self.mask24),
        ]
        let network = SystemLocalWifiPrinterNetworkProvider.network(
            from: interfaces,
            acceptedNames: ["en5", "en0"]
        )
        XCTAssertEqual(network?.subnet, LocalWifiPrinterSubnet(hostAddress: "192.168.1.10", prefixLength: 24))
    }

    func testNomeQueNaoExisteNaoCaiParaOutraInterface() {
        let interfaces: [Interface] = [("en5", [192, 168, 1, 10], Self.mask24)]
        XCTAssertNil(
            SystemLocalWifiPrinterNetworkProvider.network(from: interfaces, acceptedNames: ["en0"])
        )
    }

    // MARK: - Meio físico exigido (LocalWifiPrinterTransport)

    #if os(macOS)
    /**
     O defeito, medido: exigir um meio físico que a máquina não tem impede o `send` de abrir, mesmo
     com a impressora escutando e alcançável.

     `.cellular` é o meio escolhido porque **nenhum Mac tem rádio celular** — a ausência é do
     hardware, não do ambiente de rede, então este teste mede a mesma coisa numa máquina em Wi-Fi,
     em Ethernet ou nas duas. É exatamente a situação do balcão em Ethernet com o default `.wifi`.
     */
    func testMeioFisicoAusenteNaMaquinaImpedeOEnvioMesmoComOSumidouroEscutando() async throws {
        let (sink, endpoint) = try Self.privateSink()
        defer { sink.stop() }

        let transport = NetworkLocalWifiPrinterTransport(requiredInterfaceType: .cellular)
        do {
            try await transport.send(Data([0x1b, 0x40]), to: endpoint)
            XCTFail("Um Mac não tem interface celular; o envio não podia ter aberto.")
        } catch {
            XCTAssertEqual(
                (error as? LocalWifiPrinterTransportError)?.delivery,
                .notSent,
                "Falha antes do primeiro byte é `notSent`; nunca `indeterminate`."
            )
        }
    }

    /// A correção: sem meio fixado, o mesmo sumidouro recebe o cupom inteiro.
    func testSemMeioFixadoOsBytesChegamAoSumidouroTcpReal() async throws {
        let (sink, endpoint) = try Self.privateSink()
        defer { sink.stop() }

        let payload = PrinterTestReceipt.bytes(layout: .counter)
        let transport = NetworkLocalWifiPrinterTransport(requiredInterfaceType: nil)
        try await transport.send(payload, to: endpoint)

        guard let received = sink.waitForData(timeout: 5) else {
            XCTFail("O sumidouro TCP não recebeu bytes dentro do prazo.")
            return
        }
        XCTAssertEqual(received, payload)
    }

    /**
     O default não se moveu: construir sem argumento e construir com `.wifi` explícito dão o
     **mesmo** desfecho contra o mesmo endpoint.

     A asserção é sobre igualdade, não sobre sucesso, de propósito: numa máquina em Wi-Fi os dois
     entregam, numa máquina só em Ethernet os dois falham, e o que este teste fixa é que são o
     mesmo caminho — que é a garantia que o iOS precisa.
     */
    func testConstruirSemArgumentoEIgualAConstruirComWifi() async throws {
        let (sink, endpoint) = try Self.privateSink()
        defer { sink.stop() }

        let payload = Data([0x1b, 0x40])
        let padrao = await Self.entregou(NetworkLocalWifiPrinterTransport(), payload, endpoint)
        let explicito = await Self.entregou(
            NetworkLocalWifiPrinterTransport(requiredInterfaceType: .wifi),
            payload,
            endpoint
        )
        XCTAssertEqual(padrao, explicito)
    }

    private static func entregou(
        _ transport: NetworkLocalWifiPrinterTransport,
        _ payload: Data,
        _ endpoint: LocalWifiPrinterEndpoint
    ) async -> Bool {
        do {
            try await transport.send(payload, to: endpoint)
            return true
        } catch {
            return false
        }
    }

    /// Sumidouro escutando num IPv4 **privado** desta máquina. Loopback não serve: o endpoint do
    /// kit recusa 127.0.0.1 de propósito, e essa validação é de segurança e fica como está.
    private static func privateSink() throws -> (TCPPrivateSink, LocalWifiPrinterEndpoint) {
        guard let address = firstPrivateIPv4Address() else {
            throw XCTSkip("Esta máquina não tem nenhum IPv4 RFC1918 — não há rede local para medir.")
        }
        let sink = try TCPPrivateSink(bindAddress: address)
        guard let endpoint = LocalWifiPrinterEndpoint(ipAddress: address, port: Int(sink.port)) else {
            sink.stop()
            throw XCTSkip("O endereço \(address) não passou na validação de rede privada do endpoint.")
        }
        return (sink, endpoint)
    }

    /// Qualquer interface privada serve — é justamente o ponto da correção não depender de `en0`.
    private static func firstPrivateIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            guard let address = current.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET)
            else { continue }
            var raw = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            guard inet_ntop(AF_INET, &raw, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil else { continue }
            let text = String(cString: buffer)
            // A própria validação do kit decide o que é privado; aqui não se reimplementa a regra.
            if LocalWifiPrinterEndpoint(ipAddress: text, port: 9_100) != nil { return text }
        }
        return nil
    }
    #endif
}

#if os(macOS)
private enum TCPPrivateSinkError: Error {
    case socketFailed
    case invalidAddress
    case bindFailed(Int32)
    case getsocknameFailed
    case listenFailed
}

/**
 Lado "impressora" do socket, em BSD sockets puro, só para esta suíte.

 É primo do sumidouro da prova da Fase 0 e não foi compartilhado com ele de propósito: aquele é
 `private` do arquivo dele, e tornar um utilitário de teste público só para reusar mexeria num
 arquivo que não é desta frente. Duplicar trinta linhas de teste é mais barato que isso.
 */
private final class TCPPrivateSink: @unchecked Sendable {
    let port: UInt16
    private let listenSocket: Int32
    private let semaphore = DispatchSemaphore(value: 0)
    private var received = Data()

    init(bindAddress: String) throws {
        listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard listenSocket >= 0 else { throw TCPPrivateSinkError.socketFailed }
        let descriptor = listenSocket

        var reuse: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        guard inet_pton(AF_INET, bindAddress, &address.sin_addr) == 1 else {
            close(descriptor)
            throw TCPPrivateSinkError.invalidAddress
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else {
            let saved = errno
            close(descriptor)
            throw TCPPrivateSinkError.bindFailed(saved)
        }

        var assigned = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        guard named == 0 else {
            close(descriptor)
            throw TCPPrivateSinkError.getsocknameFailed
        }
        port = UInt16(bigEndian: assigned.sin_port)

        guard listen(descriptor, 1) == 0 else {
            close(descriptor)
            throw TCPPrivateSinkError.listenFailed
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            let client = accept(descriptor, nil, nil)
            guard client >= 0 else {
                semaphore.signal()
                return
            }
            var buffer = [UInt8](repeating: 0, count: 4_096)
            var collected = Data()
            while true {
                let read = Darwin.read(client, &buffer, buffer.count)
                guard read > 0 else { break }
                collected.append(contentsOf: buffer[0..<read])
            }
            close(client)
            received = collected
            semaphore.signal()
        }
    }

    func waitForData(timeout: TimeInterval) -> Data? {
        guard semaphore.wait(timeout: .now() + timeout) == .success else { return nil }
        return received
    }

    func stop() {
        close(listenSocket)
    }
}
#endif

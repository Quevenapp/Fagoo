import Darwin
import XCTest
@testable import ThermalPrinterKit

/**
 Prova de ponta a ponta do spike de viabilidade macOS (Fase 0): `perfil → payload → bytes → socket`
 rodando de verdade em Mac, sem impressora nenhuma.

 Isto prova que o caminho compila e entrega bytes corretos a um sumidouro TCP real, pelo mesmo
 `LocalWifiPrinterTransport` de produção (`NetworkLocalWifiPrinterTransport`) — não por um dublê.
 **Isto não prova papel.** Nenhuma asserção aqui, nem nenhuma futura, pode alegar que o comprovante
 saiu impresso: só a bancada com impressora física prova isso, como o resto do kit já documenta.

 O sumidouro não escuta em `127.0.0.1`: `LocalWifiPrinterEndpoint` só aceita IPv4 privado RFC1918
 (10/8, 172.16/12, 192.168/16) — ver `LocalWifiPrinterTypes.swift` — e recusa loopback de propósito,
 porque o objetivo do endpoint é impedir que o cupom saia da rede local, e `127.0.0.1` nunca
 apareceria numa varredura de sub-rede real. Por isso o sumidouro escuta no próprio endereço Wi-Fi
 (`en0`) da máquina que roda o teste — descoberto do mesmo jeito que `SystemLocalWifiPrinterNetworkProvider`
 descobre em produção — e a máquina se conecta nela mesma. Sem uma interface Wi-Fi de verdade com
 IPv4, o teste se anuncia ausente (`XCTSkip`) em vez de fingir que mediu alguma coisa.
 */
final class LocalWifiPrinterTransportSocketSinkTests: XCTestCase {
    func testReceiptBytesArriveAtRealTcpSinkOverLocalWifiTransport() async throws {
        guard let hostAddress = Self.currentWifiIPv4Address() else {
            throw XCTSkip(
                "Sem interface Wi-Fi (en0) com IPv4 nesta máquina. " +
                "NetworkLocalWifiPrinterTransport.send exige requiredInterfaceType = .wifi, " +
                "e sem uma rota Wi-Fi de verdade não há como abrir o socket sem fabricar um caminho falso."
            )
        }

        let sink = try TCPSinkServer(bindAddress: hostAddress)
        defer { sink.stop() }

        guard let endpoint = LocalWifiPrinterEndpoint(ipAddress: hostAddress, port: Int(sink.port)) else {
            XCTFail("Endereço \(hostAddress) não passou na validação de rede privada do endpoint.")
            return
        }

        // Perfil de 80mm já existente no kit: impressora de balcão na Wi-Fi (Elgin i9FULL 2), com
        // guilhotina GS V 0. É o mesmo layout que o produto usa — não um perfil inventado para o teste.
        let layout = ReceiptLayout.counter
        let payload = PrinterTestReceipt.bytes(layout: layout)

        let transport = NetworkLocalWifiPrinterTransport()
        try await transport.send(payload, to: endpoint)

        guard let received = sink.waitForData(timeout: 5) else {
            XCTFail("O sumidouro TCP não recebeu bytes dentro do prazo — o socket não chegou a escrever.")
            return
        }

        // Bytes idênticos ponta a ponta: o que o layout montou é exatamente o que atravessou o
        // transporte e chegou no outro lado do TCP.
        XCTAssertEqual(received, payload)

        // Todo cupom começa com ESC @ (inicialização da impressora).
        XCTAssertEqual(Array(received.prefix(2)), [0x1b, 0x40], "O cupom precisa começar com ESC @.")

        // O comprovante de teste imprime um QR via layout.qrRaster, que emite faixas GS v 0.
        XCTAssertTrue(
            contains(received, [0x1d, 0x76, 0x30]),
            "O cupom precisa conter ao menos uma faixa GS v 0 (o QR raster do comprovante de teste)."
        )

        // O perfil `counter` declara GS V 0 como corte; finish() emite o avanço e depois o comando
        // de corte por último, então o cupom termina exatamente nesse comando.
        let cutCommand = Array(layout.cutProtocol.command)
        XCTAssertEqual(cutCommand, [0x1d, 0x56, 0x00], "Pré-condição do teste: o perfil counter declara GS V 0.")
        XCTAssertEqual(
            Array(received.suffix(cutCommand.count)),
            cutCommand,
            "O cupom precisa terminar no comando de corte que o próprio perfil declarou."
        )
    }

    /// Mesma técnica de `SystemLocalWifiPrinterNetworkProvider.currentNetwork()`: `en0` é a
    /// interface Wi-Fi assumida pelo kit. Aqui não basta a sub-rede — precisamos do endereço IPv4
    /// da própria máquina, para o sumidouro escutar nele.
    private static func currentWifiIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let interface = current.pointee
            guard
                String(cString: interface.ifa_name) == "en0",
                let address = interface.ifa_addr,
                address.pointee.sa_family == UInt8(AF_INET)
            else { continue }

            var addr = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            guard inet_ntop(AF_INET, &addr, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil else { continue }
            return String(cString: buffer)
        }
        return nil
    }
}

private enum TCPSinkServerError: Error {
    case socketFailed
    case invalidAddress
    case bindFailed(Int32)
    case getsocknameFailed
    case listenFailed
}

/**
 Sumidouro TCP mínimo em BSD sockets puro (`Darwin`), só para este teste.

 Não é infraestrutura de produção nem substitui `NetworkLocalWifiPrinterTransport` — é o lado
 "impressora" do socket, fingindo só o suficiente para aceitar uma conexão e guardar o que chegou.
 Sincronização é por `DispatchSemaphore`: o `signal()` depois de `received = collected` publica a
 escrita para quem chama `waitForData` na thread do teste.
 */
private final class TCPSinkServer: @unchecked Sendable {
    let port: UInt16
    private let listenSocket: Int32
    private let semaphore = DispatchSemaphore(value: 0)
    private var received = Data()

    init(bindAddress: String) throws {
        listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard listenSocket >= 0 else { throw TCPSinkServerError.socketFailed }

        // Cópia local: os closures abaixo rodam antes de `self.port` ser atribuído, e Swift proíbe
        // acesso implícito a `self` (mesmo só de leitura) enquanto o initializer não termina.
        let socketDescriptor = listenSocket

        var reuse: Int32 = 1
        setsockopt(socketDescriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0 // porta efêmera: o SO escolhe, e getsockname devolve qual foi
        guard inet_pton(AF_INET, bindAddress, &address.sin_addr) == 1 else {
            close(socketDescriptor)
            throw TCPSinkServerError.invalidAddress
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(socketDescriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            let savedErrno = errno
            close(socketDescriptor)
            throw TCPSinkServerError.bindFailed(savedErrno)
        }

        var assigned = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getsockname(socketDescriptor, sockaddrPointer, &len)
            }
        }
        guard nameResult == 0 else {
            close(socketDescriptor)
            throw TCPSinkServerError.getsocknameFailed
        }
        port = UInt16(bigEndian: assigned.sin_port)

        guard listen(socketDescriptor, 1) == 0 else {
            close(socketDescriptor)
            throw TCPSinkServerError.listenFailed
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            let clientSocket = accept(socketDescriptor, nil, nil)
            guard clientSocket >= 0 else {
                semaphore.signal()
                return
            }
            var buffer = [UInt8](repeating: 0, count: 4_096)
            var collected = Data()
            while true {
                let bytesRead = read(clientSocket, &buffer, buffer.count)
                guard bytesRead > 0 else { break }
                collected.append(contentsOf: buffer[0..<bytesRead])
            }
            close(clientSocket)
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

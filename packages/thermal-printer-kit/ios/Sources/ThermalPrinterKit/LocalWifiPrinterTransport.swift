import Foundation
import Network

/**
 Falha do transporte de rede local.

 **É público porque quem recebe o erro precisa do `delivery`, e não do texto.** Fechado no módulo,
 um chamador de fora só conseguia ler a mensagem — e "a conexão foi interrompida durante o envio"
 lido como string não distingue queda antes do primeiro byte de queda no meio do raster. Essa
 distinção é a regra dura do `AGENTS.md`: falha depois do início da transmissão é `indeterminate` e
 exige confirmação humana antes de reimprimir. Abrir o tipo é aditivo; os casos, a ordem e as
 mensagens são exatamente os de antes.
 */
public enum LocalWifiPrinterTransportError: LocalizedError, Equatable {
    case unavailable
    case writeFailed

    public var delivery: ThermalPrintDelivery {
        switch self {
        case .unavailable: return .notSent
        case .writeFailed: return .indeterminate
        }
    }

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Não foi possível alcançar a impressora na Wi-Fi local."
        case .writeFailed:
            return "A conexão foi interrompida durante o envio à impressora."
        }
    }
}

public protocol LocalWifiPrinterTransport: Sendable {
    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool
    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws
    func readIdentity(from endpoint: LocalWifiPrinterEndpoint) async -> PrinterDeclaredIdentity?
}

public extension LocalWifiPrinterTransport {
    /// Fakes e transportes somente de escrita permanecem honestamente sem identidade.
    func readIdentity(from endpoint: LocalWifiPrinterEndpoint) async -> PrinterDeclaredIdentity? { nil }
}

/// A `NWConnection` avisa por callback e o timeout chega por outro caminho; sem este guarda a
/// continuation seria retomada duas vezes, o que derruba o processo.
private final class LocalWifiPrinterConnectionOpenOperation: @unchecked Sendable {
    private let lock = NSLock()
    private let connection: NWConnection
    private let continuation: CheckedContinuation<NWConnection, Error>
    private var completed = false
    private var timeout: DispatchWorkItem?

    init(connection: NWConnection, continuation: CheckedContinuation<NWConnection, Error>) {
        self.connection = connection
        self.continuation = continuation
    }

    func setTimeout(_ timeout: DispatchWorkItem) {
        lock.lock()
        self.timeout = timeout
        lock.unlock()
    }

    func succeed() {
        finish(.success(connection))
    }

    func fail() {
        finish(.failure(LocalWifiPrinterTransportError.unavailable))
    }

    private func finish(_ result: Result<NWConnection, Error>) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        let scheduledTimeout = timeout
        lock.unlock()
        scheduledTimeout?.cancel()
        switch result {
        case let .success(readyConnection):
            continuation.resume(returning: readyConnection)
        case .failure:
            connection.cancel()
            continuation.resume(throwing: LocalWifiPrinterTransportError.unavailable)
        }
    }
}

/// Leitura limitada por NUL, tamanho e prazo. O timeout é resultado vazio, nunca erro de usuário.
private final class LocalWifiPrinterIdentityReadOperation: @unchecked Sendable {
    private let lock = NSLock()
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let continuation: CheckedContinuation<Data?, Never>
    private var buffer = Data()
    private var completed = false
    private var timeout: DispatchWorkItem?

    init(
        connection: NWConnection,
        queue: DispatchQueue,
        continuation: CheckedContinuation<Data?, Never>
    ) {
        self.connection = connection
        self.queue = queue
        self.continuation = continuation
    }

    func start(query: Data, timeout interval: DispatchTimeInterval) {
        let work = DispatchWorkItem { self.finish(nil) }
        lock.lock()
        timeout = work
        lock.unlock()
        queue.asyncAfter(deadline: .now() + interval, execute: work)
        connection.send(content: query, completion: .contentProcessed { error in
            if error == nil { self.receive() } else { self.finish(nil) }
        })
    }

    private func receive() {
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: PrinterDeclaredIdentity.maxFieldBytes + 1
        ) { content, _, isComplete, error in
            self.lock.lock()
            guard !self.completed else {
                self.lock.unlock()
                return
            }
            if let content { self.buffer.append(content) }
            if let nul = self.buffer.firstIndex(of: 0) {
                let value = Data(self.buffer[..<nul])
                self.lock.unlock()
                self.finish(value)
                return
            }
            let tooLong = self.buffer.count > PrinterDeclaredIdentity.maxFieldBytes
            self.lock.unlock()
            if error != nil || isComplete || tooLong {
                self.finish(nil)
            } else {
                self.receive()
            }
        }
    }

    private func finish(_ value: Data?) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        let scheduled = timeout
        timeout = nil
        lock.unlock()
        scheduled?.cancel()
        connection.cancel()
        continuation.resume(returning: value)
    }
}

public final class NetworkLocalWifiPrinterTransport: LocalWifiPrinterTransport, @unchecked Sendable {
    /**
     Que meio físico o socket pode usar. `nil` é "qualquer um que a rota escolher".

     **Por que o parâmetro existe, e por que o default é `.wifi`.** No iPhone, amarrar à Wi-Fi é o
     que impede o cupom de sair pela rede móvel ou por uma VPN; o default preserva isso byte a byte,
     e nenhuma chamada existente muda de comportamento. Num Mac de balcão ligado por **Ethernet**
     não existe caminho `.wifi` nenhum, e a `NWConnection` nunca fica `.ready` — o `send` estoura o
     prazo e devolve `unavailable` mesmo com a impressora acesa no mesmo switch. É por isso que a
     prova de ponta a ponta da Fase 0 se pula sozinha em máquina sem Wi-Fi.

     Quem passa `nil` não perde a proteção que importa: `LocalWifiPrinterEndpoint` continua
     recusando qualquer endereço fora da RFC1918, e os dois `prohibit*` abaixo continuam barrando
     caminho caro ou limitado — ou seja, tethering e rede móvel seguem fora mesmo sem o
     `requiredInterfaceType`.
     */
    private let requiredInterfaceType: NWInterface.InterfaceType?

    public init(requiredInterfaceType: NWInterface.InterfaceType? = .wifi) {
        self.requiredInterfaceType = requiredInterfaceType
    }

    /// A varredura bate em toda a sub-rede; 350ms é o que separa "impressora ligada no mesmo
    /// switch" de "endereço morto" sem transformar a busca em minutos de espera.
    private static let discoveryTimeout: DispatchTimeInterval = .milliseconds(350)

    /// Conectar numa impressora que a pessoa **escolheu** é outra conta: é uma tentativa só, e
    /// desistir cedo transforma um rádio frio em "não foi possível usar a sonda".
    ///
    /// Medido no iPhone 7 com a P80 em Wi-Fi direto: a sonda de geometria falhou várias vezes
    /// seguidas e, de tanto insistir, passou a funcionar e não errou mais — o primeiro TCP de um AP
    /// barato de 2,4 GHz não cabe em 350 ms, e depois de quente cabe sempre. O Android já separava
    /// os dois: 250 ms para varrer e 1 s para conectar de propósito.
    private static let deliberateTimeout: DispatchTimeInterval = .seconds(3)
    private static let identityTimeout: DispatchTimeInterval = .milliseconds(300)

    public func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool {
        do {
            let connection = try await open(endpoint, timeout: Self.discoveryTimeout)
            connection.cancel()
            return true
        } catch {
            return false
        }
    }

    public func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        let connection = try await open(endpoint, timeout: Self.deliberateTimeout)
        defer { connection.cancel() }
        try await withCheckedThrowingContinuation { continuation in
            connection.send(content: data, completion: .contentProcessed { error in
                if error == nil {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: LocalWifiPrinterTransportError.writeFailed)
                }
            })
        }
    }

    public func readIdentity(from endpoint: LocalWifiPrinterEndpoint) async -> PrinterDeclaredIdentity? {
        let firmware = await readIdentityField(EscPos.firmwareVersionQuery, from: endpoint)
        let manufacturer = await readIdentityField(EscPos.manufacturerQuery, from: endpoint)
        let model = await readIdentityField(EscPos.modelQuery, from: endpoint)
        return PrinterDeclaredIdentity.fromResponses(
            firmware: firmware,
            manufacturer: manufacturer,
            model: model
        )
    }

    private func readIdentityField(_ query: Data, from endpoint: LocalWifiPrinterEndpoint) async -> Data? {
        guard let connection = try? await open(endpoint, timeout: Self.deliberateTimeout) else { return nil }
        let queue = DispatchQueue(label: "br.com.thermalprinterkit.local-printer-identity")
        return await withCheckedContinuation { continuation in
            LocalWifiPrinterIdentityReadOperation(
                connection: connection,
                queue: queue,
                continuation: continuation
            ).start(query: query, timeout: Self.identityTimeout)
        }
    }

    private func open(
        _ endpoint: LocalWifiPrinterEndpoint,
        timeout: DispatchTimeInterval
    ) async throws -> NWConnection {
        guard let port = NWEndpoint.Port(rawValue: UInt16(endpoint.port)) else {
            throw LocalWifiPrinterTransportError.unavailable
        }
        // Amarrado à Wi-Fi por padrão, de propósito: sem isso o iOS acha caminho pela rede móvel ou
        // por uma VPN e o cupom sairia da rede local. Caminho caro ou limitado também está fora, e
        // esses dois continuam valendo mesmo quando o meio não é fixado — ver o comentário do init.
        let parameters = NWParameters.tcp
        if let requiredInterfaceType {
            parameters.requiredInterfaceType = requiredInterfaceType
        }
        parameters.prohibitExpensivePaths = true
        parameters.prohibitConstrainedPaths = true
        let connection = NWConnection(host: NWEndpoint.Host(endpoint.ipAddress), port: port, using: parameters)
        let queue = DispatchQueue(label: "br.com.thermalprinterkit.local-printer")

        return try await withCheckedThrowingContinuation { continuation in
            let operation = LocalWifiPrinterConnectionOpenOperation(
                connection: connection,
                continuation: continuation
            )
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    operation.succeed()
                case .failed, .cancelled:
                    operation.fail()
                default:
                    break
                }
            }
            let work = DispatchWorkItem { operation.fail() }
            operation.setTimeout(work)
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout, execute: work)
        }
    }
}

enum LocalWifiPrinterDiscovery {
    /// Quantas sondas correm ao mesmo tempo. Mais que isso satura o rádio Wi-Fi do aparelho e as
    /// conexões começam a estourar o timeout por congestionamento, não por ausência de impressora.
    static let concurrentProbes = 16

    /// Força bruta na sub-rede inteira, em lotes. Nenhum Bonjour: a impressora térmica não anuncia
    /// serviço, então quem procura é quem bate na porta.
    static func discover(
        endpoints: [LocalWifiPrinterEndpoint],
        transport: any LocalWifiPrinterTransport
    ) async -> [LocalWifiPrinterEndpoint] {
        var found: [LocalWifiPrinterEndpoint] = []
        for start in stride(from: 0, to: endpoints.count, by: concurrentProbes) {
            let end = min(start + concurrentProbes, endpoints.count)
            let batch = Array(endpoints[start..<end])
            let results = await withTaskGroup(of: (Int, LocalWifiPrinterEndpoint?).self) { group in
                for (index, endpoint) in batch.enumerated() {
                    group.addTask {
                        (index, await transport.probe(endpoint) ? endpoint : nil)
                    }
                }
                var values: [(Int, LocalWifiPrinterEndpoint?)] = []
                for await value in group { values.append(value) }
                return values
            }
            found.append(contentsOf: results.sorted { $0.0 < $1.0 }.compactMap(\.1))
        }
        return found
    }
}

import XCTest
@testable import ThermalPrinterKit

/**
 A retomada Wi-Fi, depois de o processo morrer: em qual impressora o cupom sai.

 O Bluetooth ganhou identidade porque o papel desmentiu a suposição em 20/08 — com a T210 adotada e
 dormindo, o cupom saiu na portátil que nem instalada estava. O Wi-Fi tinha o mesmo defeito com
 outro transporte: a adoção guardava só o perfil, e a retomada adotava a única que respondesse à
 varredura. Numa sub-rede de balcão, "a única que respondeu" é qualquer impressora ligada.
 */
@MainActor
final class LocalWifiThermalPrinterRestoreTests: XCTestCase {
    /**
     Duas impressoras respondendo, e o cupom sai na que a pessoa adotou.

     A adotada é a `.41` de propósito: ela vem **depois** na varredura, então "a primeira que
     respondeu" não pode passar por acerto.
     */
    func testRetomadaEntreDuasImprimeNaImpressoraAdotada() async throws {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.1.41", port: 9_100))
        )))
        let transport = DiscoveryWifiTransport(respondendo: ["192.168.1.40", "192.168.1.41"])
        let controller = try makeController(store: store, transport: transport)

        let result = await controller.print(Recibo())

        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(transport.enviadoPara.map(\.ipAddress), ["192.168.1.41"])
    }

    /**
     A impressora do lado não herda o lugar da adotada que está desligada.

     `found.count == 1` bastava para adotar. Com o endpoint guardado, uma candidata que não bate não
     vira impressora adotada: nada é enviado, e quem pede papel ouve não.
     */
    func testRetomadaNaoAdotaAUnicaQueNaoBate() async throws {
        let store = InMemoryPrinterSelectionStore()
        let adotada = PersistedPrinterSelection.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.1.41", port: 9_100))
        )
        store.save(store.read().with(adotada))
        let transport = DiscoveryWifiTransport(respondendo: ["192.168.1.40"])
        let controller = try makeController(store: store, transport: transport)

        let result = await controller.print(Recibo())

        XCTAssertEqual(delivery(of: result), .notSent)
        XCTAssertTrue(transport.enviadoPara.isEmpty, "nenhum byte pode sair numa impressora que não é a dela")
        XCTAssertNotEqual(controller.state, .ready)
        // A escolha guardada continua de pé: quem não foi encontrada não é quem foi trocada.
        XCTAssertEqual(store.read().of(.localWifi), adotada)
    }

    /**
     Entrada legada, sem endpoint: o comportamento antigo continua inteiro.

     Quem adotou antes desta correção não perde a impressora nem é obrigado a readotar — candidata
     única volta a valer, e duas continuam exigindo escolha.
     */
    func testRetomadaLegadaSemEndpointMantemACandidataUnica() async throws {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.localWifi(profileId: LocalWifiThermalPrinterController.profileId)))
        XCTAssertNil(store.read().of(.localWifi)?.networkEndpoint)

        let uma = DiscoveryWifiTransport(respondendo: ["192.168.1.40"])
        let comUma = try makeController(store: store, transport: uma)
        let entregue = await comUma.print(Recibo())
        XCTAssertEqual(entregue, .delivered)
        XCTAssertEqual(uma.enviadoPara.map(\.ipAddress), ["192.168.1.40"])

        let duas = DiscoveryWifiTransport(respondendo: ["192.168.1.40", "192.168.1.41"])
        let comDuas = try makeController(store: store, transport: duas)
        let recusado = await comDuas.print(Recibo())
        XCTAssertEqual(delivery(of: recusado), .notSent)
        XCTAssertEqual(comDuas.state, .candidatesFound)
        XCTAssertTrue(duas.enviadoPara.isEmpty)
    }

    /// A confirmação humana do papel é o que grava o endpoint — e ele não aparece em nenhum texto.
    func testAdocaoGravaOEndpointENaoOMostraEmLugarNenhum() async throws {
        let store = InMemoryPrinterSelectionStore()
        let transport = DiscoveryWifiTransport(respondendo: [])
        let controller = try makeController(store: store, transport: transport)

        let teste = await controller.testManual(ipAddress: "192.168.1.41", portText: "9100")
        XCTAssertEqual(teste, .delivered)
        // Antes da confirmação humana nada foi guardado — nem perfil, nem endpoint.
        XCTAssertNil(store.read().of(.localWifi))
        controller.confirmTestReceipt()

        let guardada = try XCTUnwrap(store.read().of(.localWifi))
        XCTAssertEqual(guardada.networkEndpoint?.ipv4Address, "192.168.1.41")
        XCTAssertEqual(guardada.networkEndpoint?.port, 9_100)
        XCTAssertEqual("\(guardada)", "localWifi(\(LocalWifiThermalPrinterController.profileId))")
        XCTAssertFalse("\(store.read())".contains("192.168.1.41"))
        XCTAssertFalse(guardada.installationId.contains("192.168.1.41"))
    }

    /// Depois de reabrir o app, a impressora adotada volta sozinha e sem novo comprovante: é a
    /// mesma unidade que uma pessoa já confirmou no papel.
    func testRetomadaPorEndpointNaoPedeNovaConfirmacao() async throws {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.1.40", port: 9_100))
        )))
        let transport = DiscoveryWifiTransport(respondendo: ["192.168.1.40"])
        let controller = try makeController(store: store, transport: transport)

        let result = await controller.printTestReceiptAgain()

        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(controller.state, .ready)
        XCTAssertEqual(transport.enviadoPara.map(\.ipAddress), ["192.168.1.40"])
    }

    /**
     Procurar não desinstala.

     É o `972abbd` do Android neste lado: a busca começava apagando a impressora guardada. Quem
     toca em "procurar" para instalar a segunda, ou só para conferir se a dela aparece, não pediu
     para desinstalar a que estava — e se a varredura não achasse nada, sairia da tela sem a
     impressora que tinha antes de tocar.
     */
    func testProcurarNaoDesinstalaAImpressoraGuardada() async throws {
        let store = InMemoryPrinterSelectionStore()
        let adotada = PersistedPrinterSelection.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.1.40", port: 9_100))
        )
        store.save(store.read().with(adotada))
        // Ninguém responde: é o pior caso, a varredura que volta vazia.
        let transport = DiscoveryWifiTransport(respondendo: [])
        let controller = try makeController(store: store, transport: transport)

        controller.search()
        await waitUntil { controller.state == .printerUnavailable }

        XCTAssertEqual(store.read().of(.localWifi), adotada)
        XCTAssertEqual(store.read().selections.count, 1)
    }

    /// Instalar a segunda impressora de rede mantém a primeira. Duas no mesmo transporte convivem.
    func testAdotarASegundaImpressoraDeRedeMantemAPrimeira() async throws {
        let store = InMemoryPrinterSelectionStore()
        let transport = DiscoveryWifiTransport(respondendo: ["192.168.1.41"])
        let controller = try makeController(store: store, transport: transport)

        let primeiro = await controller.testManual(ipAddress: "192.168.1.40", portText: "9100")
        XCTAssertEqual(primeiro, .delivered)
        controller.confirmTestReceipt()
        XCTAssertEqual(store.read().selections.count, 1)

        controller.search()
        await waitUntil { controller.state == .candidatesFound }
        let candidata = try XCTUnwrap(controller.candidates.first)
        let segundo = await controller.test(candidateID: candidata.id)
        XCTAssertEqual(segundo, .delivered)
        controller.confirmTestReceipt()

        let guardadas = store.read()
        XCTAssertEqual(guardadas.selections.count, 2, "a primeira não pode sumir sem ninguém mandar")
        XCTAssertEqual(
            Set(guardadas.selections.compactMap(\.networkEndpoint?.ipv4Address)),
            ["192.168.1.40", "192.168.1.41"]
        )
        XCTAssertEqual(guardadas.activeSelection?.networkEndpoint?.ipv4Address, "192.168.1.41")
    }

    /// A rede trocou, a impressora não: a instalação confirmada no papel continua guardada.
    func testTrocarDeRedeNaoDesinstalaAImpressora() async throws {
        let store = InMemoryPrinterSelectionStore()
        let transport = DiscoveryWifiTransport(respondendo: [])
        let provider = MutableWifiNetworkProvider(network: try makeNetwork(host: "192.168.1.10"))
        let controller = LocalWifiThermalPrinterController(
            networkProvider: provider,
            transport: transport,
            store: store
        )

        let adocao = await controller.testManual(ipAddress: "192.168.1.40", portText: "9100")
        XCTAssertEqual(adocao, .delivered)
        controller.confirmTestReceipt()
        let adotada = try XCTUnwrap(store.read().of(.localWifi))

        provider.network = try makeNetwork(host: "10.10.100.150")
        let recusado = await controller.printTestReceiptAgain()

        XCTAssertEqual(delivery(of: recusado), .notSent)
        XCTAssertEqual(controller.state, .wifiUnavailable)
        XCTAssertEqual(store.read().of(.localWifi), adotada)
    }

    private func makeController(
        store: any PrinterSelectionStoring,
        transport: DiscoveryWifiTransport
    ) throws -> LocalWifiThermalPrinterController {
        LocalWifiThermalPrinterController(
            networkProvider: MutableWifiNetworkProvider(network: try makeNetwork(host: "192.168.1.10")),
            transport: transport,
            store: store
        )
    }

    private func makeNetwork(host: String) throws -> LocalWifiPrinterNetwork {
        LocalWifiPrinterNetwork(
            subnet: try XCTUnwrap(LocalWifiPrinterSubnet(hostAddress: host, prefixLength: 24))
        )
    }

    private func waitUntil(_ condition: @escaping () -> Bool, attempts: Int = 4_000) async {
        for _ in 0..<attempts {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("A operação assíncrona não avançou dentro do limite do teste.")
    }

    private func delivery(of result: ThermalPrintResult) -> ThermalPrintDelivery? {
        guard case let .failed(_, delivery) = result else { return nil }
        return delivery
    }
}

private final class MutableWifiNetworkProvider: LocalWifiPrinterNetworkProviding {
    var network: LocalWifiPrinterNetwork?

    init(network: LocalWifiPrinterNetwork?) {
        self.network = network
    }

    func currentNetwork() -> LocalWifiPrinterNetwork? { network }
}

/// Sub-rede com mais de uma impressora ligada, que é o balcão real. `enviadoPara` responde a
/// pergunta que o papel responde: saiu na dela, ou na que estava ligada ao lado?
private final class DiscoveryWifiTransport: LocalWifiPrinterTransport, @unchecked Sendable {
    private let respondendo: Set<String>
    private(set) var enviadoPara: [LocalWifiPrinterEndpoint] = []

    init(respondendo: [String]) {
        self.respondendo = Set(respondendo)
    }

    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool {
        respondendo.contains(endpoint.ipAddress)
    }

    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        enviadoPara.append(endpoint)
    }
}

private final class Recibo: ThermalReceiptPayload {
    func receiptBytes(layout: ReceiptLayout) -> Data? { Data([0x41]) }
    func clear() {}
}

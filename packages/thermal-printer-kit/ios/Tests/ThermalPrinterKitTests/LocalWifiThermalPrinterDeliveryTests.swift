import XCTest
@testable import ThermalPrinterKit

@MainActor
final class LocalWifiThermalPrinterDeliveryTests: XCTestCase {
    func testFirstPrintAfterRestartWaitsForWifiRediscovery() async throws {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.localWifi(profileId: LocalWifiThermalPrinterController.profileId)))
        let network = try makeNetwork(host: "192.168.1.10")
        let networkProvider = MutableWifiNetworkProvider(network: network)
        let transport = ScriptedWifiTransport(outcomes: [.delivered])
        transport.discoveredAddress = "192.168.1.40"
        let restored = LocalWifiThermalPrinterController(
            networkProvider: networkProvider,
            transport: transport,
            store: store
        )

        let result = await restored.print(WifiReceipt())

        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(transport.sentCount, 1)
    }

    func testUnavailableBeforeOpenMapsToNotSent() async throws {
        let fixture = try await makeReadyController(nextOutcome: .unavailable)

        let result = await fixture.controller.print(WifiReceipt())

        XCTAssertEqual(delivery(of: result), .notSent)
        XCTAssertEqual(fixture.controller.state, .failed)
    }

    func testWriteFailureMapsToIndeterminate() async throws {
        let fixture = try await makeReadyController(nextOutcome: .writeFailed)

        let result = await fixture.controller.print(WifiReceipt())

        XCTAssertEqual(delivery(of: result), .indeterminate)
        XCTAssertEqual(fixture.controller.state, .failed)
    }

    func testExternalTransportErrorMapsToIndeterminate() async throws {
        let fixture = try await makeReadyController(nextOutcome: .externalError)

        let result = await fixture.controller.print(WifiReceipt())

        XCTAssertEqual(delivery(of: result), .indeterminate)
        XCTAssertEqual(fixture.controller.state, .failed)
    }

    func testDeliveredRemainsDeliveredWhenNetworkChangesAfterTransportCompletes() async throws {
        let fixture = try await makeReadyController(nextOutcome: .delivered)
        let otherNetwork = try makeNetwork(host: "192.168.2.10")
        fixture.transport.beforeNextCompletion = {
            fixture.networkProvider.network = otherNetwork
        }

        let result = await fixture.controller.print(WifiReceipt())

        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(fixture.controller.state, .wifiUnavailable)
    }

    /**
     A preferência de emissão também é relida na hora do cupom no controlador Wi-Fi.

     O *getter* do layout operacional é uma cópia do que existe no Bluetooth, e cópia é onde uma
     das duas apodrece: sem este teste, corrigir um lado e esquecer o outro sairia certo no balcão
     e errado na portátil, ou o contrário.
     */
    func testAPreferenciaDeEmissaoEhRelidaNaHoraDoCupom() async throws {
        let escolha = EscolhaDeEmissaoWifi()
        let networkProvider = MutableWifiNetworkProvider(network: try makeNetwork(host: "192.168.1.10"))
        let transport = ScriptedWifiTransport(outcomes: [.delivered, .delivered, .delivered])
        let controller = LocalWifiThermalPrinterController(
            networkProvider: networkProvider,
            transport: transport,
            store: InMemoryPrinterSelectionStore(),
            codeEmissionOverride: { id in escolha.leia(id) }
        )
        let adoption = await controller.testManual(ipAddress: "192.168.1.40", portText: "9100")
        XCTAssertEqual(adoption, .delivered)
        controller.confirmTestReceipt()
        let perfil = try perfilDeEmissaoWifi(nativeQrHonored: true)
        XCTAssertTrue(controller.confirmHomologatedProfile(perfil))

        let padraoEntregue = await controller.print(QrOnlyWifiReceipt(qrDeEmissaoWifi))
        XCTAssertEqual(padraoEntregue, .delivered)
        let padrao = transport.sent.last ?? Data()
        XCTAssertTrue(contains(padrao, [0x1d, 0x76, 0x30, 0x00]), "o padrão continua rasterizando")
        XCTAssertFalse(contains(padrao, [0x1d, 0x28, 0x6b]), "o padrão não pede QR à firmware")

        escolha.escreva(ThermalCodeEmissionPreferences(qrEmission: .native))
        let nativoEntregue = await controller.print(QrOnlyWifiReceipt(qrDeEmissaoWifi))
        XCTAssertEqual(nativoEntregue, .delivered)
        let nativo = transport.sent.last ?? Data()
        XCTAssertTrue(contains(nativo, [0x1d, 0x28, 0x6b]), "o modo nativo pede o QR à firmware")
        XCTAssertFalse(contains(nativo, [0x1d, 0x76, 0x30, 0x00]), "o modo nativo não rasteriza")
        XCTAssertEqual(Set(escolha.consultados), [perfil.id])
    }

    /// A trava vale no caminho de produção: preferência nativa sem capacidade medida sai raster.
    func testPreferenciaNativaSemCapacidadeMedidaSaiRasterizadaNoPapel() async throws {
        let escolha = EscolhaDeEmissaoWifi()
        escolha.escreva(ThermalCodeEmissionPreferences(qrEmission: .native, barcodeEmission: .native))
        let networkProvider = MutableWifiNetworkProvider(network: try makeNetwork(host: "192.168.1.10"))
        let transport = ScriptedWifiTransport(outcomes: [.delivered, .delivered])
        let controller = LocalWifiThermalPrinterController(
            networkProvider: networkProvider,
            transport: transport,
            store: InMemoryPrinterSelectionStore(),
            codeEmissionOverride: { id in escolha.leia(id) }
        )
        let adoption = await controller.testManual(ipAddress: "192.168.1.40", portText: "9100")
        XCTAssertEqual(adoption, .delivered)
        controller.confirmTestReceipt()
        XCTAssertTrue(controller.confirmHomologatedProfile(try perfilDeEmissaoWifi(nativeQrHonored: nil)))

        let entregue = await controller.print(QrOnlyWifiReceipt(qrDeEmissaoWifi))
        XCTAssertEqual(entregue, .delivered)

        let cupom = transport.sent.last ?? Data()
        XCTAssertTrue(contains(cupom, [0x1d, 0x76, 0x30, 0x00]))
        XCTAssertFalse(contains(cupom, [0x1d, 0x28, 0x6b]))
    }

    /**
     O agregado entrega o ponto de injeção aos dois transportes.

     Um parâmetro com padrão que não fosse repassado compilaria em silêncio, e a preferência
     simplesmente nunca chegaria ao papel — o defeito que só aparece com a impressora na mesa.
     */
    func testOAgregadoEntregaOPontoDeInjecaoAoTransporte() async throws {
        let escolha = EscolhaDeEmissaoWifi()
        escolha.escreva(ThermalCodeEmissionPreferences(qrEmission: .native))
        let transport = ScriptedWifiTransport(outcomes: [.delivered, .delivered])
        let configuration = ThermalPrinterConfiguration(
            selectionStore: InMemoryPrinterSelectionStore(),
            profileStore: PrinterProfileStore(dataStore: MemoriaDePerfis()),
            networkProvider: MutableWifiNetworkProvider(network: try makeNetwork(host: "192.168.1.10")),
            localWifiTransport: transport,
            bluetoothTransport: BluetoothMudo(),
            codeEmissionOverride: { id in escolha.leia(id) }
        )
        let adoption = await configuration.localWifi.testManual(
            ipAddress: "192.168.1.40",
            portText: "9100"
        )
        XCTAssertEqual(adoption, .delivered)
        configuration.localWifi.confirmTestReceipt()
        let perfil = try perfilDeEmissaoWifi(nativeQrHonored: true)
        XCTAssertTrue(configuration.localWifi.confirmHomologatedProfile(perfil))

        let entregue = await configuration.localWifi.print(QrOnlyWifiReceipt(qrDeEmissaoWifi))
        XCTAssertEqual(entregue, .delivered)

        let cupom = transport.sent.last ?? Data()
        XCTAssertTrue(contains(cupom, [0x1d, 0x28, 0x6b]), "a preferência não atravessou o agregado")
        XCTAssertEqual(Set(escolha.consultados), [perfil.id])
    }

    private func perfilDeEmissaoWifi(nativeQrHonored: Bool?) throws -> PrinterProfile {
        let capabilities = try PrinterCapabilities(
            transports: [.localWifi],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: 9_100,
            nativeQrHonored: nativeQrHonored
        )
        return PrinterProfile(
            id: "00000000-0000-4000-8000-0000000000e2",
            displayName: "Impressora de balcão de teste",
            source: .measured,
            measuredAt: Date(timeIntervalSince1970: 1),
            capabilities: capabilities
        )
    }

    private func makeReadyController(
        nextOutcome: ScriptedWifiTransport.Outcome
    ) async throws -> (
        controller: LocalWifiThermalPrinterController,
        networkProvider: MutableWifiNetworkProvider,
        transport: ScriptedWifiTransport
    ) {
        let networkProvider = MutableWifiNetworkProvider(
            network: try makeNetwork(host: "192.168.1.10")
        )
        let transport = ScriptedWifiTransport(outcomes: [.delivered, nextOutcome])
        let controller = LocalWifiThermalPrinterController(
            networkProvider: networkProvider,
            transport: transport,
            store: InMemoryPrinterSelectionStore()
        )

        let adoption = await controller.testManual(
            ipAddress: "192.168.1.40",
            portText: "9100"
        )
        XCTAssertEqual(adoption, .delivered)
        XCTAssertEqual(controller.state, .awaitingConfirmation)
        controller.confirmTestReceipt()
        XCTAssertEqual(controller.state, .ready)

        return (controller, networkProvider, transport)
    }

    private func makeNetwork(host: String) throws -> LocalWifiPrinterNetwork {
        LocalWifiPrinterNetwork(
            subnet: try XCTUnwrap(
                LocalWifiPrinterSubnet(hostAddress: host, prefixLength: 24)
            )
        )
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

private final class ScriptedWifiTransport: LocalWifiPrinterTransport, @unchecked Sendable {
    enum Outcome {
        case delivered
        case unavailable
        case writeFailed
        case externalError
    }

    private var outcomes: [Outcome]
    var beforeNextCompletion: (() -> Void)?
    var discoveredAddress: String?
    private(set) var sentCount = 0
    /// O último cupom que desceu para o transporte. Existe para os testes que perguntam **quais**
    /// bytes saíram, e não só quantos.
    private(set) var sent: [Data] = []

    init(outcomes: [Outcome]) {
        self.outcomes = outcomes
    }

    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool {
        endpoint.ipAddress == discoveredAddress
    }

    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        sentCount += 1
        sent.append(data)
        let outcome = outcomes.removeFirst()
        let callback = beforeNextCompletion
        beforeNextCompletion = nil
        callback?()
        switch outcome {
        case .delivered:
            return
        case .unavailable:
            throw LocalWifiPrinterTransportError.unavailable
        case .writeFailed:
            throw LocalWifiPrinterTransportError.writeFailed
        case .externalError:
            throw SyntheticWifiTransportError()
        }
    }
}

private struct SyntheticWifiTransportError: Error {}

private final class WifiReceipt: ThermalReceiptPayload {
    func receiptBytes(layout: ReceiptLayout) -> Data? { Data([0x41]) }
    func clear() {}
}

/// Endereço sem assinatura: o que estes cupons provam é o comando, não o conteúdo.
private let qrDeEmissaoWifi = "https://queven.app/printher"

/// Cupom mínimo que exercita o caminho `layout.qr`, o que escolhe o modo.
private final class QrOnlyWifiReceipt: ThermalReceiptPayload {
    private var value: String?

    init(_ value: String) { self.value = value }

    func receiptBytes(layout: ReceiptLayout) -> Data? { value.flatMap { layout.qr(payload: $0) } }

    func clear() { value = nil }
}

/// O ajuste do hospedeiro, que muda enquanto o app roda — e registra por qual impressora foi
/// perguntado. `@unchecked Sendable` porque tudo aqui acontece na mesma thread do teste.
private final class EscolhaDeEmissaoWifi: @unchecked Sendable {
    private(set) var consultados: [String] = []
    private var preferencia: ThermalCodeEmissionPreferences?

    func escreva(_ nova: ThermalCodeEmissionPreferences) { preferencia = nova }

    func leia(_ profileId: String) -> ThermalCodeEmissionPreferences? {
        consultados.append(profileId)
        return preferencia
    }
}

private final class MemoriaDePerfis: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

/// O agregado exige um transporte Bluetooth; esta suíte só exercita a Wi-Fi.
private final class BluetoothMudo: BluetoothPrinterTransporting {
    var onStateChange: ((BluetoothPrinterRadioState) -> Void)?
    var onCandidates: (([BluetoothPrinterCandidate]) -> Void)?

    func startScan() {}
    func stopScan() {}
    func disconnect() {}
    func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate,
        completion: @escaping (ThermalPrintResult) -> Void
    ) {
        completion(.failed(message: "Sem rádio nesta suíte.", delivery: .notSent))
    }
}

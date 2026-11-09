import XCTest
@testable import ThermalPrinterKit

/**
 O ponto de injeção neutro do hospedeiro.

 O que estes testes protegem não é a existência do gancho: é a **posição** dele, e o conjunto de
 papéis que o recebem. Um rodapé concatenado depois de `finish()` compila, passa em qualquer teste
 de conteúdo e sai do outro lado da guilhotina — no cupom seguinte, para o cliente seguinte. E uma
 decoração que vazasse para a tira de homologação deslocaria justamente o que a tira mede.
 */
@MainActor
final class ReceiptDecorationTests: XCTestCase {
    /// Sem decoração, o kit precisa emitir exatamente os mesmos bytes de sempre.
    func testSemDecoracaoOCorteEByteAByteOMesmo() {
        let cru = Array(repeating: UInt8(0x0a), count: 5) + [0x1d, 0x56, 0x00]

        XCTAssertEqual(Array(ReceiptLayout.counter.finish()), cru)
        XCTAssertEqual(
            Array(ReceiptLayout.counter.decorated(by: DecoracaoDoHospedeiro()).finish()),
            cru
        )
    }

    /**
     O teste que justifica a frente: o rodapé precisa vir **antes** do corte.

     Se um dia alguém "simplificar" concatenando o rodapé no chamador, este teste vira vermelho — e
     a alternativa é descobrir isso no papel, no cupom do cliente seguinte.
     */
    func testORodapeSaiAntesDaGuilhotinaNuncaDepois() throws {
        let layout = ReceiptLayout.counter.decorated(by: DecoracaoDoHospedeiro(footer: rodape))
        let bytes = layout.finish()

        let corte = try XCTUnwrap(bytes.range(of: Data([0x1d, 0x56, 0x00])))
        let posicaoDoRodape = try XCTUnwrap(bytes.range(of: Data(rodape.utf8)))

        XCTAssertLessThan(
            posicaoDoRodape.upperBound,
            corte.lowerBound,
            "O rodapé saiu depois do corte: ele imprimiria no cupom seguinte."
        )
    }

    /// Sem guilhotina o rodapé continua antes do avanço, senão a serrilha parte a linha.
    func testSemGuilhotinaORodapeAindaPrecedeOAvanco() throws {
        let layout = ReceiptLayout.portable58mm.decorated(by: DecoracaoDoHospedeiro(footer: rodape))
        let bytes = layout.finish()

        XCTAssertEqual(Array(bytes.suffix(4)), Array(repeating: 0x0a, count: 4))
        let posicaoDoRodape = try XCTUnwrap(bytes.range(of: Data(rodape.utf8)))
        XCTAssertLessThanOrEqual(posicaoDoRodape.upperBound, bytes.count - 4)
    }

    /**
     Rodapé acentuado em cada modelo de codificação que o kit conhece.

     O rodapé é montado por `layout.text`, então ele respeita a página medida em vez de escolher
     uma: em CP850 o `ç` sai num byte alto, em UTF-8 sai em dois, e sem página ele dobra para
     ASCII. O que este teste protege é que a posição continua certa nos três — um rodapé de largura
     variável não pode empurrar o corte nem se perder no meio dele.
     */
    func testRodapeMultibyteNaoQuebraAPosicaoDoCorte() throws {
        let acentuado = "Cupom de operação\n"
        let decoracao = DecoracaoDoHospedeiro(footer: acentuado)

        // CP850, com guilhotina: o `ç` e o `ã` viram um byte cada.
        let cp850 = ReceiptLayout.counter.decorated(by: decoracao).finish()
        XCTAssertNotNil(cp850.range(of: Data([0x87])), "O ç de CP850 não saiu no byte da página.")
        try XCTAssertPrecede(Data([0x87]), Data([0x1d, 0x56, 0x00]), in: cp850)

        // UTF-8: os mesmos acentos ocupam dois bytes, e o corte continua depois deles.
        let utf8Layout = ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: true,
            codePage: nil,
            textEncoding: .utf8,
            cutProtocol: .gsV0,
            cutFeedLines: 5,
            printableDots: 576,
            decoration: decoracao
        )
        let utf8 = utf8Layout.finish()
        try XCTAssertPrecede(Data(acentuado.utf8), Data([0x1d, 0x56, 0x00]), in: utf8)
        // O mesmo `ç` em dois bytes aqui e num só ali: é o rodapé seguindo a página do perfil, e
        // não escolhendo uma. Trocar os dois de lugar é o defeito que este par de asserções pega.
        XCTAssertNotNil(utf8.range(of: Data([0xc3, 0xa7])))
        XCTAssertNil(utf8.range(of: Data([0x87])))
        XCTAssertNil(cp850.range(of: Data([0xc3, 0xa7])))

        // Sem página: a dobra conservadora mantém o rodapé legível e não emite byte alto nenhum.
        let semPagina = ReceiptLayout.portable58mm.decorated(by: decoracao).finish()
        XCTAssertNotNil(semPagina.range(of: Data("Cupom de operacao".utf8)))
        XCTAssertFalse(semPagina.contains { $0 > 0x7f }, "A dobra ASCII deixou passar byte alto.")
    }

    /// O cupom do hospedeiro sai decorado pelo transporte, sem o payload saber que existe gancho.
    func testCupomComumSaiComCabecalhoERodape() async throws {
        let fixture = try await makeAdoptedWifiPrinter()

        let result = await fixture.controller.print(CupomDoHospedeiro())

        XCTAssertEqual(result, .delivered)
        let cupom = try XCTUnwrap(fixture.transport.sent.last)
        // A ordem inteira numa asserção só: cabeçalho, corpo do payload, rodapé, lâmina.
        try XCTAssertPrecede(Data(cabecalho.utf8), Data([0x42, 0x42, 0x42]), in: cupom)
        try XCTAssertPrecede(Data([0x42, 0x42, 0x42]), Data(rodape.utf8), in: cupom)
        try XCTAssertPrecede(Data(rodape.utf8), Data([0x1d, 0x56, 0x00]), in: cupom)
    }

    /// O comprovante de teste é papel do hospedeiro, e carrega a decoração como qualquer venda.
    func testComprovanteDeTesteCarregaADecoracao() async throws {
        let fixture = try await makeAdoptedWifiPrinter()
        let comprovanteInicial = try XCTUnwrap(fixture.transport.sent.first)

        try XCTAssertPrecede(
            Data(cabecalho.utf8),
            Data("COMPROVANTE DE TESTE".utf8),
            in: comprovanteInicial
        )
        try XCTAssertPrecede(Data(rodape.utf8), Data([0x1d, 0x56, 0x00]), in: comprovanteInicial)

        let repetido = await fixture.controller.printTestReceiptAgain()
        XCTAssertEqual(repetido, .delivered)
        let reenviado = try XCTUnwrap(fixture.transport.sent.last)
        XCTAssertNotNil(reenviado.range(of: Data(cabecalho.utf8)))
        XCTAssertNotNil(reenviado.range(of: Data(rodape.utf8)))
    }

    /**
     A isenção deliberada: tira de homologação é instrumento de medida e não carrega decoração.

     O comprovante final, ao contrário, carrega — ele não mede nada, é o recibo da instalação. Este
     teste percorre a homologação inteira e cobra as duas coisas na mesma passagem, porque separá-las
     deixaria passar exatamente o erro que importa: alguém decorar o caminho todo "por simetria".
     */
    func testTirasNaoCarregamDecoracaoEOComprovanteFinalCarrega() async throws {
        let sender = SondaGravada()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetooth],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: MemoriaDePerfis()),
            selectionStore: InMemoryPrinterSelectionStore(),
            receiptDecoration: DecoracaoDoHospedeiro(header: cabecalho, footer: rodape)
        )

        try session.selectPaperWidth(.mm58)
        try await enviaEResponde(session, sender: sender, .geometry(printableColumns: 32, printableDots: 384))
        try await enviaEResponde(session, sender: sender, nominalRasterThroughputResponse)
        // A tira de código nativo é mais uma que precisa sair sem decoração: ela mede, e um raster
        // do hospedeiro no meio dela deslocaria o que ela mede.
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.skipNativeCodeMeasurement()
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await enviaEResponde(session, sender: sender, .codePage(nil))

        let tiras = sender.enviados
        XCTAssertFalse(tiras.isEmpty, "A homologação precisa ter imprimido tiras.")
        for (indice, tira) in tiras.enumerated() {
            XCTAssertNil(
                tira.range(of: Data(cabecalho.utf8)),
                "A tira \(indice + 1) saiu com o cabeçalho do hospedeiro."
            )
            XCTAssertNil(
                tira.range(of: Data(rodape.utf8)),
                "A tira \(indice + 1) saiu com o rodapé do hospedeiro."
            )
        }

        try session.sendFinalReceipt()
        await Task.yield()
        let comprovanteFinal = try XCTUnwrap(sender.enviados.last)
        XCTAssertGreaterThan(sender.enviados.count, tiras.count)
        try XCTAssertPrecede(
            Data(cabecalho.utf8),
            Data("Instalacao concluida".utf8),
            in: comprovanteFinal
        )
        // Sem guilhotina o fecho é avanço; o rodapé precisa estar antes dele, e não no fim do rolo.
        let posicaoDoRodape = try XCTUnwrap(comprovanteFinal.range(of: Data(rodape.utf8)))
        XCTAssertLessThanOrEqual(posicaoDoRodape.upperBound, comprovanteFinal.count - 4)
    }

    /// Sem decoração, o comprovante final continua sem carimbo nenhum do hospedeiro.
    func testComprovanteFinalSemDecoracaoNaoGanhaNada() throws {
        let perfil = try MeasuredProfile(
            id: UUID(),
            displayName: "Impressora medida",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )

        let semGancho = PrinterProbePayloads.finalReceipt(profile: perfil)
        let comGanchoVazio = PrinterProbePayloads.finalReceipt(
            profile: perfil,
            decoration: DecoracaoDoHospedeiro()
        )

        XCTAssertEqual(semGancho, comGanchoVazio)
    }

    // MARK: - Apoio

    private let cabecalho = "CABECALHO DO APP\n"
    private let rodape = "RODAPE DO APP\n"

    private func XCTAssertPrecede(
        _ primeiro: Data,
        _ segundo: Data,
        in bytes: Data,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let inicio = try XCTUnwrap(bytes.range(of: primeiro), "Trecho ausente.", file: file, line: line)
        let fim = try XCTUnwrap(bytes.range(of: segundo), "Trecho ausente.", file: file, line: line)
        XCTAssertLessThanOrEqual(inicio.upperBound, fim.lowerBound, file: file, line: line)
    }

    private func enviaEResponde(
        _ session: PrinterHomologationSession,
        sender: SondaGravada,
        _ response: PrinterHomologationResponse
    ) async throws {
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.answer(response)
    }

    private func makeAdoptedWifiPrinter() async throws -> (
        controller: LocalWifiThermalPrinterController,
        transport: TransporteGravado
    ) {
        let transport = TransporteGravado()
        let controller = LocalWifiThermalPrinterController(
            networkProvider: RedeFixa(),
            transport: transport,
            store: InMemoryPrinterSelectionStore(),
            receiptDecoration: DecoracaoDoHospedeiro(header: cabecalho, footer: rodape)
        )

        let adocao = await controller.testManual(ipAddress: "192.168.1.40", portText: "9100")
        XCTAssertEqual(adocao, .delivered)
        controller.confirmTestReceipt()
        XCTAssertEqual(controller.state, .ready)
        return (controller, transport)
    }
}

/// Decoração de teste montada pelo layout, como o contrato manda: é `layout.text` que respeita a
/// página medida, e é por isso que ela é a única forma admitida de escrever no rodapé.
private final class DecoracaoDoHospedeiro: ReceiptDecoration {
    private let textoDoCabecalho: String?
    private let textoDoRodape: String?

    init(header: String? = nil, footer: String? = nil) {
        textoDoCabecalho = header
        textoDoRodape = footer
    }

    func header(layout: ReceiptLayout) -> Data? {
        textoDoCabecalho.map { layout.text($0, alignment: 1) }
    }

    func footer(layout: ReceiptLayout) -> Data? {
        textoDoRodape.map { layout.text($0, alignment: 1) }
    }
}

/// Payload opaco para o kit: só o kit sabe onde encostar cabeçalho e rodapé nele.
private final class CupomDoHospedeiro: ThermalReceiptPayload {
    func receiptBytes(layout: ReceiptLayout) -> Data? {
        var data = EscPos.initialize()
        data.append(Data([0x42, 0x42, 0x42]))
        data.append(layout.finish())
        return data
    }

    func clear() {}
}

private final class RedeFixa: LocalWifiPrinterNetworkProviding {
    private let network = LocalWifiPrinterNetwork(
        subnet: LocalWifiPrinterSubnet(hostAddress: "192.168.1.10", prefixLength: 24)!
    )

    func currentNetwork() -> LocalWifiPrinterNetwork? { network }
}

private final class TransporteGravado: LocalWifiPrinterTransport, @unchecked Sendable {
    private(set) var sent: [Data] = []

    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool { true }

    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        sent.append(data)
    }
}

private final class SondaGravada: PrinterProbeSending {
    let transport = PrinterTransport.bluetooth
    private(set) var enviados: [Data] = []
    private var completion: ((PrinterProbeSendResult) -> Void)?

    func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void) {
        enviados.append(bytes)
        self.completion = completion
    }

    func complete(_ result: PrinterProbeSendResult) {
        let callback = completion
        completion = nil
        callback?(result)
    }
}

private final class MemoriaDePerfis: PrinterProfileDataStoring {
    private var data: Data?
    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

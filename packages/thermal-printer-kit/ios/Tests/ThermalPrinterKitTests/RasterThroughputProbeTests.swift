import CryptoKit
import XCTest
@testable import ThermalPrinterKit

/**
 A sonda que dá o fator de compensação vertical.

 O defeito medido em 20/08 na Inico T210 é raster largo saindo com 80% da altura declarada,
 coerente, só encolhido — a mesma imagem de 45,7 KB sai com 97 mm na GoldenSky MTP-II e com 80 mm
 nela. Vazão, banda, MTU, modo de escrita e cobertura foram eliminados por medição, um a um; o que
 sobra é uma firmware que encolhe por um fator constante. Nada no enlace denuncia isso. O
 instrumento é uma tira de altura declarada saindo do outro lado e uma régua na mão, e a conta que
 traduz régua em fator está aqui.

 A tira, a pergunta e a resposta humana não mudaram desde 20/08 pela manhã; a **conclusão** mudou.
 O teto de vazão que esta conta produzia continua no código, testado, para a rajada de 18/08 — mas
 nenhuma sonda o define mais.
 */
@MainActor
final class RasterThroughputProbeTests: XCTestCase {
    private let alturaMm = PrinterProbePayloads.rasterThroughputStripMillimetres

    /// Bytes da tira em 58 mm. O envio da bancada dura um segundo cravado, então a vazão medida é
    /// exatamente este número. Ela continua sendo medida e publicada; a conclusão é que deixou de
    /// depender dela.
    private var bytesDaTira: Int {
        PrinterProbePayloads.rasterThroughput(printableDots: 384)?.count ?? 0
    }

    func testATiraTemLarguraCheiaAlturaDeclaradaETramaDeMeioTom() throws {
        let bytes = try XCTUnwrap(PrinterProbePayloads.rasterThroughput(printableDots: 384))
        let texto = String(decoding: bytes, as: UTF8.self)

        // A instrução vai em ASCII, como nas outras tiras, e **não** diz quanto ela deveria medir:
        // esse número é a resposta da pergunta, e quem lê a resposta antes de medir mede menos.
        XCTAssertTrue(texto.contains("SONDA DE VAZAO"))
        XCTAssertTrue(texto.contains("Meca a altura do bloco"))
        XCTAssertFalse(texto.contains("\(alturaMm) MM"))
        XCTAssertFalse(texto.contains("\(PrinterProbePayloads.rasterThroughputStripDots) DOTS"))

        // Dezesseis faixas de 24 dots: exatamente a forma de bytes que o emissor de foto produz.
        let faixas = stripes(in: bytes)
        XCTAssertEqual(
            faixas.count,
            PrinterProbePayloads.rasterThroughputStripDots / EscPosRasterEmitter.stripeHeightDots
        )
        for faixa in faixas {
            XCTAssertEqual(faixa.widthBytes, 384 / 8)
            XCTAssertEqual(faixa.height, EscPosRasterEmitter.stripeHeightDots)
        }

        // Cobertura perto de 50%: nem papel em branco, que não mediria nada, nem preto sólido, que
        // castiga a cabeça e aciona proteção térmica — um segundo fenômeno em cima da medida.
        let pixels = faixas.flatMap(\.pixels)
        let pretos = pixels.reduce(0) { $0 + $1.nonzeroBitCount }
        let cobertura = Double(pretos) / Double(pixels.count * 8)
        XCTAssertTrue((0.45...0.60).contains(cobertura), "Cobertura fora do meio tom: \(cobertura)")

        // Nenhuma linha inteira de branco: uma tira sem tinta não teria borda para a régua.
        XCTAssertFalse(pixels.contains(0))

        // **A mesma tira nas duas plataformas.** Instrumento de medida com duas versões mede duas
        // impressoras diferentes com a mesma pergunta: a leitura de 46 mm num aparelho deixaria de
        // significar o que significa no outro. O Android fixa este mesmo par em
        // `RasterThroughputProbeTest`, e conferido byte a byte em 20/08.
        XCTAssertEqual(bytes.count, 18_667)
        XCTAssertEqual(sha256(bytes), Self.stripSha256)
    }

    /// A tira do Android e a do iOS são o mesmo instrumento: mesma altura, mesma faixa, mesma
    /// instrução. Divergir aqui seria medir duas impressoras diferentes com a mesma pergunta.
    func testATiraAcompanhaALarguraImprimivelMedida() throws {
        let estreita = try XCTUnwrap(PrinterProbePayloads.rasterThroughput(printableDots: 384))
        let larga = try XCTUnwrap(PrinterProbePayloads.rasterThroughput(printableDots: 576))

        XCTAssertGreaterThan(larga.count, estreita.count)
        XCTAssertNil(PrinterProbePayloads.rasterThroughput(printableDots: 100))
        XCTAssertEqual(PrinterProbePayloads.rasterThroughputStripDots, 384)
        XCTAssertEqual(alturaMm, 48)
    }

    /// A tira mede, não decora: ela nem tem por onde receber cabeçalho e rodapé do hospedeiro.
    func testATiraDaSondaSaiSemDecoracaoDoHospedeiro() async throws {
        let comGancho = BancadaDeVazao()
        let semGancho = BancadaDeVazao()
        let comDecoracao = sessao(sender: comGancho, decoration: CarimboDoHospedeiro())
        let semDecoracao = sessao(sender: semGancho)

        try await ateAVazao(comDecoracao, sender: comGancho)
        try await ateAVazao(semDecoracao, sender: semGancho)

        let tiraLimpa = try XCTUnwrap(semGancho.enviados.last)
        let tiraDecorada = try XCTUnwrap(comGancho.enviados.last)
        XCTAssertEqual(
            tiraLimpa,
            try XCTUnwrap(PrinterProbePayloads.rasterThroughput(printableDots: 384))
        )
        XCTAssertEqual(tiraDecorada, tiraLimpa, "A tira de vazão saiu decorada.")
    }

    /// Tira inteira, nenhum fator: `nil` é o comportamento de sempre, byte a byte.
    ///
    /// O piso de 0,97 tolera o ±1 mm de uma régua comum sem tolerar o defeito, que numa tira de
    /// 48 mm come mais de um centímetro. Acima do piso o perfil fica **sem** fator, e não com um
    /// fator de 0,98: compensação de 2% é ruído de régua virando alteração permanente de imagem.
    func testProporcaoAltaNaoGravaFator() async throws {
        for medida in [alturaMm, alturaMm - 1, 47] {
            let sender = BancadaDeVazao()
            let session = sessao(sender: sender)
            try await ateAVazao(session, sender: sender)
            try session.answer(.rasterThroughput(printedLengthMillimetres: medida))

            XCTAssertNil(session.machine.verticalRasterScale, "\(medida) mm")
        }

        // E a resposta rápida é a leitura nominal, com o mesmo desfecho.
        let sender = BancadaDeVazao()
        let rapida = sessao(sender: sender)
        try await ateAVazao(rapida, sender: sender)
        try rapida.answerRasterThroughputPrintedInFull()
        XCTAssertNil(rapida.machine.verticalRasterScale)
    }

    /// Metade da tira, fator de metade — e **sem margem nenhuma**.
    ///
    /// O teto de vazão tinha uma margem de 0,90, porque errar para cima devolvia o defeito e errar
    /// para baixo só custava segundos. Aqui a assimetria não existe: compensar 10% a mais estica a
    /// foto tanto quanto compensar 10% a menos a encolhe. A compensação quer o fator **medido**.
    func testProporcaoBaixaGravaOFatorMedidoSemMargem() async throws {
        let sender = BancadaDeVazao()
        let session = sessao(sender: sender)
        try await ateAVazao(session, sender: sender)

        // A vazão continua medida e publicada: medir não é concluir.
        XCTAssertEqual(session.machine.measuredRasterBytesPerSecond, bytesDaTira)

        try session.answer(.rasterThroughput(printedLengthMillimetres: alturaMm / 2))

        XCTAssertEqual(try XCTUnwrap(session.machine.verticalRasterScale), 0.5, accuracy: 1e-9)

        // E a T210 da bancada: 48 mm declarados, 38 medidos, fator 0,79 — não 0,71 de uma margem.
        let t210Sender = BancadaDeVazao()
        let t210 = sessao(sender: t210Sender)
        try await ateAVazao(t210, sender: t210Sender)
        try t210.answer(.rasterThroughput(printedLengthMillimetres: 38))
        XCTAssertEqual(
            try XCTUnwrap(t210.machine.verticalRasterScale),
            38.0 / Double(alturaMm),
            accuracy: 1e-9
        )
    }

    /// O fator é uma capacidade do perfil, e chega ao disco e ao layout pelo caminho normal.
    func testOFatorMedidoAtravessaOPerfil() async throws {
        let sender = BancadaDeVazao()
        let store = PrinterProfileStore(dataStore: MemoriaDeVazao())
        let session = sessao(sender: sender, store: store)
        try await ateAVazao(session, sender: sender)
        try session.answer(.rasterThroughput(printedLengthMillimetres: alturaMm / 2))
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.skipNativeCodeMeasurement()
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.answer(.codePage(nil))
        try session.sendFinalReceipt()
        sender.complete(.success)
        await Task.yield()
        try session.confirmFinalReceipt()

        let perfil = try XCTUnwrap(store.profiles().first)
        XCTAssertEqual(try XCTUnwrap(perfil.verticalRasterScale), 0.5, accuracy: 1e-9)
        XCTAssertEqual(
            try XCTUnwrap(ReceiptLayout(profile: PrinterProfile(perfil)).verticalRasterScale),
            0.5,
            accuracy: 1e-9
        )
        // E o teto de vazão continua nulo: nenhuma sonda o define desde 20/08.
        XCTAssertNil(perfil.maxRasterBytesPerSecond)
    }

    /// A régua atravessa a máquina, o disco e sai **escrita** no comprovante final.
    ///
    /// Este é o fio que sustenta reconstruir o milímetro a partir do fator em vez de guardá-lo num
    /// campo novo: quem respondeu 38 na tira precisa ler 38 no papel, depois do arredondamento, da
    /// gravação e da releitura. Se a conta perdesse o número, é aqui que apareceria.
    ///
    /// A T210 da bancada, 20/08: 38 mm de 48 na régua, fator 0,79 no perfil.
    func testALeituraDaReguaSaiEscritaNoComprovanteFinal() async throws {
        func papel(naVazao: (PrinterHomologationSession) throws -> Void) async throws -> String {
            let sender = BancadaDeVazao()
            let store = PrinterProfileStore(dataStore: MemoriaDeVazao())
            let session = sessao(sender: sender, store: store)
            try await ateAVazao(session, sender: sender)
            try naVazao(session)
            try session.sendCurrentProbe()
            sender.complete(.success)
            await Task.yield()
            try session.skipNativeCodeMeasurement()
            try session.answerCutterQuestion(.no)
            try session.completeCutFeedWithoutProbe()
            try session.sendCurrentProbe()
            sender.complete(.success)
            await Task.yield()
            try session.answer(.codePage(nil))
            try session.sendFinalReceipt()
            sender.complete(.success)
            await Task.yield()
            try session.confirmFinalReceipt()
            // Do disco, e não do rascunho: é o perfil relido que o app usa daqui a um mês.
            let relido = try XCTUnwrap(store.profiles().first)
            let bytes = PrinterProbePayloads.finalReceipt(profile: relido)
            return String(decoding: bytes, as: UTF8.self)
        }

        // Sem página medida — a resposta `nil` é a linha `a` da tira, o piso ASCII —, o encoder
        // dobra os acentos sozinho e a linha continua legível. É a outra metade da regra: nenhum
        // caractere que a página não tenha.
        let medida = try await papel { try $0.answer(.rasterThroughput(printedLengthMillimetres: 38)) }
        XCTAssertTrue(medida.contains("Vazao: 38/48 mm | fator 0,79"), medida)

        // "Usar padrão": nada a citar, e a linha continua saindo. É a MTP-II do cheque de papel.
        let semRegua = try await papel { try $0.skipRasterThroughputMeasurement() }
        XCTAssertTrue(semRegua.contains("Vazao: sem compensacao"), semRegua)
        XCTAssertFalse(semRegua.contains("fator"))
    }

    /// O campo tem faixa aceita, e a conta cai dentro dela em vez de recusar o perfil no fim.
    func testOFatorCalculadoEhPresoNaFaixaAceitaPeloCampo() async throws {
        let faixa = ReceiptLayout.allowedVerticalRasterScale

        // Um milímetro de 48 seriam 0,02: a imagem sairia com cinquenta vezes a altura pedida, e o
        // que está errado é a leitura. O piso do campo para isso aqui, e não na hora de salvar.
        let absurdo = BancadaDeVazao()
        let sessaoAbsurda = sessao(sender: absurdo)
        try await ateAVazao(sessaoAbsurda, sender: absurdo)
        try sessaoAbsurda.answer(.rasterThroughput(printedLengthMillimetres: 1))
        XCTAssertEqual(
            try XCTUnwrap(sessaoAbsurda.machine.verticalRasterScale),
            faixa.lowerBound,
            accuracy: 1e-9
        )

        // E a maior leitura que ainda conclui fator sai exata, sem encostar em teto nenhum.
        let quaseInteira = BancadaDeVazao()
        let sessaoQuaseInteira = sessao(sender: quaseInteira)
        try await ateAVazao(sessaoQuaseInteira, sender: quaseInteira)
        try sessaoQuaseInteira.answer(.rasterThroughput(printedLengthMillimetres: 46))
        XCTAssertEqual(
            try XCTUnwrap(sessaoQuaseInteira.machine.verticalRasterScale),
            46.0 / Double(alturaMm),
            accuracy: 1e-9
        )
    }

    /// A conclusão não depende mais da vazão medida, e é isso que a bancada de 20/08 pediu.
    ///
    /// A vazão continua sendo medida e publicada — medir não é concluir —, mas a régua sozinha
    /// decide o fator. Com e sem número de transporte, a mesma leitura dá o mesmo fator.
    func testAReguaDecideSozinhaComOuSemVazaoMedida() throws {
        func fator(com vazao: Int?) throws -> Double? {
            let machine = maquinaNaVazao(measuredBytesPerSecond: vazao)
            try machine.answer(.rasterThroughput(printedLengthMillimetres: alturaMm / 2))
            // A vazão entrega a sonda de código nativo, que é o passo seguinte desde que ela
            // entrou: as duas dependem da largura imprimível medida e nenhuma depende de guilhotina.
            XCTAssertEqual(machine.state, .ready(.nativeCode))
            return machine.verticalRasterScale
        }

        XCTAssertEqual(try XCTUnwrap(fator(com: nil)), 0.5, accuracy: 1e-9)
        XCTAssertEqual(try fator(com: nil), try fator(com: 10_000))
        XCTAssertEqual(try fator(com: nil), try fator(com: 500))
    }

    func testLeituraInvalidaEhRecusada() throws {
        for medida in [0, -1, alturaMm + 1, 1_000] {
            let machine = maquinaNaVazao(measuredBytesPerSecond: 10_000)

            XCTAssertThrowsError(
                try machine.answer(.rasterThroughput(printedLengthMillimetres: medida))
            ) { erro in
                XCTAssertEqual(erro as? PrinterHomologationMachineError, .invalidResponse)
            }
            // E o passo continua aberto, esperando uma leitura que caiba na tira enviada.
            XCTAssertEqual(machine.state, .awaitingResponse(.rasterThroughput))
        }
    }

    /// Resposta antes do callback do transporte continua recusada, como em toda sonda.
    func testALeituraSoEhAceitaDepoisDoEnvioTerminar() throws {
        let machine = maquina()
        try machine.selectPaperWidthUsingDefaults(.mm58)

        XCTAssertThrowsError(
            try machine.answer(.rasterThroughput(printedLengthMillimetres: alturaMm))
        )
        _ = try machine.beginSending()
        XCTAssertThrowsError(
            try machine.answer(.rasterThroughput(printedLengthMillimetres: alturaMm))
        )
    }

    /// "Usar padrão" existe porque este é o único passo que pede régua **de fora**.
    ///
    /// Os outros se leem na própria tira. Sem saída, quem não tem régua chutaria um número — e
    /// chute vira fator gravado, que deforma toda imagem daquela impressora.
    func testUsarPadraoConcluiSemFatorEGravaOMesmoPerfilDeQuemNaoMediu() throws {
        let semRegua = maquinaNaVazao(measuredBytesPerSecond: 10_000)
        try semRegua.skipRasterThroughputMeasurement()

        XCTAssertNil(semRegua.verticalRasterScale)
        XCTAssertEqual(semRegua.state, .ready(.nativeCode))

        // **Nulo é nulo.** O perfil de quem escolheu "Usar padrão" é indistinguível, campo a campo,
        // do perfil que nunca viu esta sonda: sem valor "padrão" numérico e sem marcador de que
        // alguém pulou. As duas máquinas percorrem o mesmo roteiro e recebem o mesmo id e a mesma
        // data, então a igualdade é a do dado inteiro, não a de um campo escolhido a dedo.
        let comPadrao = try perfilAteDone { try $0.skipRasterThroughputMeasurement() }
        let comMedida = try perfilAteDone { try $0.answerRasterThroughputPrintedInFull() }
        XCTAssertEqual(comPadrao, comMedida)
        XCTAssertEqual(comPadrao.capabilityKey, comMedida.capabilityKey)
        XCTAssertNil(comPadrao.verticalRasterScale)
    }

    /// Voltar reabre o passo e apaga a medida; a próxima tira é que traz o número novo.
    func testVoltarDesfazOPassoDaImagemSemImprimirNada() async throws {
        let sender = BancadaDeVazao()
        let session = sessao(sender: sender)
        try await ateAVazao(session, sender: sender)
        try session.answer(.rasterThroughput(printedLengthMillimetres: alturaMm / 2))

        XCTAssertNotNil(session.machine.verticalRasterScale)
        XCTAssertEqual(session.previousStep, .rasterThroughput)
        // Papel gasto se anuncia antes: refazer o passo manda a tira ao papel de novo.
        XCTAssertTrue(session.backReprintsProbes)
        let enviosAntes = sender.enviados.count

        try session.goBack()

        XCTAssertEqual(sender.enviados.count, enviosAntes)
        XCTAssertEqual(session.state, .homologating(.ready(.rasterThroughput)))
        XCTAssertNil(session.machine.measuredRasterBytesPerSecond)
        XCTAssertNil(session.machine.verticalRasterScale)

        // E a tira nova é que decide de novo: agora ela sai inteira, e o fator some.
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.answerRasterThroughputPrintedInFull()
        XCTAssertNil(session.machine.verticalRasterScale)
    }

    // MARK: - Bancada

    private func maquina() -> PrinterHomologationMachine {
        PrinterHomologationMachine(
            displayName: "Impressora de bancada",
            transports: [.bluetooth],
            tcpPort: nil
        )
    }

    private func maquinaNaVazao(measuredBytesPerSecond: Int?) -> PrinterHomologationMachine {
        let machine = maquina()
        try? machine.selectPaperWidthUsingDefaults(.mm58)
        _ = try? machine.beginSending()
        try? machine.sendingCompleted(
            success: true,
            measuredBytesPerSecond: measuredBytesPerSecond
        )
        return machine
    }

    private func perfilAteDone(
        _ naVazao: (PrinterHomologationMachine) throws -> Void
    ) throws -> MeasuredProfile {
        let machine = maquinaNaVazao(measuredBytesPerSecond: 10_000)
        try naVazao(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        _ = try machine.beginSending()
        try machine.sendingCompleted(success: true)
        try machine.answer(.codePage(nil))
        return try machine.measuredProfile(
            id: UUID(uuidString: "00000000-0000-4000-8000-000000000042")!,
            measuredAt: Date(timeIntervalSince1970: 1)
        )
    }

    private func sessao(
        sender: BancadaDeVazao,
        store: PrinterProfileStore = PrinterProfileStore(dataStore: MemoriaDeVazao()),
        decoration: (any ReceiptDecoration)? = nil
    ) -> PrinterHomologationSession {
        PrinterHomologationSession(
            machine: maquina(),
            sender: sender,
            profileStore: store,
            selectionStore: InMemoryPrinterSelectionStore(),
            receiptDecoration: decoration,
            now: { sender.relogio }
        )
    }

    /// Leva a sessão até a tira de vazão já impressa, aguardando a leitura da régua.
    private func ateAVazao(
        _ session: PrinterHomologationSession,
        sender: BancadaDeVazao
    ) async throws {
        try session.selectPaperWidthUsingDefaults(.mm58)
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
    }

    /// A tira de 384 dots, byte a byte, como as duas plataformas a emitem.
    private static let stripSha256 =
        "ef414daa4c4b5d3a4033ac755f4a3ed15daa2cb3a7b536b276a4a862a0e3a217"

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private struct Stripe {
        let widthBytes: Int
        let height: Int
        let pixels: [UInt8]
    }

    /// Faixas `GS v 0` da tira, lidas de volta dos bytes que sairiam pelo fio.
    private func stripes(in data: Data) -> [Stripe] {
        let bytes = [UInt8](data)
        var found: [Stripe] = []
        var index = 0
        while index + 8 <= bytes.count {
            guard bytes[index] == 0x1d, bytes[index + 1] == 0x76,
                  bytes[index + 2] == 0x30, bytes[index + 3] == 0x00
            else {
                index += 1
                continue
            }
            let widthBytes = Int(bytes[index + 4]) | (Int(bytes[index + 5]) << 8)
            let height = Int(bytes[index + 6]) | (Int(bytes[index + 7]) << 8)
            let body = index + 8
            guard body + widthBytes * height <= bytes.count else { break }
            found.append(
                Stripe(
                    widthBytes: widthBytes,
                    height: height,
                    pixels: Array(bytes[body..<(body + widthBytes * height)])
                )
            )
            index = body + widthBytes * height
        }
        return found
    }
}

/// Transporte de bancada: guarda o que saiu e cobra do relógio um tempo fixo por envio.
///
/// A duração fixa é o que torna a vazão medida um número exato — o tamanho da tira em bytes —, sem
/// depender de arredondamento de ponto flutuante para provar a conta do teto.
@MainActor
private final class BancadaDeVazao: PrinterProbeSending {
    let transport = PrinterTransport.bluetooth
    private(set) var enviados: [Data] = []
    private(set) var relogio: TimeInterval = 0
    private let duracao: TimeInterval
    private var completion: ((PrinterProbeSendResult) -> Void)?

    init(duracao: TimeInterval = 1) {
        self.duracao = duracao
    }

    func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void) {
        enviados.append(bytes)
        self.completion = completion
    }

    func complete(_ result: PrinterProbeSendResult) {
        relogio += duracao
        let callback = completion
        completion = nil
        callback?(result)
    }
}

private final class MemoriaDeVazao: PrinterProfileDataStoring {
    private var data: Data?
    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

private final class CarimboDoHospedeiro: ReceiptDecoration {
    func header(layout: ReceiptLayout) -> Data? {
        layout.text("Cabecalho do app\n", alignment: 1)
    }

    func footer(layout: ReceiptLayout) -> Data? {
        layout.text("Rodape do app\n", alignment: 1)
    }
}

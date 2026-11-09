import Foundation
import XCTest
@testable import ThermalPrinterKit

/// A linha que grava uma página de código, para distinguir o rascunho novo do antigo. Sai da
/// própria lista de candidatas, nunca de uma letra escrita à mão: a ordem delas já andou uma casa.
private var letraDoCP860: Character {
    PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp860 }!.letter
}

final class PrinterHomologationMachineTests: XCTestCase {

    func testAsDuasReguasAntecedemAEscolhaDeLargura() throws {
        let machine = makeMachine()
        let payload = try machine.beginPaperWidthRulers()
        let text = String(decoding: payload.bytes, as: UTF8.self)
        XCTAssertTrue(text.contains("58mm"))
        XCTAssertTrue(text.contains("384 Dots"))
        XCTAssertTrue(text.contains("80mm"))
        XCTAssertTrue(text.contains("576 Dots"))
        XCTAssertEqual(machine.state, .sending(.geometry))

        try machine.sendingCompleted(success: true)
        try machine.selectPaperWidthFromPrintedRulers(.mm80)

        XCTAssertEqual(machine.paperWidth, .mm80)
        // A geometria resolvida entrega a vazão, o primeiro passo que precisa da largura medida.
        XCTAssertEqual(machine.state, .ready(.rasterThroughput))
    }

    func testTodaGeometriaPassaPelaPerguntaDeGuilhotina() throws {
        let narrow = makeMachine()
        _ = try narrow.beginPaperWidthRulers()
        try narrow.sendingCompleted(success: true)
        try narrow.selectPaperWidthFromPrintedRulers(.mm58)
        XCTAssertEqual(narrow.paperWidth, .mm58)
        try passRasterThroughputProbe(narrow)
        try passNativeCodeProbe(narrow)
        XCTAssertEqual(narrow.state, .ready(.cutProtocol))

        let unknown58 = makeMachine()
        _ = try unknown58.beginPaperWidthRulers()
        try unknown58.sendingCompleted(success: true)
        try unknown58.selectNoPaperWidthFromPrintedRulers()
        try complete(unknown58, response: .geometry(printableColumns: 32, printableDots: 384))
        XCTAssertEqual(unknown58.paperWidth, .mm58)
        try passRasterThroughputProbe(unknown58)
        try passNativeCodeProbe(unknown58)
        XCTAssertEqual(unknown58.state, .ready(.cutProtocol))

        let unknown80 = makeMachine()
        _ = try unknown80.beginPaperWidthRulers()
        try unknown80.sendingCompleted(success: true)
        try unknown80.selectNoPaperWidthFromPrintedRulers()
        try complete(unknown80, response: .geometry(printableColumns: 50, printableDots: 576))
        XCTAssertEqual(unknown80.paperWidth, .mm80)
        try passRasterThroughputProbe(unknown80)
        try passNativeCodeProbe(unknown80)
        XCTAssertEqual(unknown80.state, .ready(.cutProtocol))
    }

    /// A letra do endereço `n=08` sai da própria lista, nunca de uma constante escrita à mão.
    /// Quando a linha sem seleção entrou como primeira candidata, todas as letras andaram uma
    /// casa e um teste passou a medir o `n=09` achando que media o 8 — verde, e errado.
    static func letra(address selector: UInt8) -> Character {
        PrinterProbePayloads.codePageCandidates.first { $0.isAddress && $0.selector == selector }!.letter
    }

    /// A linha sem seleção é a que sai **sem** o kit mandar `ESC t`. Escolhê-la mede que a página
    /// que a firmware liga sozinha já está certa — o caso da Tomate e da genérica LUOGAO.
    func testLetraSemSelecaoGravaAPaginaPadraoDaFirmware() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        let semSelecao = try XCTUnwrap(PrinterProbePayloads.codePageCandidates.first(where: \.isFirmwareDefault))
        try complete(machine, response: .codePage(semSelecao.letter))

        XCTAssertEqual(machine.state, .done)
        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.textEncoding, .firmwareDefaultPage)
        XCTAssertEqual(profile.codePage, .cp860)
        XCTAssertNil(profile.codePageSelector)

        // E o comprovante final desse perfil sai — sem `ESC t` e sem derrubar o app.
        XCTAssertNil(PrinterProbePayloads.finalReceipt(profile: profile).range(of: Data([0x1b, 0x74])))
    }

    func testUTF8AindaVerificaPaginaEChegaAoPerfilMedidoSemMisturarAsDuas() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        XCTAssertEqual(machine.state, .ready(.codePage))
        let utf8 = try XCTUnwrap(PrinterProbePayloads.codePageCandidates.first { $0.textEncoding == .utf8 })
        try complete(machine, response: .codePage(utf8.letter))
        XCTAssertEqual(machine.state, .done)

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.textEncoding, .utf8)
        XCTAssertNil(profile.codePage)
        XCTAssertNil(profile.codePageSelector)
    }

    /// A sonda de codificação não emite `ESC t` e depende da página que a firmware liga por padrão.
    /// Reprovar as duas linhas não prova ausência de acento — a T210 mostrou que a tabela pode
    /// estar num endereço que ninguém adivinha. "Sem acentos" segue para a tira única, e a letra
    /// do endereço ainda promove o perfil de volta a byte único.
    func testSemAcentosAindaMedePaginaELetraDoEnderecoPromoveOModelo() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        XCTAssertEqual(machine.state, .ready(.codePage))
        try complete(machine, response: .codePage(Self.letra(address: 8)))

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.textEncoding, .singleByteCodePage)
        XCTAssertEqual(profile.codePage, .cp860)
        XCTAssertEqual(profile.codePageSelector, 8)
    }

    func testSemAcentosConfirmadoPelaPaginaConcluiEmASCII() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        try complete(machine, response: .codePage(nil))

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.textEncoding, .ascii)
        XCTAssertNil(profile.codePage)
    }

    func testLetraForaDaTiraEhRecusada() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        _ = try machine.beginSending()
        try machine.sendingCompleted(success: true)

        XCTAssertThrowsError(try machine.answer(.codePage("?")))
        XCTAssertEqual(machine.state, .awaitingResponse(.codePage))
    }

    func testTiraUnicaTemUmaSondaParaNomesEEnderecos() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        XCTAssertEqual(machine.state, .ready(.codePage))
        XCTAssertFalse(try machine.beginSending().bytes.isEmpty)
    }

    func testSequenceRequiresTransportCompletionBeforeEveryResponse() throws {
        let machine = makeMachine()
        XCTAssertEqual(machine.state, .ready(.geometry))
        try machine.selectPaperWidth(.mm58)

        XCTAssertThrowsError(try machine.answer(.geometry(printableColumns: 32, printableDots: 384)))
        _ = try machine.beginSending()
        XCTAssertEqual(machine.state, .sending(.geometry))
        XCTAssertThrowsError(try machine.answer(.geometry(printableColumns: 32, printableDots: 384)))
        try machine.sendingCompleted(success: true)
        XCTAssertEqual(machine.state, .awaitingResponse(.geometry))
        try machine.answer(.geometry(printableColumns: 32, printableDots: 384))
        XCTAssertEqual(machine.state, .ready(.rasterThroughput))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        XCTAssertEqual(machine.state, .ready(.cutProtocol))
        try machine.answerCutterQuestion(.no)
        XCTAssertEqual(machine.state, .ready(.cutFeed))
        try machine.completeCutFeedWithoutProbe()
        XCTAssertEqual(machine.state, .ready(.codePage))

        try complete(machine, response: .codePage("a"))
        XCTAssertEqual(machine.state, .done)
        XCTAssertEqual(try machine.measuredProfile().cutFeedLines, 0)
    }

    func testCutFeedRequiresExplicitBenchConfirmation() throws {
        let machine = try machineAtCutFeed(protocolValue: .escM)

        XCTAssertThrowsError(try machine.beginSending()) { error in
            XCTAssertEqual(error as? PrinterHomologationMachineError, .benchConfirmationRequired)
        }
        try machine.confirmBenchReadyForCutFeed()
        _ = try machine.beginSending()
        try machine.sendingCompleted(success: true)
        try machine.answer(.cutFeed(6))

        XCTAssertEqual(machine.state, .ready(.codePage))
        try complete(machine, response: .codePage(nil))
        XCTAssertEqual(machine.state, .done)
        XCTAssertEqual(try machine.measuredProfile().cutFeedLines, 6)
    }

    func testFailureNeverRetriesAutomatically() throws {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        _ = try machine.beginSending()
        try machine.sendingCompleted(success: false)

        XCTAssertEqual(machine.state, .failed(.geometry))
        XCTAssertThrowsError(try machine.beginSending())
        try machine.retryAfterFailure()
        XCTAssertEqual(machine.state, .ready(.geometry))
    }

    func testEmbeddedFeedVisitsCutFeedAndCompletesAtZeroWithoutProbe() throws {
        for protocolValue in [CutProtocol.gsV65, .gsV66] {
            let machine = try machineAtCutFeed(protocolValue: protocolValue)

            XCTAssertEqual(machine.state, .ready(.cutFeed))
            XCTAssertThrowsError(try machine.beginSending()) { error in
                XCTAssertEqual(error as? PrinterHomologationMachineError, .noProbeRequired)
            }
            try machine.completeCutFeedWithoutProbe()
            XCTAssertEqual(machine.state, .ready(.codePage))
            try complete(machine, response: .codePage(nil))
            XCTAssertEqual(try machine.measuredProfile().cutFeedLines, 0)
        }
    }

    func testGeometryRejectsAColumnThatWasNotPrintedOnTheRuler() throws {
        for width in PrinterPaperWidth.allCases {
            let machine = makeMachine()
            try machine.selectPaperWidth(width)
            _ = try machine.beginSending()
            try machine.sendingCompleted(success: true)

            XCTAssertThrowsError(
                try machine.answer(
                    .geometry(
                        printableColumns: width.geometryProbeColumns + 1,
                        printableDots: width.defaultPrintableDots
                    )
                )
            )
        }
    }

    func testCaminhoCurtoAplicaGeometriaPadraoSemEnviarRegua() throws {
        for width in PrinterPaperWidth.allCases {
            let machine = makeMachine()

            try machine.selectPaperWidthUsingDefaults(width)

            XCTAssertEqual(machine.state, .ready(.rasterThroughput))
            try passRasterThroughputProbe(machine)
            try passNativeCodeProbe(machine)
            XCTAssertEqual(machine.state, .ready(.cutProtocol))
            try machine.answerCutterQuestion(.no)
            XCTAssertEqual(machine.state, .ready(.cutFeed))
            try machine.completeCutFeedWithoutProbe()
            // Uma tira só decide texto e página: a etapa de codificação separada saiu em 12/08.
            XCTAssertEqual(try machine.beginSending().bytes, PrinterProbePayloads.codePage())
        }
    }

    func testPerguntaSemGuilhotinaNaoEnviaSondaENaoViraCampoDePerfil() throws {
        let machine = try shortMachineAtCutQuestion()

        try machine.answerCutterQuestion(.no)

        XCTAssertEqual(machine.state, .ready(.cutFeed))
        XCTAssertEqual(machine.resolvedCutProtocol, CutProtocol.none)
        XCTAssertThrowsError(try machine.beginSending()) { error in
            XCTAssertEqual(error as? PrinterHomologationMachineError, .noProbeRequired)
        }
        try machine.completeCutFeedWithoutProbe()
        try complete(machine, response: .codePage(nil))
        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.cutProtocol, .none)
        XCTAssertEqual(profile.cutFeedLines, 0)
        XCTAssertFalse(profile.cutModeHonored)
    }

    /// Todos os dialetos saem antes de qualquer pergunta.
    ///
    /// Parar no primeiro que corta economizava papel e escondia o que a impressora faz nos outros
    /// — e deixava a escolha sem comparação. Medido na LUOGAO em 12/08.
    func testASondaImprimeOsSeisDialetosESoEntaoAbreAEscolha() throws {
        let machine = try shortMachineAtCutQuestion()
        try machine.answerCutterQuestion(.unknown)

        var visited: [CutProtocol] = []
        for _ in 0..<PrinterHomologationMachine.allCutProtocols.count {
            let dialect = try XCTUnwrap(machine.currentCutProbeProtocol)
            visited.append(dialect)
            // Cada comando vai sozinho e é a última coisa do payload: é isso que faz o papel
            // responder só pela guilhotina.
            let tira = try machine.beginSending().bytes
            XCTAssertEqual(tira.suffix(dialect.command.count), dialect.command)
            XCTAssertThrowsError(try machine.advanceCutProbe())
            try machine.sendingCompleted(success: true)
            try machine.advanceCutProbe()
        }

        XCTAssertEqual(visited, [.gsV0, .gsV1, .gsV65, .gsV66, .escI, .escM])
        XCTAssertNil(machine.currentCutProbeProtocol)
        try machine.answer(.cutProtocol(.escM))

        XCTAssertEqual(machine.resolvedCutProtocol, .escM)
        XCTAssertEqual(machine.state, .ready(.cutFeed))
        // A régua inteira, e só depois da confirmação de bancada: o avanço não chega escolhido.
        try machine.confirmBenchReadyForCutFeed()
        XCTAssertEqual(try machine.beginSending().bytes, PrinterProbePayloads.cutFeed(cutProtocol: .escM))
        try machine.sendingCompleted(success: true)
        try machine.answer(.cutFeed(5))
        XCTAssertEqual(
            try machine.beginSending().bytes,
            PrinterProbePayloads.codePage(cutProtocol: .escM, cutFeedLines: 5)
        )
    }

    /// Pular é decisão explícita, e o que entra é o palpite de outra bancada — sem fingir medição.
    func testPularOAvancoGravaOPalpiteESegueParaOTexto() throws {
        let machine = try shortMachineAtCutFeed()
        try machine.skipCutFeedMeasurement()

        XCTAssertEqual(machine.state, .ready(.codePage))
        try complete(machine, response: .codePage(nil))
        XCTAssertEqual(try machine.measuredProfile().cutFeedLines, 5)
    }

    func testDoisCortesQueFalhamExplicamAMedicaoEPermitemRetomarOAvancado() throws {
        let machine = try shortMachineAtCutQuestion()
        try machine.answerCutterQuestion(.yes)
        for _ in 0..<PrinterHomologationMachine.allCutProtocols.count {
            _ = try machine.beginSending()
            try machine.sendingCompleted(success: true)
            try machine.advanceCutProbe()
        }
        try machine.answer(.cutProtocol(.none))

        XCTAssertTrue(machine.cutMeasurementFailed)
        XCTAssertEqual(machine.resolvedCutProtocol, CutProtocol.none)
        XCTAssertEqual(machine.state, .ready(.cutFeed))
        try machine.retryCutWithAdvancedProbe()
        XCTAssertEqual(machine.state, .ready(.cutProtocol))
        XCTAssertEqual(machine.currentCutProbeProtocol, .gsV0)
        XCTAssertTrue(machine.usesAdvancedCutProtocolProbe)
    }

    /// A etapa de avanço não chega com valor escolhido.
    ///
    /// Ela abria com 5 — medido na P80 e na Tomate — e pedia confirmação: quem respondesse "não
    /// comeu texto" gravava um número que não mediu. A distância entre a cabeça e a lâmina é
    /// física de cada impressora, e é isso que a régua inteira mede. Decidido em 12/08, ao custo
    /// de oito tiras em toda impressora com guilhotina.
    func testAvancoNaoChegaPreEscolhido() throws {
        let machine = try shortMachineAtCutFeed()
        XCTAssertTrue(machine.usesCutFeedRuler)
        XCTAssertThrowsError(try machine.beginSending()) { error in
            XCTAssertEqual(error as? PrinterHomologationMachineError, .benchConfirmationRequired)
        }
        try machine.confirmBenchReadyForCutFeed()
        let tira = try machine.beginSending().bytes
        XCTAssertEqual(tira, PrinterProbePayloads.cutFeed(cutProtocol: .gsV1))
        for lines in PrinterProbePayloads.cutFeedCandidates where lines > 0 {
            XCTAssertNotNil(tira.range(of: Data(">>> \(lines) <<<".utf8)), "\(lines)")
        }

        try machine.sendingCompleted(success: true)
        try machine.answer(.cutFeed(2))
        XCTAssertEqual(machine.state, .ready(.codePage))
        try complete(machine, response: .codePage(nil))
        XCTAssertEqual(try machine.measuredProfile().cutFeedLines, 2)
    }

    /// O cheque de bancada do iPhone 7, em 20/08: 58 mm escolhido numa impressora de 80.
    ///
    /// Sem retrocesso a pessoa só tinha duas saídas, ambas ruins — seguir medindo contra a premissa
    /// errada ou recomeçar do zero. Voltar reabre o passo; as réguas saem de novo porque a pessoa
    /// mandou imprimi-las, não porque o retrocesso imprimiu sozinho.
    func testVoltarCorrigeALarguraErradaEOPerfilSaiComAGeometriaNova() throws {
        let machine = makeMachine()
        _ = try machine.beginPaperWidthRulers()
        try machine.sendingCompleted(success: true)
        try machine.selectPaperWidthFromPrintedRulers(.mm58)

        XCTAssertEqual(machine.state, .ready(.rasterThroughput))
        XCTAssertTrue(machine.canGoBack)
        XCTAssertEqual(machine.previousStep, .geometry)
        XCTAssertTrue(machine.backReprintsProbes)

        try machine.goBack()

        XCTAssertEqual(machine.state, .ready(.geometry))
        XCTAssertNil(machine.paperWidth)
        _ = try machine.beginPaperWidthRulers()
        try machine.sendingCompleted(success: true)
        try machine.selectPaperWidthFromPrintedRulers(.mm80)
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        try complete(machine, response: .codePage(nil))

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.paperWidthMm, 80)
        XCTAssertEqual(profile.printableColumns, 48)
        XCTAssertEqual(profile.printableDots, 576)
    }

    /// Voltar desfaz uma decisão por toque: o passo reaberto perde a resposta dele e as seguintes,
    /// porque foram medidas contra a premissa que está sendo corrigida, e as anteriores ficam.
    func testVoltarDeCadaPassoDesfazSoDaliParaFrente() throws {
        let machine = makeMachine()
        _ = try machine.beginPaperWidthRulers()
        try machine.sendingCompleted(success: true)
        try machine.selectNoPaperWidthFromPrintedRulers()
        try complete(machine, response: .geometry(printableColumns: 50, printableDots: 576))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.answerCutterQuestion(.yes)
        for _ in 0..<PrinterHomologationMachine.allCutProtocols.count {
            _ = try machine.beginSending()
            try machine.sendingCompleted(success: true)
            try machine.advanceCutProbe()
        }
        try machine.answer(.cutProtocol(.escM))
        try machine.confirmBenchReadyForCutFeed()
        _ = try machine.beginSending()
        try machine.sendingCompleted(success: true)
        try machine.answer(.cutFeed(4))
        XCTAssertEqual(machine.state, .ready(.codePage))

        // Do texto para o avanço: some o avanço medido, ficam largura, geometria e corte.
        XCTAssertEqual(machine.previousStep, .cutFeed)
        XCTAssertTrue(machine.backReprintsProbes)
        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.cutFeed))
        XCTAssertEqual(machine.resolvedCutProtocol, .escM)
        XCTAssertEqual(machine.paperWidth, .mm80)
        XCTAssertEqual(machine.printableColumns, 50)
        // A bancada volta a ser perguntada: a confirmação anterior valeu para o envio anterior.
        XCTAssertFalse(machine.benchReadyForCutFeed)

        // Do avanço para o corte: some o dialeto escolhido e a triagem, fica a geometria.
        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.cutProtocol))
        XCTAssertNil(machine.resolvedCutProtocol)
        XCTAssertNil(machine.currentCutProbeProtocol)
        XCTAssertEqual(machine.printableColumns, 50)

        // Do corte para o código nativo: somem as duas respostas, e o perfil volta a não saber se
        // aquela firmware desenha o que o comando nativo pede.
        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.nativeCode))
        XCTAssertNil(machine.nativeQrHonored)
        XCTAssertNil(machine.nativeBarcodeHonored)
        XCTAssertEqual(machine.printableColumns, 50)

        // Do código nativo para a imagem: some a leitura da régua externa, e o fator some junto.
        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.rasterThroughput))
        XCTAssertNil(machine.measuredRasterBytesPerSecond)
        XCTAssertNil(machine.verticalRasterScale)
        XCTAssertEqual(machine.printableColumns, 50)

        // Da imagem para a régua completa: some a resposta dela, fica a recusa das duas larguras.
        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.geometry))
        XCTAssertNil(machine.paperWidth)
        XCTAssertEqual(machine.printableColumns, 48)

        // Da régua completa para o começo: a homologação volta ao zero, sem resposta nenhuma.
        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.geometry))
        XCTAssertNil(machine.printableColumns)

        // O primeiro passo não volta: não há premissa anterior para desfazer.
        XCTAssertFalse(machine.canGoBack)
        XCTAssertNil(machine.previousStep)
        XCTAssertFalse(machine.backReprintsProbes)
        XCTAssertThrowsError(try machine.goBack()) { error in
            XCTAssertEqual(error as? PrinterHomologationMachineError, .invalidState)
        }
    }

    /// Voltar e responder outra coisa produz o perfil da resposta nova, não o da antiga.
    func testVoltarEResponderDeNovoGravaARespostaNova() throws {
        let machine = try shortMachineAtCutFeed()
        XCTAssertEqual(machine.resolvedCutProtocol, .gsV1)

        try machine.goBack()
        XCTAssertEqual(machine.state, .ready(.cutProtocol))
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        try complete(machine, response: .codePage(nil))

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.cutProtocol, .none)
        XCTAssertEqual(profile.cutFeedLines, 0)
    }

    /// O alcance novo do retrocesso: `done` ainda tem premissa anterior para desfazer.
    ///
    /// A tira de acentos é a última medida, e a letra escolhida nela só se prova no comprovante
    /// final. Quem escolheu a letra errada chegava a `done` sem saída: a máquina recusava o
    /// retrocesso, e a única correção era recomeçar. O passo reaberto é o de texto, e ele
    /// reimprime — nada sai por causa do "Voltar" em si.
    func testComprovanteFinalVoltaParaOsAcentosEARespostaNovaEAQueGrava() throws {
        let machine = try shortMachineAtCutQuestion()
        try machine.answerCutterQuestion(.no)
        try machine.completeCutFeedWithoutProbe()
        try complete(machine, response: .codePage(letraDoCP860))

        XCTAssertEqual(machine.state, .done)
        XCTAssertTrue(machine.canGoBack)
        XCTAssertEqual(machine.previousStep, .codePage)
        XCTAssertTrue(machine.backReprintsProbes)

        try machine.goBack()

        XCTAssertEqual(machine.state, .ready(.codePage))
        try complete(machine, response: .codePage(nil))

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertNil(profile.codePage)
        XCTAssertNil(profile.codePageSelector)
    }

    /// Um envio no ar não volta: a resposta sobre a tira que está saindo vem antes do retrocesso.
    func testEnvioEmCursoEFalhaPendenteNaoVoltam() throws {
        let machine = try shortMachineAtCutQuestion()
        try machine.answerCutterQuestion(.yes)
        _ = try machine.beginSending()

        XCTAssertFalse(machine.canGoBack)
        XCTAssertThrowsError(try machine.goBack())

        try machine.sendingCompleted(success: false)
        XCTAssertEqual(machine.state, .failed(.cutProtocol))
        XCTAssertFalse(machine.canGoBack)
        XCTAssertThrowsError(try machine.goBack())

        try machine.retryAfterFailure()
        XCTAssertTrue(machine.canGoBack)
    }

    /// Regressão de neutralidade: quem não toca em "Voltar" continua vendo as mesmas tiras.
    ///
    /// O retrocesso acrescenta uma transição à máquina, e a única prova de que ele não mexeu no
    /// papel é comparar os bytes de um roteiro completo com os payloads das sondas.
    func testRoteiroSemVoltarMantemAsTirasByteAByte() throws {
        let machine = makeMachine()
        try machine.selectPaperWidthUsingDefaults(.mm58)
        // A tira nova entra na mesma conferência das outras: os bytes que a máquina emite são os
        // do construtor da sonda, na largura imprimível medida, e nada além disso.
        XCTAssertEqual(
            try machine.beginSending().bytes,
            try XCTUnwrap(PrinterProbePayloads.rasterThroughput(printableDots: 384))
        )
        try machine.sendingCompleted(success: true)
        try machine.answerRasterThroughputPrintedInFull()
        XCTAssertEqual(
            try machine.beginSending().bytes,
            try XCTUnwrap(PrinterProbePayloads.nativeCode(printableDots: 384))
        )
        try machine.sendingCompleted(success: true)
        try machine.skipNativeCodeMeasurement()
        try machine.answerCutterQuestion(.yes)
        for _ in 0..<PrinterHomologationMachine.allCutProtocols.count {
            let dialect = try XCTUnwrap(machine.currentCutProbeProtocol)
            XCTAssertEqual(
                try machine.beginSending().bytes,
                try XCTUnwrap(PrinterProbePayloads.isolatedCut(dialect))
            )
            try machine.sendingCompleted(success: true)
            try machine.advanceCutProbe()
        }
        try machine.answer(.cutProtocol(.gsV1))
        try machine.confirmBenchReadyForCutFeed()
        XCTAssertEqual(
            try machine.beginSending().bytes,
            PrinterProbePayloads.cutFeed(cutProtocol: .gsV1)
        )
        try machine.sendingCompleted(success: true)
        try machine.answer(.cutFeed(4))
        XCTAssertEqual(
            try machine.beginSending().bytes,
            PrinterProbePayloads.codePage(cutProtocol: .gsV1, cutFeedLines: 4)
        )
        try machine.sendingCompleted(success: true)
        try machine.answer(.codePage(Self.letra(address: 8)))

        let profile = try machine.measuredProfile(measuredAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(profile.paperWidthMm, 58)
        XCTAssertEqual(profile.printableColumns, 32)
        XCTAssertEqual(profile.printableDots, 384)
        XCTAssertEqual(profile.cutProtocol, .gsV1)
        XCTAssertEqual(profile.cutFeedLines, 4)
        XCTAssertEqual(profile.codePage, .cp860)
        XCTAssertEqual(profile.codePageSelector, 8)
    }

    /// A resposta da sonda atravessa a máquina até o perfil, e a chave de capacidade **não se move**.
    ///
    /// As duas coisas são o contrato deste passo. A primeira é óbvia: medição que não alcança o
    /// perfil é bobina gasta à toa. A segunda é o que impede a frente de partir o catálogo — a chave
    /// é identidade de capacidade, e duas impressoras com as mesmas capacidades têm de compartilhar
    /// chave. Estes dois campos não mudam byte nenhum sozinhos: quem muda os bytes é a preferência
    /// de quem usa, e ela não mora no perfil. É a razão exata do `cutModeHonored` estar fora.
    func testARespostaDoCodigoNativoChegaAoPerfilSemMoverAChaveDeCapacidade() throws {
        func perfilCom(_ resposta: PrinterHomologationResponse?) throws -> MeasuredProfile {
            let machine = makeMachine()
            try machine.selectPaperWidthUsingDefaults(.mm58)
            try passRasterThroughputProbe(machine)
            _ = try machine.beginSending()
            try machine.sendingCompleted(success: true)
            if let resposta {
                try machine.answer(resposta)
            } else {
                try machine.skipNativeCodeMeasurement()
            }
            try machine.answerCutterQuestion(.no)
            try machine.completeCutFeedWithoutProbe()
            _ = try machine.beginSending()
            try machine.sendingCompleted(success: true)
            try machine.answer(.codePage(nil))
            return try machine.measuredProfile(
                id: UUID(uuidString: "00000000-0000-4000-8000-0000000000C1")!,
                measuredAt: Date(timeIntervalSince1970: 1)
            )
        }

        let medido = try perfilCom(.nativeCode(qrHonored: true, barcodeHonored: false))
        XCTAssertEqual(medido.nativeQrHonored, true)
        XCTAssertEqual(medido.nativeBarcodeHonored, false)
        // E a capacidade alcança o layout: sem isso a trava veria `nil` e o modo nativo nunca
        // sairia — a medição existiria e não chegaria ao papel.
        XCTAssertEqual(PrinterProfile(medido).nativeQrHonored, true)
        XCTAssertEqual(PrinterProfile(medido).nativeBarcodeHonored, false)

        // "Não consigo dizer" grava a ausência nos dois, e não um "não".
        let semResposta = try perfilCom(nil)
        XCTAssertNil(semResposta.nativeQrHonored)
        XCTAssertNil(semResposta.nativeBarcodeHonored)

        // A chave é a mesma nos três estados: quem já contribuiu continua casando.
        let negativo = try perfilCom(.nativeCode(qrHonored: false, barcodeHonored: false))
        XCTAssertEqual(semResposta.capabilityKey, medido.capabilityKey)
        XCTAssertEqual(semResposta.capabilityKey, negativo.capabilityKey)
    }

    private func makeMachine() -> PrinterHomologationMachine {
        PrinterHomologationMachine(
            displayName: "Impressora medida",
            transports: [.bluetoothLE],
            tcpPort: nil
        )
    }

    private func shortMachineAtCutQuestion() throws -> PrinterHomologationMachine {
        let machine = makeMachine()
        try machine.selectPaperWidthUsingDefaults(.mm58)
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        return machine
    }

    private func shortMachineAtCutFeed() throws -> PrinterHomologationMachine {
        let machine = try shortMachineAtCutQuestion()
        try machine.answerCutterQuestion(.yes)
        // A varredura sai inteira e a escolha vem à vista das tiras.
        for _ in 0..<PrinterHomologationMachine.allCutProtocols.count {
            _ = try machine.beginSending()
            try machine.sendingCompleted(success: true)
            try machine.advanceCutProbe()
        }
        try machine.answer(.cutProtocol(.gsV1))
        return machine
    }

    private func machineAtCutFeed(protocolValue: CutProtocol) throws -> PrinterHomologationMachine {
        let machine = makeMachine()
        try machine.selectPaperWidth(.mm58)
        try complete(machine, response: .geometry(printableColumns: 32, printableDots: 384))
        try passRasterThroughputProbe(machine)
        try passNativeCodeProbe(machine)
        try machine.useAdvancedCutProtocolProbe()
        while machine.currentCutProbeProtocol != protocolValue {
            try complete(machine, response: .cutAttempt(cut: false))
        }
        try complete(machine, response: .cutAttempt(cut: true))
        return machine
    }

    private func complete(
        _ machine: PrinterHomologationMachine,
        response: PrinterHomologationResponse
    ) throws {
        _ = try machine.beginSending()
        try machine.sendingCompleted(success: true)
        try machine.answer(response)
    }
}

@MainActor
final class PrinterHomologationSessionTests: XCTestCase {
    func testIdentidadeEhLidaUmaVezAntesDoComprovanteEPersisteFirmware() async throws {
        let identity = PrinterDeclaredIdentity(
            firmwareVersion: "SV3.2.2",
            manufacturer: "GoldenSky",
            model: "58E_BT"
        )!
        let sender = ControlledProbeSender(transport: .localWifi, identity: identity)
        let store = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora temporária",
                transports: [.localWifi],
                tcpPort: 9_100
            ),
            sender: sender,
            profileStore: store,
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: .geometry(printableColumns: 32, printableDots: 384)
        )
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))

        try session.sendFinalReceipt()
        await Task.yield()
        XCTAssertEqual(sender.identityReadCount, 1)
        XCTAssertEqual(session.declaredIdentity, identity)
        sender.complete(.success)
        await Task.yield()

        XCTAssertEqual(try session.previewFinalProfile().displayName, "GoldenSky 58E_BT")
        XCTAssertEqual(try session.previewFinalProfile().firmwareVersion, "SV3.2.2")
        let finalText = String(decoding: sender.lastPayload, as: UTF8.self)
        XCTAssertTrue(finalText.contains("Modelo: 58E_BT"))

        try session.rejectFinalReceipt()
        try session.sendFinalReceipt()
        XCTAssertEqual(sender.identityReadCount, 1)
        sender.complete(.success)
        await Task.yield()
        try session.confirmFinalReceipt()
        XCTAssertEqual(store.profiles().first?.firmwareVersion, "SV3.2.2")
    }

    func testSilencioNoGSIProssegueParaOComprovanteSemErro() async throws {
        let sender = ControlledProbeSender(transport: .localWifi, identityReadEnabled: true)
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.localWifi],
                tcpPort: 9_100
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: .geometry(printableColumns: 32, printableDots: 384)
        )
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))

        try session.sendFinalReceipt()
        await Task.yield()

        XCTAssertTrue(session.identityReadCompleted)
        XCTAssertNil(session.declaredIdentity)
        XCTAssertEqual(sender.identityReadCount, 1)
        // O perfil deste teste não é UTF-8, então a linha sai pela dobra da página medida: o que
        // se afirma é a frase, não os bytes do `ã`.
        let semIdentidade = String(decoding: sender.lastPayload, as: UTF8.self)
        XCTAssertTrue(semIdentidade.contains("Identidade GS I: "))
        XCTAssertTrue(semIdentidade.contains("respondeu"))
        XCTAssertNil(session.lastError)
    }

    func testRenomearAntesDeAdotarTrocaSoONomeEPreservaAMedicao() async throws {
        // O perfil herdava o nome do perfil de descoberta e nascia "Impressora temporária" depois
        // da homologação, sem distinguir duas impressoras do mesmo tamanho. Nomear no fim é
        // quando a pessoa sabe qual é: acabou de ver o comprovante sair dela.
        let sender = ControlledProbeSender()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let machine = PrinterHomologationMachine(
            displayName: "Impressora temporária",
            transports: [.bluetoothLE],
            tcpPort: nil
        )
        let session = PrinterHomologationSession(
            machine: machine,
            sender: sender,
            profileStore: profileStore,
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidth(.mm58)
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.answer(.geometry(printableColumns: 32, printableDots: 384))
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))
        try session.sendFinalReceipt()
        sender.complete(.success)
        await Task.yield()

        let antes = try session.previewFinalProfile()
        XCTAssertEqual(antes.displayName, "Impressora temporária")

        try session.renameFinalProfile("  T210 do balcão  ")
        let depois = try session.previewFinalProfile()

        XCTAssertEqual(depois.displayName, "T210 do balcão")
        XCTAssertEqual(depois.capabilities, antes.capabilities)
        XCTAssertEqual(depois.id, antes.id)

        // Nome em branco mantém o que já existe em vez de apagar.
        try session.renameFinalProfile("   ")
        XCTAssertEqual(try session.previewFinalProfile().displayName, "T210 do balcão")

        try session.confirmFinalReceipt()
        XCTAssertEqual(profileStore.profiles().first?.displayName, "T210 do balcão")
    }

    func testSessionWaitsForRealCallbackAndPersistsOnlyAfterFinalHumanConfirmation() async throws {
        let sender = ControlledProbeSender()
        let profileBackend = SessionMemoryProfileDataStore()
        let profileStore = PrinterProfileStore(dataStore: profileBackend)
        let selectionStore = InMemoryPrinterSelectionStore()
        let machine = PrinterHomologationMachine(
            displayName: "Impressora medida",
            transports: [.bluetoothLE],
            tcpPort: nil
        )
        let session = PrinterHomologationSession(
            machine: machine,
            sender: sender,
            profileStore: profileStore,
            selectionStore: selectionStore
        )
        try session.selectPaperWidth(.mm58)

        try session.sendCurrentProbe()
        XCTAssertEqual(session.state, .homologating(.sending(.geometry)))
        XCTAssertEqual(profileStore.profiles(), [])
        sender.complete(.success)
        await Task.yield()
        XCTAssertEqual(session.state, .homologating(.awaitingResponse(.geometry)))
        try session.answer(.geometry(printableColumns: 32, printableDots: 384))
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()

        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))
        XCTAssertEqual(session.state, .finalReceiptReady)
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertNil(selectionStore.read().of(.bluetooth))

        try session.sendFinalReceipt()
        XCTAssertEqual(session.state, .sendingFinalReceipt)
        XCTAssertEqual(profileStore.profiles(), [])
        sender.complete(.success)
        await Task.yield()
        XCTAssertEqual(session.state, .awaitingFinalConfirmation)
        XCTAssertEqual(profileStore.profiles(), [])

        try session.confirmFinalReceipt()
        guard case let .finished(profile) = session.state else {
            return XCTFail("A sessão deveria concluir com o perfil adotado.")
        }
        XCTAssertEqual(profileStore.profiles(), [profile])
        XCTAssertEqual(selectionStore.read().of(.bluetooth), .bluetooth(profileId: profile.id))
    }

    func testFailedCallbackDoesNotRepeatProbe() async throws {
        let sender = ControlledProbeSender()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetoothLE],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidth(.mm58)
        try session.sendCurrentProbe()

        sender.complete(.failure(.unavailable))
        await Task.yield()

        XCTAssertEqual(sender.sendCount, 1)
        XCTAssertEqual(session.state, .homologating(.failed(.geometry)))
        XCTAssertEqual(session.lastError, .sendFailed)
    }

    func testFailedFinalCallbackWaitsForHumanAndCanAdoptWhenPaperPrinted() async throws {
        let sender = ControlledProbeSender()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let selectionStore = InMemoryPrinterSelectionStore()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetoothLE],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: profileStore,
            selectionStore: selectionStore
        )
        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: .geometry(printableColumns: 32, printableDots: 384)
        )
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))

        try session.sendFinalReceipt()
        sender.complete(.failure(.unavailable))
        await Task.yield()

        XCTAssertEqual(session.state, .finalReceiptFailed)
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertNil(selectionStore.read().of(.bluetooth))
        XCTAssertThrowsError(try session.sendFinalReceipt())

        // O callback não prova ausência de papel. A confirmação humana ainda pode adotar.
        try session.confirmFinalReceipt()
        guard case let .finished(profile) = session.state else {
            return XCTFail("A confirmação humana deveria adotar o perfil medido.")
        }
        XCTAssertEqual(profileStore.profiles(), [profile])
        XCTAssertEqual(selectionStore.read().of(.bluetooth), .bluetooth(profileId: profile.id))
    }

    func testNotPrintedAfterFailedFinalCallbackOnlyPreparesExplicitRetry() async throws {
        let sender = ControlledProbeSender()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetoothLE],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: .geometry(printableColumns: 32, printableDots: 384)
        )
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))
        try session.sendFinalReceipt()
        sender.complete(.failure(.unavailable))
        await Task.yield()
        let sendsBeforeDecision = sender.sendCount

        try session.rejectFinalReceipt()

        XCTAssertEqual(session.state, .finalReceiptReady)
        XCTAssertEqual(sender.sendCount, sendsBeforeDecision)
        try session.sendFinalReceipt()
        XCTAssertEqual(sender.sendCount, sendsBeforeDecision + 1)
    }

    func testConfigurationAdoptsMeasuredProfileImmediatelyAndRestoresItAfterRestart() async throws {
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        bluetoothTransport.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await bluetoothTransport.waitUntilSendStarts()
        bluetoothTransport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }
        XCTAssertEqual(configuration.bluetooth.state, .awaitingConfirmation)
        XCTAssertEqual(configuration.handleInitialReceipt(.printedWithProblem), .homologationRequired)

        let session = try configuration.makeHomologationSession()
        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: bluetoothTransport,
            response: .geometry(printableColumns: 40, printableDots: 320)
        )
        try await sendAndAnswer(
            session,
            sender: bluetoothTransport,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: bluetoothTransport)
        try session.useAdvancedCutProtocolProbe()
        while session.machine.currentCutProbeProtocol != .escM {
            try await sendAndAnswer(
                session,
                sender: bluetoothTransport,
                response: .cutAttempt(cut: false)
            )
        }
        try await sendAndAnswer(session, sender: bluetoothTransport, response: .cutAttempt(cut: true))
        try session.confirmBenchReadyForCutFeed()
        try await sendAndAnswer(session, sender: bluetoothTransport, response: .cutFeed(6))
        // A CP860 deixou de existir como nome na tira: quem quer `ESC t 3` escolhe o endereço,
        // e o perfil passa a gravar o seletor explicitamente.
        try await sendAndAnswer(
            session,
            sender: bluetoothTransport,
            response: .codePage(PrinterHomologationMachineTests.letra(address: 3))
        )
        try session.sendFinalReceipt()
        bluetoothTransport.complete(.success)
        await Task.yield()
        try session.confirmFinalReceipt()

        guard case let .finished(profile) = session.state else {
            return XCTFail("A homologação deveria terminar adotada.")
        }
        XCTAssertEqual(configuration.bluetooth.state, .ready)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertEqual(selectionStore.read().of(.bluetooth), .bluetooth(profileId: profile.id))

        let immediateReceipt = LayoutRecordingReceipt()
        XCTAssertTrue(configuration.bluetooth.printAccepted(immediateReceipt))
        await bluetoothTransport.waitUntilSendStarts()
        XCTAssertEqual(immediateReceipt.layout, ReceiptLayout(profile: PrinterProfile(profile)))
        XCTAssertEqual(immediateReceipt.layout?.columns, 40)
        XCTAssertEqual(immediateReceipt.layout?.qrWidthDots, 320)
        XCTAssertTrue(contains(bluetoothTransport.payloads.last ?? Data(), [0x1b, 0x74, 0x03]))
        XCTAssertEqual(
            Array((bluetoothTransport.payloads.last ?? Data()).suffix(8)),
            Array(repeating: 0x0a, count: 6) + [0x1b, 0x6d]
        )
        bluetoothTransport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .ready }

        let restartedTransport = ConfigurationBluetoothTransport()
        let restarted = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: restartedTransport
        )
        restarted.bluetooth.restoreAdoptedPrinter()
        restartedTransport.publish([BluetoothPrinterCandidate(id: 2, label: "Impressora Bluetooth 1")])
        await Task.yield()

        XCTAssertEqual(restarted.bluetooth.state, .ready)
        XCTAssertEqual(restarted.profileStore.profile(id: profile.id), profile)

        let restartedReceipt = LayoutRecordingReceipt()
        XCTAssertTrue(restarted.bluetooth.printAccepted(restartedReceipt))
        await restartedTransport.waitUntilSendStarts()
        XCTAssertEqual(restartedReceipt.layout, ReceiptLayout(profile: PrinterProfile(profile)))
        XCTAssertEqual(restartedReceipt.layout?.codePage, .cp860)
        XCTAssertEqual(restartedReceipt.layout?.cutProtocol, .escM)
        XCTAssertEqual(restartedReceipt.layout?.cutFeedLines, 6)
        restartedTransport.complete(.success)
    }

    /// Apagar medição é a saída para medição errada, e ela existe porque medição errada existe.
    ///
    /// A regra "perfil medido nunca é sobrescrito" protege contra acidente, não contra vontade: a
    /// T210 foi gravada com 80 mm e 48 colunas em 12/08 porque a largura da busca atravessou de
    /// outra impressora.
    func testApagarAMedicaoSoltaAImpressoraQueApontavaParaEla() throws {
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let selectionStore = InMemoryPrinterSelectionStore()
        let medido = try MeasuredProfile(
            id: UUID(),
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.bluetoothLE],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: .cp860,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )
        try profileStore.save(medido)
        selectionStore.save(selectionStore.read().with(.bluetooth(profileId: medido.id)))
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: ConfigurationBluetoothTransport()
        )

        try configuration.forgetMeasuredProfile(id: medido.id)

        XCTAssertTrue(profileStore.profiles().isEmpty)
        XCTAssertNil(selectionStore.read().of(.bluetooth))
    }

    func testConfigurationUsesConservativeProfileForRetiredUnknownSelection() async throws {
        let selectionStore = InMemoryPrinterSelectionStore(
            selection: .bluetooth(profileId: "perfil-remoto-extinto")
        )
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let transport = ConfigurationBluetoothTransport()
        let restarted = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: transport
        )

        // Uma seleção antiga sem perfil medido ou embutido não pode recuperar capacidades pela
        // rede nem inventá-las: o fallback continua imprimindo sem acento, corte ou status.
        XCTAssertEqual(
            restarted.coordinator.adoptedPrinters.first?.displayName,
            "Impressora temporária"
        )
        XCTAssertNotNil(restarted.coordinator.adoptedPrinters.first?.warning)

        restarted.bluetooth.restoreAdoptedPrinter()
        transport.publish([BluetoothPrinterCandidate(id: 2, label: "Impressora Bluetooth 1")])
        await Task.yield()

        XCTAssertEqual(restarted.bluetooth.state, .ready)
        let receipt = LayoutRecordingReceipt()
        XCTAssertTrue(restarted.bluetooth.printAccepted(receipt))
        await transport.waitUntilSendStarts()
        XCTAssertEqual(receipt.layout?.columns, 32)
        XCTAssertEqual(receipt.layout?.qrWidthDots, 320)
        XCTAssertNil(receipt.layout?.codePage)
        XCTAssertEqual(receipt.layout?.cutProtocol, CutProtocol.none)
        transport.complete(.success)
    }

    func testEphemeralCommandRequiresTargetUsesCallbackAndNeverPersists() async throws {
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        var missingResult: PrinterProbeSendResult?
        XCTAssertFalse(configuration.sendEphemeralCommand(Data([0xde, 0xad]), fallingBackToAdopted: true) { missingResult = $0 })
        XCTAssertEqual(missingResult, .failure(.rejected))

        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        bluetoothTransport.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await bluetoothTransport.waitUntilSendStarts()

        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        var inFlightResult: PrinterProbeSendResult?
        XCTAssertFalse(
            configuration.sendEphemeralCommand(Data([0xca, 0xfe]), fallingBackToAdopted: true) { inFlightResult = $0 }
        )
        XCTAssertEqual(inFlightResult, .failure(.rejected))
        XCTAssertEqual(configuration.handleInitialReceipt(.printedWithProblem), .discarded)
        XCTAssertThrowsError(try configuration.makeHomologationSession())

        bluetoothTransport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }
        XCTAssertTrue(configuration.hasEphemeralProbeTarget)
        XCTAssertNil(selectionStore.read().of(.bluetooth))
        XCTAssertEqual(profileStore.profiles(), [])

        var delivered: PrinterProbeSendResult?
        XCTAssertTrue(configuration.sendEphemeralCommand(Data([0xde, 0xad]), fallingBackToAdopted: true) { delivered = $0 })
        XCTAssertEqual(bluetoothTransport.payloads.last, Data([0xde, 0xad]))
        XCTAssertNil(delivered)
        bluetoothTransport.complete(.success)

        XCTAssertEqual(delivered, .success)
        XCTAssertNil(selectionStore.read().of(.bluetooth))
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertFalse(String(describing: configuration).localizedCaseInsensitiveContains("dead"))
        XCTAssertFalse(
            BluetoothPrinterProbeSender(transport: bluetoothTransport, candidate: candidate)
                .description.localizedCaseInsensitiveContains("dead")
        )
    }

    func testRejectedBluetoothTestPreservesAcceptedTargetAndInvalidManualDiscardsIt() async {
        let transport = ConfigurationBluetoothTransport()
        let configuration = ThermalPrinterConfiguration(
            selectionStore: InMemoryPrinterSelectionStore(),
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: transport
        )
        let candidateA = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        let candidateB = BluetoothPrinterCandidate(id: 2, label: "Impressora Bluetooth 2")
        configuration.bluetooth.search()
        transport.publish([candidateA, candidateB])
        await Task.yield()

        configuration.test(candidateA)
        await transport.waitUntilSendStarts()
        configuration.test(candidateB)
        transport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }

        XCTAssertTrue(configuration.hasEphemeralProbeTarget)
        XCTAssertTrue(configuration.sendEphemeralCommand(Data([0x1b, 0x40]), fallingBackToAdopted: true) { _ in })
        XCTAssertEqual(transport.candidateIDs, [candidateA.id, candidateA.id])
        transport.complete(.success)

        configuration.testManual(ipAddress: "endereço inválido", portText: "9100")
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
    }

    func testFailedInitialCallbackNeverAuthorizesEphemeralTarget() async throws {
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let configuration = ThermalPrinterConfiguration(
            selectionStore: InMemoryPrinterSelectionStore(),
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        bluetoothTransport.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await bluetoothTransport.waitUntilSendStarts()
        bluetoothTransport.complete(.failure(.unavailable))
        await waitUntil { configuration.bluetooth.state == .printerUnavailable }

        XCTAssertEqual(configuration.bluetooth.state, .printerUnavailable)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertThrowsError(try configuration.makeHomologationSession())
        var result: PrinterProbeSendResult?
        XCTAssertFalse(configuration.sendEphemeralCommand(Data([0xba, 0xad]), fallingBackToAdopted: true) { result = $0 })
        XCTAssertEqual(result, .failure(.rejected))
        XCTAssertEqual(configuration.handleInitialReceipt(.notPrinted), .discarded)
    }

    /**
     Comando cru pela impressora instalada, sem candidata nenhuma em memória.

     É o relato de campo: quem adotou a portátil e foi mandar `1b 40` ouvia "Nenhuma candidata em
     memória" com a impressora ligada e imprimindo cupom ao lado. O Android nunca teve isso —
     `pendingProbeTarget(transport) ?: adoptedProbeTarget(transport)` resolve o alvo dentro da
     própria API —, e no iOS a ponte existia sem ninguém caindo nela.

     A segunda metade é o que impede o conserto de virar outro defeito: o comando cru não adota, não
     grava e não retém alvo. Depois do envio ``hasEphemeralProbeTarget`` continua falso, que é como
     a tela de configuração sabe que não há papel prometido por esta unidade.
     */
    func testComandoCruAlcancaAImpressoraAdotadaSemCandidataEfemera() async throws {
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        bluetoothTransport.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await bluetoothTransport.waitUntilSendStarts()
        bluetoothTransport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }
        XCTAssertEqual(configuration.handleInitialReceipt(.printedCorrectly), .adopted)
        let instalada = try XCTUnwrap(selectionStore.read().of(.bluetooth))

        // O estado do defeito, medido antes do conserto: adotada, gravada, `.ready` — e sem
        // candidata efêmera. A primeira asserção é a semântica antiga, que não se move.
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertTrue(configuration.canSendEphemeralCommand)

        var resultado: PrinterProbeSendResult?
        XCTAssertTrue(configuration.sendEphemeralCommand(Data([0x1b, 0x40]), fallingBackToAdopted: true) { resultado = $0 })
        XCTAssertEqual(bluetoothTransport.payloads.last, Data([0x1b, 0x40]))
        XCTAssertEqual(bluetoothTransport.candidateIDs.last, candidate.id)
        XCTAssertNil(resultado, "O desfecho é do callback real do transporte, não do aceite.")
        bluetoothTransport.complete(.success)

        XCTAssertEqual(resultado, .success)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertNil(configuration.manualConfigurationForPendingPrinter())
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertEqual(selectionStore.read().selections.count, 1)
        XCTAssertEqual(
            selectionStore.read().of(.bluetooth)?.installationId,
            instalada.installationId
        )
    }

    /**
     Processo novo, nenhuma sessão: só a impressora que já estava instalada.

     O caso acima prova a queda logo depois de adotar; este prova a outra metade do relato — "só
     funciona depois de um scan". Aqui ninguém varreu nada: o app reabriu, a retomada reencontrou a
     unidade guardada e o comando cru precisa sair assim mesmo.

     A primeira asserção existe para o teste não passar por acidente de fixture: instalada no store
     **não** é impressora alcançável, e enquanto a retomada não refaz o vínculo físico a recusa
     continua sendo a certa.
     */
    func testAImpressoraRetomadaServeAoComandoCruSemSessaoNenhuma() async throws {
        let selectionStore = InMemoryPrinterSelectionStore(
            selection: .bluetooth(profileId: "perfil-medido-da-portatil")
        )
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let transport = ConfigurationBluetoothTransport()
        let reaberto = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: transport
        )

        XCTAssertFalse(reaberto.canSendEphemeralCommand)

        reaberto.bluetooth.restoreAdoptedPrinter()
        transport.publish([BluetoothPrinterCandidate(id: 2, label: "Impressora Bluetooth 1")])
        await Task.yield()

        XCTAssertEqual(reaberto.bluetooth.state, .ready)
        XCTAssertFalse(reaberto.hasEphemeralProbeTarget)
        XCTAssertTrue(reaberto.canSendEphemeralCommand)

        var resultado: PrinterProbeSendResult?
        XCTAssertTrue(reaberto.sendEphemeralCommand(Data([0x1b, 0x40]), fallingBackToAdopted: true) { resultado = $0 })
        XCTAssertEqual(transport.payloads.last, Data([0x1b, 0x40]))
        transport.complete(.success)

        XCTAssertEqual(resultado, .success)
        XCTAssertFalse(reaberto.hasEphemeralProbeTarget)
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertEqual(selectionStore.read().selections.count, 1)
    }

    /**
     A consulta que habilita o botão não prepara coisa nenhuma.

     `probeTarget` é `@Published` e a tela lê esta pergunta de dentro do `body`: preparar ali mutaria
     estado publicado durante a atualização da View. Este é o guarda contra o refactor que
     "simplificaria" a consulta chamando a ponte no getter — ela passaria a gravar alvo,
     ``hasEphemeralProbeTarget`` viraria verdadeiro para o app inteiro, e a tela de configuração
     começaria a prometer papel por uma unidade que ninguém escolheu.

     A sessão de homologação continua recusando de propósito, e é aqui que isso fica preso: a queda
     é do comando cru e de mais nada. Quem abre sessão prepara antes, explicitamente, porque a
     adoção da sessão grava instalação e uma sessão nascida de queda automática deixaria a segunda
     para a mesma impressora física.
     */
    func testAConsultaDoComandoCruNaoPreparaCandidataNenhuma() async throws {
        let selectionStore = InMemoryPrinterSelectionStore(
            selection: .bluetooth(profileId: "perfil-medido-da-portatil")
        )
        let transport = ConfigurationBluetoothTransport()
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: transport
        )
        configuration.bluetooth.restoreAdoptedPrinter()
        transport.publish([BluetoothPrinterCandidate(id: 3, label: "Impressora Bluetooth 1")])
        await Task.yield()

        // Três leituras, como a tela faz num único desenho: texto, guarda do preparo e `.disabled`.
        XCTAssertTrue(configuration.canSendEphemeralCommand)
        XCTAssertTrue(configuration.canSendEphemeralCommand)
        XCTAssertTrue(configuration.canSendEphemeralCommand)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertNil(configuration.manualConfigurationForPendingPrinter())
        XCTAssertThrowsError(try configuration.makeHomologationSession())

        XCTAssertTrue(configuration.sendEphemeralCommand(Data([0x1b, 0x40]), fallingBackToAdopted: true) { _ in })
        transport.complete(.success)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)

        // Preparar continua sendo gesto pedido, e é o único que grava alvo.
        XCTAssertTrue(configuration.prepareHomologationForAdoptedPrinter())
        XCTAssertTrue(configuration.hasEphemeralProbeTarget)
    }

    /**
     Candidata viva num transporte **nunca** faz o comando cru sair pelo outro.

     Nasceu da revisão deste próprio conserto, e foi medida antes de escrita: a queda resolvia pelo
     transporte **ativo**, sem relação com a candidata em curso, e os bytes destinados à unidade em
     edição saíam pela impressora instalada do outro meio — comando cru, que grava configuração não
     volátil, escolhendo sozinho outra impressora física.

     Agora a queda resolve no transporte de quem está sendo editado: havendo candidata, é o
     transporte dela, mesmo que ela não esteja confirmada. E aí a recusa é a resposta certa — é o
     que este teste prende.
     */
    func testCandidataVivaNumTransporteNaoDesviaOComandoCruParaOutro() async throws {
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: RedeDaBancadaProvider(),
            localWifiTransport: FalhaNaEntregaWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )

        // Uma portátil adotada e alcançável: sozinha, ela autoriza o comando cru.
        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 11, label: "Impressora Bluetooth 1")
        bluetoothTransport.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await bluetoothTransport.waitUntilSendStarts()
        bluetoothTransport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }
        XCTAssertEqual(configuration.handleInitialReceipt(.printedCorrectly), .adopted)
        XCTAssertTrue(configuration.canSendEphemeralCommand)
        let enviadosNaPortatil = bluetoothTransport.payloads.count

        // Agora entra uma candidata de rede, que não se confirma. A portátil continua instalada,
        // ligada e pronta — e é exatamente por isso que o desvio seria silencioso.
        configuration.testManual(ipAddress: "192.168.1.41", portText: "9100")
        await waitUntil { configuration.localWifi.state != .testing }
        XCTAssertFalse(
            configuration.hasEphemeralProbeTarget,
            "A candidata de rede está viva, mas o comprovante falhou: ela não se confirmou."
        )
        XCTAssertFalse(
            configuration.canSendEphemeralCommand,
            "Com candidata viva na rede, a portátil instalada não pode ser oferecida como alvo."
        )

        var resultado: PrinterProbeSendResult?
        XCTAssertFalse(
            configuration.sendEphemeralCommand(Data([0xba, 0xad]), fallingBackToAdopted: true) { resultado = $0 }
        )
        XCTAssertEqual(resultado, .failure(.rejected))
        XCTAssertEqual(
            bluetoothTransport.payloads.count,
            enviadosNaPortatil,
            "Nenhum byte pode ter saído pela portátil."
        )
    }

    func testActiveAdoptedPrinterCanPrepareAnEphemeralHomologationTarget() async throws {
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        bluetoothTransport.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await bluetoothTransport.waitUntilSendStarts()
        bluetoothTransport.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }
        XCTAssertEqual(configuration.handleInitialReceipt(.printedCorrectly), .adopted)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)

        XCTAssertTrue(configuration.prepareHomologationForAdoptedPrinter())
        XCTAssertTrue(configuration.hasEphemeralProbeTarget)
        let session = try configuration.makeHomologationSession()
        var result: PrinterProbeSendResult?
        XCTAssertTrue(configuration.sendEphemeralCommand(Data([0x1b, 0x40]), fallingBackToAdopted: true) { result = $0 })
        bluetoothTransport.complete(.success)
        await Task.yield()

        XCTAssertEqual(result, .success)
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertFalse(String(describing: configuration).contains(candidate.label))

        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: bluetoothTransport,
            response: .geometry(printableColumns: 32, printableDots: 384)
        )
        try await sendAndAnswer(
            session,
            sender: bluetoothTransport,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: bluetoothTransport)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: bluetoothTransport, response: .codePage(nil))
        try session.sendFinalReceipt()
        bluetoothTransport.complete(.success)
        await Task.yield()
        try session.confirmFinalReceipt()

        guard case let .finished(profile) = session.state else {
            return XCTFail("A homologação da adotada deveria concluir.")
        }
        XCTAssertEqual(configuration.bluetooth.state, .ready)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertEqual(selectionStore.read().of(.bluetooth), .bluetooth(profileId: profile.id))
        XCTAssertEqual(profileStore.profiles(), [profile])
    }

    func testFinalConfirmationRollsBackProfileWhenProfileWriteFailsAfterWriting() async throws {
        let backend = FailAfterWritingProfileDataStore()
        let profileStore = PrinterProfileStore(dataStore: backend)
        let selectionStore = InMemoryPrinterSelectionStore()
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        let session = try await makeSessionAwaitingFinalConfirmation(
            configuration: configuration,
            sender: bluetoothTransport
        )
        backend.failAfterNextWrite = true

        XCTAssertThrowsError(try session.confirmFinalReceipt()) { error in
            XCTAssertEqual(error as? PrinterHomologationSessionError, .persistenceFailed)
        }

        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertNil(selectionStore.read().of(.bluetooth))
        XCTAssertEqual(configuration.bluetooth.state, .awaitingConfirmation)
        XCTAssertTrue(configuration.hasEphemeralProbeTarget)
        XCTAssertEqual(session.state, .awaitingFinalConfirmation)
    }

    func testFinalConfirmationRollsBackSelectionAndKeepsRuntimePendingWhenRereadFails() async throws {
        let profileStore = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let selectionStore = FailAfterSelectionSaveStore()
        let bluetoothTransport = ConfigurationBluetoothTransport()
        let configuration = ThermalPrinterConfiguration(
            selectionStore: selectionStore,
            profileStore: profileStore,
            networkProvider: NoLocalNetworkProvider(),
            localWifiTransport: NoopWifiTransport(),
            bluetoothTransport: bluetoothTransport
        )
        let session = try await makeSessionAwaitingFinalConfirmation(
            configuration: configuration,
            sender: bluetoothTransport
        )
        selectionStore.failNextConfirmation = true

        XCTAssertThrowsError(try session.confirmFinalReceipt()) { error in
            XCTAssertEqual(error as? PrinterHomologationSessionError, .confirmationFailed)
        }
        XCTAssertEqual(profileStore.profiles(), [])
        XCTAssertNil(selectionStore.read().of(.bluetooth))
        XCTAssertEqual(configuration.bluetooth.state, .awaitingConfirmation)
        XCTAssertTrue(configuration.hasEphemeralProbeTarget)
        XCTAssertEqual(session.state, .awaitingFinalConfirmation)

        // A compensação preserva uma nova tentativa humana; ela não repete envio algum.
        XCTAssertNoThrow(try session.confirmFinalReceipt())
        guard case .finished = session.state else {
            return XCTFail("A segunda confirmação deveria concluir depois da falha transitória.")
        }
        XCTAssertEqual(configuration.bluetooth.state, .ready)
        XCTAssertFalse(configuration.hasEphemeralProbeTarget)
        XCTAssertNotNil(selectionStore.read().of(.bluetooth))
        XCTAssertEqual(profileStore.profiles().count, 1)
    }

    /// O retrocesso atravessa a sessão sem inventar estado: quem reverte é a máquina, e o estado
    /// publicado é a consequência. Nenhum byte sai por causa de um "Voltar".
    func testVoltarReverteAMedicaoNaSessaoENaoEnviaNada() async throws {
        let sender = ControlledProbeSender()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetoothLE],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.sendPaperWidthRulers()
        sender.complete(.success)
        await Task.yield()
        try session.selectPaperWidthFromPrintedRulers(.mm58)

        XCTAssertEqual(sender.sendCount, 1)
        XCTAssertEqual(session.state, .homologating(.ready(.rasterThroughput)))
        XCTAssertTrue(session.canGoBack)
        XCTAssertEqual(session.previousStep, .geometry)
        XCTAssertTrue(session.backReprintsProbes)

        try session.goBack()

        // Voltar não imprime: a régua só sai de novo quando a pessoa pedir.
        XCTAssertEqual(sender.sendCount, 1)
        XCTAssertEqual(session.state, .homologating(.ready(.geometry)))
        XCTAssertNil(session.machine.paperWidth)
        XCTAssertFalse(session.canGoBack)
        XCTAssertThrowsError(try session.goBack())
    }

    /// O comprovante final volta enquanto a confirmação humana não foi dada.
    ///
    /// A letra de acento só se prova aqui, e quem lê no comprovante que escolheu errado precisa
    /// corrigir antes de dizer "saiu certo". O rascunho vai junto: nada foi persistido, e a próxima
    /// passagem por `done` tem de montar o perfil da resposta nova, não reaproveitar o da antiga.
    func testComprovanteFinalVoltaAteAConfirmacaoEDescartaORascunho() async throws {
        let sender = ControlledProbeSender()
        let store = PrinterProfileStore(dataStore: SessionMemoryProfileDataStore())
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetoothLE],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: store,
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidthUsingDefaults(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(letraDoCP860))

        XCTAssertEqual(session.state, .finalReceiptReady)
        XCTAssertTrue(session.canGoBack)
        XCTAssertEqual(session.previousStep, .codePage)
        let enviosAntes = sender.sendCount
        XCTAssertEqual(try session.previewFinalProfile().codePage, .cp860)

        try session.goBack()

        // Voltar não imprime, não grava e não deixa o rascunho antigo para trás.
        XCTAssertEqual(sender.sendCount, enviosAntes)
        XCTAssertTrue(store.profiles().isEmpty)
        XCTAssertEqual(session.state, .homologating(.ready(.codePage)))

        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))
        XCTAssertEqual(session.state, .finalReceiptReady)
        XCTAssertNil(try session.previewFinalProfile().codePage)
    }

    /// Depois do comprovante enviado ainda volta; depois da confirmação, não.
    ///
    /// Instalação concluída é concluída: o perfil está no disco e a seleção já apontou para ele.
    /// Um comprovante que falhou também não volta — ali se decide primeiro sobre o papel.
    func testAConfirmacaoFinalFechaORetrocessoDeVez() async throws {
        let sender = ControlledProbeSender()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora medida",
                transports: [.bluetoothLE],
                tcpPort: nil
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: SessionMemoryProfileDataStore()),
            selectionStore: InMemoryPrinterSelectionStore()
        )
        try session.selectPaperWidthUsingDefaults(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))

        try session.sendFinalReceipt()
        sender.complete(.success)
        await Task.yield()
        XCTAssertEqual(session.state, .awaitingFinalConfirmation)
        XCTAssertTrue(session.canGoBack)

        // "Saiu com problema" devolve o comprovante ao começo, e o retrocesso continua aberto.
        try session.rejectFinalReceipt()
        XCTAssertEqual(session.state, .finalReceiptReady)
        XCTAssertTrue(session.canGoBack)

        try session.sendFinalReceipt()
        sender.complete(.success)
        await Task.yield()
        try session.confirmFinalReceipt()

        XCTAssertFalse(session.canGoBack)
        XCTAssertThrowsError(try session.goBack())
    }

    private func sendAndAnswer(
        _ session: PrinterHomologationSession,
        sender: ControlledProbeSender,
        response: PrinterHomologationResponse
    ) async throws {
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.answer(response)
    }

    private func sendAndAnswer(
        _ session: PrinterHomologationSession,
        sender: ConfigurationBluetoothTransport,
        response: PrinterHomologationResponse
    ) async throws {
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.answer(response)
    }

    /// Atravessa a sonda de código nativo por "não consigo dizer".
    ///
    /// Estes testes medem outra coisa, e a ausência nos dois campos devolve exatamente o perfil que
    /// eles sempre conferiram. Quem mede código nativo responde a sonda.
    private func sendAndSkipNativeCode(
        _ session: PrinterHomologationSession,
        sender: ControlledProbeSender
    ) async throws {
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.skipNativeCodeMeasurement()
    }

    private func sendAndSkipNativeCode(
        _ session: PrinterHomologationSession,
        sender: ConfigurationBluetoothTransport
    ) async throws {
        try session.sendCurrentProbe()
        sender.complete(.success)
        await Task.yield()
        try session.skipNativeCodeMeasurement()
    }

    private func makeSessionAwaitingFinalConfirmation(
        configuration: ThermalPrinterConfiguration,
        sender: ConfigurationBluetoothTransport
    ) async throws -> PrinterHomologationSession {
        configuration.bluetooth.search()
        let candidate = BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")
        sender.publish([candidate])
        await Task.yield()
        configuration.test(candidate)
        await sender.waitUntilSendStarts()
        sender.complete(.success)
        await waitUntil { configuration.bluetooth.state == .awaitingConfirmation }
        XCTAssertEqual(configuration.handleInitialReceipt(.printedWithProblem), .homologationRequired)

        let session = try configuration.makeHomologationSession()
        try session.selectPaperWidth(.mm58)
        try await sendAndAnswer(
            session,
            sender: sender,
            response: .geometry(printableColumns: 32, printableDots: 384)
        )
        try await sendAndAnswer(
            session,
            sender: sender,
            response: nominalRasterThroughputResponse
        )
        try await sendAndSkipNativeCode(session, sender: sender)
        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()
        try await sendAndAnswer(session, sender: sender, response: .codePage(nil))
        try session.sendFinalReceipt()
        sender.complete(.success)
        await Task.yield()
        XCTAssertEqual(session.state, .awaitingFinalConfirmation)
        return session
    }

    private func waitUntil(
        _ condition: @escaping () -> Bool,
        attempts: Int = 100
    ) async {
        for _ in 0..<attempts {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("A operação assíncrona não avançou dentro do limite do teste.")
    }
}

private final class ControlledProbeSender: PrinterProbeSending {
    let transport: PrinterTransport
    let canReadIdentity: Bool
    private let identity: PrinterDeclaredIdentity?
    private var completion: ((PrinterProbeSendResult) -> Void)?
    private(set) var sendCount = 0
    private(set) var identityReadCount = 0
    private(set) var lastPayload = Data()

    init(
        transport: PrinterTransport = .bluetooth,
        identity: PrinterDeclaredIdentity? = nil,
        identityReadEnabled: Bool? = nil
    ) {
        self.transport = transport
        self.identity = identity
        canReadIdentity = identityReadEnabled ?? (identity != nil)
    }

    func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void) {
        sendCount += 1
        lastPayload = bytes
        self.completion = completion
    }

    func readIdentity(completion: @escaping (PrinterDeclaredIdentity?) -> Void) {
        identityReadCount += 1
        completion(identity)
    }

    func complete(_ result: PrinterProbeSendResult) {
        let callback = completion
        completion = nil
        callback?(result)
    }
}

private final class SessionMemoryProfileDataStore: PrinterProfileDataStoring {
    var data: Data?
    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

private enum AtomicStoreFailure: Error { case injected }

private final class FailAfterWritingProfileDataStore: PrinterProfileDataStoring {
    var failAfterNextWrite = false
    private var data: Data?

    func readProfileData() throws -> Data? { data }

    func writeProfileData(_ data: Data?) throws {
        self.data = data
        if failAfterNextWrite {
            failAfterNextWrite = false
            throw AtomicStoreFailure.injected
        }
    }
}

private final class FailAfterSelectionSaveStore: PrinterSelectionStoring {
    var failNextConfirmation = false
    private var current = PersistedPrinterSelections()
    private var staleRead: PersistedPrinterSelections?

    func read() -> PersistedPrinterSelections {
        if let staleRead {
            self.staleRead = nil
            return staleRead
        }
        return current
    }

    func save(_ selections: PersistedPrinterSelections) {
        let previous = current
        current = selections
        if failNextConfirmation, selections.activeSelection != nil {
            failNextConfirmation = false
            staleRead = previous
        }
    }

    func clear() { current = PersistedPrinterSelections() }
}

private final class ConfigurationBluetoothTransport: BluetoothPrinterTransporting {
    var onStateChange: ((BluetoothPrinterRadioState) -> Void)?
    var onCandidates: (([BluetoothPrinterCandidate]) -> Void)?
    private var completion: ((ThermalPrintResult) -> Void)?
    private(set) var payloads: [Data] = []
    private(set) var candidateIDs: [Int] = []

    func startScan() { onStateChange?(.ready) }
    func stopScan() {}
    func disconnect() {}

    func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate,
        completion: @escaping (ThermalPrintResult) -> Void
    ) {
        payloads.append(payload)
        candidateIDs.append(candidate.id)
        self.completion = completion
    }

    func publish(_ candidates: [BluetoothPrinterCandidate]) { onCandidates?(candidates) }

    func waitUntilSendStarts(attempts: Int = 100) async {
        for _ in 0..<attempts {
            if completion != nil { return }
            await Task.yield()
        }
    }

    func complete(_ result: PrinterProbeSendResult) {
        let callback = completion
        completion = nil
        callback?(
            result == .success
                ? .delivered
                : .failed(message: "Falha sintética.", delivery: .notSent)
        )
    }
}

private final class LayoutRecordingReceipt: ThermalReceiptPayload {
    private(set) var layout: ReceiptLayout?
    private(set) var wasCleared = false

    func receiptBytes(layout: ReceiptLayout) -> Data? {
        self.layout = layout
        var data = layout.text("Ã\n", alignment: 0)
        data.append(layout.finish())
        return data
    }

    func clear() { wasCleared = true }
}

private struct NoLocalNetworkProvider: LocalWifiPrinterNetworkProviding {
    func currentNetwork() -> LocalWifiPrinterNetwork? { nil }
}

/// Rede presente, para o caso que precisa de uma candidata de rede **viva** ao lado de uma
/// portátil instalada. Sem rede, `testManual` recusa o endereço e nunca chega a reter candidata —
/// e o teste passaria medindo a fixture.
private struct RedeDaBancadaProvider: LocalWifiPrinterNetworkProviding {
    func currentNetwork() -> LocalWifiPrinterNetwork? {
        LocalWifiPrinterSubnet(hostAddress: "192.168.1.10", prefixLength: 24)
            .map(LocalWifiPrinterNetwork.init(subnet:))
    }
}

private final class NoopWifiTransport: LocalWifiPrinterTransport, @unchecked Sendable {
    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool { false }
    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {}
}

/// Rede que aceita o endereço e falha na entrega: é o que deixa a candidata **viva e não
/// confirmada**, que é o estado do defeito. Um transporte que entrega faria a candidata se
/// confirmar, e o comando sairia por ela — certo, e sem medir nada.
private final class FalhaNaEntregaWifiTransport: LocalWifiPrinterTransport, @unchecked Sendable {
    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool { true }
    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        throw LocalWifiPrinterTransportError.unavailable
    }
}

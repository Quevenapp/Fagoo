import Foundation
import XCTest
@testable import ThermalPrinterKit

/**
 A homologação passa a existir para a Diebold IM453H no lado Swift, e o que ela promete é o que ela
 emite.

 **O que estava quebrado.** As sondas deste kit eram ESC/POS de ponta a ponta, e nada perguntava o
 dialeto antes de mandá-las. Um perfil Procomp contribuído pelo Android é lido deste disco desde
 30/08/2026 — então bastava adotá-lo e tocar em "medir de novo" para a régua raster sair como dois
 metros de código e o aparelho parar de responder até desligar e ligar, que é o que a bobina de
 24/08/2026 pagou do lado Kotlin.

 Esta suíte prende a série que fecha isso, e ela prende as quatro coisas que o papel cobra:

 1. **nenhum comando ESC/POS** sai nesta série — é o defeito que custa aparelho, e não papel;
 2. **as etapas que não têm tira honesta não abrem** — código nativo e página;
 3. **o corte é o `ESC w` medido**, o mesmo que fecha todo cupom de venda;
 4. **o dialeto atravessa a adoção** — sem isso a impressora homologada voltava a ESC/POS ao ser
    salva, e só o cupom seguinte mostraria, longe da causa.

 Espelha `android/src/test/java/br/com/thermalprinterkit/HomologacaoProcompTest.kt`.

 **Nada aqui saiu em papel**, e nada aqui abre socket ou toca impressora.
 */
@MainActor
final class HomologacaoProcompTests: XCTestCase {
    private let serie = printerHomologationProbeSet(.procompEscP)

    /// Toda tira que a série Procomp sabe montar, com a geometria de 80 mm da IM453H.
    private func todasAsTiras() throws -> [PrinterProbe] {
        [
            ProcompHomologationProbes.paperWidthRulers(),
            ProcompHomologationProbes.geometry(paperWidth: .mm80),
            ProcompHomologationProbes.fullGeometry(),
            try XCTUnwrap(ProcompHomologationProbes.rasterThroughput(printableDots: 576)),
            ProcompHomologationProbes.isolatedCut(),
            ProcompHomologationProbes.cutFeed(),
            try XCTUnwrap(ProcompHomologationProbes.finalReceipt(profile: try perfilProcomp())),
        ]
    }

    /**
     Cada sequência abaixo é uma das que a IM453H recebeu em 23 e 24/08/2026. `ESC @` saiu como um
     `@` impresso; `GS v 0` e as demais deixaram o aparelho travado, com a tecla de avanço morta e
     recuperação só no desligar e ligar.

     **E não há nenhum `1D` sequer**, medido byte a byte nas sete tiras — ver
     ``testNenhumByte1DSaiEmTodaAMedicaoProcomp()``, que é a forma mais forte da mesma prova. Esta
     lista continua existindo porque é ela que **nomeia** o que se está evitando: um `1D` que
     reaparecesse falha nos dois testes, e só este diz qual comando voltou.
     */
    func testNenhumaTiraDaSerieProcompCarregaComandoEscPos() throws {
        let proibidas: [(String, [UInt8])] = [
            ("ESC @", [0x1B, 0x40]),
            ("GS v 0", [0x1D, 0x76, 0x30]),
            ("GS V", [0x1D, 0x56]),
            ("GS !", [0x1D, 0x21]),
            ("GS ( k", [0x1D, 0x28, 0x6B]),
            ("GS k", [0x1D, 0x6B]),
            ("GS I", [0x1D, 0x49]),
            ("ESC a", [0x1B, 0x61]),
            ("ESC t", [0x1B, 0x74]),
            ("DLE EOT", [0x10, 0x04]),
        ]

        for tira in try todasAsTiras() {
            for (nome, sequencia) in proibidas {
                XCTAssertFalse(
                    contem(sequencia, em: tira.bytes),
                    "A tira de \(tira.size) bytes carrega \(nome), que trava esta impressora."
                )
            }
        }
    }

    /// É este campo que o portão do envio lê. Uma tira sem ele seria recusada pela proteção que
    /// existe para ela — ou pior, uma tira ESC/POS passaria por Procomp.
    func testTodaTiraDaSerieSeDeclaraProcomp() throws {
        for tira in try todasAsTiras() {
            XCTAssertEqual(tira.dialect, .procompEscP)
        }
    }

    func testOCorteDeTodaTiraQueCortaEOEscWMedido() {
        let escW = ProcompEscP.cut(.escW)
        XCTAssertEqual(Array(escW), [0x1B, 0x77])

        XCTAssertTrue(
            ProcompHomologationProbes.isolatedCut().bytes.suffix(escW.count).elementsEqual(escW),
            "A tira isolada de corte não termina na lâmina."
        )
        for tira in ProcompHomologationProbes.cutFeedStrips() {
            XCTAssertTrue(
                tira.bytes.suffix(escW.count).elementsEqual(escW),
                "A tira de avanço \(tira.feedLines) não termina na lâmina."
            )
        }
    }

    func testAReguaDeAvancoSaiInteiraUmCortePorValorMedido() {
        let tiras = ProcompHomologationProbes.cutFeedStrips()

        XCTAssertEqual(tiras.map(\.feedLines), PrinterProbePayloads.cutFeedCandidates)
        // O envio único é a concatenação das oito, e não uma nona tira montada de outro jeito.
        XCTAssertEqual(
            tiras.reduce(0) { $0 + $1.bytes.count },
            ProcompHomologationProbes.cutFeed().size
        )
    }

    /// `finish()` no dialeto Procomp é `procompFinish`: quatro `LF` e `ESC w`. Se este papel saiu
    /// cortado, o cupom de amanhã sai cortado pelos mesmos bytes — não há segundo caminho.
    /**
     **Perfil ESC/POS na folha Procomp recusa — e não derruba o processo.**

     Aqui esteve uma `precondition`, que continua ativa em release. Medido por mutação em
     04/09/2026: trocando o dialeto que ``PrinterHomologationMachine/measuredProfile()`` passa, o
     processo de teste morria com signal 5 antes de a asserção rodar — em produção seria o app do
     balcão fechando no lugar de uma tela com "tentar de novo". Esta prova é o que impede a
     precondição de voltar: com ela de volta, este teste mataria o processo em vez de passar.

     O caminho recuperável termina em ``PrinterHomologationSession`` como `.finalReceiptFailed`.
     */
    func testUmPerfilEscPosNaFolhaProcompRecusaEmVezDeDerrubarOProcesso() throws {
        let escPos = try perfilProcomp(dialect: .epsonCompatible)

        XCTAssertNil(ProcompHomologationProbes.finalReceipt(profile: escPos))
        // E a contraprova, para a asserção acima não passar por uma folha que nunca sai.
        XCTAssertNotNil(ProcompHomologationProbes.finalReceipt(profile: try perfilProcomp()))
    }

    func testOComprovanteFinalFechaPeloMesmoCorteDoCupomDeVenda() throws {
        let perfil = try perfilProcomp(cutFeedLines: 4)
        let fecho = ReceiptLayout(profile: PrinterProfile(perfil)).finish()

        let comprovante = try XCTUnwrap(ProcompHomologationProbes.finalReceipt(profile: perfil)).bytes

        XCTAssertEqual(Array(fecho), [0x0A, 0x0A, 0x0A, 0x0A, 0x1B, 0x77])
        XCTAssertTrue(
            comprovante.suffix(fecho.count).elementsEqual(fecho),
            "O comprovante não termina pelo fecho do cupom."
        )
    }

    func testSemGuilhotinaOComprovanteAvancaENaoCorta() throws {
        let semCorte = try perfilProcomp(cutProtocol: .none, cutFeedLines: 0)

        let comprovante = try XCTUnwrap(ProcompHomologationProbes.finalReceipt(profile: semCorte)).bytes

        XCTAssertFalse(
            contem(Array(ProcompEscP.cut(.escW)), em: comprovante),
            "Saiu comando de corte numa impressora sem guilhotina."
        )
        XCTAssertTrue(contemOTexto("Corte: sem guilhotina", em: comprovante))
    }

    /**
     A folha sai **em ABICOMP**, não em UTF-8, então a conferência é por bytes: procurar "avanço"
     numa `String` decodificada não acharia nada. Encodar a frase esperada pelo mesmo encoder da
     impressora é o que faz este teste medir o papel.
     */
    func testACertidaoNaoAfirmaMedicaoQueNinguemFezNestaImpressora() throws {
        let papel = try XCTUnwrap(ProcompHomologationProbes.finalReceipt(profile: try perfilProcomp())).bytes

        // O `.gsV1` do perfil é o lugar do corte no formato comum, não uma medição: nenhum byte `GS`
        // chega aqui. A folha diz o comando que saiu.
        XCTAssertFalse(
            contemOTexto(CutProtocol.gsV1.label, em: papel),
            "A folha imprime o nome de um comando ESC/POS."
        )
        XCTAssertTrue(contemOTexto("Corte: ESC w (parcial) | avanço 4", em: papel))
        // Não há `ESC t` neste caminho: o texto sai na tabela de fábrica.
        XCTAssertTrue(contemOTexto("Tabela: ABICOMP", em: papel))
        XCTAssertFalse(contemOTexto("Codificação:", em: papel))
        // `GS I` é comando `GS`. Ninguém perguntou, e "não respondeu" seria afirmar a pergunta.
        XCTAssertTrue(contemOTexto(ProcompHomologationProbes.identityUnasked, em: papel))
        XCTAssertFalse(contemOTexto("não respondeu", em: papel))
        // As duas capacidades que a série não mede saem nomeadas como não medidas.
        XCTAssertTrue(contemOTexto("QR nativo: não medido", em: papel))
        XCTAssertTrue(contemOTexto("Barras nativas: não medido", em: papel))
    }

    func testASequenciaPulaCodigoNativoEPaginaEAEscPosContinuaMedindoOsDois() throws {
        let procomp = maquina(dialect: .procompEscP)
        try procomp.selectPaperWidthUsingDefaults(.mm80)
        XCTAssertEqual(procomp.state, .ready(.rasterThroughput))
        _ = try procomp.beginSending()
        try procomp.sendingCompleted(success: true)
        try procomp.answerRasterThroughputPrintedInFull()

        // Sem tira honesta de código nativo, a etapa não abre — e os dois campos ficam ausentes.
        XCTAssertEqual(procomp.state, .ready(.cutProtocol))
        XCTAssertNil(procomp.nativeQrHonored)
        XCTAssertNil(procomp.nativeBarcodeHonored)

        try procomp.answerCutterQuestion(.no)
        try procomp.completeCutFeedWithoutProbe()

        // E sem tira de página a medição termina aqui, em vez de perguntar o que o emissor descarta.
        XCTAssertEqual(procomp.state, .done)
        XCTAssertEqual(try procomp.measuredProfile().textEncoding, .ascii)
        XCTAssertNil(try procomp.measuredProfile().codePage)

        // O mutante: a série ESC/POS continua atravessando as duas etapas.
        let escpos = maquina(dialect: .epsonCompatible)
        try escpos.selectPaperWidthUsingDefaults(.mm58)
        _ = try escpos.beginSending()
        try escpos.sendingCompleted(success: true)
        try escpos.answerRasterThroughputPrintedInFull()
        XCTAssertEqual(escpos.state, .ready(.nativeCode))
        _ = try escpos.beginSending()
        try escpos.sendingCompleted(success: true)
        try escpos.skipNativeCodeMeasurement()
        try escpos.answerCutterQuestion(.no)
        try escpos.completeCutFeedWithoutProbe()
        XCTAssertEqual(escpos.state, .ready(.codePage))
    }

    /// Os dois cortes medidos nesta firmware — `ESC w` e `ESC US` — cortaram igual, e `procompFinish`
    /// emite `ESC w` de qualquer jeito. Uma tira por comando seria papel gasto numa escolha que o
    /// produto ignora.
    func testASondaDeCorteMandaUmComandoENaoOsSeisDoEscPos() {
        XCTAssertEqual(serie.cutCandidates, [.gsV1])
        XCTAssertEqual(printerHomologationProbeSet(.epsonCompatible).cutCandidates.count, 6)
    }

    /// As duas respostas não podem divergir: a máquina decide se entra na etapa pelo booleano e monta
    /// a tira pela função.
    func testASerieDeclaraOQueMedeEOQueElaDeclaraEOQueElaMonta() {
        for dialeto in EscPosDialect.allCases {
            let conjunto = printerHomologationProbeSet(dialeto)
            XCTAssertEqual(
                conjunto.measuresNativeCode,
                conjunto.nativeCode(printableDots: 576) != nil,
                "measuresNativeCode discorda de nativeCode() em \(dialeto)."
            )
            XCTAssertEqual(
                conjunto.measuresCodePage,
                conjunto.codePage(cutProtocol: .none, cutFeedLines: 0) != nil,
                "measuresCodePage discorda de codePage() em \(dialeto)."
            )
        }
    }

    /// Piso: largura, vazão e comprovante final. Teto: mais a régua completa, a tira de corte e as
    /// oito de avanço. A conta da série ESC/POS não se move — é ela que a tela do iPhone já anuncia.
    func testOPapelAnunciadoContaAsTirasQueEstaSerieRealmenteManda() {
        XCTAssertEqual(PrinterHomologationPaperCost.minimumStrips(.procompEscP), 3)
        XCTAssertEqual(PrinterHomologationPaperCost.maximumStrips(.procompEscP), 13)
        XCTAssertEqual(PrinterHomologationPaperCost.minimumStrips(.epsonCompatible), 5)
        XCTAssertEqual(
            PrinterHomologationPaperCost.maximumStrips(.epsonCompatible),
            PrinterHomologationPaperCost.maximumStrips
        )
    }

    /**
     **A prova de ponta a ponta, e a que importa.** Homologar a Diebold do começo ao fim, capturar
     tudo o que sairia pelo fio e afirmar que nem `ESC @` nem `GS v 0` estão lá — nem qualquer outro
     comando `GS`, inclusive o `GS I` do leitor de identidade, que sai por um caminho que não passa
     por sonda nenhuma.

     E o perfil adotado é Procomp. Sem o dialeto em `MeasuredProfile.init`, a impressora homologada
     voltaria a falar ESC/POS no primeiro cupom depois de salva.
     */
    func testHomologarADieboldAdotaUmPerfilProcompENaoUmEscPos() async throws {
        let store = PrinterProfileStore(dataStore: ProcompMemoryProfileDataStore())
        let sender = CapturadorDeSondas(
            identity: PrinterDeclaredIdentity(firmwareVersion: "1.0", manufacturer: "Diebold", model: "IM453H")
        )
        let session = sessaoProcomp(store: store, sender: sender)

        try session.sendPaperWidthRulers()
        sender.complete()
        await Task.yield()
        try session.selectPaperWidthFromPrintedRulers(.mm80)

        try session.sendCurrentProbe()
        sender.complete()
        await Task.yield()
        try session.answerRasterThroughputPrintedInFull()

        try session.answerCutterQuestion(.yes)
        try session.sendAllCutProbes()
        sender.complete()
        await Task.yield()
        try session.answer(.cutProtocol(.gsV1))

        try session.confirmBenchReadyForCutFeed()
        try session.sendCurrentProbe()
        sender.complete()
        await Task.yield()
        try session.answer(.cutFeed(4))

        XCTAssertEqual(session.state, .finalReceiptReady)
        try session.sendFinalReceipt()
        sender.complete()
        await Task.yield()
        XCTAssertEqual(session.state, .awaitingFinalConfirmation)
        try session.confirmFinalReceipt()

        let adotado = try XCTUnwrap(store.profiles().first)
        XCTAssertEqual(
            adotado.dialect,
            .procompEscP,
            "A impressora homologada voltaria a falar ESC/POS no primeiro cupom depois de salva."
        )
        XCTAssertEqual(adotado.paperWidthMm, 80)
        XCTAssertEqual(adotado.cutFeedLines, 4)
        XCTAssertTrue(adotado.cutProtocol.hasCutter)

        // `GS I` nunca foi ao fio: o leitor de identidade não chega a ser chamado neste dialeto, e é
        // por isso que a certidão diz "não perguntada" em vez de "não respondeu".
        XCTAssertEqual(sender.identityReadCount, 0)

        // Cinco envios: réguas de largura, vazão, a tira de corte, as oito de avanço num envio, e o
        // comprovante final.
        XCTAssertEqual(sender.sendCount, 5)
        let fio = sender.tudoQueSaiu
        XCTAssertFalse(contem([0x1B, 0x40], em: fio), "Saiu `ESC @` para a Diebold.")
        XCTAssertFalse(contem([0x1D, 0x76, 0x30], em: fio), "Saiu `GS v 0` para a Diebold.")
        XCTAssertFalse(contem([0x1D, 0x49], em: fio), "Saiu `GS I` para a Diebold.")
        XCTAssertFalse(fio.contains(Self.gs), "Saiu um byte `GS` para uma firmware que não tem nenhum.")
    }

    /**
     **Nenhum byte `1D` sai em toda a medição Procomp**, e não só nenhum comando `GS`.

     São 74.520 bytes nas sete tiras, contados em 04/09/2026: zero ocorrências. É a forma mais forte
     da prova porque não depende de eu ter listado o comando certo — a IM453H não tem **nenhum**
     comando `GS`, então o alvo honesto é o byte, não a lista.

     **Onde isto é estrutura e onde é medição, porque a diferença importa.** Nas tiras que medem
     (réguas, vazão, corte, avanço) todo byte é comando de ``ProcompEscP``, texto em ABICOMP, ou
     pixel de régua e de meio tom — e nenhum desses vale `1D`; ali a ausência é estrutural. No
     comprovante final entra a trama do QR, e ali dentro do `ESC n` a firmware está em modo gráfico:
     um `1D` seria **dado**, não comando. Este QR não tem nenhum, e isso é medição do payload
     `THERMAL-PRINTER-KIT-HOMOLOGATION` — trocar o conteúdo do QR pode fazer aparecer um, e isso
     **não** seria defeito. Quem mexer nele conserta este número, não o dialeto.
     */
    func testNenhumByte1DSaiEmTodaAMedicaoProcomp() throws {
        for tira in try todasAsTiras() {
            XCTAssertEqual(
                [UInt8](tira.bytes).filter { $0 == Self.gs }.count,
                0,
                "A tira de \(tira.size) bytes carrega um `1D` — e esta firmware não tem comando `GS` nenhum."
            )
        }
    }

    /**
     A contraprova, sem a qual uma sessão que não manda nada passaria no teste acima.

     A mesma medição no caminho ESC/POS **tem** de carregar `GS v 0`, e ela sai com duas tiras a mais
     — a de código nativo e a de página — que a série Procomp não tem.
     */
    func testAMesmaMedicaoNoCaminhoEscPosCarregaGsV0EDuasTirasAMais() async throws {
        let store = PrinterProfileStore(dataStore: ProcompMemoryProfileDataStore())
        let sender = CapturadorDeSondas()
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Impressora ESC/POS",
                transports: [.localWifi],
                tcpPort: 9_100
            ),
            sender: sender,
            profileStore: store,
            selectionStore: InMemoryPrinterSelectionStore()
        )

        try session.sendPaperWidthRulers()
        sender.complete()
        await Task.yield()
        try session.selectPaperWidthFromPrintedRulers(.mm80)

        try session.sendCurrentProbe()
        sender.complete()
        await Task.yield()
        try session.answerRasterThroughputPrintedInFull()

        // A etapa que a série Procomp não tem.
        XCTAssertEqual(session.state, .homologating(.ready(.nativeCode)))
        try session.sendCurrentProbe()
        sender.complete()
        await Task.yield()
        try session.skipNativeCodeMeasurement()

        try session.answerCutterQuestion(.no)
        try session.completeCutFeedWithoutProbe()

        // E a outra.
        XCTAssertEqual(session.state, .homologating(.ready(.codePage)))
        try session.sendCurrentProbe()
        sender.complete()
        await Task.yield()
        try session.answer(.codePage(nil))

        // Neste caminho o `GS I` **é** perguntado, e a leitura acontece antes do comprovante: o
        // envio só se registra no ciclo seguinte. É a diferença que a prova Procomp não tem.
        try session.sendFinalReceipt()
        await Task.yield()
        XCTAssertEqual(sender.identityReadCount, 1)
        sender.complete()
        await Task.yield()
        try session.confirmFinalReceipt()

        XCTAssertEqual(store.profiles().first?.dialect, .epsonCompatible)
        XCTAssertEqual(sender.sendCount, 5)
        XCTAssertTrue(
            contem([0x1D, 0x76, 0x30], em: sender.tudoQueSaiu),
            "a série ESC/POS precisa continuar mandando `GS v 0`, senão a prova de cima é vazia"
        )
        XCTAssertTrue(
            contem([0x1B, 0x40], em: sender.tudoQueSaiu),
            "e continuar abrindo em `ESC @`"
        )
    }

    /**
     O perfil medido carrega o dialeto, e **sem dialeto informado ele continua nascendo ESC/POS**.

     A contraprova é metade da prova: um padrão que tivesse virado Procomp por descuido faria toda
     impressora já homologada deste kit trocar de dialeto na próxima medição, e a `capabilityKey`
     delas andaria junto.
     */
    func testOPerfilMedidoCarregaODialetoEOPadraoContinuaEscPos() throws {
        XCTAssertEqual(try perfilProcomp().dialect, .procompEscP)

        let semDialeto = try MeasuredProfile(
            displayName: "Impressora de sempre",
            measuredAt: Date(timeIntervalSince1970: 1_700_000_000),
            transports: [.usb],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .gsV1,
            cutFeedLines: 4,
            tcpPort: nil
        )
        XCTAssertEqual(semDialeto.dialect, .epsonCompatible)
    }

    /// É a tira que resolve os 576 dots "de convenção" e as 48 colunas que só uma régua de bancada
    /// tinha visto. Ela precisa cobrir a largura desta impressora de ponta a ponta.
    func testAReguaCompletaDeGeometriaExisteNestaSerie() {
        let papel = ProcompHomologationProbes.fullGeometry().bytes

        XCTAssertTrue(contemOTexto("REGUA TEXTUAL 24 A 64", em: papel))
        XCTAssertTrue(contemOTexto("576 DOTS", em: papel))
        XCTAssertTrue(contemOTexto("640 DOTS", em: papel))
        XCTAssertNotNil(ProcompHomologationProbes.rasterThroughput(printableDots: 576))
    }

    // MARK: - Apoio

    private func sessaoProcomp(
        store: PrinterProfileStore,
        sender: CapturadorDeSondas
    ) -> PrinterHomologationSession {
        PrinterHomologationSession(
            machine: maquina(dialect: .procompEscP),
            sender: sender,
            profileStore: store,
            selectionStore: InMemoryPrinterSelectionStore(),
            dialect: .procompEscP
        )
    }

    private func maquina(dialect: EscPosDialect) -> PrinterHomologationMachine {
        PrinterHomologationMachine(
            displayName: "Diebold IM453H",
            transports: [.localWifi],
            tcpPort: 9_100,
            dialect: dialect
        )
    }

    private func perfilProcomp(
        cutProtocol: CutProtocol = .gsV1,
        cutFeedLines: Int = 4,
        dialect: EscPosDialect = .procompEscP
    ) throws -> MeasuredProfile {
        try MeasuredProfile(
            displayName: "Diebold IM453H",
            measuredAt: Date(timeIntervalSince1970: 1_700_000_000),
            transports: [.usb],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: cutProtocol,
            cutFeedLines: cutFeedLines,
            tcpPort: nil,
            dialect: dialect
        )
    }

    private func contem(_ agulha: [UInt8], em data: Data) -> Bool {
        let palheiro = [UInt8](data)
        guard !agulha.isEmpty, palheiro.count >= agulha.count else { return false }
        return (0...(palheiro.count - agulha.count)).contains { inicio in
            Array(palheiro[inicio ..< inicio + agulha.count]) == agulha
        }
    }

    /// A frase como ela sai da impressora: pelo encoder do dialeto, e não em UTF-8.
    private func contemOTexto(_ frase: String, em data: Data) -> Bool {
        contem(Array(ProcompEscP.encode(frase, table: .abicomp)), em: data)
    }

    /// O primeiro byte de `GS v 0`, `GS !`, `GS V`, `GS ( k` — e de todo comando `GS`.
    private static let gs: UInt8 = 0x1D
}

/// Store em memória isolado deste arquivo. Ver a mesma nota em `RecusaDeDialetoTests`.
private final class ProcompMemoryProfileDataStore: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

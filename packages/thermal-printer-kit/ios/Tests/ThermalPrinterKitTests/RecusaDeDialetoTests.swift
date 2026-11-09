import Foundation
import XCTest
@testable import ThermalPrinterKit

/**
 Nenhum byte de uma sonda alcança uma impressora que fala outra língua.

 **Medido em 24/08/2026, na marra, do lado Kotlin.** `PrinterProbePayloads` monta bytes crus, sem
 ``ReceiptLayout``, então não há por onde o dialeto entrar: são onze `ESC @` e um `GS v 0` fixos no
 código. Com a Diebold IM453H adotada — que não tem um único comando `GS` — a régua raster do passo
 de geometria saiu como **dois metros de código**, e o aparelho parou de responder até desligar e
 ligar.

 **No lado Swift esse portão não existia até este lote**, nem na forma velha. `PrinterProbeSession`
 entregava os bytes da máquina direto ao remetente sem perguntar nada, e a única coisa que impedia a
 sonda ESC/POS de alcançar uma IM453H era não haver como escolher aquele dialeto pela tela. Perfil
 Procomp contribuído pelo Android é lido deste disco desde 30/08/2026, então essa proteção era
 acidente de calendário, não decisão.

 **A pergunta é a certa desde o começo aqui**: não "esta impressora fala ESC/POS?", que acertaria por
 acaso enquanto houvesse uma série só, mas **estes bytes falam a língua desta impressora?** A
 pergunta velha teria recusado a série Procomp pelo mesmo portão que existe para protegê-la.

 **Nada aqui saiu em papel**, e nada aqui abre socket ou toca impressora.
 */
@MainActor
final class RecusaDeDialetoTests: XCTestCase {

    // MARK: - O portão do envio

    /// A prova que importa: os bytes ESC/POS de sempre **não chegam** a uma firmware Procomp.
    ///
    /// Sem a comparação em `PrinterHomologationSession.send`, `sendCount` seria 1 e a IM453H
    /// receberia `GS v 0` — a régua raster que a travou em 24/08/2026.
    func testSondaEscPosNaoChegaAUmaFirmwareProcomp() throws {
        let (session, sender) = sessao(bytesDe: .epsonCompatible, alvo: .procompEscP)

        try session.sendPaperWidthRulers()

        XCTAssertEqual(sender.sendCount, 0, "A sonda foi enviada assim mesmo.")
        XCTAssertEqual(session.lastError, .dialectNotSupported)
        XCTAssertEqual(
            session.lastError?.errorDescription?.contains("Nada foi enviado"),
            true,
            "A mensagem não diz que nada saiu."
        )
        // O passo fecha em `failed`, que é a verdade sobre o papel: a tira não saiu. `retry` continua
        // sendo o caminho de quem quiser tentar de novo — e não um estado preso em `sending`.
        XCTAssertEqual(session.state, .homologating(.failed(.geometry)))
    }

    /// O outro lado da mesma trava. Ela não existiria se o portão olhasse só o alvo: bastaria
    /// trocá-lo de lugar para a série errada passar.
    func testSondaProcompNaoChegaAUmaFirmwareEscPos() throws {
        let (session, sender) = sessao(bytesDe: .procompEscP, alvo: .epsonCompatible)

        try session.sendPaperWidthRulers()

        XCTAssertEqual(sender.sendCount, 0, "A sonda foi enviada assim mesmo.")
        XCTAssertEqual(session.lastError, .dialectNotSupported)
    }

    /// A contraprova sem a qual as duas de cima passariam numa sessão que não manda nada.
    func testAMesmaSondaContinuaSaindoEmEscPos() throws {
        let (session, sender) = sessao(bytesDe: .epsonCompatible, alvo: .epsonCompatible)

        try session.sendPaperWidthRulers()

        XCTAssertEqual(sender.sendCount, 1)
        XCTAssertNil(session.lastError)
        XCTAssertTrue(
            contem([0x1D, 0x76, 0x30], em: sender.enviados[0]),
            "a régua raster ESC/POS é `GS v 0`, e ela precisa continuar saindo por este caminho"
        )
    }

    /// E a série Procomp alcança a impressora Procomp — que é o que este lote destrava.
    func testASerieProcompAlcancaAImpressoraProcomp() throws {
        let (session, sender) = sessao(bytesDe: .procompEscP, alvo: .procompEscP)

        try session.sendPaperWidthRulers()

        XCTAssertEqual(sender.sendCount, 1)
        XCTAssertNil(session.lastError)
        XCTAssertFalse(
            contem([0x1B, 0x40], em: sender.enviados[0]),
            "`ESC @` não é comando desta firmware: em 23/08/2026 o `40h` saiu impresso como `@`"
        )
    }

    // MARK: - O portão em si

    /**
     As quatro perguntas, fixadas por dialeto.

     O `switch` exaustivo sem `default` é quem guarda o terceiro dialeto — compilador é melhor guarda
     que teste. O que este teste guarda é o **valor** de cada resposta para os dois que existem: um
     `true` que virasse `false` por descuido no Procomp devolveria exatamente o defeito de 23/08.
     */
    func testAsQuatroPerguntasDoPortao() {
        XCTAssertTrue(EscPosDialectGate.composesReceipt(.epsonCompatible))
        XCTAssertTrue(
            EscPosDialectGate.composesReceipt(.procompEscP),
            "o kit compõe cupom inteiro em Procomp desde 30/08/2026 — texto, raster e corte"
        )

        XCTAssertTrue(EscPosDialectGate.emitsEscPos(.epsonCompatible))
        XCTAssertFalse(
            EscPosDialectGate.emitsEscPos(.procompEscP),
            "não é 'não sabemos imprimir': é 'não emitimos ESC/POS para ela'"
        )

        XCTAssertTrue(EscPosDialectGate.usesEscPosStatusQueries(.epsonCompatible))
        XCTAssertFalse(EscPosDialectGate.usesEscPosStatusQueries(.procompEscP))

        XCTAssertTrue(EscPosDialectGate.usesEscPosIdentityQuery(.epsonCompatible))
        XCTAssertFalse(EscPosDialectGate.usesEscPosIdentityQuery(.procompEscP))
    }

    /// O prólogo é o de cada firmware, e não o `ESC @` que era fixo.
    func testOPrologoEODeCadaDialeto() {
        XCTAssertEqual(Array(EscPosDialectGate.prologue(for: .epsonCompatible)), [0x1B, 0x40])

        let procomp = EscPosDialectGate.prologue(for: .procompEscP)
        XCTAssertEqual(procomp, ProcompEscP.reset())
        XCTAssertFalse(
            contem([0x1B, 0x40], em: procomp),
            "`ESC @` não é comando da IM453H: o `40h` foi parar no papel como um `@`"
        )
        XCTAssertFalse(procomp.contains(Self.gs), "e nenhum comando `GS` abre trabalho nela")
    }

    // MARK: - O comprovante de teste, que não passa por homologação nenhuma

    /**
     **O papel que qualquer pessoa alcança tocando em "imprimir teste".**

     `PrinterTestReceipt.bytes` abria com `EscPos.initialize()` — `1B 40` cru — e compunha **todo o
     resto** pelo layout, que já fala Procomp. O corpo saía traduzido e o prólogo não. Os três
     chamadores são de produção — os dois controladores e a conferência da configuração declarada — e
     nenhum deles passa por sonda: bastava um perfil Procomp adotado, e ele é lido deste disco desde
     30/08/2026.
     */
    func testOComprovanteDeTesteNaoAbreEmEscArrobaNumLayoutProcomp() {
        let papel = PrinterTestReceipt.bytes(layout: layout(dialect: .procompEscP))

        XCTAssertFalse(contem([0x1B, 0x40], em: papel), "o prólogo continuava sendo nosso, não dela")
        XCTAssertTrue(
            papel.starts(with: ProcompEscP.reset()),
            "ele tem de abrir desligando cada atributo pelo comando que desliga aquele atributo"
        )
    }

    /**
     **O prólogo era metade do conserto; a outra metade estava impressa no papel.**

     Consertado o `ESC @`, três frases continuavam saindo num comprovante Procomp e as três
     afirmavam medições que ninguém fez: `Página:` e `Codificação:` descrevem uma escolha de tabela
     que esta firmware não faz — não há `ESC t`, o texto sai em ABICOMP de fábrica —, e `Corte:`
     imprimia o nome do enum ESC/POS (`GS V 1`) numa impressora que nunca recebe um byte `GS`.
     Medido em 04/09/2026 sobre os bytes deste mesmo papel.

     A certidão de homologação já dizia o certo (ver
     ``ProcompHomologationProbes/profileLines(profile:identity:transport:)``); era só esta folha —
     a que não passa por homologação nenhuma — que continuava mentindo.
     */
    func testOComprovanteDeTesteProcompNaoAfirmaTabelaNemCorteQueNinguemMediu() {
        let camada = layout(dialect: .procompEscP)
        let frases = PrinterTestReceipt.dialectLines(layout: camada)

        XCTAssertFalse(frases.contains("Página:"), "não há `ESC t` nesta firmware")
        XCTAssertFalse(frases.contains("Codificação:"), "a tabela é a de fábrica, e não uma escolha")
        XCTAssertFalse(frases.contains("GS V"), "o nome do enum ESC/POS viraria cadastro um mês depois")
        XCTAssertTrue(frases.contains("Tabela: ABICOMP (fábrica)"), "o papel diz qual tabela saiu")
        XCTAssertTrue(frases.contains("Corte: ESC w"), "e diz o comando que saiu")
        // E do outro lado, nos bytes que realmente saem: nenhum comando `GS` neste papel. As
        // frases acima viajam codificadas em ABICOMP, então é aqui que a afirmação vira byte.
        XCTAssertFalse(
            PrinterTestReceipt.bytes(layout: camada).contains(0x1D),
            "um comando GS chegou a uma impressora sem comandos GS"
        )
    }

    /// A contraprova: no papel ESC/POS as três linhas continuam saindo, porque lá elas são medição.
    func testOComprovanteDeTesteEscPosContinuaDizendoPaginaCodificacaoECorte() {
        let frases = PrinterTestReceipt.dialectLines(layout: layout(dialect: .epsonCompatible))

        XCTAssertTrue(frases.contains("Página:"))
        XCTAssertTrue(frases.contains("Codificação:"))
        XCTAssertTrue(frases.contains("Corte:"))
        XCTAssertFalse(frases.contains("Tabela: ABICOMP"), "ABICOMP é da outra firmware")
    }

    /// A contraprova: o comprovante ESC/POS continua abrindo em `ESC @`, byte a byte.
    func testOComprovanteDeTesteEscPosContinuaAbrindoEmEscArroba() {
        let papel = PrinterTestReceipt.bytes(layout: layout(dialect: .epsonCompatible))

        XCTAssertTrue(papel.starts(with: EscPos.initialize()))
    }

    // MARK: - Apoio

    private func sessao(
        bytesDe: EscPosDialect,
        alvo: EscPosDialect
    ) -> (PrinterHomologationSession, CapturadorDeSondas) {
        let sender = CapturadorDeSondas()
        // Os dois dialetos chegam por caminhos independentes de propósito: o da máquina decide os
        // **bytes**, o da sessão é o do **alvo**. Fossem lidos de um lugar só, a comparação nunca
        // poderia discordar e o portão não protegeria nada.
        let session = PrinterHomologationSession(
            machine: PrinterHomologationMachine(
                displayName: "Diebold IM453H",
                transports: [.localWifi],
                tcpPort: 9_100,
                dialect: bytesDe
            ),
            sender: sender,
            profileStore: PrinterProfileStore(dataStore: RecusaMemoryProfileDataStore()),
            selectionStore: InMemoryPrinterSelectionStore(),
            dialect: alvo
        )
        return (session, sender)
    }

    private func layout(dialect: EscPosDialect) -> ReceiptLayout {
        ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: true,
            codePage: nil,
            cutProtocol: .gsV1,
            cutFeedLines: 4,
            printableDots: 576,
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

    /// O primeiro byte de `GS v 0`, `GS !`, `GS V`, `GS ( k` e de todo comando `GS`.
    private static let gs: UInt8 = 0x1D
}

/// Remetente que **acumula todos** os envios, e não só o último: a prova de bytes deste lote precisa
/// da homologação inteira concatenada, e `ControlledProbeSender` guarda apenas `lastPayload`.
final class CapturadorDeSondas: PrinterProbeSending {
    let transport: PrinterTransport
    let canReadIdentity: Bool
    private let identity: PrinterDeclaredIdentity?
    private var completion: ((PrinterProbeSendResult) -> Void)?

    private(set) var enviados: [Data] = []
    private(set) var identityReadCount = 0

    var sendCount: Int { enviados.count }
    /// Tudo o que sairia pelo fio, na ordem em que sairia.
    var tudoQueSaiu: Data { enviados.reduce(into: Data()) { $0.append($1) } }

    init(
        transport: PrinterTransport = .localWifi,
        identity: PrinterDeclaredIdentity? = nil,
        identityReadEnabled: Bool = true
    ) {
        self.transport = transport
        self.identity = identity
        canReadIdentity = identityReadEnabled
    }

    func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void) {
        enviados.append(bytes)
        self.completion = completion
    }

    func readIdentity(completion: @escaping (PrinterDeclaredIdentity?) -> Void) {
        identityReadCount += 1
        completion(identity)
    }

    func complete(_ result: PrinterProbeSendResult = .success) {
        let callback = completion
        completion = nil
        callback?(result)
    }
}

/// Store em memória isolado deste arquivo: nomes iguais em alvos diferentes já custaram tempo aqui.
final class RecusaMemoryProfileDataStore: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

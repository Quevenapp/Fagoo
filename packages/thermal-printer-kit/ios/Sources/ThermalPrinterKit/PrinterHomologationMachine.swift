import Foundation

public enum PrinterHomologationStep: String, CaseIterable, Sendable {
    case geometry = "GEOMETRY"
    /// Mede quanto raster esta impressora aguenta receber por segundo.
    ///
    /// Vem **depois** da geometria porque a tira precisa da largura imprimível medida: o defeito só
    /// aparece em largura cheia, e uma tira mais estreita mediria outra impressora. Vem **antes** do
    /// corte porque não depende de guilhotina nenhuma.
    case rasterThroughput = "RASTER_THROUGHPUT"
    /// Mede se a firmware desenha o QR e o código de barras quando o comando nativo pede.
    ///
    /// Vem **depois** da vazão pela mesma dependência que põe a vazão depois da geometria: a
    /// largura de módulo sai da área imprimível medida, e um símbolo mais largo que o papel sai
    /// truncado — truncamento é indistinguível de "a firmware não entendeu", que é justamente o que
    /// este passo existe para distinguir. Vem **antes** do corte porque não depende de guilhotina
    /// nenhuma, e não pode vir depois de `codePage`, que conclui a máquina.
    case nativeCode = "NATIVE_CODE"
    case cutProtocol = "CUT_PROTOCOL"
    case cutFeed = "CUT_FEED"
    /// Mede modelo de codificação e página na mesma tira.
    ///
    /// O passo `TEXT_ENCODING` saiu em 12/08: ele perguntava "byte único, UTF-8 ou sem acentos?"
    /// antes deste, e a pergunta não é respondível com o papel na mão. Os três viraram as três
    /// primeiras linhas desta tira.
    case codePage = "CODE_PAGE"
}

public enum PrinterHomologationState: Equatable, Sendable {
    case ready(PrinterHomologationStep)
    case sending(PrinterHomologationStep)
    case awaitingResponse(PrinterHomologationStep)
    case failed(PrinterHomologationStep)
    case done
}

public enum PrinterHomologationResponse: Equatable, Sendable {
    case geometry(printableColumns: Int, printableDots: Int)
    /// Letra da primeira linha certa na tira única; `nil` quando nenhuma candidata serviu.
    case codePage(Character?)
    /// Resultado visível da tentativa de corte atual. O modo não é inferido: a bancada mostrou
    /// que seis das sete impressoras não entregam a distinção prometida pelo comando.
    case cutAttempt(cut: Bool)
    /// Compatibilidade da resposta longa antiga. A tela curta não pergunta modo e perfis novos
    /// mantêm `cutModeHonored = false`, mesmo quando um importador ainda envia este argumento.
    case cutProtocol(CutProtocol, deliveredMode: CutMode? = nil)
    case cutFeed(Int)
    /// Quantos milímetros a tira de vazão mediu na régua — a leitura, não a conclusão.
    ///
    /// É a mesma pergunta das etapas de geometria: quem está na frente da impressora responde o que
    /// viu no papel. A conta que decide se existe teto, e qual, é da máquina.
    case rasterThroughput(printedLengthMillimetres: Int)
    /**
     O que saiu em cada um dos dois blocos da tira de código nativo.

     **Dois valores, e não um.** `GS ( k` e `GS k` são comandos de gerações diferentes e nada obriga
     uma firmware a atender os dois: o `GS k` é ESC/POS de 1992 e está em quase toda portátil, o
     `GS ( k` é da geração 2D e falta em muitas das mesmas portáteis. Com "E" lógico, uma impressora
     que desenha barras perfeitamente perderia o recurso por causa do QR; com "OU", o app ofereceria
     QR nativo numa firmware que só provou o `GS k`.

     `true` é "saiu figura"; `false` é "saiu texto, ou não saiu nada" — as duas significam a mesma
     coisa para o perfil. Quem não consegue dizer não responde: usa
     ``PrinterHomologationMachine/skipNativeCodeMeasurement()``.
     */
    case nativeCode(qrHonored: Bool, barcodeHonored: Bool)
}

public enum PrinterCutterAnswer: String, CaseIterable, Sendable {
    case yes = "YES"
    case no = "NO"
    case unknown = "UNKNOWN"
}

public enum PrinterHomologationMachineError: Error, Equatable, LocalizedError {
    case invalidState
    case paperWidthRequired
    case invalidResponse
    case benchConfirmationRequired
    case noProbeRequired
    case incompleteProfile

    public var errorDescription: String? {
        switch self {
        case .invalidState: return "A homologação não aceita esta ação no estado atual."
        case .paperWidthRequired: return "Escolha 58 ou 80 mm antes de imprimir a régua."
        case .invalidResponse: return "Resposta incompatível com a sonda atual."
        case .benchConfirmationRequired: return PrinterProbePayloads.cutFeedBenchWarning
        case .noProbeRequired: return "Este protocolo conclui o avanço com zero e não precisa de sonda."
        case .incompleteProfile: return "A homologação ainda não reuniu todas as capacidades."
        }
    }
}

/// Máquina sem interface e sem cronômetro. Uma resposta humana só é aceita depois de o transporte
/// encerrar seu callback; falha volta por ação explícita e nunca repete envio automaticamente.
public final class PrinterHomologationMachine {
    public private(set) var state: PrinterHomologationState = .ready(.geometry)
    public private(set) var paperWidth: PrinterPaperWidth?
    public private(set) var benchReadyForCutFeed = false
    public private(set) var currentCutProbeProtocol: CutProtocol?
    public private(set) var usesAdvancedCutProtocolProbe = false
    /// Verdadeiro quando este dialeto precisa da régua de avanço — todo dialeto com guilhotina que
    /// não carrega alimentação no próprio comando.
    ///
    /// Antes existia um caminho curto que abria com 5 linhas — medido na P80 e na Tomate — e pedia
    /// confirmação: quem respondesse "não comeu texto" gravava um número que não mediu. A distância
    /// entre a cabeça e a lâmina é física de cada impressora. Decidido em 12/08, ao custo de oito
    /// tiras em toda impressora com guilhotina.
    public private(set) var usesCutFeedRuler = false
    public private(set) var cutMeasurementFailed = false
    public var resolvedCutProtocol: CutProtocol? { cutProtocol }

    private let displayName: String
    private let transports: Set<PrinterCapabilityTransport>
    private let tcpPort: Int?

    /**
     O dialeto do alvo, e portanto o da série de tiras que esta máquina monta.

     Ele decide três coisas que antes não tinham como ser decididas: **quais bytes** saem (a série,
     por ``printerHomologationProbeSet(_:)``), **quais etapas existem** (ver
     ``PrinterHomologationProbeSet/measuresNativeCode`` e
     ``PrinterHomologationProbeSet/measuresCodePage``) e **o que o perfil grava** — sem ele,
     homologar uma Diebold pelo iPhone adotava um perfil ESC/POS, e só o cupom seguinte mostraria,
     longe da causa.
     */
    public let dialect: EscPosDialect
    private let probeSet: any PrinterHomologationProbeSet
    /// Colunas medidas na régua, ou o padrão da largura escolhida. A tela lê para anunciar quantas
    /// linhas a tira de página vai ocupar **nesta** impressora.
    public private(set) var printableColumns: Int?
    private var printableDots: Int?
    private var textEncoding: ThermalTextEncoding?
    private var codePage: ThermalCodePage?
    private var codePageSelector: UInt8?
    private var cutModeHonored = false
    private var answeredCodePage = false
    private var cutProtocol: CutProtocol?
    private var cutFeedLines: Int?
    private var cutterAnswer: PrinterCutterAnswer?
    private var cutAttempt = 0
    private var classifyWidthFromFullRuler = false

    /// Vazão real do último envio da tira de vazão, em bytes por segundo, ou `nil` se não deu para
    /// medir. Chega por `sendingCompleted`: quem cronometra é o transporte, nunca esta máquina.
    public private(set) var measuredRasterBytesPerSecond: Int?
    /**
     Fator que a resposta da régua produziu; `nil` é o raster de sempre, sem compensação.

     Foi `maxRasterBytesPerSecond` até 20/08. A tira e a pergunta continuam as mesmas; o que mudou
     é a conclusão, porque a hipótese de vazão foi medida e refutada. Ver
     ``answerRasterThroughput(printedLengthMillimetres:)``.
     */
    public private(set) var verticalRasterScale: Double?

    /**
     O que a tira de código nativo mediu, ou `nil` enquanto ninguém respondeu.

     `nil` não é "não": é "ninguém perguntou". A distinção existe porque Ajustes precisa mandar
     remedir em vez de dizer que a impressora não sabe — e porque um `false` por padrão ficaria
     indistinguível de uma medição negativa no comprovante, que é a informação que ele carrega.
     */
    public private(set) var nativeQrHonored: Bool?
    /// O mesmo para o `GS k`. São dois comandos, e por isso são duas respostas.
    public private(set) var nativeBarcodeHonored: Bool?

    /// Piso do "saiu inteira": 0,97 de 48 mm são 46,6 mm, o ±1 mm de uma régua comum.
    static let healthyRasterRatio = 0.97

    /// Fotografias das decisões já tomadas, da primeira até a que está aberta agora.
    ///
    /// Cada uma é a máquina inteira no instante em que aquela decisão abriu, antes da resposta
    /// dela. `goBack()` restaura a última: o que foi medido de lá para frente some, porque foi
    /// medido contra a premissa que está sendo corrigida, e o que veio antes fica intacto. O
    /// retrocesso mora aqui, e não na tela, porque estado paralelo na interface seria uma segunda
    /// verdade sobre o que a impressora já disse no papel.
    private var previousSteps: [StepEntry] = []
    /// A máquina recém-criada: nenhuma resposta, e as duas réguas de largura ainda por imprimir.
    private var stepEntry = StepEntry()

    /// Todos os dialetos com comando. Parar no primeiro que corta economizava papel e escondia o
    /// que a impressora faz nos outros — e deixava a escolha sem comparação. Medido na LUOGAO em
    /// 12/08: com uma tira só não há com o que comparar.
    public static let allCutProtocols = CutProtocol.allCases.filter(\.hasCutter)

    /// Os comandos de corte **desta** série. Na ESC/POS são os seis de ``allCutProtocols``; na
    /// Procomp é um só, porque os dois cortes medidos naquela firmware cortam igual e o emissor
    /// manda `ESC w` de qualquer jeito. Ver ``PrinterHomologationProbeSet/cutCandidates``.
    public var cutProtocolCandidates: [CutProtocol] { probeSet.cutCandidates }

    /// Palpite da P80 e da Tomate, usado só quando a pessoa pula a medição de propósito.
    static let unmeasuredCutFeedLines = 5

    /// - Parameter dialect: o dialeto do alvo. Fica por último e com padrão pela convenção do kit —
    ///   ver a nota de ``ReceiptLayout/init(columns:qrWidthDots:hasCutter:codePage:codePageSelector:textEncoding:cutProtocol:cutFeedLines:printableDots:decoration:rasterStripeHeightDots:verticalRasterScale:qrEmission:barcodeEmission:dialect:)``.
    ///   O padrão é o ESC/POS de sempre, para nenhum chamador de fora deste kit precisar mudar.
    public init(
        displayName: String,
        transports: Set<PrinterCapabilityTransport>,
        tcpPort: Int?,
        dialect: EscPosDialect = .epsonCompatible
    ) {
        self.displayName = displayName
        self.transports = transports
        self.tcpPort = tcpPort
        self.dialect = dialect
        probeSet = printerHomologationProbeSet(dialect)
    }

    public func selectPaperWidth(_ width: PrinterPaperWidth) throws {
        guard state == .ready(.geometry) else { throw PrinterHomologationMachineError.invalidState }
        paperWidth = width
        printableColumns = width.defaultPrintableColumns
        printableDots = width.defaultPrintableDots
    }

    /// O caminho curto usa os padrões provados na bancada e segue sem gastar papel. A régua
    /// continua disponível por `selectPaperWidth(_:)`, que deliberadamente permanece no passo.
    public func selectPaperWidthUsingDefaults(_ width: PrinterPaperWidth) throws {
        try selectPaperWidth(width)
        advanceAfterGeometry()
    }

    /// Passo que `goBack()` reabre, ou `nil` quando não há decisão anterior para desfazer.
    public var previousStep: PrinterHomologationStep? {
        guard case let .ready(step)? = previousSteps.last?.state else { return nil }
        return step
    }

    /// Só volta quem tem decisão anterior e não está no meio de um envio nem de uma falha.
    ///
    /// O primeiro passo não volta porque não há premissa anterior. `done` volta: a medição acabou,
    /// mas o comprovante final ainda não foi confirmado, e quem escolheu a letra errada de acento
    /// precisa corrigir antes de dizer que o papel saiu certo. Quem sabe se a confirmação já
    /// aconteceu é a `PrinterHomologationSession`, que conhece o comprovante; a máquina só sabe que
    /// `done` ainda tem premissa anterior para desfazer. Falha pendente resolve-se primeiro, para o
    /// retrocesso nunca ser a resposta a uma tira que talvez tenha saído.
    public var canGoBack: Bool {
        guard previousStep != nil else { return false }
        switch state {
        case .ready, .awaitingResponse, .done: return true
        case .sending, .failed: return false
        }
    }

    /// Verdadeiro quando avançar de novo pelo passo reaberto manda tiras ao papel outra vez.
    ///
    /// Voltar sozinho não imprime nada; a reimpressão acontece quando a pessoa refizer o passo pelo
    /// caminho normal dele. Isto existe para a tela anunciar o custo antes do toque, e é
    /// deliberadamente conservador no corte: responder "Não" ali não gasta papel, mas prometer
    /// papel a mais é o erro barato — prometer a menos é o que a regra proíbe.
    public var backReprintsProbes: Bool {
        guard let entry = previousSteps.last, case let .ready(step) = entry.state else { return false }
        switch step {
        // As duas réguas de largura, a régua completa e a tira de texto saem de novo.
        case .geometry, .codePage: return true
        // A tira de vazão é a mais cara em papel de todas as que saem uma vez só: são 48 mm de
        // meio tom em largura cheia. Reabrir o passo e avançar por ele de novo gasta outra.
        case .rasterThroughput: return true
        // Uma tira com o QR e o código de barras nativos: reabrir e avançar manda outra ao papel.
        case .nativeCode: return true
        // "Sim" e "Não sei" mandam os seis dialetos de novo; só "Não" sai de graça.
        case .cutProtocol: return true
        case .cutFeed:
            guard let cut = entry.cutProtocol else { return false }
            return cut.hasCutter && !cut.hasEmbeddedFeed
        }
    }

    /// Desfaz uma decisão: reabre o passo anterior com as respostas dele em diante descartadas.
    ///
    /// Nenhum byte sai daqui. Medido no iPhone 7 em 20/08: quem escolhia 58 mm numa impressora de
    /// 80 não tinha como corrigir, e a única saída era recomeçar a homologação inteira.
    public func goBack() throws {
        guard canGoBack, let entry = previousSteps.popLast() else {
            throw PrinterHomologationMachineError.invalidState
        }
        restore(entry)
    }

    public func selectPaperWidthFromPrintedRulers(_ width: PrinterPaperWidth) throws {
        guard state == .awaitingResponse(.geometry), paperWidth == nil else {
            throw PrinterHomologationMachineError.invalidState
        }
        paperWidth = width
        printableColumns = width.defaultPrintableColumns
        printableDots = width.defaultPrintableDots
        advanceAfterGeometry()
    }

    public func selectNoPaperWidthFromPrintedRulers() throws {
        guard state == .awaitingResponse(.geometry), paperWidth == nil else {
            throw PrinterHomologationMachineError.invalidState
        }
        printableColumns = 48
        printableDots = 576
        classifyWidthFromFullRuler = true
        // Mesmo passo, outra decisão: a recusa das duas réguas troca a premissa da medição e por
        // isso guarda a sua própria fotografia. No Android essa fronteira é a divisão entre WIDTH e
        // GEOMETRY; aqui os dois moram no passo `geometry`, e o retrocesso precisa distingui-los.
        advance(to: .ready(.geometry))
    }

    public func beginPaperWidthRulers() throws -> PrinterProbe {
        guard state == .ready(.geometry), paperWidth == nil else {
            throw PrinterHomologationMachineError.invalidState
        }
        state = .sending(.geometry)
        return probeSet.paperWidthRulers()
    }

    /// Pergunta de triagem, não medição: não cria campo de perfil. O que será persistido continua
    /// sendo somente o protocolo resultante depois das tentativas reais no papel.
    public func answerCutterQuestion(_ answer: PrinterCutterAnswer) throws {
        guard state == .ready(.cutProtocol), cutterAnswer == nil else {
            throw PrinterHomologationMachineError.invalidState
        }
        cutterAnswer = answer
        if answer == .no {
            finishCutProtocol(.none)
        } else {
            cutAttempt = 0
            currentCutProbeProtocol = cutProtocolCandidates[cutAttempt]
        }
    }

    /// O avançado preserva os dialetos homologados, enviados um por callback. Assim um relato
    /// identifica exatamente o comando tentado e uma falha jamais dispara o próximo sozinha.
    public func useAdvancedCutProtocolProbe() throws {
        guard state == .ready(.cutProtocol), cutterAnswer == nil else {
            throw PrinterHomologationMachineError.invalidState
        }
        usesAdvancedCutProtocolProbe = true
        cutAttempt = 0
        currentCutProbeProtocol = cutProtocolCandidates[cutAttempt]
    }

    public func retryCutWithAdvancedProbe() throws {
        guard state == .ready(.cutFeed), cutMeasurementFailed, cutProtocol == CutProtocol.none else {
            throw PrinterHomologationMachineError.invalidState
        }
        cutProtocol = nil
        cutFeedLines = nil
        cutMeasurementFailed = false
        usesAdvancedCutProtocolProbe = true
        cutAttempt = 0
        currentCutProbeProtocol = cutProtocolCandidates[cutAttempt]
        // Retomar o avançado é uma decisão como as outras: voltar dela devolve a tela do avanço
        // zero, com a medição de corte ainda declarada como fracassada.
        advance(to: .ready(.cutProtocol))
    }

    /// Devolve a sonda e muda para `sending` numa única operação para impedir envio duplicado.
    ///
    /// **A sonda carrega o dialeto em que foi montada**, e é ele que o portão do envio lê. Ver
    /// ``PrinterProbe``.
    public func beginSending() throws -> PrinterProbe {
        guard case let .ready(step) = state else { throw PrinterHomologationMachineError.invalidState }
        let payload: PrinterProbe
        switch step {
        case .geometry:
            payload = paperWidth.map { probeSet.geometry(paperWidth: $0) } ?? probeSet.fullGeometry()
        case .codePage:
            guard let cutProtocol, let cutFeedLines else {
                throw PrinterHomologationMachineError.incompleteProfile
            }
            guard let bytes = probeSet.codePage(
                cutProtocol: cutProtocol,
                cutFeedLines: cutFeedLines
            ) else { throw PrinterHomologationMachineError.noProbeRequired }
            payload = bytes
        case .rasterThroughput:
            guard let printableDots,
                  let bytes = probeSet.rasterThroughput(printableDots: printableDots)
            else { throw PrinterHomologationMachineError.incompleteProfile }
            payload = bytes
        case .nativeCode:
            // A largura de módulo sai da área imprimível medida: é a dependência que decide a
            // posição deste passo na sequência.
            guard let printableDots,
                  let bytes = probeSet.nativeCode(printableDots: printableDots)
            else { throw PrinterHomologationMachineError.incompleteProfile }
            payload = bytes
        case .cutProtocol:
            guard let currentCutProbeProtocol,
                  let bytes = probeSet.isolatedCut(currentCutProbeProtocol)
            else { throw PrinterHomologationMachineError.noProbeRequired }
            payload = bytes
        case .cutFeed:
            guard let cutProtocol else { throw PrinterHomologationMachineError.incompleteProfile }
            guard cutProtocol.hasCutter, !cutProtocol.hasEmbeddedFeed else {
                throw PrinterHomologationMachineError.noProbeRequired
            }
            if !benchReadyForCutFeed {
                throw PrinterHomologationMachineError.benchConfirmationRequired
            }
            // Nenhum valor chega escolhido: a régua inteira é a medição.
            let bytes = probeSet.cutFeed(cutProtocol: cutProtocol)
            guard let bytes else {
                throw PrinterHomologationMachineError.noProbeRequired
            }
            payload = bytes
        }
        state = .sending(step)
        return payload
    }

    /// O comprovante final desta série. Existe aqui, e não na sessão, para haver **um** lugar que
    /// escolhe a série: a sessão não conhece dialeto de bytes, só o do alvo.
    public func finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: (any ReceiptDecoration)?
    ) -> PrinterProbe? {
        probeSet.finalReceipt(
            profile: profile,
            identity: identity,
            transport: transport,
            decoration: decoration
        )
    }

    public func sendingCompleted(success: Bool) throws {
        try sendingCompleted(success: success, measuredBytesPerSecond: nil)
    }

    /// - Parameter measuredBytesPerSecond: vazão real do envio que acabou de terminar — bytes
    ///   entregues ao transporte divididos pelo tempo que ele levou —, ou `nil` quando o chamador
    ///   não mediu. Só o passo de vazão a guarda, e ela nunca é suposta: sem medida não há teto,
    ///   porque inventar um número seria a heurística por modelo que este campo existe para não ser.
    public func sendingCompleted(success: Bool, measuredBytesPerSecond: Int?) throws {
        guard case let .sending(step) = state else { throw PrinterHomologationMachineError.invalidState }
        if step == .rasterThroughput {
            measuredRasterBytesPerSecond =
                (success && (measuredBytesPerSecond ?? 0) > 0) ? measuredBytesPerSecond : nil
        }
        state = success ? .awaitingResponse(step) : .failed(step)
    }

    public func retryAfterFailure() throws {
        guard case let .failed(step) = state else { throw PrinterHomologationMachineError.invalidState }
        state = .ready(step)
    }

    public func confirmBenchReadyForCutFeed() throws {
        guard state == .ready(.cutFeed),
              let cutProtocol, cutProtocol.hasCutter, !cutProtocol.hasEmbeddedFeed
        else { throw PrinterHomologationMachineError.invalidState }
        benchReadyForCutFeed = true
    }

    /// NONE e GS V 65/66 visitam o passo CUT_FEED, mas concluem com zero sem mandar uma sonda.
    /// Isso preserva a sequência da máquina e libera a codificação somente depois de a distância
    /// estar definida, sem acrescentar avanço aos dialetos que já o carregam.
    public func completeCutFeedWithoutProbe() throws {
        guard state == .ready(.cutFeed),
              let cutProtocol, cutProtocol == .none || cutProtocol.hasEmbeddedFeed
        else { throw PrinterHomologationMachineError.invalidState }
        cutFeedLines = 0
        advanceAfterCutFeed()
    }

    /// Pula a régua e grava o palpite da bancada, sem fingir que ele foi medido.
    ///
    /// Oito tiras é o preço da medição, e nem toda hora é hora de pagá-lo. O valor que entra é o
    /// mesmo cinco que a P80 e a Tomate mediram — a diferença é que agora ele é escolha explícita
    /// de quem está na frente da impressora. O comprovante final imprime o avanço, então o número
    /// fica à vista de quem quiser conferir.
    public func skipCutFeedMeasurement() throws {
        guard state == .ready(.cutFeed), usesCutFeedRuler
        else { throw PrinterHomologationMachineError.invalidState }
        cutFeedLines = Self.unmeasuredCutFeedLines
        advanceAfterCutFeed()
    }

    public func answer(_ response: PrinterHomologationResponse) throws {
        guard case let .awaitingResponse(step) = state else {
            throw PrinterHomologationMachineError.invalidState
        }
        switch (step, response) {
        case let (.geometry, .geometry(columns, dots)):
            guard (24...64).contains(columns),
                  (256...640).contains(dots), dots.isMultiple(of: 32)
            else { throw PrinterHomologationMachineError.invalidResponse }
            if classifyWidthFromFullRuler {
                paperWidth = columns <= 32 && dots <= 384 ? .mm58 : .mm80
            } else {
                guard let paperWidth,
                      columns <= paperWidth.geometryProbeColumns,
                      paperWidth.geometryProbeDots.contains(dots)
                else { throw PrinterHomologationMachineError.invalidResponse }
            }
            printableColumns = columns
            printableDots = dots
            advanceAfterGeometry()
        case let (.rasterThroughput, .rasterThroughput(millimetres)):
            try answerRasterThroughput(printedLengthMillimetres: millimetres)
        case let (.nativeCode, .nativeCode(qr, barcode)):
            // Nada é inferido do outro bloco, nem de marca, modelo, `firmwareVersion` ou dialeto: o
            // único produtor destes dois campos é esta resposta.
            nativeQrHonored = qr
            nativeBarcodeHonored = barcode
            advance(to: .ready(.cutProtocol))
        case let (.codePage, .codePage(letter)):
            answeredCodePage = true
            let candidate: CodePageProbeCandidate?
            if let letter {
                guard let found = PrinterProbePayloads.codePageCandidates.first(where: {
                    String($0.letter).lowercased() == String(letter).lowercased()
                }) else { throw PrinterHomologationMachineError.invalidResponse }
                candidate = found
            } else {
                candidate = nil
            }
            // A candidata carrega a decisão inteira: modelo de codificação, tabela e endereço.
            // Eram três coisas decididas em dois lugares até 12/08, e as duas plataformas já
            // tinham divergido num deles. Sem letra — host antigo — vale a linha `a`, que é
            // exatamente a dobra ASCII conservadora.
            let resolved = candidate ?? PrinterProbePayloads.codePageCandidates[0]
            textEncoding = resolved.textEncoding
            codePage = resolved.codePage
            // O endereço só é persistido nas candidatas `n=..`; um nome usa o canônico da própria
            // tabela. Foi esse campo que a T210 provou precisar atravessar o disco.
            codePageSelector = resolved.isAddress ? resolved.selector : nil
            advance(to: .done)
        case let (.cutProtocol, .cutAttempt(cut)):
            // Compatibilidade: hosts antigos ainda respondem tira a tira. A resposta positiva
            // encerra a varredura com aquele dialeto; a negativa apenas avança.
            guard let attempted = currentCutProbeProtocol else {
                throw PrinterHomologationMachineError.invalidResponse
            }
            if cut {
                finishCutProtocol(attempted)
            } else {
                try advanceCutProbe()
            }
        case let (.cutProtocol, .cutProtocol(protocolValue, _)):
            // A escolha à vista das tiras. O modo deixou de ser uma pergunta e perfis novos
            // permanecem conservadores (`cutModeHonored = false`).
            guard protocolValue == .none || cutProtocolCandidates.contains(protocolValue) else {
                throw PrinterHomologationMachineError.invalidResponse
            }
            cutMeasurementFailed = protocolValue == .none
            finishCutProtocol(protocolValue)
        case let (.cutFeed, .cutFeed(lines)):
            guard PrinterCapabilities.allowedCutFeedLines.contains(lines),
                  let cutProtocol, cutProtocol.hasCutter, !cutProtocol.hasEmbeddedFeed
            else { throw PrinterHomologationMachineError.invalidResponse }
            cutFeedLines = lines
            advanceAfterCutFeed()
        default:
            throw PrinterHomologationMachineError.invalidResponse
        }
    }

    /// Registra que a tira do dialeto atual saiu e prepara a próxima; depois da última, a etapa
    /// fica aguardando a escolha. Não há pergunta entre as tiras: o papel é que responde, e ele
    /// responde melhor com todos os cortes lado a lado.
    public func advanceCutProbe() throws {
        guard case .awaitingResponse(.cutProtocol) = state, currentCutProbeProtocol != nil else {
            throw PrinterHomologationMachineError.invalidState
        }
        cutAttempt += 1
        if cutAttempt < cutProtocolCandidates.count {
            currentCutProbeProtocol = cutProtocolCandidates[cutAttempt]
            state = .ready(.cutProtocol)
        } else {
            currentCutProbeProtocol = nil
            state = .awaitingResponse(.cutProtocol)
        }
    }

    private func finishCutProtocol(_ protocolValue: CutProtocol) {
        cutProtocol = protocolValue
        cutModeHonored = false
        cutFeedLines = (protocolValue == .none || protocolValue.hasEmbeddedFeed) ? 0 : nil
        currentCutProbeProtocol = nil
        usesCutFeedRuler = protocolValue.hasCutter && !protocolValue.hasEmbeddedFeed
        benchReadyForCutFeed = false
        // O avanço vem imediatamente depois do dialeto: só depois de medi-lo as sondas de
        // codificação podem usar a distância daquela impressora para entregar cada tira.
        advance(to: .ready(.cutFeed))
    }

    /// Toda saída da geometria passa por aqui, e o próximo passo é a vazão.
    ///
    /// A tira de vazão precisa da largura imprimível medida, então este é o primeiro instante em
    /// que ela pode existir — e é onde ela entra, para os três caminhos que resolvem geometria: a
    /// largura aceita por padrão, a escolhida nas duas réguas e a classificada pela régua completa.
    private func advanceAfterGeometry() {
        measuredRasterBytesPerSecond = nil
        verticalRasterScale = nil
        advance(to: .ready(.rasterThroughput))
    }

    /// "Saiu do tamanho certo": a leitura nominal da tira, sem régua na mão.
    ///
    /// Existe porque exigir a régua de quem já viu a tira sair inteira é cobrar trabalho para
    /// confirmar o caso comum — e porque uma leitura apressada de 46 em vez de 48 mm gravaria
    /// compensação numa impressora que não precisa dela, esticando a foto dela em 4%.
    public func answerRasterThroughputPrintedInFull() throws {
        try answer(
            .rasterThroughput(
                printedLengthMillimetres: PrinterProbePayloads.rasterThroughputStripMillimetres
            )
        )
    }

    /// Sai do passo sem medida, e o perfil fica **sem compensação** — o raster de hoje, inteiro.
    ///
    /// Este é o único passo do assistente que pede uma régua **de fora**: os outros se leem na
    /// própria tira, comparando o que saiu com o que a tira anuncia. Quem não tem régua na mão não
    /// pode ficar preso aqui, e muito menos ser empurrado a chutar um número — um chute vira fator
    /// gravado, e fator errado deforma toda imagem daquela impressora.
    ///
    /// **Nulo é nulo.** Não existe valor "padrão" numérico nem marcador dizendo que alguém pulou: o
    /// perfil que sai daqui é indistinguível, campo a campo, de um perfil que nunca viu esta sonda.
    /// Diferente de `skipCutFeedMeasurement()`, que grava o palpite de outra bancada: ali o campo é
    /// obrigatório e um valor precisa existir; aqui a ausência **é** a resposta.
    public func skipRasterThroughputMeasurement() throws {
        guard state == .awaitingResponse(.rasterThroughput) else {
            throw PrinterHomologationMachineError.invalidState
        }
        verticalRasterScale = nil
        advanceAfterRasterThroughput()
    }

    /// Sai do passo sem medida, e o perfil fica com os **dois** campos ausentes.
    ///
    /// É o "não consigo dizer" da tira: quem não sabe se aquilo era um código ou um monte de letras
    /// não pode ser empurrado a escolher, porque um palpite vira capacidade gravada — e capacidade
    /// gravada errada faz o app oferecer o comando nativo numa firmware que imprime o payload como
    /// texto no meio do cupom.
    ///
    /// **Nulo é nulo**, como em `skipRasterThroughputMeasurement()`: o perfil que sai daqui é
    /// indistinguível, campo a campo, de um perfil que nunca viu esta sonda.
    public func skipNativeCodeMeasurement() throws {
        guard state == .awaitingResponse(.nativeCode) else {
            throw PrinterHomologationMachineError.invalidState
        }
        nativeQrHonored = nil
        nativeBarcodeHonored = nil
        advance(to: .ready(.cutProtocol))
    }

    /// Toda saída da vazão passa por aqui, e o próximo passo é o do código nativo.
    ///
    /// Os dois campos são zerados na entrada pelo mesmo motivo que a vazão zera o fator: o passo
    /// que abre ainda não mediu nada, e um valor sobrevivente de uma passagem anterior seria
    /// medição de outra tira.
    private func advanceAfterRasterThroughput() {
        nativeQrHonored = nil
        nativeBarcodeHonored = nil
        // Série sem tira honesta de código nativo **não abre a etapa**, e os dois campos ficam
        // ausentes — a mesma ausência de `skipNativeCodeMeasurement()`, que quer dizer "ninguém
        // mediu". No dialeto Procomp `ESC ( k` e `ESC | 0` estão no manual e nunca saíram em papel;
        // perguntar por eles ali não custa uma tira torta, custa o aparelho travado.
        guard probeSet.measuresNativeCode else {
            advance(to: .ready(.cutProtocol))
            return
        }
        advance(to: .ready(.nativeCode))
    }

    /**
     Toda saída do avanço passa por aqui, e o próximo passo é o da página — quando ele existe.

     **Série sem tira de página conclui a medição aqui.** É o caso do dialeto Procomp: `procompText`
     codifica na tabela de fábrica da firmware e **não consulta** a página do perfil, então a tira
     produziria uma resposta que o emissor descarta. Os dois campos que `measuredProfile()` exige
     ficam com o mesmo valor que o campo da máquina Kotlin já tem por padrão — `.ascii` e página
     nula —, e eles são inertes neste caminho: nada em ``ReceiptLayout/text(_:alignment:bold:size:)``
     os lê no ramo Procomp. Gravar outra coisa seria afirmar uma escolha que este dialeto não faz.
     */
    private func advanceAfterCutFeed() {
        guard probeSet.measuresCodePage else {
            textEncoding = .ascii
            codePage = nil
            codePageSelector = nil
            answeredCodePage = true
            advance(to: .done)
            return
        }
        advance(to: .ready(.codePage))
    }

    /**
     Traduz régua em fator de compensação vertical, sem consultar marca nem modelo.

     A proporção entre o que saiu e a altura declarada da tira é **quanto do raster esta firmware
     imprime**. Se saiu inteira, não há o que compensar e o perfil segue `nil` — byte a byte como
     sempre foi. Se encolheu, é essa proporção que o perfil grava, e o emissor passa a mandar
     `1/proporção` linhas para o papel sair na altura pretendida.

     **Por que a conclusão mudou em 20/08.** Até aquela tarde esta conta produzia um teto de vazão.
     A bancada mediu e refutou: a mesma imagem de 45,7 KB sai com 97 mm na GoldenSky MTP-II e com
     80 mm na Inico T210, pelo mesmo caminho e no mesmo aparelho, e mudar o teto — sem teto,
     32 KB/s, 4 KB/s — não mudou nem a velocidade nem o defeito. Cobertura, banda, MTU e modo de
     escrita caíram do mesmo jeito, um a um. O que sobrou é uma firmware que encolhe raster largo
     por um fator constante, e fator constante se compensa. A tira e a pergunta não mudaram: mudou
     o que se conclui delas.

     **Os números, e por quê.**

     `0,97` é o piso do "saiu inteira". Numa tira de 48 mm ele cai em 46,6 mm, ou seja, tolera o
     ±1 mm de quem lê uma régua comum sem tolerar o defeito, que encurta mais de dez milímetros.
     Acima dele o perfil fica sem fator, e não com fator 0,98: compensação de 2% é ruído de régua
     virando alteração permanente de imagem.

     **Não há margem de segurança, e a ausência é deliberada.** O teto tinha uma, de 0,90, porque um
     teto errado para cima devolvia o defeito e errar para baixo só custava segundos. Aqui a
     assimetria não existe: compensar 10% a mais estica a foto tanto quanto compensar 10% a menos a
     encolhe. A compensação quer o fator **medido**, não um chute conservador.

     O travamento na faixa fecha o que o campo do perfil aceita, para uma leitura absurda parar aqui
     em vez de derrubar a gravação lá no fim, depois de a pessoa ter gasto a bobina inteira.
     */
    private func answerRasterThroughput(printedLengthMillimetres: Int) throws {
        let expected = PrinterProbePayloads.rasterThroughputStripMillimetres
        guard (1...expected).contains(printedLengthMillimetres) else {
            throw PrinterHomologationMachineError.invalidResponse
        }
        let ratio = Double(printedLengthMillimetres) / Double(expected)
        if ratio >= Self.healthyRasterRatio {
            verticalRasterScale = nil
        } else {
            let allowed = ReceiptLayout.allowedVerticalRasterScale
            verticalRasterScale = min(max(ratio, allowed.lowerBound), allowed.upperBound)
        }
        advanceAfterRasterThroughput()
    }

    /// Único caminho de avanço: publica o novo estado e guarda o passo que fica para trás.
    ///
    /// Concentrar as decisões aqui é o que garante que todo passo alcançado tenha uma fotografia
    /// anterior para `goBack()` restaurar — inclusive os que uma resposta atravessa sem imprimir,
    /// como o avanço de quem não tem guilhotina.
    private func advance(to newState: PrinterHomologationState) {
        let leaving = stepEntry
        state = newState
        previousSteps.append(leaving)
        stepEntry = captureStepEntry()
    }

    private func captureStepEntry() -> StepEntry {
        StepEntry(
            state: state,
            paperWidth: paperWidth,
            printableColumns: printableColumns,
            printableDots: printableDots,
            textEncoding: textEncoding,
            codePage: codePage,
            codePageSelector: codePageSelector,
            cutModeHonored: cutModeHonored,
            answeredCodePage: answeredCodePage,
            cutProtocol: cutProtocol,
            cutFeedLines: cutFeedLines,
            cutterAnswer: cutterAnswer,
            cutAttempt: cutAttempt,
            classifyWidthFromFullRuler: classifyWidthFromFullRuler,
            measuredRasterBytesPerSecond: measuredRasterBytesPerSecond,
            verticalRasterScale: verticalRasterScale,
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored,
            benchReadyForCutFeed: benchReadyForCutFeed,
            currentCutProbeProtocol: currentCutProbeProtocol,
            usesAdvancedCutProtocolProbe: usesAdvancedCutProtocolProbe,
            usesCutFeedRuler: usesCutFeedRuler,
            cutMeasurementFailed: cutMeasurementFailed
        )
    }

    private func restore(_ entry: StepEntry) {
        state = entry.state
        paperWidth = entry.paperWidth
        printableColumns = entry.printableColumns
        printableDots = entry.printableDots
        textEncoding = entry.textEncoding
        codePage = entry.codePage
        codePageSelector = entry.codePageSelector
        cutModeHonored = entry.cutModeHonored
        answeredCodePage = entry.answeredCodePage
        cutProtocol = entry.cutProtocol
        cutFeedLines = entry.cutFeedLines
        cutterAnswer = entry.cutterAnswer
        cutAttempt = entry.cutAttempt
        classifyWidthFromFullRuler = entry.classifyWidthFromFullRuler
        // A fotografia é do instante em que o passo abriu, antes de a tira sair: reabrir o passo
        // devolve a máquina sem medida e sem fator, e o número novo virá da tira nova.
        measuredRasterBytesPerSecond = entry.measuredRasterBytesPerSecond
        verticalRasterScale = entry.verticalRasterScale
        // Mesma regra: reabrir o passo devolve a máquina sem as duas respostas, e as novas virão da
        // tira nova. Voltar não pode preservar a medição da premissa que está sendo corrigida.
        nativeQrHonored = entry.nativeQrHonored
        nativeBarcodeHonored = entry.nativeBarcodeHonored
        // A fotografia é do instante em que o passo abriu, quando a bancada ainda não tinha sido
        // confirmada: reabrir o avanço volta a pedir a decisão sobre as oito tiras.
        benchReadyForCutFeed = entry.benchReadyForCutFeed
        currentCutProbeProtocol = entry.currentCutProbeProtocol
        usesAdvancedCutProtocolProbe = entry.usesAdvancedCutProtocolProbe
        usesCutFeedRuler = entry.usesCutFeedRuler
        cutMeasurementFailed = entry.cutMeasurementFailed
        stepEntry = entry
    }

    /// A máquina inteira no instante em que um passo abriu, antes de a resposta dele existir.
    private struct StepEntry {
        var state: PrinterHomologationState = .ready(.geometry)
        var paperWidth: PrinterPaperWidth?
        var printableColumns: Int?
        var printableDots: Int?
        var textEncoding: ThermalTextEncoding?
        var codePage: ThermalCodePage?
        var codePageSelector: UInt8?
        var cutModeHonored = false
        var answeredCodePage = false
        var cutProtocol: CutProtocol?
        var cutFeedLines: Int?
        var cutterAnswer: PrinterCutterAnswer?
        var cutAttempt = 0
        var classifyWidthFromFullRuler = false
        var measuredRasterBytesPerSecond: Int?
        var verticalRasterScale: Double?
        var nativeQrHonored: Bool?
        var nativeBarcodeHonored: Bool?
        var benchReadyForCutFeed = false
        var currentCutProbeProtocol: CutProtocol?
        var usesAdvancedCutProtocolProbe = false
        var usesCutFeedRuler = false
        var cutMeasurementFailed = false
    }

    public func measuredProfile(id: UUID = UUID(), measuredAt: Date = Date()) throws -> MeasuredProfile {
        guard state == .done, let paperWidth, let printableColumns, let printableDots,
              let textEncoding, answeredCodePage, let cutProtocol, let cutFeedLines
        else { throw PrinterHomologationMachineError.incompleteProfile }
        return try MeasuredProfile(
            id: id,
            displayName: displayName,
            measuredAt: measuredAt,
            transports: transports,
            paperWidth: paperWidth,
            printableColumns: printableColumns,
            printableDots: printableDots,
            codePage: codePage,
            textEncoding: textEncoding,
            codePageSelector: codePageSelector,
            cutProtocol: cutProtocol,
            cutModeHonored: cutModeHonored,
            cutFeedLines: cutFeedLines,
            tcpPort: tcpPort,
            // Só a régua desta impressora produz este fator. Perfil homologado antes da sonda
            // continua sem compensação até ser remedido; nada aqui completa a lacuna sozinho. O
            // teto de vazão não é mais concluído por sonda nenhuma desde 20/08, e por isso nem
            // aparece aqui: perfil novo nasce sem teto.
            verticalRasterScale: verticalRasterScale,
            // Só a tira desta impressora produz estes dois campos. Perfil homologado antes da sonda
            // continua com os dois ausentes até ser remedido, e nada aqui — marca, modelo, firmware
            // ou dialeto — completa a lacuna por conta própria.
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored,
            // O dialeto que mediu é o dialeto que fica. Sem esta linha o perfil nascia
            // `.epsonCompatible` mesmo depois de a série Procomp ter saído no papel, e a impressora
            // homologada voltava a falar ESC/POS no primeiro cupom depois de adotada.
            dialect: dialect
        )
    }
}

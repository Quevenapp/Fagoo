import Foundation

/**
 Por que uma sonda não concluiu — e, quando o transporte sabe, se ela chegou a escrever.

 **Os três casos são a mesma divisão de ``ThermalPrintDelivery``, mais a recusa anterior a qualquer
 transporte.** Ela existe aqui porque os dois transportes já a carregam e ela era descartada
 exatamente nesta fronteira: ``BluetoothPrinterTransporting/send(_:to:completion:)`` devolve
 ``ThermalPrintResult``, que traz `delivery`, e ``LocalWifiPrinterTransportError`` publica
 `delivery` desde sempre. Colapsar os dois em "falhou" é a classe de erro medida em 21/08/2026, com
 socket morto tratado como falha da sonda: quem lê só "falhou" não pode dizer se reenviar é seguro.
 */
public enum PrinterProbeFailure: Equatable, Sendable {
    /// A escrita não começou. Nada chegou à impressora, e reenviar é seguro.
    /// Corresponde a ``ThermalPrintDelivery/notSent``.
    case unavailable

    /// A escrita começou e o desfecho não é afirmável daqui.
    /// Corresponde a ``ThermalPrintDelivery/indeterminate``, e **nunca autoriza reenvio
    /// automático** — a regra do AGENTS.md vale igual para sonda e para cupom.
    case interrupted

    /// Não havia remetente algum: nem candidata retida, nem impressora instalada e pronta. É a
    /// recusa do próprio agregado, anterior a qualquer transporte, e o único caso em que
    /// ``ThermalPrinterConfiguration/sendEphemeralCommand(_:fallingBackToAdopted:completion:)``
    /// devolve `false`.
    case rejected
}

extension PrinterProbeFailure {
    /// Do que o transporte mediu para o que a sonda publica. `rejected` não nasce daqui: ele é
    /// anterior ao transporte.
    static func from(_ delivery: ThermalPrintDelivery) -> PrinterProbeFailure {
        switch delivery {
        case .notSent: return .unavailable
        case .indeterminate: return .interrupted
        }
    }
}

public enum PrinterProbeSendResult: Equatable, Sendable {
    case success
    case failure(PrinterProbeFailure)
}

/// Ponte mínima para a homologação. A candidata fica retida apenas pelo adapter em memória e o
/// callback é o do transporte real; a sessão não chama `print` nem `test` da venda.
public protocol PrinterProbeSending: AnyObject {
    var transport: PrinterTransport { get }
    var canReadIdentity: Bool { get }
    func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void)

    /// Nome que o próprio aparelho anunciou, quando existe. Batiza o perfil medido no lugar de
    /// "Impressora temporária" — nome que nem é temporário nem distingue duas do mesmo tamanho.
    var declaredName: String? { get }

    func readIdentity(completion: @escaping (PrinterDeclaredIdentity?) -> Void)
}

public extension PrinterProbeSending {
    var canReadIdentity: Bool { false }
    /// Wi-Fi não carrega nome no fio: quem nomeia ali é o `GS I`, se a firmware responder.
    var declaredName: String? { nil }
    func readIdentity(completion: @escaping (PrinterDeclaredIdentity?) -> Void) { completion(nil) }
}

public final class BluetoothPrinterProbeSender: PrinterProbeSending, CustomStringConvertible {
    public let transport = PrinterTransport.bluetooth
    private let printerTransport: any BluetoothPrinterTransporting
    private let candidate: BluetoothPrinterCandidate

    public init(
        transport: any BluetoothPrinterTransporting,
        candidate: BluetoothPrinterCandidate
    ) {
        printerTransport = transport
        self.candidate = candidate
    }

    public var declaredName: String? { candidate.declaredName }

    public func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void) {
        printerTransport.send(bytes, to: candidate) { result in
            switch result {
            case .delivered:
                completion(.success)
            case .failed(_, let delivery):
                // A mensagem do transporte não é repassada: ela pode nomear a candidata. O que
                // sobe é só a divisão que o BLE já mede — falha antes da primeira escrita contra
                // queda depois dela.
                completion(.failure(.from(delivery)))
            }
        }
    }

    public var description: String { "BluetoothPrinterProbeSender(candidate=[REDACTED])" }
}

public final class LocalWifiPrinterProbeSender: PrinterProbeSending, CustomStringConvertible {
    public let transport = PrinterTransport.localWifi
    public let canReadIdentity = true
    private let printerTransport: any LocalWifiPrinterTransport
    private let endpoint: LocalWifiPrinterEndpoint

    public init(
        transport: any LocalWifiPrinterTransport,
        endpoint: LocalWifiPrinterEndpoint
    ) {
        printerTransport = transport
        self.endpoint = endpoint
    }

    public func sendProbe(_ bytes: Data, completion: @escaping (PrinterProbeSendResult) -> Void) {
        let printerTransport = printerTransport
        let endpoint = endpoint
        Task {
            do {
                try await printerTransport.send(bytes, to: endpoint)
                completion(.success)
            } catch let error as LocalWifiPrinterTransportError {
                // O erro do sistema não é repassado: ele pode carregar detalhes do endpoint. O que
                // sobe é só a divisão que o próprio transporte já publica em `delivery`.
                completion(.failure(.from(error.delivery)))
            } catch {
                // Erro que o transporte não tipou: conta como escrita começada, que é o lado
                // seguro. Dizer "não saiu" quando saiu faria reenviar um quadro que já gravou; o
                // contrário custa uma olhada no papel, que é o comprovante de qualquer jeito.
                completion(.failure(.interrupted))
            }
        }
    }

    public func readIdentity(completion: @escaping (PrinterDeclaredIdentity?) -> Void) {
        let printerTransport = printerTransport
        let endpoint = endpoint
        Task { completion(await printerTransport.readIdentity(from: endpoint)) }
    }

    public var description: String { "LocalWifiPrinterProbeSender(endpoint=[REDACTED])" }
}

public enum PrinterHomologationSessionState: Equatable, Sendable {
    case homologating(PrinterHomologationState)
    case finalReceiptReady
    case sendingFinalReceipt
    case awaitingFinalConfirmation
    case finalReceiptFailed
    case finished(MeasuredProfile)
}

public enum PrinterHomologationSessionError: Error, Equatable, LocalizedError {
    case sendFailed
    case persistenceFailed
    case confirmationFailed

    /**
     Os bytes desta sonda foram montados em outro dialeto, e **nada saiu para a impressora**.

     **Por que este caso mora aqui, e não em ``PrinterProbeFailure``.** O espelho exato do Kotlin
     seria `ThermalPrinterState.DialectNotSupported`, isto é, um caso novo no enum de falha da sonda
     — e `Printher/PrinterWifiSetupContract.swift` faz um `switch` exaustivo sobre
     ``PrinterProbeFailure`` sem `default`, num arquivo fora do escopo deste lote. Um caso novo lá
     quebraria a compilação do alvo `Printher`. Aqui a recusa é do agregado, é anterior a qualquer
     transporte, e é isso que a mensagem diz em letra.
     */
    case dialectNotSupported

    public var errorDescription: String? {
        switch self {
        case .sendFailed: return "A sonda não foi concluída. Nada será repetido automaticamente."
        case .persistenceFailed: return "O perfil não pôde ser salvo. A impressora ainda não foi adotada."
        case .confirmationFailed: return "A seleção salva não pôde ser confirmada. A impressora ainda não foi adotada."
        case .dialectNotSupported:
            return "Esta sonda foi montada em outro dialeto e não sai para esta impressora. Nada foi enviado a ela."
        }
    }
}

@MainActor
public final class PrinterHomologationSession: ObservableObject {
    @Published public private(set) var state: PrinterHomologationSessionState
    @Published public private(set) var lastError: PrinterHomologationSessionError?
    @Published public private(set) var declaredIdentity: PrinterDeclaredIdentity?
    @Published public private(set) var identityReadCompleted = false

    public let machine: PrinterHomologationMachine
    private let sender: any PrinterProbeSending
    private let profileStore: PrinterProfileStore
    private let selectionStore: any PrinterSelectionStoring
    private let runtimeAdopter: ((MeasuredProfile) -> Bool)?
    private let onAdoptionCommitted: (() -> Void)?
    /// Decoração do hospedeiro, e **só para o comprovante final**.
    ///
    /// As tiras saem por `sendCurrentProbe`, que emite bytes de `PrinterProbePayloads` sem layout
    /// nenhum: elas não têm por onde receber decoração, e é assim que fica. Tira é instrumento de
    /// medida — um raster do hospedeiro no meio da régua de geometria desloca o que ela mede, e
    /// uma linha a mais na tira de avanço muda a distância que ela existe para medir.
    private let receiptDecoration: (any ReceiptDecoration)?
    private var finalProfile: MeasuredProfile?

    /// Relógio do envio, e o mínimo que o transporte precisava expor.
    ///
    /// A vazão é medida onde o transporte realmente começa e termina: do instante em que os bytes
    /// são entregues a ele até o desfecho que ele devolve no callback. Nenhuma sonda supõe vazão —
    /// a sonda de vazão lê este número.
    ///
    /// **O que ele inclui, e por que isso é o lado seguro.** A janela de dreno de 1,5 s do BLE
    /// conta como tempo de envio, então o número sai igual ou **menor** que a taxa instantânea do
    /// enlace. Teto medido para baixo imprime devagar; medido para cima devolve o descarte de
    /// linha. É argumento porque a suíte precisa exercer o ritmo sem esperar de verdade.
    private let now: () -> TimeInterval

    /**
     O dialeto **do alvo** — a língua que a impressora do outro lado do fio fala.

     Ele chega independentemente do dialeto da máquina, e é essa independência que torna a
     comparação capaz de discordar. Ver ``send(_:then:)``.
     */
    public let dialect: EscPosDialect

    /// - Parameter dialect: o dialeto do alvo. Fica por último e com padrão pela convenção do kit;
    ///   o padrão é o ESC/POS de sempre, para nenhum chamador de fora precisar mudar.
    public init(
        machine: PrinterHomologationMachine,
        sender: any PrinterProbeSending,
        profileStore: PrinterProfileStore,
        selectionStore: any PrinterSelectionStoring,
        receiptDecoration: (any ReceiptDecoration)? = nil,
        runtimeAdopter: ((MeasuredProfile) -> Bool)? = nil,
        onAdoptionCommitted: (() -> Void)? = nil,
        now: @escaping () -> TimeInterval = { Date().timeIntervalSinceReferenceDate },
        dialect: EscPosDialect = .epsonCompatible
    ) {
        self.now = now
        self.dialect = dialect
        self.machine = machine
        self.sender = sender
        self.profileStore = profileStore
        self.selectionStore = selectionStore
        self.receiptDecoration = receiptDecoration
        self.runtimeAdopter = runtimeAdopter
        self.onAdoptionCommitted = onAdoptionCommitted
        state = .homologating(machine.state)
    }

    public func selectPaperWidth(_ width: PrinterPaperWidth) throws {
        try machine.selectPaperWidth(width)
        refreshMachineState()
    }

    public func selectPaperWidthUsingDefaults(_ width: PrinterPaperWidth) throws {
        try machine.selectPaperWidthUsingDefaults(width)
        refreshMachineState()
    }

    public func selectPaperWidthFromPrintedRulers(_ width: PrinterPaperWidth) throws {
        try machine.selectPaperWidthFromPrintedRulers(width)
        refreshMachineState()
    }

    public func selectNoPaperWidthFromPrintedRulers() throws {
        try machine.selectNoPaperWidthFromPrintedRulers()
        refreshMachineState()
    }

    /**
     Recusa uma sonda cujos bytes não falam a língua do alvo — e **não manda nada ao transporte**.

     **A pergunta mudou, e a antiga acertava por acaso.** O portão do Kotlin olhava só o alvo: "esta
     impressora fala ESC/POS?". Com uma série de sondas só, isso bastava — todo byte de homologação
     era ESC/POS, então recusar o alvo era recusar os bytes. Com duas séries a pergunta certa é
     outra: **estes bytes falam a língua desta impressora?** A anterior teria recusado a série
     Procomp pelo mesmo portão que existe para protegê-la, e deixaria a série ESC/POS alcançar uma
     IM453H se alguém trocasse o portão de lugar.

     O que a recusa evita é o que a bobina de 24/08/2026 pagou: numa firmware sem **nenhum** comando
     `GS`, a régua raster do passo de geometria sai como dois metros de código e o aparelho para de
     responder até desligar e ligar. Não é papel: é a impressora parada até alguém ir fisicamente
     até ela.

     **A máquina já saiu de `ready` quando esta pergunta é feita, e isso é deliberado.** Quem monta a
     sonda é ela, e só depois de montada os bytes têm dialeto — perguntar antes seria voltar à
     pergunta velha, a do alvo. A recusa então fecha o passo em `failed`, que é a verdade sobre o
     papel: a tira não saiu, e ``retryAfterFailure()`` continua sendo o caminho de quem quer tentar
     de novo.

     ``ThermalPrinterConfiguration/sendEphemeralCommand(_:fallingBackToAdopted:completion:)`` — o
     caminho de bytes crus — **não** passa por esta recusa, de propósito: ele existe para as sondas
     de bancada, montadas no dialeto certo por quem as escreve.
     */
    @discardableResult
    private func send(
        _ probe: PrinterProbe,
        then completion: @escaping (PrinterProbeSendResult) -> Void
    ) -> Bool {
        guard probe.dialect == dialect else {
            lastError = .dialectNotSupported
            return false
        }
        sender.sendProbe(probe.bytes, completion: completion)
        return true
    }

    /// Fecha o passo que a máquina abriu para uma tira que não vai sair. Ver ``send(_:then:)``.
    private func closeRefusedProbeStep() {
        try? machine.sendingCompleted(success: false)
        refreshMachineState()
    }

    public func sendPaperWidthRulers() throws {
        let payload = try machine.beginPaperWidthRulers()
        lastError = nil
        refreshMachineState()
        let saiu = send(payload) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                do {
                    try self.machine.sendingCompleted(success: result == .success)
                    if result != .success { self.lastError = .sendFailed }
                    self.refreshMachineState()
                } catch {
                    self.lastError = .sendFailed
                }
            }
        }
        if !saiu { closeRefusedProbeStep() }
    }

    public func answerCutterQuestion(_ answer: PrinterCutterAnswer) throws {
        try machine.answerCutterQuestion(answer)
        refreshMachineState()
    }

    public func useAdvancedCutProtocolProbe() throws {
        try machine.useAdvancedCutProtocolProbe()
        refreshMachineState()
    }

    public func retryCutWithAdvancedProbe() throws {
        try machine.retryCutWithAdvancedProbe()
        refreshMachineState()
    }

    /// Verdadeiro enquanto a série de tiras de corte ainda tem dialeto a imprimir.
    private var sweepingCutProbes = false

    public func sendCurrentProbe() throws {
        let probe = try machine.beginSending()
        lastError = nil
        refreshMachineState()
        let size = probe.size
        let startedAt = now()
        let saiu = send(probe) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                do {
                    // A vazão vem do transporte, do envio que acabou de terminar. A máquina não tem
                    // relógio e não inventa número nenhum: ela recebe o que foi medido, ou `nil`.
                    try self.machine.sendingCompleted(
                        success: result == .success,
                        measuredBytesPerSecond: self.bytesPerSecond(bytes: size, since: startedAt)
                    )
                    if result != .success { self.lastError = .sendFailed }
                    self.refreshMachineState()
                    self.continueCutSweepIfNeeded(lastSendSucceeded: result == .success)
                } catch {
                    self.lastError = .sendFailed
                }
            }
        }
        if !saiu {
            // A varredura de corte também para aqui: ela anda pelo callback do transporte, e não
            // houve transporte nenhum.
            sweepingCutProbes = false
            closeRefusedProbeStep()
        }
    }

    private func bytesPerSecond(bytes: Int, since startedAt: TimeInterval) -> Int? {
        let elapsed = now() - startedAt
        guard bytes > 0, elapsed > 0 else { return nil }
        let rate = Double(bytes) / elapsed
        guard rate >= 1 else { return nil }
        return rate >= Double(Int.max) ? Int.max : Int(rate)
    }

    public func answer(_ response: PrinterHomologationResponse) throws {
        try machine.answer(response)
        refreshMachineState()
    }

    public func confirmBenchReadyForCutFeed() throws {
        try machine.confirmBenchReadyForCutFeed()
        refreshMachineState()
    }

    public func skipCutFeedMeasurement() throws {
        try machine.skipCutFeedMeasurement()
        refreshMachineState()
    }

    /// "Saiu do tamanho certo": a leitura nominal da tira de vazão, sem régua na mão.
    public func answerRasterThroughputPrintedInFull() throws {
        try machine.answerRasterThroughputPrintedInFull()
        refreshMachineState()
    }

    /// "Não consigo dizer": a tira saiu, ninguém soube ler, e o perfil fica sem as duas respostas.
    public func skipNativeCodeMeasurement() throws {
        try machine.skipNativeCodeMeasurement()
        refreshMachineState()
    }

    /// "Usar padrão": sem régua, sem medida e sem teto — o ritmo de hoje, sem regressão.
    public func skipRasterThroughputMeasurement() throws {
        try machine.skipRasterThroughputMeasurement()
        refreshMachineState()
    }

    /// Imprime todos os dialetos de corte, um payload por vez, e só então abre a escolha.
    ///
    /// Cada comando continua sozinho no seu envio — é isso que faz uma falha identificar qual
    /// dialeto quebrou —, mas não há mais pergunta entre as tiras: quem escolhe precisa das tiras
    /// lado a lado. A série anda pelo callback do transporte, nunca por cronômetro, e uma falha a
    /// interrompe onde parou.
    public func sendAllCutProbes() throws {
        sweepingCutProbes = true
        do {
            try sendCurrentProbe()
        } catch {
            sweepingCutProbes = false
            throw error
        }
    }

    private func continueCutSweepIfNeeded(lastSendSucceeded: Bool) {
        guard sweepingCutProbes else { return }
        guard lastSendSucceeded, case .awaitingResponse(.cutProtocol) = machine.state,
              machine.currentCutProbeProtocol != nil
        else {
            sweepingCutProbes = false
            return
        }
        do {
            try machine.advanceCutProbe()
            refreshMachineState()
            guard machine.state == .ready(.cutProtocol) else {
                sweepingCutProbes = false
                return
            }
            try sendCurrentProbe()
        } catch {
            sweepingCutProbes = false
            lastError = .sendFailed
        }
    }

    public func completeCutFeedWithoutProbe() throws {
        try machine.completeCutFeedWithoutProbe()
        refreshMachineState()
    }

    public func retryAfterFailure() throws {
        try machine.retryAfterFailure()
        lastError = nil
        refreshMachineState()
    }

    /// Passo que `goBack()` reabre, e se refazê-lo manda tiras ao papel de novo.
    public var previousStep: PrinterHomologationStep? { machine.previousStep }

    /// O retrocesso vale enquanto a instalação não foi confirmada.
    ///
    /// Medir e conferir o comprovante final são a mesma decisão vista de dois lados: a letra de
    /// acento escolhida na tira só se prova no comprovante, e quem lê ali que escolheu errado
    /// precisa poder corrigir **antes** de responder "saiu certo". Depois da confirmação não volta —
    /// instalação concluída é concluída, e o perfil já está no disco. Envio no ar e falha pendente
    /// continuam de fora: primeiro se decide sobre o papel que talvez tenha saído.
    public var canGoBack: Bool {
        switch state {
        case .homologating, .finalReceiptReady, .awaitingFinalConfirmation:
            return machine.canGoBack
        case .sendingFinalReceipt, .finalReceiptFailed, .finished:
            return false
        }
    }

    public var backReprintsProbes: Bool { machine.backReprintsProbes }

    /// Desfaz uma decisão da medição, na máquina, sem mandar byte nenhum.
    ///
    /// A reimpressão das tiras do passo reaberto acontece quando a pessoa avançar por ele de novo,
    /// pelo caminho normal — voltar nunca imprime sozinho.
    ///
    /// Voltar do comprovante final descarta o rascunho junto: ele foi montado a partir da resposta
    /// que está sendo desfeita, e `preparedFinalProfile()` devolve o que estiver guardado — sem
    /// descartar, a segunda passagem por `done` reaproveitaria o perfil da letra errada. Nada foi
    /// persistido até a confirmação, então não há o que desfazer no disco.
    public func goBack() throws {
        guard canGoBack else { throw PrinterHomologationMachineError.invalidState }
        try machine.goBack()
        finalProfile = nil
        lastError = nil
        refreshMachineState()
    }

    public func sendFinalReceipt() throws {
        guard state == .finalReceiptReady else {
            throw PrinterHomologationMachineError.invalidState
        }
        let profile = try preparedFinalProfile()
        state = .sendingFinalReceipt
        lastError = nil
        // **A identidade não é perguntada a quem não fala a língua da pergunta.** `GS I` é comando
        // `GS`, e a IM453H não tem nenhum; `LocalWifiPrinterProbeSender` declara `canReadIdentity`
        // sem olhar perfil algum, então o transporte dispararia `1D 49 41/42/43` por um caminho que
        // não passa por sonda nenhuma. `nil` aqui é "não perguntada", e a folha do dialeto Procomp
        // diz isso em letra em vez de "não respondeu" — ver ``ProcompHomologationProbes/identityUnasked``.
        guard sender.canReadIdentity,
              EscPosDialectGate.usesEscPosIdentityQuery(dialect),
              !identityReadCompleted
        else {
            identityReadCompleted = true
            sendPreparedFinalReceipt(profile)
            return
        }
        sender.readIdentity { [weak self] identity in
            Task { @MainActor in
                guard let self else { return }
                self.declaredIdentity = identity
                self.identityReadCompleted = true
                let identified = try? self.profile(profile, applying: identity)
                self.finalProfile = identified ?? profile
                self.sendPreparedFinalReceipt(self.finalProfile ?? profile)
            }
        }
    }

    /// O comprovante final sai pela **série desta medição**, e não por uma cópia local dela: no
    /// dialeto Procomp ele é composto pelo ``ReceiptLayout``, como o cupom de venda, enquanto
    /// ``PrinterProbePayloads/finalReceipt(profile:identity:transport:decoration:)`` abre em `ESC @`
    /// e emite cada linha por ``EscPos/text(_:alignment:bold:size:codePage:codePageSelector:textEncoding:)``
    /// direto — nem a metade que o layout sabe traduzir chegaria traduzida.
    private func sendPreparedFinalReceipt(_ profile: MeasuredProfile) {
        // Série e perfil discordando de dialeto é erro de fiação, e ele chega aqui como recusa —
        // não como `precondition`, que derrubaria o app do balcão. Ver
        // ``ProcompHomologationProbeSet/finalReceipt(profile:identity:transport:decoration:)``.
        guard let comprovante = machine.finalReceipt(
            profile: profile,
            identity: declaredIdentity,
            transport: sender.transport,
            decoration: receiptDecoration
        ) else {
            lastError = .sendFailed
            state = .finalReceiptFailed
            return
        }
        let saiu = send(comprovante) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                if result == .success {
                    self.state = .awaitingFinalConfirmation
                } else {
                    self.lastError = .sendFailed
                    self.state = .finalReceiptFailed
                }
            }
        }
        if !saiu { state = .finalReceiptFailed }
    }

    private func profile(
        _ profile: MeasuredProfile,
        applying identity: PrinterDeclaredIdentity?
    ) throws -> MeasuredProfile {
        guard let identity else { return profile }
        let named = identity.displayName(or: profile.displayName)
        if let identified = try? MeasuredProfile.validated(
            id: profile.id,
            displayName: named,
            measuredAt: profile.measuredAt,
            source: profile.source,
            capabilities: profile.capabilities,
            firmwareVersion: identity.firmwareVersion
        ) {
            return identified
        }
        return try MeasuredProfile.validated(
            id: profile.id,
            displayName: profile.displayName,
            measuredAt: profile.measuredAt,
            source: profile.source,
            capabilities: profile.capabilities,
            firmwareVersion: identity.firmwareVersion
        )
    }

    /// Único ponto que grava. Chegar a DONE ou concluir o callback não prova papel; somente esta
    /// confirmação humana salva o UUID medido e troca a seleção para ele.
    /// O perfil que será adotado, para a tela mostrar e o teste conferir antes da gravação.
    public func previewFinalProfile() throws -> MeasuredProfile { try preparedFinalProfile() }

    /// Renomeia o perfil antes de adotar.
    ///
    /// O nome vinha do perfil de descoberta, e no Caminho B isso é "Impressora temporária" — que
    /// nem é temporário nem distingue duas impressoras do mesmo tamanho. Nomear no fim é quando a
    /// pessoa sabe qual é: acabou de ver o comprovante sair. Nome vazio ou só espaço mantém o
    /// anterior; a validação do `MeasuredProfile` continua recusando identificador técnico.
    public func renameFinalProfile(_ name: String) throws {
        guard state == .awaitingFinalConfirmation || state == .finalReceiptFailed else {
            throw PrinterHomologationMachineError.invalidState
        }
        let limpo = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !limpo.isEmpty else { return }
        let atual = try preparedFinalProfile()
        finalProfile = try MeasuredProfile.validated(
            id: atual.id,
            displayName: limpo,
            measuredAt: atual.measuredAt,
            source: atual.source,
            capabilities: atual.capabilities,
            firmwareVersion: atual.firmwareVersion
        )
    }

    public func confirmFinalReceipt() throws {
        guard state == .awaitingFinalConfirmation || state == .finalReceiptFailed else {
            throw PrinterHomologationMachineError.invalidState
        }
        let profile = try preparedFinalProfile()
        let previousProfile = profileStore.profile(id: profile.id)
        let previousSelections = selectionStore.read()
        var confirmingSelection = false
        do {
            try profileStore.save(profile)
            guard profileStore.profile(id: profile.id) == profile else {
                throw PrinterHomologationSessionError.persistenceFailed
            }
            confirmingSelection = true
            let selection: PersistedPrinterSelection = sender.transport == .localWifi
                ? .localWifi(profileId: profile.id)
                : .bluetooth(profileId: profile.id)
            if let runtimeAdopter {
                guard runtimeAdopter(profile) else {
                    throw PrinterHomologationSessionError.confirmationFailed
                }
            } else {
                selectionStore.save(selectionStore.read().with(selection))
                guard selectionStore.read().of(sender.transport) == selection else {
                    throw PrinterHomologationSessionError.confirmationFailed
                }
            }
            onAdoptionCommitted?()
            lastError = nil
            state = .finished(profile)
        } catch {
            rollback(
                profileID: profile.id,
                previousProfile: previousProfile,
                previousSelections: previousSelections
            )
            let mapped = (error as? PrinterHomologationSessionError)
                ?? (confirmingSelection ? .confirmationFailed : .persistenceFailed)
            lastError = mapped
            throw mapped
        }
    }

    /// Um comprovante final problemático não adota nem repete nada. A candidata e o rascunho
    /// continuam apenas nesta sessão para a pessoa decidir corrigir ou sair.
    public func rejectFinalReceipt() throws {
        guard state == .awaitingFinalConfirmation || state == .finalReceiptFailed else {
            throw PrinterHomologationMachineError.invalidState
        }
        lastError = nil
        state = .finalReceiptReady
    }

    private func preparedFinalProfile() throws -> MeasuredProfile {
        if let finalProfile { return finalProfile }
        let profile = try machine.measuredProfile()
        finalProfile = profile
        return profile
    }

    private func refreshMachineState() {
        state = machine.state == .done ? .finalReceiptReady : .homologating(machine.state)
    }

    /// Compensa qualquer gravação parcial antes de devolver a falha. O controller só promove sua
    /// candidata depois de reler a seleção, portanto uma closure que retorna `false` ainda deixa o
    /// runtime pendente e seguro para nova tentativa explícita.
    private func rollback(
        profileID: String,
        previousProfile: MeasuredProfile?,
        previousSelections: PersistedPrinterSelections
    ) {
        if let previousProfile {
            try? profileStore.save(previousProfile)
        } else {
            try? profileStore.remove(id: profileID)
        }
        selectionStore.save(previousSelections)
    }
}

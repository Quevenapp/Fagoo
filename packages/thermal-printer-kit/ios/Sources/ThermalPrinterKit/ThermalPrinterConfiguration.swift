import Combine
import Foundation

public enum InitialReceiptOutcome: Equatable, Sendable {
    case printedCorrectly
    case printedWithProblem
    case notPrinted
}

public enum InitialReceiptAction: Equatable, Sendable {
    case adopted
    case homologationRequired
    case discarded
    case temporaryProfileRequiresHomologation
}

/// Agregado neutro usado pelas duas Views públicas. Ele preserva os controllers M1 e apenas retém
/// o transporte/candidata necessários para o caminho novo de homologação.
@MainActor
public final class ThermalPrinterConfiguration: ObservableObject {
    public let coordinator: ThermalPrintingCoordinator
    public let localWifi: LocalWifiThermalPrinterController
    public let bluetooth: BluetoothThermalPrinterController
    public let profileStore: PrinterProfileStore

    /// Só fica verdadeiro depois do callback real do comprovante inicial ou de uma preparação
    /// explícita sobre a impressora já adotada. Reter uma candidata durante o envio não dá
    /// autoridade antecipada para homologação ou comando cru.
    public var hasEphemeralProbeTarget: Bool { confirmedProbeTarget != nil }

    /**
     Se existe alguém para receber um comando cru **agora** — a candidata efêmera ou, sem ela, a
     impressora instalada e alcançável no transporte ativo.

     É pergunta diferente de ``hasEphemeralProbeTarget``, e por isso é propriedade diferente.
     Aquela responde "há candidata retida em memória?", que é o que a configuração manual e o aviso
     de papel precisam saber; esta responde "dá para mandar bytes?", e as duas respostas deixaram de
     coincidir quando o comando cru ganhou a queda para a adotada, como no Android.

     Não muta `probeTarget` nem nenhum `@Published` do agregado, e precisa continuar assim: a
     tela lê isto de dentro do `body`, e preparar aqui mutaria estado publicado durante a
     atualização da View. Quem prepara é o envio. (Não é *livre de efeito*: a leitura desce ao
     store, e o do chaveiro descarta registro que não decodifica. Mas nada do que a View observa
     se move.)

     É cara o bastante para não ser lida duas vezes por desenho — leia uma vez no topo do `body`.
     */
    public var canSendEphemeralCommand: Bool { ephemeralCommandSender(fallingBackToAdopted: true) != nil }

    private struct ProbeTarget {
        enum Origin {
            case initialReceipt
            case adoptedPrinter
        }

        let id: UUID
        let sender: any PrinterProbeSending
        let profile: PrinterProfile
        let origin: Origin
        /**
         O perfil que a pessoa declarou nesta configuração e que **ainda não foi gravado**.

         O rascunho vive em memória até a confirmação humana do papel, como em qualquer outro
         caminho do kit. Gravar antes seria prometer no disco uma impressora que ninguém viu
         imprimir.
         */
        let declaredProfile: MeasuredProfile?
        /// Preenchido só quando a candidata é uma unidade que já está instalada. É o que separa
        /// "instalar" de "editar": editar regrava a mesma instalação, e não cria a segunda.
        let installationId: String?

        init(
            id: UUID,
            sender: any PrinterProbeSending,
            profile: PrinterProfile,
            origin: Origin,
            declaredProfile: MeasuredProfile? = nil,
            installationId: String? = nil
        ) {
            self.id = id
            self.sender = sender
            self.profile = profile
            self.origin = origin
            self.declaredProfile = declaredProfile
            self.installationId = installationId
        }
    }

    private let selectionStore: any PrinterSelectionStoring
    private let networkProvider: any LocalWifiPrinterNetworkProviding
    private let localWifiTransport: any LocalWifiPrinterTransport
    private let bluetoothTransport: any BluetoothPrinterTransporting
    /// Cabeçalho e rodapé do app hospedeiro. Entra uma vez aqui e alcança os dois transportes e o
    /// comprovante final da homologação; as tiras de sonda continuam de fora, de propósito.
    private let receiptDecoration: (any ReceiptDecoration)?
    /**
     O que o hospedeiro prefere para os códigos de cada impressora; `nil` mantém o padrão.

     Entra uma vez aqui e alcança os dois transportes, como a decoração. **O kit não lê preferência
     nenhuma**: quem guarda a escolha é o app, chaveada pelo `profileId`, e esta superfície não sabe
     o nome do recurso que recebeu. A trava por capacidade medida continua dentro do kit — o que
     chega por aqui é preferência, não autorização.
     */
    private let codeEmissionOverride: @Sendable (String) -> ThermalCodeEmissionPreferences?
    @Published private var probeTarget: ProbeTarget?
    private var observers: [AnyCancellable] = []

    /**
     - Parameters:
       - selectionStore: onde mora a impressora adotada.
       - profileStore: onde moram os perfis medidos.

     Os dois entram por aqui, e é este par que um app e sua extensão precisam compartilhar para
     enxergarem a **mesma** impressora. Não há caminho novo para isso: já eram injetáveis, e o que
     mudou foi cada store ganhar por onde apontar para o container comum.

     ```swift
     ThermalPrinterConfiguration(
         selectionStore: KeychainPrinterSelectionStore(accessGroup: grupoDoChaveiro),
         profileStore: PrinterProfileStore(
             dataStore: UserDefaultsPrinterProfileDataStore(suiteName: appGroup)!
         )
     )
     ```

     Compartilhar só um dos dois é pior que não compartilhar nenhum: a extensão acharia a
     impressora adotada e não o perfil dela, e imprimiria na largura conservadora — cupom estreito
     no papel largo, sem erro em lugar nenhum.
     */
    public init(
        selectionStore: any PrinterSelectionStoring = KeychainPrinterSelectionStore(),
        profileStore: PrinterProfileStore = PrinterProfileStore(),
        networkProvider: any LocalWifiPrinterNetworkProviding = SystemLocalWifiPrinterNetworkProvider(),
        localWifiTransport: any LocalWifiPrinterTransport = NetworkLocalWifiPrinterTransport(),
        bluetoothTransport: any BluetoothPrinterTransporting = CoreBluetoothPrinterTransport(),
        receiptDecoration: (any ReceiptDecoration)? = nil,
        codeEmissionOverride: @escaping @Sendable (String) -> ThermalCodeEmissionPreferences? = { _ in nil }
    ) {
        self.selectionStore = selectionStore
        self.profileStore = profileStore
        self.networkProvider = networkProvider
        self.localWifiTransport = localWifiTransport
        self.bluetoothTransport = bluetoothTransport
        self.receiptDecoration = receiptDecoration
        self.codeEmissionOverride = codeEmissionOverride
        localWifi = LocalWifiThermalPrinterController(
            networkProvider: networkProvider,
            transport: localWifiTransport,
            store: selectionStore,
            profileStore: profileStore,
            receiptDecoration: receiptDecoration,
            codeEmissionOverride: codeEmissionOverride
        )
        bluetooth = BluetoothThermalPrinterController(
            transport: bluetoothTransport,
            store: selectionStore,
            profileStore: profileStore,
            receiptDecoration: receiptDecoration,
            codeEmissionOverride: codeEmissionOverride
        )
        coordinator = ThermalPrintingCoordinator(
            store: selectionStore,
            localWifi: localWifi,
            bluetooth: bluetooth,
            profileStore: profileStore
        )
        observers = [
            localWifi.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            bluetooth.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
            coordinator.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() },
        ]
    }

    public func test(
        _ candidate: LocalWifiPrinterCandidate,
        profile: PrinterProfile = BundledPrinterProfiles.elginI9Full2
    ) {
        guard localWifi.testAccepted(candidateID: candidate.id) else { return }
        probeTarget = ProbeTarget(
            id: UUID(),
            sender: LocalWifiPrinterProbeSender(
                transport: localWifiTransport,
                endpoint: candidate.endpoint
            ),
            profile: profile,
            origin: .initialReceipt
        )
    }

    /// Mantém a candidata/endpoint efêmero e troca apenas o perfil escolhido no catálogo visual.
    public func applyPendingDiscoveryProfile(_ profile: PrinterProfile) {
        guard let target = probeTarget, target.origin == .initialReceipt else { return }
        probeTarget = ProbeTarget(
            id: target.id,
            sender: target.sender,
            profile: profile,
            origin: target.origin
        )
    }

    public func testManual(
        ipAddress: String,
        portText: String,
        profile: PrinterProfile = BundledPrinterProfiles.elginI9Full2
    ) {
        testManual(ipAddress: ipAddress, portText: portText, profile: profile, declaring: nil)
    }

    /**
     Comprovante de teste de um endereço digitado, com as opções que a pessoa acabou de declarar.

     O papel sai **com essas opções** — é assim que ela vê o acento e o corte certos antes de
     confirmar. O perfil declarado não é gravado aqui: ele viaja com a candidata em memória e só
     chega ao disco em ``handleInitialReceipt(_:)``, depois da resposta sobre o papel.
     */
    public func testManual(
        ipAddress: String,
        portText: String,
        declaring profile: MeasuredProfile
    ) {
        testManual(
            ipAddress: ipAddress,
            portText: portText,
            profile: PrinterProfile(profile),
            declaring: profile
        )
    }

    private func testManual(
        ipAddress: String,
        portText: String,
        profile: PrinterProfile,
        declaring declared: MeasuredProfile?
    ) {
        let layout = declared.map { ReceiptLayout(profile: PrinterProfile($0)) }
        guard let port = Int(portText),
              let endpoint = LocalWifiPrinterEndpoint(ipAddress: ipAddress, port: port),
              let network = networkProvider.currentNetwork(),
              network.subnet.isSelectable(endpoint)
        else {
            discardEphemeralProbeTarget()
            _ = localWifi.testManualAccepted(
                ipAddress: ipAddress,
                portText: portText,
                layout: layout
            )
            return
        }
        guard localWifi.testManualAccepted(
            ipAddress: ipAddress,
            portText: portText,
            layout: layout
        ) else { return }
        probeTarget = ProbeTarget(
            id: UUID(),
            sender: LocalWifiPrinterProbeSender(
                transport: localWifiTransport,
                endpoint: endpoint
            ),
            profile: profile,
            origin: .initialReceipt,
            declaredProfile: declared
        )
    }

    public func test(
        _ candidate: BluetoothPrinterCandidate,
        profile: PrinterProfile = BundledPrinterProfiles.portable58mm
    ) {
        guard bluetooth.testAccepted(candidate) else { return }
        probeTarget = ProbeTarget(
            id: UUID(),
            sender: BluetoothPrinterProbeSender(
                transport: bluetoothTransport,
                candidate: candidate
            ),
            profile: profile,
            origin: .initialReceipt
        )
    }

    @discardableResult
    public func handleInitialReceipt(_ outcome: InitialReceiptOutcome) -> InitialReceiptAction {
        guard let target = confirmedProbeTarget, target.origin == .initialReceipt else {
            return .discarded
        }
        switch outcome {
        case .printedCorrectly:
            guard target.profile.isPersistent else { return .temporaryProfileRequiresHomologation }
            // A declaração vira disco aqui, e não antes: quem autoriza a gravação é a resposta
            // humana sobre o papel. Sem este passo a instalação apontaria para um perfil que não
            // existe no store, e a impressora imprimiria pelo conservador sem ninguém pedir.
            if let declared = target.declaredProfile, !persistDeclaredProfile(declared) {
                return .homologationRequired
            }
            let adopted: Bool
            if target.sender.transport == .localWifi {
                adopted = localWifi.confirmHomologatedProfile(target.profile)
            } else {
                adopted = bluetooth.confirmHomologatedProfile(target.profile)
            }
            guard adopted else { return .homologationRequired }
            discardEphemeralProbeTarget()
            return .adopted
        case .printedWithProblem:
            // Não chama reject/discard: a candidata continua viva para as sondas.
            return .homologationRequired
        case .notPrinted:
            if target.sender.transport == .localWifi {
                localWifi.rejectTestReceipt()
            } else {
                bluetooth.discardTestReceipt()
            }
            discardEphemeralProbeTarget()
            return .discarded
        }
    }

    /// Prepara a impressora já adotada para a ação avançada. Sem transporte explícito, usa a
    /// seleção ativa; endpoint e handle continuam fechados dentro do sender redigido.
    @discardableResult
    public func prepareHomologationForAdoptedPrinter(
        transport requestedTransport: PrinterTransport? = nil
    ) -> Bool {
        if requestedTransport == nil, confirmedProbeTarget != nil { return true }
        guard let transport = requestedTransport ?? coordinator.activeTransport,
              let selection = selectionStore.read().of(transport),
              let sender = adoptedProbeSender(for: transport)
        else { return false }
        probeTarget = ProbeTarget(
            id: UUID(),
            sender: sender,
            profile: resolveProfile(for: selection),
            origin: .adoptedPrinter,
            installationId: selection.installationId
        )
        return confirmedProbeTarget != nil
    }

    // MARK: - Configuração manual

    /// A configuração que vale hoje para uma unidade instalada, para a engrenagem abrir os campos
    /// no que já é verdade. `nil` quando a unidade não está mais na lista.
    public func manualConfiguration(for installationId: String) -> PrinterManualConfiguration? {
        selectionStore.read()
            .ofInstallation(installationId)
            .map { PrinterManualConfiguration(resolveProfile(for: $0)) }
    }

    /// O ponto de partida para declarar as opções da candidata que está em memória: o perfil de
    /// descoberta dela, que é conservador de propósito. `nil` sem candidata.
    public func manualConfigurationForPendingPrinter() -> PrinterManualConfiguration? {
        confirmedProbeTarget.map { PrinterManualConfiguration($0.profile) }
    }

    /**
     Comprovante de teste com as opções declaradas, antes de qualquer gravação.

     Ele vai pela candidata em memória — a mesma ponte da homologação —, e nenhum byte novo é
     inventado aqui: é o comprovante de teste do kit montado sobre o layout que a pessoa acabou de
     escolher. Devolve `false` quando não há impressora em memória para receber; nesse caso a tela
     diz o que falta em vez de desabilitar um botão em silêncio.
     */
    @discardableResult
    public func sendManualConfigurationTestReceipt(
        _ configuration: PrinterManualConfiguration,
        completion: @escaping (PrinterProbeSendResult) -> Void
    ) -> Bool {
        guard let target = confirmedProbeTarget else {
            completion(.failure(.rejected))
            return false
        }
        let transport = target.sender.transport
        guard let capabilities = try? configuration.capabilities(
            transports: [transport.capabilityTransport]
        ) else {
            completion(.failure(.rejected))
            return false
        }
        let layout = ReceiptLayout(
            profile: PrinterProfile(
                id: target.profile.id,
                displayName: configuration.displayName,
                source: target.profile.source,
                measuredAt: target.profile.measuredAt,
                capabilities: capabilities
            ),
            decoration: receiptDecoration
        )
        // A configuração declarada não mede sonda nenhuma: quando ela não carrega as duas respostas,
        // elas saem ausentes, que é a verdade sobre um perfil que ninguém mediu. Quando carrega —
        // porque a declaração foi aberta de uma medição que já passou pela tira de código nativo —,
        // o comprovante de conferência sai como o cupom de venda sairá, e é para isso que ele serve.
        target.sender.sendProbe(
            PrinterTestReceipt.bytes(
                layout: layout,
                nativeQrHonored: capabilities.nativeQrHonored,
                nativeBarcodeHonored: capabilities.nativeBarcodeHonored
            ),
            completion: completion
        )
        return true
    }

    /**
     Regrava as opções de uma unidade **que já está instalada**.

     Mesma identidade, mesma instalação: o `installationId` é perfil mais o resumo da identidade
     física, então preservar o identificador do perfil preserva a unidade, e a lista continua com
     um card só. Quando a unidade apontava para uma entrada do catálogo — que é compartilhada e não
     se edita —, a declaração vira uma medição local nova e a instalação passa a apontar para ela,
     ainda no lugar da antiga.

     Não exige a impressora ligada: trocar a página de código de uma impressora que está no
     estoque é uma operação de armazenamento, e recusá-la por causa do rádio seria inventar um
     requisito que o papel não tem. Quem quiser conferir antes imprime o comprovante de teste, que
     esse sim precisa dela respondendo.
     */
    @discardableResult
    public func saveManualConfiguration(
        _ configuration: PrinterManualConfiguration,
        for installationId: String
    ) throws -> MeasuredProfile {
        let stored = selectionStore.read()
        guard let selection = stored.ofInstallation(installationId) else {
            throw PrinterManualConfigurationError.installationNotFound
        }
        let transport = selection.transport
        let previous = profileStore.profile(id: selection.profileId)
        // Os quatro campos medidos tardios não têm campo em tela nenhuma, e esta rota não mede
        // sonda: sem isto, trocar a página de código de uma T210 já medida apagava a compensação
        // vertical dela em silêncio — a foto voltava a sair 20% curta e o cupom continuava saindo.
        // É a mesma preservação que `firmwareVersion` já fazia, pelo mesmo `previous`.
        let profile = try configuration
            .preservingLateMeasurements(from: previous)
            .profile(
                id: previous?.id ?? UUID().uuidString.lowercased(),
                transports: (previous?.transports ?? []).union([transport.capabilityTransport]),
                measuredAt: PrinterManualConfiguration.nextMeasurementDate(
                    after: previous?.measuredAt
                ),
                firmwareVersion: previous?.firmwareVersion
            )

        try persist(profile, rollingBackTo: previous)
        let updated = selection.replacingProfile(profile.id)
        selectionStore.save(stored.replacingInstallation(installationId, with: updated))
        guard selectionStore.read().ofInstallation(updated.installationId) == updated else {
            selectionStore.save(stored)
            rollback(profileID: profile.id, to: previous)
            throw PrinterManualConfigurationError.persistenceFailed
        }

        // O store não alcança o layout que já está em memória, e o cupom seguinte sairia com a
        // página antiga sem erro em lugar nenhum. Só a unidade ativa: o controlador reconstrói o
        // layout pela seleção em uso, e pedir isso ao editar uma irmã parada instalaria no papel
        // as opções da impressora errada.
        if stored.activeInstallationId == installationId {
            switch transport {
            case .localWifi: localWifi.reapplyOperationalLayout()
            case .bluetooth: bluetooth.reapplyOperationalLayout()
            }
        }
        coordinator.refresh()
        return profile
    }

    /**
     Instala a impressora que está em memória com as opções declaradas, sem novas sondas.

     Espelha `PrinterHomologationTarget.saveManualConfiguration` do Android: preserva a validação
     do perfil, a confirmação de releitura do store e a adoção do vínculo físico; a única coisa que
     não faz é afirmar que houve uma nova prova em papel. Quando a candidata é uma unidade que já
     está instalada, isto é edição e não adoção — e aí o caminho é ``saveManualConfiguration(_:for:)``,
     que regrava a mesma instalação em vez de criar a segunda.
     */
    @discardableResult
    public func adoptManualConfiguration(
        _ configuration: PrinterManualConfiguration
    ) throws -> MeasuredProfile {
        guard let target = confirmedProbeTarget else {
            throw PrinterManualConfigurationError.printerNotAvailable
        }
        if let installationId = target.installationId {
            let profile = try saveManualConfiguration(configuration, for: installationId)
            discardEphemeralProbeTarget()
            return profile
        }
        let transport = target.sender.transport
        let profile = try configuration.profile(
            id: UUID().uuidString.lowercased(),
            transports: [transport.capabilityTransport]
        )
        try persist(profile, rollingBackTo: nil)
        let adopted = transport == .localWifi
            ? localWifi.confirmHomologatedProfile(PrinterProfile(profile))
            : bluetooth.confirmHomologatedProfile(PrinterProfile(profile))
        guard adopted else {
            rollback(profileID: profile.id, to: nil)
            throw PrinterManualConfigurationError.adoptionFailed
        }
        discardEphemeralProbeTarget()
        return profile
    }

    /// Grava e **relê** antes de seguir. Perfil que o store aceitou e devolve diferente é a falha
    /// que custou 44 impressões da T210; ela precisa aparecer aqui, não no papel.
    private func persist(_ profile: MeasuredProfile, rollingBackTo previous: MeasuredProfile?) throws {
        do {
            try profileStore.save(profile)
        } catch {
            rollback(profileID: profile.id, to: previous)
            throw PrinterManualConfigurationError.persistenceFailed
        }
        guard profileStore.profile(id: profile.id) == profile else {
            rollback(profileID: profile.id, to: previous)
            throw PrinterManualConfigurationError.persistenceFailed
        }
    }

    private func persistDeclaredProfile(_ profile: MeasuredProfile) -> Bool {
        let previous = profileStore.profile(id: profile.id)
        do {
            try persist(profile, rollingBackTo: previous)
            return true
        } catch {
            return false
        }
    }

    private func rollback(profileID: String, to previous: MeasuredProfile?) {
        if let previous {
            try? profileStore.save(previous)
        } else {
            try? profileStore.remove(id: profileID)
        }
    }

    public func makeHomologationSession(
        store: PrinterProfileStore? = nil,
        displayName: String? = nil
    ) throws -> PrinterHomologationSession {
        guard let target = confirmedProbeTarget else {
            throw PrinterHomologationMachineError.invalidState
        }
        let transport = target.sender.transport
        let targetID = target.id
        let machine = PrinterHomologationMachine(
            // O nome que o aparelho anunciou vence o genérico do perfil de descoberta — sem isto
            // o perfil medido nasce "Impressora temporária", que não distingue duas do mesmo
            // tamanho na lista. A pessoa ainda pode trocar no fim, e a validação do
            // `MeasuredProfile` continua recusando identificador técnico. O Android já fazia.
            displayName: displayName ?? target.sender.declaredName ?? target.profile.displayName,
            transports: [transport.capabilityTransport],
            tcpPort: transport == .localWifi ? 9_100 : nil,
            // O dialeto do alvo já estava aqui, na mão, e era descartado: a máquina montava a série
            // ESC/POS para qualquer impressora e o perfil medido nascia `.epsonCompatible`.
            dialect: target.profile.dialect
        )
        return PrinterHomologationSession(
            machine: machine,
            sender: target.sender,
            profileStore: store ?? profileStore,
            selectionStore: selectionStore,
            // Só o comprovante final recebe a decoração; as tiras, não. A sessão sabe distinguir
            // os dois, e é por isso que o gancho entra nela em vez de no `sender`.
            receiptDecoration: receiptDecoration,
            runtimeAdopter: { [weak self] profile in
                guard let self, self.probeTarget?.id == targetID else { return false }
                let operationalProfile = PrinterProfile(profile)
                let adopted = transport == .localWifi
                    ? self.localWifi.confirmHomologatedProfile(operationalProfile)
                    : self.bluetooth.confirmHomologatedProfile(operationalProfile)
                return adopted
            },
            onAdoptionCommitted: { [weak self] in
                guard let self, self.probeTarget?.id == targetID else { return }
                self.discardEphemeralProbeTarget()
            },
            // O mesmo dialeto vai à sessão, e **é a mesma expressão da máquina, do mesmo
            // objeto, nesta mesma função** — `target.profile.dialect` nas duas. Aqui esteve
            // escrito que os dois lados eram independentes e que por isso o portão do envio
            // protegia algo; não são, e a frase induzia ao contrário.
            //
            // **O que o portão do envio (`PrinterProbeSession.send`) mede, então.** Medido por
            // mutação em 04/09/2026: apaguei a guarda `probe.dialect == dialect` inteira e as 16
            // provas de `HomologacaoProcompTests` — a de ponta a ponta inclusive — ficaram verdes;
            // só as duas de `RecusaDeDialetoTests`, que dessincronizam os dois de propósito,
            // ficaram vermelhas. Ou seja: por este caminho a guarda é tautológica, e o que ela pega
            // é um **conjunto de sondas** que carimbe o dialeto errado — `probe.dialect` vem do
            // conjunto, não daqui. É rede para o dia em que alguém escrever o terceiro conjunto.
            dialect: target.profile.dialect
        )
    }

    /**
     Quem recebe o comando cru: a candidata efêmera primeiro, a impressora instalada depois.

     A ordem é a do Android, que resolve isto dentro da própria API — `pendingProbeTarget(transport)
     ?: adoptedProbeTarget(transport)` —, e ela importa: uma configuração em andamento não pode
     perder a candidata que a pessoa acabou de testar para uma unidade instalada que ninguém
     apontou. O transporte também é o do Android, `transport ?: selectionStore.read().active`; sem
     transporte ativo não há palpite, devolve nulo.

     Nada é gravado. O alvo adotado é montado e descartado nesta chamada, de propósito: se ficasse
     em `probeTarget`, ``hasEphemeralProbeTarget`` viraria verdadeiro para o app inteiro e a tela de
     configuração passaria a prometer papel por uma unidade que não é a que está sendo editada.

     Continua fechando por baixo, e isso é a favor: `adoptedProbeSender` exige controlador em
     `.ready` e, na rede, a mesma Wi-Fi da instalação. O Android não confere nem estado nem rede na
     queda dele; recusar aqui é melhor que mandar bytes para um endereço morto.
     */
    private func ephemeralCommandSender(
        fallingBackToAdopted: Bool
    ) -> (any PrinterProbeSending)? {
        if let target = confirmedProbeTarget { return target.sender }
        guard fallingBackToAdopted else { return nil }
        // A queda resolve **no transporte da candidata viva**, quando há uma. Sem este escopo,
        // uma candidata que saiu de `.ready` mandava os bytes pela impressora instalada de
        // *outro* transporte: medido na revisão, o payload destinado à portátil saiu na de rede,
        // e comando cru grava configuração não volátil. Só quando não há candidata alguma é que
        // o transporte ativo decide.
        guard let transport = probeTarget?.sender.transport ?? coordinator.activeTransport
        else { return nil }
        return adoptedProbeSender(for: transport)
    }

    /// Ponte exclusiva para ferramentas de bancada que já fizeram sua própria confirmação de
    /// risco. O agregado não guarda, descreve nem repete o buffer; o chamador continua responsável
    /// por zerá-lo assim que receber o callback real.
    ///
    /// A queda para a impressora instalada é **pedida**, nunca herdada: só quem passa
    /// `fallingBackToAdopted` a recebe. O pulso de gaveta da homologação compartilha esta porta e
    /// **não** a pede, porque ali a resposta humana sobre o papel vira capacidade medida — pulsar
    /// numa unidade que não é a da sessão contaminaria a medição em silêncio.
    @discardableResult
    public func sendEphemeralCommand(
        _ bytes: Data,
        fallingBackToAdopted: Bool = false,
        completion: @escaping (PrinterProbeSendResult) -> Void
    ) -> Bool {
        guard let sender = ephemeralCommandSender(fallingBackToAdopted: fallingBackToAdopted) else {
            completion(.failure(.rejected))
            return false
        }
        sender.sendProbe(bytes, completion: completion)
        return true
    }

    /// Apaga uma medição deste aparelho e solta a impressora que apontava para ela.
    ///
    /// A regra "perfil medido nunca é sobrescrito" continua valendo: ela protege medição contra
    /// acidente, não contra vontade. Medição errada existe — a T210 foi gravada com 80 mm porque a
    /// largura da busca atravessou de outra impressora —, e sem uma saída explícita o único caminho
    /// seria apagar os dados do app inteiro.
    ///
    /// A conta de quem apontava para o perfil vem **antes** de apagar: depois da remoção o perfil
    /// já não resolve, e a seleção órfã se apresentaria como o conservador sem ninguém pedir.
    /// Sai **quem apontava para o perfil**, e não o transporte inteiro: com duas portáteis
    /// instaladas, apagar a medição de uma não pode desinstalar a que usa outra medição.
    public func forgetMeasuredProfile(id: String) throws {
        let stored = selectionStore.read()
        let remaining = stored.selections
            .filter { $0.profileId == id }
            .reduce(stored) { selections, selection in
                selections.withoutInstallation(selection.installationId)
            }
        try profileStore.remove(id: id)
        selectionStore.save(remaining)
        if probeTarget?.profile.id == id { probeTarget = nil }
    }

    public func discardEphemeralProbeTarget() {
        probeTarget = nil
    }

    private var confirmedProbeTarget: ProbeTarget? {
        guard let probeTarget else { return nil }
        let expectedStateIsPresent: Bool
        switch probeTarget.sender.transport {
        case .localWifi:
            expectedStateIsPresent = probeTarget.origin == .initialReceipt
                ? localWifi.state == .awaitingConfirmation
                : localWifi.state == .ready
        case .bluetooth:
            expectedStateIsPresent = probeTarget.origin == .initialReceipt
                ? bluetooth.state == .awaitingConfirmation
                : bluetooth.state == .ready
        }
        return expectedStateIsPresent ? probeTarget : nil
    }

    private func adoptedProbeSender(for transport: PrinterTransport) -> (any PrinterProbeSending)? {
        switch transport {
        case .localWifi: return localWifi.adoptedProbeSender()
        case .bluetooth: return bluetooth.adoptedProbeSender()
        }
    }

    private func resolveProfile(for selection: PersistedPrinterSelection) -> PrinterProfile {
        let profileId: String
        let paperWidth: PrinterPaperWidth
        switch selection {
        case .localWifi:
            profileId = selection.profileId == LocalWifiThermalPrinterController.profileId
                ? BundledPrinterProfiles.elginI9Full2.id
                : selection.profileId
            paperWidth = .mm80
        case .bluetooth:
            profileId = selection.profileId
            paperWidth = .mm58
        }
        return PrinterProfileResolver(measured: profileStore.profiles()).resolve(
            profileId: profileId,
            transport: selection.transport,
            paperWidth: paperWidth
        )
    }
}

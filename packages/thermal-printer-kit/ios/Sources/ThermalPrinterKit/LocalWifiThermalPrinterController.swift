import Foundation

@MainActor
public final class LocalWifiThermalPrinterController: ObservableObject {
    @Published public private(set) var state: LocalWifiPrinterState = .idle
    @Published public private(set) var candidates: [LocalWifiPrinterCandidate] = []

    private let networkProvider: any LocalWifiPrinterNetworkProviding
    private let transport: any LocalWifiPrinterTransport
    private let store: any PrinterSelectionStoring
    private let profileStore: PrinterProfileStore?
    private let now: () -> Date
    /// Cabeçalho e rodapé do app hospedeiro, aplicados a todo cupom que sai por este transporte.
    /// Default `nil`: quem não passa nada imprime o que sempre imprimiu. Ver ``ReceiptDecoration``.
    private let receiptDecoration: (any ReceiptDecoration)?
    /**
     O que o hospedeiro prefere para os códigos daquela impressora; `nil` mantém o padrão.

     Ponto de injeção neutro, do mesmo feitio da decoração: **o kit não lê preferência nenhuma**, e
     esta assinatura não sabe que existe uma tela de ajustes do outro lado. Recebe o `profileId`
     porque a escolha é por impressora — um ajuste global seria um segundo cadastro.
     */
    private let codeEmissionOverride: @Sendable (String) -> ThermalCodeEmissionPreferences?
    private let printJobs = ThermalPrintJobQueue()
    private var candidateNetwork: LocalWifiPrinterNetwork?
    private var candidateExpiration: Date?
    private var pending: (endpoint: LocalWifiPrinterEndpoint, candidateID: Int?, network: LocalWifiPrinterNetwork)?
    /// Sem prazo: no balcão a pessoa do caixa não pode refazer a configuração a cada dez minutos.
    private var confirmed: (endpoint: LocalWifiPrinterEndpoint, network: LocalWifiPrinterNetwork)?
    private var adoptedLayout = ReceiptLayout.counter
    /// O layout acompanha a seleção confirmada apenas em memória. Sem store de perfis injetado,
    /// o controller conserva exatamente o comportamento homologado no M1.
    ///
    /// A escrita instala a decoração do hospedeiro **em toda atribuição**. É de propósito: são
    /// cinco pontos que trocam o layout — adoção, homologação, retomada, limpeza e o default do
    /// M1 —, e um deles esquecido seria um caminho de impressão sem rodapé, descoberto no papel.
    private var operationalLayout: ReceiptLayout {
        get {
            // A preferência é lida **na hora do cupom**, e não na adoção: trocar o ajuste e mandar
            // imprimir em seguida precisa valer no papel seguinte. Aplicada no setter, ela só
            // mudaria depois de readotar a impressora.
            guard let profile = adoptedProfile,
                  let preferida = codeEmissionOverride(profile.id)
            else { return adoptedLayout }
            // A trava outra vez, e pela mesma função da adoção: o perfil pode ter sido remedido, e
            // o layout guardado não sabe distinguir "padrão" de "só o padrão foi autorizado".
            let honrada = preferida.honored(by: profile)
            return adoptedLayout.emitting(
                qr: honrada.qrEmission,
                barcode: honrada.barcodeEmission
            )
        }
        set {
            adoptedLayout = newValue.decorated(by: receiptDecoration)
            // Trocar o layout é trocar de impressora ou voltar ao estático do M1; até que alguém
            // diga **qual perfil** foi adotado, não há preferência a consultar. Zerar aqui faz o
            // esquecimento render os bytes de sempre, e não um modo que ninguém mediu.
            adoptedProfile = nil
        }
    }

    /**
     O perfil que a adoção resolveu, guardado por causa da preferência de emissão.

     Só o `id` seria suficiente para consultar o ajuste do hospedeiro, mas não para **travá-lo**: a
     autorização vem da capacidade medida, e ela não sobrevive dentro do layout — `rasterized` é ao
     mesmo tempo "o padrão" e "o que a medição permitiu". Guardar o perfil é o que mantém a trava a
     um só lugar. Nada de identidade física entra aqui; o endpoint continua no registro cifrado.
     */
    private var adoptedProfile: PrinterProfile?

    /// Layout do comprovante que sai antes de existir perfil adotado. É o do balcão, como sempre
    /// foi, mais o gancho do hospedeiro: o comprovante de teste é papel do app, não tira de sonda.
    private var initialTestLayout: ReceiptLayout {
        ReceiptLayout.counter.decorated(by: receiptDecoration)
    }

    /// A instalação persiste; o socket, não. Na retomada, quem tem endpoint guardado só volta a
    /// ficar pronta se **ela** responder; sem endpoint, só uma descoberta sem ambiguidade.
    private var restoring = false
    /**
     **Qual** unidade esta retomada procura. Com duas impressoras de rede instaladas, "a seleção
     Wi-Fi" deixou de ser uma só.

     É publicado pelo mesmo motivo do Bluetooth: o card daquela impressora precisa dizer que é ela
     que está sendo procurada, e depois que ela não respondeu. Só o id da instalação sai daqui; o
     endpoint continua fechado no registro cifrado.
     */
    @Published public private(set) var reconnectingInstallationId: String?

    public init(
        networkProvider: any LocalWifiPrinterNetworkProviding = SystemLocalWifiPrinterNetworkProvider(),
        transport: any LocalWifiPrinterTransport = NetworkLocalWifiPrinterTransport(),
        store: any PrinterSelectionStoring = KeychainPrinterSelectionStore(),
        now: @escaping () -> Date = Date.init,
        profileStore: PrinterProfileStore? = nil,
        receiptDecoration: (any ReceiptDecoration)? = nil,
        codeEmissionOverride: @escaping @Sendable (String) -> ThermalCodeEmissionPreferences? = { _ in nil }
    ) {
        self.networkProvider = networkProvider
        self.transport = transport
        self.store = store
        self.now = now
        self.profileStore = profileStore
        self.receiptDecoration = receiptDecoration
        self.codeEmissionOverride = codeEmissionOverride
        adoptedLayout = ReceiptLayout.counter.decorated(by: receiptDecoration)
        restoreConfirmedSelection()
    }

    /// Retoma a instalação preservada por uma nova descoberta. Nenhum endereço sai do Keychain.
    private func restoreConfirmedSelection() {
        guard let selection = store.read().of(.localWifi) else { return }
        reconnectingInstallationId = selection.installationId
        restoring = true
        beginSearch()
    }

    /**
     Esquece a impressora que está em memória sem tocar no que está guardado.

     Quem grava é o coordenador. Uma segunda gravação a partir daqui desinstalaria impressora que
     ninguém mandou desinstalar.
     */
    func discardRuntimeSelection() {
        clearEphemeralSelections()
        restoring = false
        reconnectingInstallationId = nil
        state = .idle
    }

    /// Solta a unidade em uso e vai atrás da que o store diz ser a ativa agora.
    func reconnectAdoptedPrinter() {
        discardRuntimeSelection()
        restoreConfirmedSelection()
    }

    /**
     Vai atrás de **esta** unidade, e não da que o transporte estava servindo.

     Irmã de ``reconnectAdoptedPrinter()``: aquela segue o store, que aponta para a ativa; esta
     segue a instalação pedida. Existe para o comprovante de teste do card — com duas impressoras
     de rede instaladas, conferir a que está parada não pode alcançar a irmã.

     Solta a conexão anterior antes de procurar: deixá-la viva é o que faria o cupom cair na
     impressora errada quando a pedida não respondesse.
     */
    func restoreInstallation(_ installationId: String) {
        guard case .localWifi? = store.read().ofInstallation(installationId) else { return }
        discardRuntimeSelection()
        reconnectingInstallationId = installationId
        restoring = true
        beginSearch()
    }

    /// A unidade que esta retomada procura, e não "a seleção Wi-Fi": com duas instaladas, são
    /// coisas diferentes.
    private func restoringSelection() -> PersistedPrinterSelection? {
        let stored = store.read()
        return reconnectingInstallationId.flatMap(stored.ofInstallation) ?? stored.of(.localWifi)
    }

    /**
     Qual das que responderam é a impressora adotada.

     Com endpoint guardado, quantas responderam deixa de importar: ou está a dela na varredura, ou
     nenhuma serve. Adotar a que sobrou é o defeito medido no Bluetooth em 20/08 — o cupom saiu na
     portátil que nem instalada estava — e aqui era o mesmo, com outro transporte: `found.count == 1`
     bastava, então a impressora de rede do vizinho de sub-rede herdava o lugar da que estava
     desligada.

     Sem endpoint guardado o registro é legado, e o comportamento antigo continua inteiro: candidata
     única volta a valer sozinha, duas continuam exigindo escolha. Quem adotou antes desta correção
     não perde a impressora nem é obrigado a readotar.
     */
    private func restoredEndpoint(
        among found: [LocalWifiPrinterEndpoint]
    ) -> LocalWifiPrinterEndpoint? {
        guard let persistido = restoringSelection()?.networkEndpoint else {
            return found.count == 1 ? found.first : nil
        }
        return found.first { $0.ipAddress == persistido.ipv4Address && $0.port == persistido.port }
    }

    /**
     Procurar não desinstala.

     Esta busca começava apagando a impressora guardada — era o `972abbd` do Android deste lado. A
     pessoa que toca em "procurar" para instalar a segunda impressora, ou só para conferir se a
     dela aparece, não pediu para desinstalar a que estava; e quando a varredura não achasse nada,
     ela sairia da tela sem a impressora que tinha antes de tocar. Quem desinstala é ``reset()``,
     que é o botão de descartar, e a exclusão por unidade do coordenador.
     */
    public func search() {
        restoring = false
        reconnectingInstallationId = nil
        beginSearch()
    }

    private func beginSearch() {
        guard !state.isBusy, let network = networkProvider.currentNetwork() else {
            state = .wifiUnavailable
            return
        }
        clearEphemeralSelections()
        state = .searching
        let endpoints = network.subnet.discoveryCandidates()
        let transport = transport
        Task { [weak self] in
            let found = await LocalWifiPrinterDiscovery.discover(endpoints: endpoints, transport: transport)
            guard let self else { return }
            guard self.networkProvider.currentNetwork() == network else {
                self.state = .wifiUnavailable
                return
            }
            if self.restoring, let retomada = self.restoredEndpoint(among: found) {
                self.restoring = false
                self.confirmed = (retomada, network)
                self.restoreOperationalLayout()
                self.reconnectingInstallationId = nil
                self.state = .ready
                return
            }
            self.restoring = false
            self.candidateNetwork = network
            self.candidateExpiration = self.now().addingTimeInterval(120)
            self.candidates = found.enumerated().compactMap { offset, endpoint in
                LocalWifiPrinterCandidate(id: offset + 1, order: offset + 1, endpoint: endpoint)
            }
            self.state = self.candidates.isEmpty ? .printerUnavailable : .candidatesFound
        }
    }

    @discardableResult
    public func testAccepted(candidateID: Int) -> Bool {
        guard state == .candidatesFound,
              let network = activeCandidateNetwork(),
              let candidate = candidates.first(where: { $0.id == candidateID })
        else {
            state = .idle
            return false
        }
        state = .testing
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performTest(
                endpoint: candidate.endpoint,
                candidateID: candidate.id,
                network: network
            )
        }
        return true
    }

    public func test(candidateID: Int) async -> ThermalPrintResult {
        guard state == .candidatesFound, let network = activeCandidateNetwork(),
              let candidate = candidates.first(where: { $0.id == candidateID })
        else {
            state = .idle
            return Self.notSent("A candidata Wi-Fi não está mais disponível.")
        }
        state = .testing
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performTest(
                endpoint: candidate.endpoint,
                candidateID: candidate.id,
                network: network
            )
        }
    }

    /// - Parameter layout: o papel que a pessoa declarou nesta tela, quando ela declarou algum.
    ///   `nil` mantém o comprovante de balcão que sempre saiu antes de existir perfil adotado —
    ///   trocá-lo por padrão mudaria o que sai no papel em todo caminho de busca.
    @discardableResult
    public func testManualAccepted(
        ipAddress: String,
        portText: String,
        layout: ReceiptLayout? = nil
    ) -> Bool {
        guard !state.isBusy, state != .awaitingConfirmation,
              let port = Int(portText), let endpoint = LocalWifiPrinterEndpoint(ipAddress: ipAddress, port: port),
              let network = networkProvider.currentNetwork(), network.subnet.isSelectable(endpoint) else {
            state = .invalidAddress
            return false
        }
        state = .testing
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performTest(
                endpoint: endpoint,
                candidateID: nil,
                network: network,
                layout: layout
            )
        }
        return true
    }

    public func testManual(ipAddress: String, portText: String) async -> ThermalPrintResult {
        guard !state.isBusy, state != .awaitingConfirmation, let port = Int(portText),
              let endpoint = LocalWifiPrinterEndpoint(ipAddress: ipAddress, port: port),
              let network = networkProvider.currentNetwork(), network.subnet.isSelectable(endpoint)
        else {
            state = .invalidAddress
            return Self.notSent("O endereço Wi-Fi informado não está disponível.")
        }
        state = .testing
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performTest(endpoint: endpoint, candidateID: nil, network: network)
        }
    }

    public func confirmTestReceipt() {
        _ = confirmPendingPrinter(profileId: Self.profileId, layout: .counter)
    }

    /// Promove a candidata retida pela homologação e instala imediatamente o layout que acabou de
    /// ser confirmado no papel, sem regravar o perfil M1.
    @discardableResult
    func confirmHomologatedProfile(_ profile: PrinterProfile) -> Bool {
        let layout = ReceiptLayout(profile: profile)
        if state == .awaitingConfirmation {
            let adotou = confirmPendingPrinter(profileId: profile.id, layout: layout)
            // Depois da atribuição do layout, que zera o perfil adotado de propósito. Só há
            // preferência a consultar quando a adoção deu certo.
            if adotou { adoptedProfile = profile }
            return adotou
        }
        guard state == .ready, let confirmed else { return false }
        let selection = PersistedPrinterSelection.localWifi(
            profileId: profile.id,
            endpoint: PersistedNetworkEndpoint(confirmed.endpoint)
        )
        store.save(store.read().with(selection))
        guard store.read().ofInstallation(selection.installationId) == selection else { return false }
        objectWillChange.send()
        operationalLayout = layout
        adoptedProfile = profile
        return true
    }

    /**
     Reaplica o layout da unidade em uso depois de alguém regravar o perfil dela.

     A configuração manual grava no store, e o store não alcança o layout que já está em memória:
     sem isto, o cupom seguinte sairia com a página e o corte antigos até o app reabrir — e a
     pessoa acabou de ver o comprovante certo sair, o que torna o defeito invisível.
     */
    func reapplyOperationalLayout() {
        guard confirmed != nil else { return }
        restoreOperationalLayout()
        objectWillChange.send()
    }

    /// Cria a ponte de sonda sem expor o endpoint confirmado. Rede alterada não é tratada como a
    /// mesma impressora: a pessoa precisa reencontrá-la antes de homologar.
    func adoptedProbeSender() -> (any PrinterProbeSending)? {
        guard state == .ready, let confirmed,
              networkProvider.currentNetwork() == confirmed.network
        else { return nil }
        return LocalWifiPrinterProbeSender(transport: transport, endpoint: confirmed.endpoint)
    }

    @discardableResult
    private func confirmPendingPrinter(profileId: String, layout: ReceiptLayout) -> Bool {
        guard state == .awaitingConfirmation, let pending else { return false }
        // A pessoa confirmou o papel de **uma** impressora. Guardar qual foi é o que permite
        // reencontrá-la depois; sem isso, a retomada só sabia procurar "uma impressora".
        let selection = PersistedPrinterSelection.localWifi(
            profileId: profileId,
            endpoint: PersistedNetworkEndpoint(pending.endpoint)
        )
        store.save(store.read().with(selection))
        guard store.read().ofInstallation(selection.installationId) == selection else { return false }
        self.pending = nil
        confirmed = (pending.endpoint, pending.network)
        operationalLayout = layout
        candidates = []
        candidateNetwork = nil
        candidateExpiration = nil
        state = .ready
        return true
    }

    public func rejectTestReceipt() {
        guard let pending else { return }
        self.pending = nil
        if let candidateID = pending.candidateID {
            candidates.removeAll { $0.id == candidateID }
            state = candidates.isEmpty ? .idle : .candidatesFound
        } else {
            state = .idle
        }
    }

    /// Agenda o cupom e informa somente que entrou na fila; não afirma entrega.
    @discardableResult
    public func printAccepted(_ payload: any ThermalReceiptPayload) -> Bool {
        guard let prepared = prepare(payload) else { return false }
        state = .printing
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performPrint(prepared.receipt, to: prepared.target)
        }
        return true
    }

    /// Imprime e só retorna depois do desfecho final do transporte.
    public func print(_ payload: any ThermalReceiptPayload) async -> ThermalPrintResult {
        guard await ensureAdoptedPrinterIsReady() else {
            payload.clear()
            return Self.notSent("A impressora Wi-Fi adotada não foi reencontrada.")
        }
        guard let prepared = prepare(payload) else {
            return Self.notSent("Não foi possível preparar o cupom para a impressora Wi-Fi.")
        }
        state = .printing
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performPrint(prepared.receipt, to: prepared.target)
        }
    }

    @discardableResult
    public func printTestReceiptAgainAccepted() -> Bool {
        guard state == .ready else { return false }
        guard let confirmed,
              networkProvider.currentNetwork() == confirmed.network
        else {
            // A rede trocou, a impressora não. Desinstalar aqui apagava uma instalação
            // confirmada no papel por causa de um Wi-Fi que caiu — o Android nunca fez isso, e
            // agora que o endpoint é guardado a retomada reencontra a mesma unidade sozinha.
            clearEphemeralSelections()
            state = .wifiUnavailable
            return false
        }
        // As duas respostas vêm do perfil adotado, e não do layout: um layout rasterizado não
        // distingue "é o padrão" de "foi o máximo que a medição permitiu".
        let receipt = Self.testReceipt(
            layout: operationalLayout,
            nativeQrHonored: adoptedProfile?.nativeQrHonored,
            nativeBarcodeHonored: adoptedProfile?.nativeBarcodeHonored
        )
        state = .printing
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performPrint(receipt, to: confirmed)
        }
        return true
    }

    public func printTestReceiptAgain() async -> ThermalPrintResult {
        guard await ensureAdoptedPrinterIsReady() else {
            return Self.notSent("A impressora Wi-Fi adotada não foi reencontrada.")
        }
        guard let confirmed,
              networkProvider.currentNetwork() == confirmed.network
        else {
            clearEphemeralSelections()
            state = .wifiUnavailable
            return Self.notSent("A impressora Wi-Fi confirmada não está mais disponível.")
        }
        state = .printing
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Wi-Fi não está disponível.") }
            return await self.performPrint(
                Self.testReceipt(
                    layout: self.operationalLayout,
                    nativeQrHonored: self.adoptedProfile?.nativeQrHonored,
                    nativeBarcodeHonored: self.adoptedProfile?.nativeBarcodeHonored
                ),
                to: confirmed
            )
        }
    }

    /// A descoberta iniciada na abertura é assíncrona. O primeiro trabalho aguarda seu resultado
    /// em vez de falhar e obrigar a pessoa a tocar novamente. Ainda não houve abertura do socket,
    /// portanto esta espera não repete nenhum envio.
    private func ensureAdoptedPrinterIsReady() async -> Bool {
        if state == .ready, confirmed != nil { return true }
        if state == .testing || state == .awaitingConfirmation || state == .printing ||
            state == .failed || (state == .candidatesFound && !restoring) {
            return false
        }
        guard case .localWifi? = store.read().of(.localWifi) else { return false }
        if !restoring && state != .searching { restoreConfirmedSelection() }

        // /24 em lotes de 16, com 350 ms por lote, fecha em aproximadamente seis segundos.
        for _ in 0..<80 {
            if state == .ready, confirmed != nil { return true }
            // `printerUnavailable` entra aqui porque a retomada por endpoint termina assim quando
            // nenhuma das que responderam é a dela: a varredura acabou, e esperar o prazo inteiro
            // só atrasaria a recusa honesta.
            if state == .candidatesFound || state == .wifiUnavailable || state == .printerUnavailable {
                return false
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return state == .ready && confirmed != nil
    }

    /// Comprovante de teste da impressora de balcão. Ela tem guilhotina, então o cupom fecha com
    /// corte total — o da portátil termina em avanço.
    /// Pelo layout **do perfil adotado**, não pelo do balcão: o comprovante repete o que foi
    /// medido, e é ele que prova que o perfil relido do disco é o mesmo da bancada. Impressora que
    /// recebe bytes ainda erra acento, corta em cima do texto ou não faz raster.
    static func testReceipt(
        layout: ReceiptLayout = .counter,
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil
    ) -> Data {
        PrinterTestReceipt.bytes(
            layout: layout,
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored
        )
    }

    nonisolated static let profileId = "generic.counter.escpos"

    private func prepare(
        _ payload: any ThermalReceiptPayload
    ) -> (receipt: Data, target: (endpoint: LocalWifiPrinterEndpoint, network: LocalWifiPrinterNetwork))? {
        defer { payload.clear() }
        guard state == .ready || state == .printing else { return nil }
        guard let confirmed,
              networkProvider.currentNetwork() == confirmed.network,
              let receipt = decoratedReceiptBytes(of: payload, layout: operationalLayout)
        else {
            if confirmed == nil {
                state = .idle
            } else {
                clearEphemeralSelections()
                state = .wifiUnavailable
            }
            return nil
        }
        return (receipt, confirmed)
    }

    private func performTest(
        endpoint: LocalWifiPrinterEndpoint,
        candidateID: Int?,
        network: LocalWifiPrinterNetwork,
        layout: ReceiptLayout? = nil
    ) async -> ThermalPrintResult {
        let papel = layout.map { $0.decorated(by: receiptDecoration) } ?? initialTestLayout
        let result = await send(Self.testReceipt(layout: papel), to: endpoint)
        switch result {
        case .delivered:
            guard networkProvider.currentNetwork() == network else {
                state = .wifiUnavailable
                // O transporte já concluiu o envio. A troca de rede impede adotar a candidata,
                // mas não pode reescrever esse desfecho como "nada foi enviado".
                return .delivered
            }
            pending = (endpoint, candidateID, network)
            state = .awaitingConfirmation
        case .failed:
            state = .printerUnavailable
        }
        return result
    }

    private func performPrint(
        _ receipt: Data,
        to target: (endpoint: LocalWifiPrinterEndpoint, network: LocalWifiPrinterNetwork)
    ) async -> ThermalPrintResult {
        guard state == .ready || state == .printing,
              let current = confirmed,
              current.endpoint == target.endpoint,
              current.network == target.network,
              networkProvider.currentNetwork() == target.network
        else {
            return Self.notSent("A impressora Wi-Fi confirmada não está mais disponível.")
        }
        state = .printing
        let result = await send(receipt, to: target.endpoint)
        switch result {
        case .delivered:
            state = networkProvider.currentNetwork() == target.network ? .ready : .wifiUnavailable
        case .failed:
            confirmed = nil
            state = .failed
        }
        return result
    }

    private func send(
        _ receipt: Data,
        to endpoint: LocalWifiPrinterEndpoint
    ) async -> ThermalPrintResult {
        do {
            try await transport.send(receipt, to: endpoint)
            return .delivered
        } catch let error as LocalWifiPrinterTransportError {
            return .failed(
                message: error.errorDescription ?? "Não foi possível enviar à impressora Wi-Fi.",
                delivery: error.delivery
            )
        } catch {
            // Implementações externas do protocolo podem lançar erro sem fase. Depois de chamar
            // `send`, o único resultado seguro é indeterminado.
            return .failed(
                message: "A conexão Wi-Fi caiu durante o envio.",
                delivery: .indeterminate
            )
        }
    }

    private static func notSent(_ message: String) -> ThermalPrintResult {
        .failed(message: message, delivery: .notSent)
    }

    private func activeCandidateNetwork() -> LocalWifiPrinterNetwork? {
        guard let network = candidateNetwork, let expiration = candidateExpiration, expiration > now(), networkProvider.currentNetwork() == network else {
            candidates = []
            candidateNetwork = nil
            candidateExpiration = nil
            return nil
        }
        return network
    }

    private func clearEphemeralSelections() {
        candidates = []
        candidateNetwork = nil
        candidateExpiration = nil
        pending = nil
        confirmed = nil
        operationalLayout = .counter
    }

    /// Resolve UUIDs medidos depois de reiniciar. O ID histórico do M1 continua apontando para o
    /// mesmo perfil embutido; IDs desconhecidos caem no perfil temporário conservador.
    private func restoreOperationalLayout() {
        guard let profileStore, let selection = restoringSelection() else {
            operationalLayout = .counter
            return
        }
        let profileId = selection.profileId
        let resolvedID = profileId == Self.profileId
            ? BundledPrinterProfiles.elginI9Full2.id
            : profileId
        let profile = PrinterProfileResolver(measured: profileStore.profiles()).resolve(
            profileId: resolvedID,
            transport: .localWifi,
            paperWidth: .mm80
        )
        operationalLayout = ReceiptLayout(profile: profile)
        // Depois da atribuição, que zera o perfil adotado. Sem isto, reabrir o app devolveria a
        // impressora ao modo padrão até a próxima adoção — e a pessoa não teria mexido em nada.
        adoptedProfile = profile
    }
}

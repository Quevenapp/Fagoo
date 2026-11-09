import CoreBluetooth
import Foundation

/// Impressora térmica Bluetooth LE. O iOS não abre SPP sem certificação MFi, então BLE é o único
/// caminho — e as portáteis 58mm de balcão anunciam o serviço padrão de impressora.
///
/// A impressora é reencontrada pelo anúncio a cada busca, e o rótulo mostrado à pessoa é
/// posicional. O identificador do periférico é persistido — no store cifrado, e só para saber qual
/// das que anunciam é a adotada; ele não vira rótulo, log nem nada que a pessoa veja.
enum BluetoothPrinterProfile {
    /// Serviço padrão de impressora térmica ESC/POS em BLE.
    static let escPosService = CBUUID(string: "18F0")
    static let escPosCharacteristic = CBUUID(string: "2AF1")

    /// Serviço genérico dos módulos usados por boa parte das portáteis chinesas.
    static let vendorService = CBUUID(string: "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2")
    static let vendorCharacteristic = CBUUID(string: "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F")

    static let services = [escPosService, vendorService]

    static func characteristics(for service: CBUUID) -> [CBUUID] {
        service == escPosService ? [escPosCharacteristic] : [vendorCharacteristic]
    }

    /// Portátil 58mm: 384 pontos imprimíveis, 32 colunas e sem guilhotina.
    static let printableDots = 384
    static let columns = 32
    static let hasCutter = false

    /**
     Nenhuma. Ela ignorou `ESC t` nas seis páginas sondadas em bancada (CP850, CP860, CP437, CP1252,
     CP866 e CP858) e não imprimiu uma linha acentuada legível em nenhuma — engoliu os bytes altos e
     comeu quebras de linha junto. Com `nil`, o acento dobra para ASCII e o cupom volta a ser lido.
     */
    static let codePage: ThermalCodePage? = nil
}

public enum BluetoothPrinterState: Equatable {
    case idle
    case unauthorized
    case poweredOff
    case searching
    case candidatesFound
    case connecting
    case testing
    case awaitingConfirmation
    case ready
    case printing
    case printerUnavailable
    case failed

    public var title: String {
        switch self {
        case .idle: return "Escolha uma impressora"
        case .unauthorized: return "Acesso Bluetooth não permitido"
        case .poweredOff: return "Bluetooth desligado"
        case .searching: return "Procurando impressora Bluetooth"
        case .candidatesFound: return "Escolha a impressora"
        case .connecting: return "Conectando à impressora"
        case .testing: return "Enviando comprovante"
        case .awaitingConfirmation: return "Confirme o comprovante"
        case .ready: return "Impressora pronta"
        case .printing: return "Imprimindo o cupom"
        case .printerUnavailable: return "Impressora não encontrada"
        case .failed: return "Não foi possível imprimir"
        }
    }

    public var message: String {
        switch self {
        case .idle: return "Ligue a impressora e procure as impressoras Bluetooth por perto."
        case .unauthorized:
            return "Autorize o Bluetooth para este aplicativo nos Ajustes do aparelho e tente novamente."
        case .poweredOff: return "Ligue o Bluetooth do aparelho e tente novamente."
        case .searching: return "Procurando impressoras térmicas Bluetooth ligadas por perto."
        case .candidatesFound: return "Escolha uma para enviar somente o comprovante de teste."
        case .connecting: return "Verificando a conexão da impressora escolhida."
        case .testing: return "Aguarde o envio do comprovante de teste."
        case .awaitingConfirmation: return "Confirme se o papel saiu na impressora escolhida."
        case .ready: return "A impressora confirmada está pronta para receber envios."
        case .printing: return "Enviando o cupom para a impressora confirmada."
        case .printerUnavailable: return "Confira se a impressora está ligada, com papel e por perto."
        case .failed: return "Tente novamente. A seleção atual não foi mantida."
        }
    }

    public var isBusy: Bool { self == .searching || self == .connecting || self == .testing || self == .printing }
}

/// Candidata efêmera. O `id` mostrado à pessoa é posicional e não deriva do UUID do periférico.
public struct BluetoothPrinterCandidate: Identifiable, Hashable, Sendable, CustomStringConvertible {
    public let id: Int
    public let label: String
    /// Nome que o aparelho anunciou, quando ele existe e passou pelo filtro de identificador
    /// técnico. É diferente de [label], que cai na numeração quando ninguém se identifica — e é
    /// este, não aquele, que serve para batizar o perfil medido.
    public let declaredName: String?
    /// `CBPeripheral.identifier` desta candidata: qual aparelho é este, entre os que responderam.
    ///
    /// O `id` posicional muda a cada varredura e não serve para reconhecer a impressora adotada
    /// depois de reabrir o app; este não muda. Viaja fechado — não entra em `description`, em
    /// rótulo nem em tela — e é nulo quando a candidata não veio do CoreBluetooth.
    public let peripheralIdentifier: UUID?

    public init(
        id: Int,
        label: String,
        declaredName: String? = nil,
        peripheralIdentifier: UUID? = nil
    ) {
        self.id = id
        self.label = label
        self.declaredName = declaredName
        self.peripheralIdentifier = peripheralIdentifier
    }

    public var description: String { "BluetoothPrinterCandidate(id=\(id))" }
}

/// Transporte isolado para permitir teste sem rádio.
public protocol BluetoothPrinterTransporting: AnyObject {
    var onStateChange: ((BluetoothPrinterRadioState) -> Void)? { get set }
    var onCandidates: (([BluetoothPrinterCandidate]) -> Void)? { get set }

    /// Teto de vazão de raster do perfil em uso, em bytes por segundo; `nil` é o envio byte a byte
    /// já homologado. Ver ``PrinterCapabilities/maxRasterBytesPerSecond``.
    ///
    /// Vale a partir do **próximo** trabalho: trocar o ritmo no meio de um cupom mudaria a conta de
    /// quem já está soltando bloco.
    var maxRasterBytesPerSecond: Int? { get set }

    func startScan()
    func stopScan()
    func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate,
        completion: @escaping (ThermalPrintResult) -> Void
    )
    func disconnect()
}

public extension BluetoothPrinterTransporting {
    /// Transporte que não pratica ritmo aceita o teto e o ignora, em vez de obrigar toda
    /// implementação — inclusive as de teste — a carregar um campo que ela não usa.
    var maxRasterBytesPerSecond: Int? {
        get { nil }
        set {}
    }
}

public enum BluetoothPrinterRadioState: Equatable {
    case unknown
    case unauthorized
    case poweredOff
    case ready
}

@MainActor
public final class BluetoothThermalPrinterController: ObservableObject {
    @Published public private(set) var state: BluetoothPrinterState = .idle
    @Published public private(set) var candidates: [BluetoothPrinterCandidate] = []

    private let transport: any BluetoothPrinterTransporting
    private let store: any PrinterSelectionStoring
    private let profileStore: PrinterProfileStore?
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
    private var pending: BluetoothPrinterCandidate?
    private var confirmed: BluetoothPrinterCandidate?
    private var adoptedLayout = ReceiptLayout.portable58mm
    /**
     Teto de vazão da unidade em uso, ou `nil` enquanto ninguém mediu.

     Anda junto do layout porque vem do mesmo perfil, e é entregue ao transporte no instante do
     envio: um só ponto de leitura, em vez de quatro pontos de troca — o mesmo motivo pelo qual a
     decoração é instalada dentro do setter de ``operationalLayout``.
     */
    private var operationalRasterCeiling: Int?
    /// Perfil operacional da candidata confirmada. O default preserva os bytes do M1 quando o
    /// controller é usado isoladamente, sem o agregado M2.
    ///
    /// A escrita instala a decoração do hospedeiro **em toda atribuição**, pelo mesmo motivo do
    /// controlador Wi-Fi: um dos quatro pontos de troca esquecido seria um cupom sem rodapé.
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
     um só lugar. Nada de identidade física entra aqui; o peripheral continua no registro cifrado.
     */
    private var adoptedProfile: PrinterProfile?

    /// Uma escolha preservada só volta a valer depois de a impressora ser reencontrada.
    private var restoring = false
    /**
     **Qual** unidade esta retomada procura. Com duas portáteis instaladas, "a seleção Bluetooth"
     deixou de ser uma só, e reencontrar a irmã da que está ativa é o cupom na impressora errada
     por outro caminho.

     É publicado porque a tela precisa dizer, no card **daquela** impressora, que é ela que está
     sendo procurada — e depois que ela não respondeu. Só o id da instalação sai daqui; o
     identificador do periférico continua fechado no registro cifrado.
     */
    @Published public private(set) var reconnectingInstallationId: String?
    /// Invalida closures já aceitas quando `reset()` encerra a sessão atual.
    private var operationGeneration: UInt64 = 0
    /**
     Quanto a retomada espera antes de desistir da impressora guardada.

     Entra por parâmetro pelo mesmo motivo de `samples` e `wait` na espera da tela: provar as duas
     saídas — reencontrou e desistiu — sem rádio e sem relógio. O padrão são os mesmos quinze
     segundos que ``ensureAdoptedPrinterIsReady()`` já se dá antes de recusar um trabalho.
     */
    private let reconnectDeadline: () async -> Void
    /// Invalida o prazo de uma retomada anterior: quem começou a próxima já decidiu por ela.
    private var reconnectGeneration: UInt64 = 0

    public init(
        transport: any BluetoothPrinterTransporting = CoreBluetoothPrinterTransport(),
        store: any PrinterSelectionStoring = KeychainPrinterSelectionStore(),
        profileStore: PrinterProfileStore? = nil,
        receiptDecoration: (any ReceiptDecoration)? = nil,
        codeEmissionOverride: @escaping @Sendable (String) -> ThermalCodeEmissionPreferences? = { _ in nil },
        reconnectDeadline: @escaping () async -> Void = {
            try? await Task.sleep(nanoseconds: 15_000_000_000)
        }
    ) {
        self.transport = transport
        self.store = store
        self.profileStore = profileStore
        self.receiptDecoration = receiptDecoration
        self.codeEmissionOverride = codeEmissionOverride
        self.reconnectDeadline = reconnectDeadline
        adoptedLayout = ReceiptLayout.portable58mm.decorated(by: receiptDecoration)
        transport.onStateChange = { [weak self] radio in
            Task { @MainActor in self?.apply(radio) }
        }
        transport.onCandidates = { [weak self] found in
            Task { @MainActor in self?.apply(found) }
        }
        // O perfil sobrevive ao processo; o peripheral não. Começar a busca junto com o
        // controller reduz a espera, e os métodos assíncronos abaixo ainda aguardam o reencontro
        // caso a pessoa toque antes de o CoreBluetooth publicar a candidata.
        restoreAdoptedPrinter()
    }

    public func search() {
        guard !state.isBusy else { return }
        pending = nil
        confirmed = nil
        candidates = []
        state = .searching
        transport.startScan()
    }

    @discardableResult
    public func testAccepted(_ candidate: BluetoothPrinterCandidate) -> Bool {
        guard state == .candidatesFound || state == .ready else { return false }
        state = .testing
        transport.stopScan()
        let generation = operationGeneration
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Bluetooth não está disponível.") }
            return await self.performTest(candidate, generation: generation)
        }
        return true
    }

    public func test(_ candidate: BluetoothPrinterCandidate) async -> ThermalPrintResult {
        guard state == .candidatesFound || state == .ready else {
            return Self.notSent("A impressora Bluetooth está ocupada.")
        }
        state = .testing
        transport.stopScan()
        let generation = operationGeneration
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Bluetooth não está disponível.") }
            return await self.performTest(candidate, generation: generation)
        }
    }

    /// Só a confirmação humana de que o papel saiu adota a impressora.
    public func confirmTestReceipt() {
        // Caminho M1, sem perfil medido: nada a declarar, e sem teto é como este cupom sempre saiu.
        _ = confirmPendingPrinter(profileId: Self.profileId, layout: .portable58mm, ceiling: nil)
    }

    /// Fecho da homologação M2. Reaproveita a candidata já testada e preserva o UUID medido em
    /// vez de regravar o perfil bundled do comprovante inicial.
    @discardableResult
    func confirmHomologatedProfile(_ profile: PrinterProfile) -> Bool {
        let layout = ReceiptLayout(profile: profile)
        if state == .awaitingConfirmation {
            let adotou = confirmPendingPrinter(
                profileId: profile.id,
                layout: layout,
                ceiling: profile.maxRasterBytesPerSecond
            )
            // Depois da atribuição do layout, que zera o perfil adotado de propósito. Só há
            // preferência a consultar quando a adoção deu certo.
            if adotou { adoptedProfile = profile }
            return adotou
        }
        guard state == .ready, let confirmed else { return false }
        let selection = PersistedPrinterSelection.bluetooth(
            profileId: profile.id,
            peripheralIdentifier: confirmed.peripheralIdentifier
        )
        store.save(store.read().with(selection))
        guard store.read().ofInstallation(selection.installationId) == selection else { return false }
        objectWillChange.send()
        operationalLayout = layout
        adoptedProfile = profile
        operationalRasterCeiling = profile.maxRasterBytesPerSecond
        return true
    }

    /**
     Reaplica o layout da unidade em uso depois de alguém regravar o perfil dela.

     A configuração manual grava no store, e o store não alcança o layout que já está em memória:
     sem isto, o cupom seguinte sairia com a página e o corte antigos até o app reabrir.
     */
    func reapplyOperationalLayout() {
        guard confirmed != nil else { return }
        restoreOperationalLayout()
        objectWillChange.send()
    }

    /// O adapter retém a candidata confirmada sem publicar handle, UUID ou rótulo técnico.
    func adoptedProbeSender() -> (any PrinterProbeSending)? {
        guard state == .ready, let confirmed else { return nil }
        return BluetoothPrinterProbeSender(transport: transport, candidate: confirmed)
    }

    @discardableResult
    private func confirmPendingPrinter(
        profileId: String,
        layout: ReceiptLayout,
        ceiling: Int?
    ) -> Bool {
        guard state == .awaitingConfirmation, let candidate = pending else { return false }
        // A pessoa confirmou o papel de **uma** impressora. Guardar qual foi é o que permite
        // reencontrá-la depois; sem isso, a retomada só sabia procurar "uma impressora".
        let selection = PersistedPrinterSelection.bluetooth(
            profileId: profileId,
            peripheralIdentifier: candidate.peripheralIdentifier
        )
        store.save(store.read().with(selection))
        // Pela unidade, e não pelo transporte: com duas portáteis instaladas, conferir "a seleção
        // Bluetooth" perguntaria por outra impressora.
        guard store.read().ofInstallation(selection.installationId) == selection else { return false }
        confirmed = candidate
        operationalLayout = layout
        operationalRasterCeiling = ceiling
        pending = nil
        candidates = []
        // Depois de uma escolha humana não há mais nada a retomar.
        restoring = false
        reconnectingInstallationId = nil
        state = .ready
        return true
    }

    public func discardTestReceipt() {
        guard state == .awaitingConfirmation, let discarded = pending else { return }
        pending = nil
        candidates.removeAll { $0.id == discarded.id }
        state = candidates.isEmpty ? .printerUnavailable : .candidatesFound
    }

    /// Agenda o cupom e informa somente que o trabalho entrou na fila; não afirma entrega.
    @discardableResult
    public func printAccepted(_ payload: any ThermalReceiptPayload) -> Bool {
        guard let prepared = prepare(payload) else { return false }
        state = .printing
        let generation = operationGeneration
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Bluetooth não está disponível.") }
            return await self.performPrint(
                prepared.receipt,
                to: prepared.candidate,
                generation: generation
            )
        }
        return true
    }

    /// Imprime e só retorna depois do desfecho final do transporte.
    public func print(_ payload: any ThermalReceiptPayload) async -> ThermalPrintResult {
        guard await ensureAdoptedPrinterIsReady() else {
            payload.clear()
            return Self.notSent("A impressora Bluetooth adotada não foi reencontrada.")
        }
        guard let prepared = prepare(payload) else {
            return Self.notSent("Não foi possível preparar o cupom para a impressora Bluetooth.")
        }
        state = .printing
        let generation = operationGeneration
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Bluetooth não está disponível.") }
            return await self.performPrint(
                prepared.receipt,
                to: prepared.candidate,
                generation: generation
            )
        }
    }

    /// Reenvia o comprovante de teste para a impressora já adotada. É o que confirma, depois de
    /// fechar e abrir o app, que a escolha preservada continua valendo.
    @discardableResult
    public func printTestReceiptAgainAccepted() -> Bool {
        guard state == .ready, let candidate = confirmed else { return false }
        // As duas respostas vêm do perfil adotado, e não do layout: um layout rasterizado não
        // distingue "é o padrão" de "foi o máximo que a medição permitiu".
        let receipt = Self.testReceipt(
            layout: operationalLayout,
            nativeQrHonored: adoptedProfile?.nativeQrHonored,
            nativeBarcodeHonored: adoptedProfile?.nativeBarcodeHonored
        )
        state = .printing
        let generation = operationGeneration
        printJobs.accept { [weak self] in
            guard let self else { return Self.notSent("O controlador Bluetooth não está disponível.") }
            return await self.performPrint(receipt, to: candidate, generation: generation)
        }
        return true
    }

    public func printTestReceiptAgain() async -> ThermalPrintResult {
        // BLE não fica conectado entre trabalhos. O próprio toque aguarda a varredura terminar;
        // exigir um segundo toque fazia teste, texto e imagem parecerem quebrados após reabrir.
        guard await ensureAdoptedPrinterIsReady() else {
            return Self.notSent("A impressora Bluetooth adotada não foi reencontrada.")
        }
        guard state == .ready, let candidate = confirmed else {
            return Self.notSent("Nenhuma impressora Bluetooth está confirmada.")
        }
        // As duas respostas vêm do perfil adotado, e não do layout: um layout rasterizado não
        // distingue "é o padrão" de "foi o máximo que a medição permitiu".
        let receipt = Self.testReceipt(
            layout: operationalLayout,
            nativeQrHonored: adoptedProfile?.nativeQrHonored,
            nativeBarcodeHonored: adoptedProfile?.nativeBarcodeHonored
        )
        state = .printing
        let generation = operationGeneration
        return await printJobs.run { [weak self] in
            guard let self else { return Self.notSent("O controlador Bluetooth não está disponível.") }
            return await self.performPrint(receipt, to: candidate, generation: generation)
        }
    }

    /// Desinstala a impressora Bluetooth **em uso** e esquece o que estava em memória.
    ///
    /// Era `without(.bluetooth)`, que apagava todas as instalações do meio físico de uma vez. Isso
    /// era coerente quando cabia uma impressora por transporte; com duas portáteis no balcão,
    /// descartar a T210 levava junto a MTP-II que ninguém mandou descartar.
    public func reset() {
        discardRuntimeSelection()
        store.save(store.read().withoutActiveAt(.bluetooth))
    }

    /**
     Esquece a impressora que está em memória sem tocar no que está guardado.

     Quem grava é o coordenador, e é ele quem sabe qual unidade continua instalada. Uma segunda
     gravação a partir daqui desinstalaria impressora que ninguém mandou desinstalar — foi assim
     que procurar no Bluetooth passou a desinstalar a que estava, no Android.
     */
    func discardRuntimeSelection() {
        operationGeneration &+= 1
        printJobs.cancelPending(returning: Self.notSent("A impressão Bluetooth foi cancelada."))
        transport.stopScan()
        transport.disconnect()
        pending = nil
        confirmed = nil
        operationalLayout = .portable58mm
        operationalRasterCeiling = nil
        candidates = []
        restoring = false
        reconnectingInstallationId = nil
        state = .idle
    }

    /// Solta a unidade em uso e vai atrás da que o store diz ser a ativa agora. A prontidão chega
    /// depois, pela varredura: quem troca de impressora vê a escolha no toque, não no fim do scan.
    func reconnectAdoptedPrinter() {
        discardRuntimeSelection()
        restoreAdoptedPrinter()
    }

    /**
     Vai atrás de **esta** unidade, e não da que o transporte estava servindo.

     Irmã de ``reconnectAdoptedPrinter()``, e a diferença é a única que importa aqui: aquela segue
     o store — que aponta para a ativa —, esta segue a instalação pedida. Existe para o comprovante
     de teste do card: com duas portáteis instaladas, o transporte guarda a conexão de uma só, e
     conferir a que está parada não pode alcançar a irmã.

     Solta a conexão anterior antes de procurar, de propósito: deixá-la viva é o que faria o cupom
     cair na impressora errada quando a pedida não respondesse.
     */
    func restoreInstallation(_ installationId: String) {
        guard case .bluetooth? = store.read().ofInstallation(installationId) else { return }
        discardRuntimeSelection()
        reconnectingInstallationId = installationId
        restoring = true
        search()
        startReconnectDeadline()
    }

    /// Retoma a escolha preservada procurando a impressora de novo. Com identidade guardada, só a
    /// que bate é adotada; sem ela, só uma candidata única. Nos outros casos a pessoa escolhe,
    /// como na primeira vez.
    public func restoreAdoptedPrinter() {
        guard confirmed == nil, let selection = store.read().of(.bluetooth) else { return }
        reconnectingInstallationId = selection.installationId
        restoring = true
        search()
        startReconnectDeadline()
    }

    /**
     Toda retomada tem prazo.

     A varredura que a pessoa **pede** continua aberta, de propósito: muitas térmicas só publicam o
     serviço no scan response, e desistir cedo esconderia impressora que ainda vai anunciar. A
     retomada é outra coisa — ninguém pediu, ela roda ao abrir o app —, e sem prazo ela ficava em
     `.searching` para sempre quando a impressora guardada estava desligada. `.searching` é
     ocupação, e ocupação eterna é o que deixou a tela de impressoras inteira cinza no iPhone 7 em
     21/08, sem uma linha dizendo o que acontecia. Estado eterno não é espera: é defeito.
     */
    private func startReconnectDeadline() {
        reconnectGeneration &+= 1
        let generation = reconnectGeneration
        let deadline = reconnectDeadline
        Task { @MainActor [weak self] in
            await deadline()
            guard let self, self.reconnectGeneration == generation, self.restoring,
                  self.state == .searching
            else { return }
            self.reconnectGaveUp()
        }
    }

    /// A retomada desistiu. A escolha continua guardada — quem desinstala é a pessoa —, e o que
    /// esta saída diz é que a impressora não respondeu no prazo.
    private func reconnectGaveUp() {
        restoring = false
        transport.stopScan()
        candidates = []
        // O id fica: é por ele que a tela sabe em qual card dizer que ninguém respondeu.
        state = .printerUnavailable
    }

    /// A unidade que esta retomada procura, e não "a seleção Bluetooth": com duas instaladas, são
    /// coisas diferentes.
    private func restoringSelection() -> PersistedPrinterSelection? {
        let stored = store.read()
        return reconnectingInstallationId.flatMap(stored.ofInstallation) ?? stored.of(.bluetooth)
    }

    /// Aguarda somente o reencontro anterior ao envio. Nenhum byte foi aceito pelo CoreBluetooth
    /// neste ponto, portanto uma nova varredura não cria risco de cupom duplicado.
    private func ensureAdoptedPrinterIsReady() async -> Bool {
        if state == .ready, confirmed != nil { return true }
        // Trabalho em curso, confirmação humana pendente ou falha anterior não são retomada de
        // processo. Em especial, `.failed` pode representar envio indeterminado e nunca autoriza
        // reencontro seguido de repetição automática.
        if state == .connecting || state == .testing || state == .awaitingConfirmation ||
            state == .printing || state == .failed || (state == .candidatesFound && !restoring) {
            return false
        }
        guard case .bluetooth? = store.read().of(.bluetooth) else { return false }
        if !restoring { restoreAdoptedPrinter() }

        // A busca BLE é aberta porque muitas térmicas anunciam o serviço só no scan response.
        // Quinze segundos acompanha o prazo de abertura GATT já usado pelo transporte.
        for _ in 0..<150 {
            if state == .ready, confirmed != nil { return true }
            if state == .unauthorized || state == .poweredOff { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return state == .ready && confirmed != nil
    }

    static let profileId = "generic.portable58.escpos"

    /// Comprovante de teste da portátil. O da impressora de balcão nomeia o modelo e pede corte,
    /// que aqui seria mentira e comando inútil.
    /// Pelo layout **do perfil adotado**: o comprovante repete o que a bancada mediu, e é ele que
    /// prova que o perfil relido do disco é o mesmo. Impressora que recebe bytes ainda erra acento,
    /// corta em cima do texto ou não faz raster — nada disso aparecia nas quatro linhas antigas.
    static func testReceipt(
        layout: ReceiptLayout = .portable58mm,
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil
    ) -> Data {
        PrinterTestReceipt.bytes(
            layout: layout,
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored
        )
    }

    private func prepare(
        _ payload: any ThermalReceiptPayload
    ) -> (receipt: Data, candidate: BluetoothPrinterCandidate)? {
        // A assinatura não fica retida enquanto trabalhos anteriores drenam a fila.
        defer { payload.clear() }
        guard state == .ready || state == .printing else { return nil }
        guard let candidate = confirmed,
              let receipt = decoratedReceiptBytes(of: payload, layout: operationalLayout)
        else {
            if confirmed != nil { state = .failed }
            return nil
        }
        return (receipt, candidate)
    }

    private func performTest(
        _ candidate: BluetoothPrinterCandidate,
        generation: UInt64
    ) async -> ThermalPrintResult {
        guard generation == operationGeneration, state == .testing else {
            return Self.notSent("O teste Bluetooth foi cancelado.")
        }
        let result = await send(
            Self.testReceipt(
                layout: operationalLayout,
                nativeQrHonored: adoptedProfile?.nativeQrHonored,
                nativeBarcodeHonored: adoptedProfile?.nativeBarcodeHonored
            ),
            to: candidate
        )
        guard generation == operationGeneration, state == .testing else { return result }
        switch result {
        case .delivered:
            pending = candidate
            state = .awaitingConfirmation
        case .failed:
            state = .printerUnavailable
        }
        return result
    }

    private func performPrint(
        _ receipt: Data,
        to candidate: BluetoothPrinterCandidate,
        generation: UInt64
    ) async -> ThermalPrintResult {
        guard generation == operationGeneration,
              (state == .ready || state == .printing),
              confirmed == candidate
        else {
            return Self.notSent("A impressora Bluetooth confirmada não está mais disponível.")
        }
        state = .printing
        let result = await send(receipt, to: candidate)
        guard generation == operationGeneration, state == .printing else { return result }
        switch result {
        case .delivered:
            state = .ready
        case .failed:
            // Qualquer falha invalida a seleção em memória. Em `indeterminate`, repetir sozinho
            // poderia entregar duas fichas válidas; em `notSent`, o novo teste prova o caminho.
            confirmed = nil
            state = .failed
        }
        return result
    }

    private func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate
    ) async -> ThermalPrintResult {
        // Um ponto de leitura só, no instante do envio: o ritmo vale para todo cupom que sai por
        // aqui — venda, comprovante de teste e reimpressão — sem cada caminho lembrar disso.
        transport.maxRasterBytesPerSecond = operationalRasterCeiling
        return await withCheckedContinuation { continuation in
            transport.send(payload, to: candidate) { result in
                Task { @MainActor in continuation.resume(returning: result) }
            }
        }
    }

    private static func notSent(_ message: String) -> ThermalPrintResult {
        .failed(message: message, delivery: .notSent)
    }

    private func apply(_ radio: BluetoothPrinterRadioState) {
        switch radio {
        case .unauthorized:
            state = .unauthorized
            candidates = []
        case .poweredOff:
            state = .poweredOff
            candidates = []
        case .ready, .unknown:
            break
        }
    }

    private func apply(_ found: [BluetoothPrinterCandidate]) {
        guard state == .searching || state == .candidatesFound else { return }
        candidates = found
        if restoring {
            if let adopted = restoringSelection()?.peripheralIdentifier {
                // Com identidade guardada, quantas responderam deixa de importar: ou está a dela
                // na lista, ou nenhuma serve. Adotar a que sobrou foi o que imprimiu na MTP-II em
                // 20/08, com a T210 adotada e dormindo do lado.
                if let mesma = found.first(where: { $0.peripheralIdentifier == adopted }) {
                    return adoptRestored(mesma)
                }
                // A busca continua até o prazo de quem espera o papel, e a lista fica aberta para
                // uma escolha humana — com comprovante e confirmação, como na primeira vez.
                state = found.isEmpty ? .searching : .candidatesFound
                return
            }
            // Entrada legada, gravada antes de a identidade existir: candidata única volta a
            // valer sozinha, que é a paridade com o Android, onde `address` nulo cai em
            // `singleOrNull`. Duas continuam exigindo escolha.
            if found.count == 1 { return adoptRestored(found[0]) }
        }
        if found.count > 1 { restoring = false }
        state = found.isEmpty ? .searching : .candidatesFound
    }

    /// Retoma sem novo comprovante: é a mesma unidade que uma pessoa já confirmou no papel.
    private func adoptRestored(_ candidate: BluetoothPrinterCandidate) {
        restoring = false
        confirmed = candidate
        restoreOperationalLayout()
        reconnectingInstallationId = nil
        candidates = []
        transport.stopScan()
        state = .ready
    }

    /// O layout vem do perfil, não da identidade: depois do reencontro BLE, os perfis embutidos e
    /// medidos recompõem a largura, a página e o corte da unidade que foi adotada.
    private func restoreOperationalLayout() {
        guard let profileStore, let selection = restoringSelection() else {
            operationalLayout = .portable58mm
            operationalRasterCeiling = nil
            return
        }
        let profile = PrinterProfileResolver(measured: profileStore.profiles()).resolve(
            profileId: selection.profileId,
            transport: .bluetooth,
            paperWidth: .mm58
        )
        operationalLayout = ReceiptLayout(profile: profile)
        // Depois da atribuição, que zera o perfil adotado. Sem isto, reabrir o app devolveria a
        // impressora ao modo padrão até a próxima adoção — e a pessoa não teria mexido em nada.
        adoptedProfile = profile
        // O ritmo é recomposto junto com a largura e o corte: sem isto, reabrir o app devolveria a
        // foto encolhida na impressora que a bancada já tinha medido.
        operationalRasterCeiling = profile.maxRasterBytesPerSecond
    }
}

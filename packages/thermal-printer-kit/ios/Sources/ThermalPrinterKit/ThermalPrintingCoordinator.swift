import Combine
import Foundation

/// Impressora confirmada e o meio pelo qual ela é alcançada. Nenhum endereço é exposto.
public struct AdoptedPrinter: Identifiable, Equatable {
    public let transport: PrinterTransport
    public let displayName: String
    public let active: Bool
    /// Aviso conservador quando a seleção não pôde ser resolvida para um perfil persistido ou
    /// bundled. Nunca contém endpoint nem identificador do periférico.
    public let warning: String?
    /// Identifica somente o perfil em uso; nunca o aparelho. Espelha o campo do Android, e vale a
    /// mesma leitura: perfil é capacidade de impressão, não identidade — não há endereço, MAC,
    /// VID/PID nem UUID de periférico aqui, e o próprio store recusaria um ID que parecesse um.
    ///
    /// `nil` quando nada foi resolvido, pelo mesmo motivo de ``printableDots``.
    public let profileId: String?
    /**
     Largura imprimível do perfil resolvido, em pontos.

     Existe porque o hospedeiro precisa dela para rasterizar na medida certa — logotipo, foto,
     qualquer imagem — e o caminho que sobrava era desfazer o mapeamento por `displayName`, que
     acerta enquanto dois perfis não tiverem o mesmo nome. É a mesma largura que o cupom vai usar:
     sai do mesmo `PrinterProfileResolver` que recompõe o layout operacional dos controladores.

     `nil` quando não há store de perfis para resolver — sem ele, `displayName` também cai no
     rótulo genérico. Vale inclusive quando o perfil resolvido é o temporário conservador: a
     largura publicada continua sendo a que sai no papel, e é o ``warning`` que diz que ela não foi
     medida.
     */
    public let printableDots: Int?
    /**
     Identifica esta **unidade**, e não o modelo dela.

     Duas impressoras iguais no mesmo balcão são duas instalações e têm ids diferentes aqui. O
     valor é o perfil mais um resumo truncado da identidade física — nunca o endereço, que não sai
     do store cifrado. É por ele que se ativa e se exclui uma impressora: ``PrinterTransport``
     deixou de identificar unidade no dia em que duas passaram a caber no mesmo meio físico.

     Diferente do Android, aqui ele não é opcional: quem monta este valor é sempre o coordenador, a
     partir da instalação guardada, e um caminho alternativo sem id seria um botão de excluir sem
     saber o que excluir.
     */
    public let installationId: String

    public var id: String { installationId }
    public var transportLabel: String { transport.label }
}

/**
 Reúne os transportes de impressão. No Android um objeto só cuida de Wi-Fi, USB e Bluetooth; aqui
 são dois controladores independentes, e este coordenador é quem sabe qual deles recebe os cupons.

 O balcão pode ter a impressora de rede e a portátil adotadas ao mesmo tempo — só a ativa imprime.
 */
@MainActor
public final class ThermalPrintingCoordinator: ObservableObject {
    @Published public private(set) var adoptedPrinters: [AdoptedPrinter] = []

    public let localWifi: LocalWifiThermalPrinterController
    public let bluetooth: BluetoothThermalPrinterController

    private let store: any PrinterSelectionStoring
    private let profileStore: PrinterProfileStore?
    private var observers: [AnyCancellable] = []

    /// - Parameter receiptDecoration: cabeçalho e rodapé do hospedeiro. Só vale para os
    ///   controladores que este coordenador cria; quem injeta os seus próprios os configura na
    ///   construção deles. Ver ``ReceiptDecoration``.
    public init(
        store: any PrinterSelectionStoring = KeychainPrinterSelectionStore(),
        localWifi: LocalWifiThermalPrinterController? = nil,
        bluetooth: BluetoothThermalPrinterController? = nil,
        profileStore: PrinterProfileStore? = nil,
        receiptDecoration: (any ReceiptDecoration)? = nil
    ) {
        self.store = store
        self.profileStore = profileStore
        self.localWifi = localWifi ?? LocalWifiThermalPrinterController(
            store: store,
            profileStore: profileStore,
            receiptDecoration: receiptDecoration
        )
        self.bluetooth = bluetooth ?? BluetoothThermalPrinterController(
            store: store,
            profileStore: profileStore,
            receiptDecoration: receiptDecoration
        )
        // Confirmar ou descartar uma impressora muda o que está guardado; a lista acompanha.
        observers = [
            self.localWifi.objectWillChange.sink { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            },
            self.bluetooth.objectWillChange.sink { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            },
        ]
        refresh()
    }

    /// Compatibilidade: ativa a primeira impressora confirmada deste transporte. Com duas
    /// instaladas no mesmo meio físico o transporte não distingue qual delas recebe o cupom — quem
    /// sabe a unidade chama ``activateInstallation(_:)``.
    public func activate(_ transport: PrinterTransport) {
        guard let selection = store.read().selections.first(where: { $0.transport == transport })
        else { return }
        activateInstallation(selection.installationId)
    }

    /**
     Passa a mandar os cupons para **esta** unidade.

     A escolha é gravada e publicada no mesmo toque; a reconexão vem depois e só atualiza a
     prontidão. Segurar a publicação até o fim da reconexão foi o que, no Android, deixou o check
     congelado na impressora anterior por segundos — na bancada isso se lê como "não dá para
     selecionar a outra".
     */
    public func activateInstallation(_ installationId: String) {
        let stored = store.read()
        guard let selection = stored.ofInstallation(installationId) else { return }
        let jaAtendendo = stored.activeSelection?.installationId == installationId
            && isReady(selection.transport)
        store.save(stored.activatedInstallation(installationId))
        refresh()
        // Reconectar a que já está pronta e servindo custaria uma varredura por nada.
        if !jaAtendendo { reconnect(selection.transport) }
    }

    /**
     Exclui **uma** impressora, sem tocar nas irmãs.

     O perfil medido só é apagado quando nenhuma outra unidade ainda o usa: duas portáteis do mesmo
     modelo compartilham a medição, e remover uma não pode levar a capacidade da outra. Medição
     feita por uma pessoa na bancada nunca se perde por efeito colateral.
     */
    public func removeInstallation(_ installationId: String) {
        let stored = store.read()
        guard let removed = stored.ofInstallation(installationId) else { return }
        let eraAtiva = stored.activeSelection?.installationId == installationId
        let restante = stored.withoutInstallation(installationId)
        if restante.selections.allSatisfy({ $0.profileId != removed.profileId }) {
            try? profileStore?.remove(id: removed.profileId)
        }
        store.save(restante)
        if eraAtiva {
            discardRuntimeSelection(removed.transport)
            if let proxima = restante.activeSelection { reconnect(proxima.transport) }
        }
        refresh()
    }

    private func isReady(_ transport: PrinterTransport) -> Bool {
        switch transport {
        case .bluetooth: return bluetooth.state == .ready
        case .localWifi: return localWifi.state == .ready
        }
    }

    private func reconnect(_ transport: PrinterTransport) {
        switch transport {
        case .bluetooth: bluetooth.reconnectAdoptedPrinter()
        case .localWifi: localWifi.reconnectAdoptedPrinter()
        }
    }

    private func discardRuntimeSelection(_ transport: PrinterTransport) {
        switch transport {
        case .bluetooth: bluetooth.discardRuntimeSelection()
        case .localWifi: localWifi.discardRuntimeSelection()
        }
    }

    /// Agenda na impressora ativa e informa somente que o trabalho entrou na fila.
    @discardableResult
    public func printAccepted(_ payload: any ThermalReceiptPayload) -> Bool {
        switch store.read().active {
        case .bluetooth:
            return bluetooth.printAccepted(payload)
        case .localWifi:
            return localWifi.printAccepted(payload)
        case nil:
            // Ninguém adotou impressora: o payload não seguiria adiante, então a assinatura
            // também não pode ficar viva esperando uma segunda tentativa.
            payload.clear()
            return false
        }
    }

    /// Imprime na impressora ativa e devolve o desfecho final, não o agendamento.
    public func print(_ payload: any ThermalReceiptPayload) async -> ThermalPrintResult {
        switch store.read().active {
        case .bluetooth:
            return await bluetooth.print(payload)
        case .localWifi:
            return await localWifi.print(payload)
        case nil:
            payload.clear()
            return .failed(
                message: "Nenhuma impressora está ativa neste aparelho.",
                delivery: .notSent
            )
        }
    }

    /**
     Testa uma impressora adotada sem trocar quem recebe os cupons. No balcão, diagnosticar uma
     impressora não pode custar a troca da que está em uso.
     */
    @discardableResult
    public func testAccepted(_ transport: PrinterTransport) -> Bool {
        switch transport {
        case .bluetooth:
            return bluetooth.printTestReceiptAgainAccepted()
        case .localWifi:
            return localWifi.printTestReceiptAgainAccepted()
        }
    }

    public func test(_ transport: PrinterTransport) async -> ThermalPrintResult {
        switch transport {
        case .bluetooth:
            return await bluetooth.printTestReceiptAgain()
        case .localWifi:
            return await localWifi.printTestReceiptAgain()
        }
    }

    /**
     Testa **a unidade do card tocado**, e não uma impressora qualquer daquele meio físico.

     ``test(_:)`` mira o transporte, e o controlador guarda uma conexão por transporte: a da unidade
     que está servindo. Com duas portáteis instaladas, pedir o comprovante da que está parada
     alcançava a irmã ativa, e o papel saía na impressora que ninguém tocou — medido no iPhone 7 em
     20/08. É o mesmo defeito que `dfce4fa` corrigiu na configuração manual, por outra porta.

     Testar não escolhe: a ativa continua ativa, nada é gravado, e a conexão em memória dela é
     devolvida quando o teste termina, tenha saído papel ou não. Unidade que não responde recusa
     nomeando a impressora, sem byte em impressora nenhuma — cair na ativa seria o próprio defeito.
     */
    public func testInstallation(_ installationId: String) async -> ThermalPrintResult {
        let stored = store.read()
        guard let selection = stored.ofInstallation(installationId) else {
            return .failed(
                message: "Esta impressora não está instalada neste aparelho.",
                delivery: .notSent
            )
        }
        // O transporte já está nesta unidade — inclusive quando ela é a ativa. Caminho de sempre,
        // byte a byte, sem varredura extra.
        guard stored.of(selection.transport)?.installationId != installationId else {
            return await test(selection.transport)
        }
        let nome = adoptedPrinters.first { $0.installationId == installationId }?.displayName
            ?? Self.displayName(for: selection)
        let resultado: ThermalPrintResult
        switch selection.transport {
        case .bluetooth:
            bluetooth.restoreInstallation(installationId)
            resultado = await bluetooth.printTestReceiptAgain()
            // A mira volta para quem estava servindo. `reconnect` relê o store, que este caminho
            // não tocou: é exatamente a unidade de antes do teste.
            bluetooth.reconnectAdoptedPrinter()
        case .localWifi:
            localWifi.restoreInstallation(installationId)
            resultado = await localWifi.printTestReceiptAgain()
            localWifi.reconnectAdoptedPrinter()
        }
        // Só quando nada saiu. Falha depois do primeiro byte fala de papel, e trocá-la por "não
        // respondeu" apagaria o aviso que manda conferir a impressora antes de repetir.
        guard case .failed(_, .notSent) = resultado else { return resultado }
        return .failed(
            message: "\(nome) não respondeu — confira se ela está ligada.",
            delivery: .notSent
        )
    }

    /// Reenvia o comprovante de teste para a impressora ativa.
    @discardableResult
    public func printTestReceiptAgainAccepted() -> Bool {
        switch store.read().active {
        case .bluetooth:
            return bluetooth.printTestReceiptAgainAccepted()
        case .localWifi:
            return localWifi.printTestReceiptAgainAccepted()
        case nil:
            return false
        }
    }

    public func printTestReceiptAgain() async -> ThermalPrintResult {
        switch store.read().active {
        case .bluetooth:
            return await bluetooth.printTestReceiptAgain()
        case .localWifi:
            return await localWifi.printTestReceiptAgain()
        case nil:
            return .failed(
                message: "Nenhuma impressora está ativa neste aparelho.",
                delivery: .notSent
            )
        }
    }

    public var activeTransport: PrinterTransport? { store.read().active }

    /// Republica a lista a partir do que está guardado.
    ///
    /// Interna, e não privada, por causa da configuração manual: ela regrava o perfil de uma
    /// unidade sem passar por nenhum controlador — a impressora pode estar até desligada —, e sem
    /// este empurrão o card continuaria mostrando o nome e a largura antigos.
    func refresh() {
        let stored = store.read()
        adoptedPrinters = stored.selections.map { selection in
            let resolved = resolvedProfile(for: selection)
            return AdoptedPrinter(
                transport: selection.transport,
                displayName: resolved?.displayName ?? Self.displayName(for: selection),
                // Por unidade, não por transporte: com duas iguais instaladas, comparar o meio
                // físico marcaria as duas como ativas.
                active: selection.installationId == stored.activeSelection?.installationId,
                warning: resolved?.warning,
                profileId: resolved?.id,
                printableDots: resolved?.printableDots,
                installationId: selection.installationId
            )
        }
    }

    private func resolvedProfile(for selection: PersistedPrinterSelection) -> PrinterProfile? {
        guard let profileStore else { return nil }
        let profileId: String
        let paperWidth: PrinterPaperWidth
        switch selection {
        case .localWifi:
            // O ID do M1 antecede os perfis M2, mas representa exatamente o layout embutido da
            // impressora de balcão já homologada.
            profileId = selection.profileId == LocalWifiThermalPrinterController.profileId
                ? BundledPrinterProfiles.elginI9Full2.id
                : selection.profileId
            paperWidth = .mm80
        case .bluetooth:
            // A identidade da unidade não participa da resolução de perfil: ela diz em qual
            // impressora imprimir, nunca com que largura.
            profileId = selection.profileId
            paperWidth = .mm58
        }
        return PrinterProfileResolver(measured: profileStore.profiles()).resolve(
            profileId: profileId,
            transport: selection.transport,
            paperWidth: paperWidth
        )
    }

    private static func displayName(for selection: PersistedPrinterSelection) -> String {
        switch selection {
        case .localWifi: return "Impressora de balcão"
        case .bluetooth: return "Portátil 58mm"
        }
    }
}

import Combine
import Foundation
import ThermalPrinterKit

struct ThermalPrinterReadyProfile: Equatable, Identifiable {
    let id: String
    let displayName: String
    let source: PrinterProfileSource
    let capabilities: PrinterCapabilities

    init(_ profile: MeasuredProfile) {
        id = profile.id
        displayName = profile.displayName
        source = .measured
        capabilities = profile.capabilities
    }

    init(_ profile: PrinterProfile) {
        id = profile.id
        displayName = profile.displayName
        source = profile.source
        capabilities = profile.capabilities
    }

    var badge: String {
        switch source {
        case .measured: return "Medida neste aparelho"
        case .bundled: return "Homologada por nós"
        default: return ""
        }
    }

    var detail: String {
        let cutter = capabilities.cutProtocol.hasCutter ? "corta o papel" : "sem guilhotina"
        return "\(capabilities.paperWidth.rawValue) mm · \(cutter)"
    }
}

enum ThermalPrinterConnectionMode: String, CaseIterable, Equatable, Identifiable {
    case usb
    case bluetooth
    case directWifi
    case localNetwork

    var id: String { rawValue }

    var title: String {
        switch self {
        case .usb: return "Cabo USB"
        case .bluetooth: return "Bluetooth"
        case .directWifi: return "Wi-Fi da impressora"
        case .localNetwork: return "Rede do local"
        }
    }

    var detail: String {
        switch self {
        case .usb: return "Ela fica ligada por cabo neste celular"
        case .bluetooth: return "Sem fio, pertinho do celular"
        case .directWifi: return "O celular se conecta direto nela"
        case .localNetwork: return ThermalPrinterSetupCopy.localNetworkDetail
        }
    }

    var symbol: String {
        switch self {
        case .usb: return "cable.connector"
        case .bluetooth: return "dot.radiowaves.left.and.right"
        case .directWifi: return "wifi"
        case .localNetwork: return "network"
        }
    }

    /// Wi-Fi direto e rede local continuam sobre o mesmo transporte nesta fase. Separar o vínculo
    /// de rede pertence à Fase 6 e não pode alterar a chave de capacidades aqui.
    var operationalTransport: PrinterTransport? {
        switch self {
        case .usb: return nil
        case .bluetooth: return .bluetooth
        case .directWifi, .localNetwork: return .localWifi
        }
    }

    func isShown(for capabilities: PrinterCapabilities) -> Bool {
        switch self {
        case .usb:
            return capabilities.transports.contains(.usb)
        case .bluetooth:
            return capabilities.transports.contains(.bluetooth) ||
                capabilities.transports.contains(.bluetoothLE)
        case .directWifi, .localNetwork:
            return capabilities.transports.contains(.localWifi)
        }
    }

    func unavailabilityReason(for capabilities: PrinterCapabilities?) -> String? {
        switch self {
        case .usb:
            return "Não disponível neste aparelho"
        case .bluetooth:
            guard let capabilities else { return nil }
            if capabilities.transports.contains(.bluetoothLE) { return nil }
            if capabilities.transports.contains(.bluetooth) {
                return "Bluetooth clássico (SPP) não está disponível neste aparelho"
            }
            return "Esta impressora não oferece Bluetooth"
        case .directWifi, .localNetwork:
            guard let capabilities else { return nil }
            return capabilities.transports.contains(.localWifi)
                ? nil
                : "Esta impressora não oferece conexão de rede"
        }
    }
}

enum ThermalPrinterSetupRoute: Equatable {
    case profiles
    case readyConnections(profileID: String)
    case newConnections
    case search(mode: ThermalPrinterConnectionMode, profileID: String?)
    case paperCost(mode: ThermalPrinterConnectionMode, profileID: String?)
    case modelGrid
    case manualWifi(ThermalPrinterManualTarget)
    /// As opções operacionais de uma unidade instalada: página, corte, avanço e largura.
    case manualConfiguration(ThermalPrinterManualTarget)
}

enum ThermalPrinterSetupCopy {
    static let localNetworkDetail = "Ela está no mesmo Wi-Fi ou no cabo de rede"
    static let iOSNetworkLimit = "Rede do local usa a Wi-Fi do aparelho. Adaptador USB-Ethernet não está disponível no iOS."
    static let continueTitle = "Continuar"
    static let searchAlternative = "Não apareceu? Tente conectar de outro jeito."
}

/// Identificadores herdados da tela homologada do consumidor. Alterá-los quebraria as sondas de
/// navegação dos apps, por isso as Views e os testes compartilham esta lista explícita.
enum ThermalPrinterSetupAccessibility {
    static let screen = "printerSetup.screen"
    static let search = "printerSetup.search"
    static let profile = "printerSetup.profile"
    static let manualToggle = "printerSetup.manual.toggle"
    static let manualAddress = "printerSetup.manual.address"
    static let manualPort = "printerSetup.manual.port"
    static let manualTest = "printerSetup.manual.test"
    static let manualEntry = "printerSetup.manual.entry"

    /// Os campos da configuração manual, espelhando as `testTag` do Android — é por eles que as
    /// sondas de navegação dos apps alcançam página, corte e largura.
    static let manualConfiguration = "printerSetup.manual.configuration"
    static let manualName = "printerSetup.manual.name"
    static let manualColumns = "printerSetup.manual.columns"
    static let manualSave = "printerSetup.manual.save"
    static let manualPrint = "printerSetup.manual.print"
    static let manualWarning = "printerSetup.manual.warning"

    static func manualPaperWidth(_ millimeters: Int) -> String {
        "printerSetup.manual.paperWidth.\(millimeters)"
    }
    static func manualPrintableDots(_ dots: Int) -> String { "printerSetup.manual.dots.\(dots)" }
    static func manualCutter(_ present: Bool) -> String {
        "printerSetup.manual.cutter.\(present ? "yes" : "no")"
    }
    static func manualCutProtocol(_ protocolo: String) -> String {
        "printerSetup.manual.cutProtocol.\(protocolo)"
    }
    static func manualCutFeed(_ lines: Int) -> String { "printerSetup.manual.cutFeed.\(lines)" }
    static func manualEncoding(_ letter: Character) -> String {
        "printerSetup.manual.encoding-\(letter)"
    }

    static func manualProfile(_ id: String) -> String { "printerSetup.manual.profile.\(id)" }
    static let bluetoothSearch = "printerSetup.bluetooth.search"
    static let candidateContinue = "printerSetup.candidate.continue"
    static let connecting = "printerSetup.connecting"

    static func candidate(_ id: Int) -> String { "printerSetup.candidate.\(id)" }
    static func bluetoothCandidate(_ id: Int) -> String {
        "printerSetup.bluetooth.candidate.\(id)"
    }
    static func adopted(_ transport: PrinterTransport) -> String { adopted(slug: transport.rawValue) }
    static func test(_ transport: PrinterTransport) -> String { test(slug: transport.rawValue) }

    static func adopted(slug: String) -> String { "printerSetup.adopted.\(slug)" }
    static func test(slug: String) -> String { "printerSetup.test.\(slug)" }
    static func edit(slug: String) -> String { "printerSetup.edit.\(slug)" }
    static func remove(slug: String) -> String { "printerSetup.remove.\(slug)" }
    static func warning(slug: String) -> String { "printerSetup.warning.\(slug)" }
    /// A linha que diz que o transporte está procurando **esta** unidade, ou que desistiu dela.
    static func reach(slug: String) -> String { "printerSetup.reach.\(slug)" }

    /**
     Como uma unidade da lista se identifica na tela.

     Enquanto o meio físico tem uma instalação só, o identificador histórico continua valendo — é
     o que as sondas dos apps já procuram, e trocá-lo por um resumo de identidade quebraria todas
     de uma vez. A segunda unidade do mesmo transporte é o que obriga a desempatar: sem isso, os
     dois cards, os dois botões de teste e os dois avisos nascem com o mesmo identificador, e não
     há como tocar num deles em particular. É o mesmo critério do Android.
     */
    static func installationSlug(
        _ printer: AdoptedPrinter,
        among printers: [AdoptedPrinter]
    ) -> String {
        let noMesmoMeioFisico = printers.filter { $0.transport == printer.transport }
        guard noMesmoMeioFisico.count > 1 else { return printer.transport.rawValue }
        return "\(printer.transport.rawValue).\(printer.installationId)"
    }
}

/// Estado de apresentação separado da impressora. Em particular, fechar uma apresentação do
/// SwiftUI nunca é convertido em resposta sobre o que aconteceu no papel.
@MainActor
final class ThermalPrinterSetupFlow: ObservableObject {
    @Published private(set) var route: ThermalPrinterSetupRoute = .profiles
    @Published private(set) var suppressesReceiptQuestion = false
    @Published var showsHomologation = false
    @Published private(set) var homologationPreparationAccepted = false
    /**
     O assistente deve abrir direto no formulário declarado, em vez das sondas.

     Quem escolhe "Configuração manual" na abertura do custo em papel já sabe largura, colunas,
     acento, corte e avanço, e não quer atravessar as tiras. A declaração, porém, não termina antes
     do comprovante de conexão: instalar declarado exige a candidata confirmada em memória, e o core
     recusa sem ela — por isso a escolha paga **essa** tira, a mesma que a tela já anunciava, e
     nenhuma sonda. A resposta sobre o papel continua sendo a de sempre; o que este sinal muda é
     onde o assistente abre depois dela.
     */
    @Published private(set) var homologationOpensManualConfiguration = false
    @Published private(set) var notice: String?
    /// Qual unidade a tela está reconectando agora, se alguma. Ver ``activationStarted(_:)``.
    @Published private(set) var connecting: ConnectingPrinter?
    /// Qual unidade está com o comprovante a caminho, se alguma. Ver ``testStarted(_:)``.
    @Published private(set) var testing: ConnectingPrinter?

    /// A impressora do aviso "Conectando…". Só nome e unidade: nada do que identifica o aparelho
    /// fisicamente passa por aqui.
    struct ConnectingPrinter: Equatable {
        let installationId: String
        let displayName: String
    }

    /**
     A pessoa tocou num card inativo.

     A lista já mudou — o coordenador publica a escolha no mesmo toque —, e o que falta é a
     conexão. Sem este aviso a tela fica parada durante a varredura, que no BLE são segundos, e a
     leitura de bancada vira "não dá para selecionar a outra".
     */
    func activationStarted(_ printer: AdoptedPrinter) {
        notice = nil
        connecting = ConnectingPrinter(
            installationId: printer.installationId,
            displayName: printer.displayName
        )
    }

    /**
     A reconexão terminou.

     Falhar aqui não desfaz a escolha, e o aviso diz exatamente isso: a impressora marcada continua
     sendo a que a pessoa tocou, e o que não aconteceu foi a conexão. É a lição que o Android já
     aplicou em `4875b57` — escolha e prontidão são informações diferentes, e prometer a segunda
     porque a primeira deu certo é o que faz o cupom sumir sem explicação.
     */
    func activationFinished(_ printer: AdoptedPrinter, connected: Bool) {
        guard connecting?.installationId == printer.installationId else { return }
        connecting = nil
        guard !connected else { return }
        notice = "\(printer.displayName) ficou como escolhida, mas a conexão falhou. "
            + "Confira se ela está ligada e faça um teste."
    }

    /**
     Segura o aviso enquanto a reconexão decide.

     A espera é amostrada em vez de aguardar um retorno porque ativar não é assíncrono: o
     coordenador manda reconectar e volta na hora, e quem sabe se a impressora respondeu é o
     estado do transporte. `samples` e `wait` entram por parâmetro para a suíte poder provar as
     três saídas — conectou, recusou e esgotou — sem relógio nem rádio.
     */
    func awaitActivation(
        of printer: AdoptedPrinter,
        samples: Int,
        progress: () -> PrinterConnectionProgress,
        wait: () async -> Void
    ) async {
        for _ in 0..<max(samples, 1) {
            switch progress() {
            case .connected:
                return activationFinished(printer, connected: true)
            case .unreachable:
                return activationFinished(printer, connected: false)
            case .connecting:
                await wait()
            }
        }
        // Prazo esgotado sem desfecho: a varredura pode continuar, mas o aviso não pode ficar.
        activationFinished(printer, connected: progress() == .connected)
    }

    /// A unidade saiu da lista, ou não saiu. O texto separa os dois: excluir e continuar
    /// aparecendo é o defeito que a pessoa precisa enxergar, não um silêncio.
    func installationRemoved(_ displayName: String, succeeded: Bool) {
        connecting = nil
        notice = succeeded
            ? "\(displayName) saiu das impressoras instaladas."
            : "\(displayName) continua instalada neste aparelho. Tente de novo."
    }

    /// Resultado do teste de uma impressora adotada, em texto.
    ///
    /// O botão descartava o retorno com `_ =`, então tocar em Testar e nada acontecer era
    /// indistinguível de app travado — foi o que a MTP-II mostrou na bancada. Falha aqui quase
    /// sempre significa que o rádio caiu depois da adoção, e a pessoa precisa saber disso para
    /// procurar de novo em vez de duvidar do toque.
    /**
     O comprovante do card foi pedido.

     Testar a unidade que está parada conecta nela antes de imprimir e devolve a conexão à ativa
     depois — no BLE são duas varreduras, de segundos cada. Sem sinal no card, o toque parece não
     ter pego, que é exatamente o mal-entendido que o botão Testar já produziu uma vez.
     */
    func testStarted(_ printer: AdoptedPrinter) {
        notice = nil
        testing = ConnectingPrinter(
            installationId: printer.installationId,
            displayName: printer.displayName
        )
    }

    func testFinished(_ printer: AdoptedPrinter, result: ThermalPrintResult) {
        if testing?.installationId == printer.installationId { testing = nil }
        reportTestResult(result)
    }

    func reportTestResult(_ result: ThermalPrintResult) {
        switch result {
        case .delivered:
            notice = "Comprovante enviado. Confira se o papel saiu."
        case let .failed(message, delivery):
            // Falha depois do primeiro byte não autoriza reenvio automático nem promete que o
            // papel não saiu: a pessoa confere a impressora antes de decidir.
            notice =
                delivery == .indeterminate
                    ? message + " Confira a impressora antes de repetir."
                    : message
        }
    }
    private var homologationCompleted = false
    /// A instalação veio da configuração declarada, e não das sondas. O texto de conclusão muda:
    /// dizer "após a confirmação no papel" quando ninguém imprimiu nada é a mentira que faz a
    /// pessoa confiar no acento que ela não viu.
    private var homologationWasManual = false

    static func readyProfiles(measured: [MeasuredProfile]) -> [ThermalPrinterReadyProfile] {
        measured.map(ThermalPrinterReadyProfile.init)
    }

    func selectProfile(_ id: String) {
        route = .readyConnections(profileID: id)
        notice = nil
    }

    func addNewPrinter() {
        route = .modelGrid
        notice = nil
    }

    func selectProfileForHomologation() {
        route = .newConnections
        notice = nil
    }

    func selectConnection(_ mode: ThermalPrinterConnectionMode, profileID: String?) {
        route = .search(mode: mode, profileID: profileID)
        notice = nil
    }

    /// Endereço digitado, ao lado da busca. Procurar não é o único caminho: impressora fora da
    /// faixa varrida não aparece por mais que se toque em procurar de novo.
    func configureManually(_ target: ThermalPrinterManualTarget) {
        route = .manualWifi(target)
        notice = nil
    }

    /// As opções operacionais de uma unidade instalada. É onde a engrenagem chega, nos dois
    /// transportes: no Android a engrenagem sempre abriu a configuração manual, e o que ela edita
    /// — página, corte, avanço, largura — não depende de rádio nem de endereço.
    func configureOptions(_ target: ThermalPrinterManualTarget) {
        route = .manualConfiguration(target)
        notice = nil
    }

    /// A unidade recebeu opções novas e continua sendo a mesma da lista.
    func manualConfigurationSaved(_ displayName: String) {
        route = .profiles
        notice = "\(displayName) foi configurada. Faça um teste para conferir no papel."
    }

    func goBack() {
        switch route {
        case .profiles:
            break
        case .readyConnections, .newConnections:
            route = .modelGrid
        case let .search(_, profileID):
            if let profileID {
                route = .readyConnections(profileID: profileID)
            } else {
                route = .newConnections
            }
        case let .paperCost(mode, profileID):
            route = .search(mode: mode, profileID: profileID)
        case .modelGrid:
            route = .profiles
        case let .manualWifi(target):
            // A engrenagem sai da lista e volta para ela; o caminho de instalar volta para onde a
            // conexão foi escolhida.
            if target.isReconfiguration {
                route = .manualConfiguration(target)
            } else if let profileID = target.profileID {
                route = .readyConnections(profileID: profileID)
            } else {
                route = .newConnections
            }
        case .manualConfiguration:
            route = .profiles
        }
        notice = nil
    }

    func willStartTest() {
        suppressesReceiptQuestion = false
        showsHomologation = false
        homologationPreparationAccepted = false
        homologationOpensManualConfiguration = false
        homologationCompleted = false
        notice = nil
    }

    func requestPaperCost(mode: ThermalPrinterConnectionMode, profileID: String?) {
        route = .paperCost(mode: mode, profileID: profileID)
        notice = nil
    }

    func acceptPaperCost() {
        guard case let .paperCost(mode, profileID) = route else { return }
        route = .search(mode: mode, profileID: profileID)
        willStartTest()
    }

    /**
     O custo aceito por quem vai declarar em vez de medir.

     É o mesmo "Começar o teste" menos as sondas: o comprovante de conexão sai — sem ele não há
     candidata em memória, e sem candidata a instalação declarada é recusada pelo core —, e a
     resposta humana sobre o papel leva ao formulário declarado em vez da primeira régua.
     */
    func acceptPaperCostDeclaringConfiguration() {
        guard case .paperCost = route else { return }
        acceptPaperCost()
        homologationOpensManualConfiguration = true
    }

    func cancelPaperCost() {
        guard case let .paperCost(mode, profileID) = route else { return }
        route = .search(mode: mode, profileID: profileID)
        notice = nil
    }

    func preliminaryTestCouldNotStart() {
        notice = "A impressora encontrada não está mais disponível. Procure de novo."
    }

    /// Chamado pelo `set` do Binding do alerta. É intencionalmente inerte: tocar fora, usar voltar
    /// ou o SwiftUI desmontar a apresentação não informa se o comprovante saiu.
    func receiptQuestionDismissalWasRequested() {}

    func answerInitialReceipt(
        _ outcome: InitialReceiptOutcome,
        resolve: (InitialReceiptOutcome) -> InitialReceiptAction
    ) {
        switch resolve(outcome) {
        case .adopted:
            suppressesReceiptQuestion = false
            route = .profiles
            notice = "Impressora confirmada pelo comprovante físico."
        case .homologationRequired:
            // O core não descarta nem confirma a candidata neste caminho.
            suppressesReceiptQuestion = true
            homologationPreparationAccepted = false
            showsHomologation = true
            homologationCompleted = false
            notice = "A candidata foi preservada somente em memória para a configuração."
        case .temporaryProfileRequiresHomologation:
            // No caminho B, a pessoa aceitou o custo antes do comprovante preliminar. O assistente
            // começa direto nas sondas e não repete a mesma abertura depois da confirmação física.
            suppressesReceiptQuestion = true
            homologationPreparationAccepted = true
            showsHomologation = true
            homologationCompleted = false
            notice = "A candidata foi preservada somente em memória para a configuração."
        case .discarded:
            suppressesReceiptQuestion = false
            homologationOpensManualConfiguration = false
            notice = "A candidata não foi selecionada."
        }
    }

    /**
     A engrenagem de uma impressora Bluetooth.

     Não há endereço para digitar num rádio que só se alcança por anúncio: reconfigurar aqui é
     medir de novo, e a régua sai no papel dela. Sem a impressora respondendo não existe sonda, e
     dizer isso é mais útil que abrir um assistente que não teria em quem tocar.
     */
    func reconfigurationRequested(_ displayName: String, hasEphemeralTarget: Bool) {
        guard hasEphemeralTarget else {
            notice = "Ligue \(displayName) e deixe ela perto do celular para reconfigurar."
            return
        }
        requestAdvancedHomologation(hasEphemeralTarget: true)
    }

    /// A unidade reconfigurada substituiu a anterior, que saiu da lista.
    func reconfigurationFinished(_ displayName: String) {
        notice = "\(displayName) foi reconfigurada e continua sendo a impressora marcada."
    }

    /**
     A reconfiguração instalou outra unidade e a anterior ficou na lista.

     Tirá-la daqui apagaria junto a medição que nenhuma outra impressora usa, e medição de bancada
     não se perde por efeito colateral de uma tela de endereço. Quem sabe se a antiga ainda existe
     é a pessoa, e a lixeira é o caminho — com o aviso que ela já traz sobre a medição.
     */
    func reconfigurationLeftPreviousInstallation(_ displayName: String) {
        notice = "\(displayName) continua na lista com a configuração antiga. "
            + "Se ela não existe mais, use a lixeira para excluí-la."
    }

    func requestAdvancedHomologation(hasEphemeralTarget: Bool) {
        guard hasEphemeralTarget else {
            notice = "Procure e teste uma impressora primeiro. A configuração precisa de uma candidata em memória."
            return
        }
        suppressesReceiptQuestion = true
        homologationPreparationAccepted = false
        showsHomologation = true
        homologationCompleted = false
        notice = nil
    }

    func homologationFinished() {
        homologationCompleted = true
        showsHomologation = false
        suppressesReceiptQuestion = false
        homologationPreparationAccepted = false
        homologationOpensManualConfiguration = false
        route = .profiles
        notice = "Impressora configurada e selecionada após a confirmação no papel."
    }

    /// A impressora foi instalada com as opções declaradas, sem novas sondas. Fecha o assistente
    /// pelo mesmo caminho da conclusão medida — o desfecho é uma instalação nos dois casos.
    func manualConfigurationAdopted() {
        homologationCompleted = true
        homologationWasManual = true
        showsHomologation = false
    }

    /// A confirmação final já gravou o perfil e trocou a seleção, mas a tela de conclusão ainda
    /// permanece aberta até a pessoa escolher a saída explícita. Separar esses dois fatos impede
    /// que um gesto de fechar o sheet trate uma adoção concluída como cancelamento.
    func homologationAdoptionCommitted() {
        homologationCompleted = true
    }

    /// O fechamento sem conclusão rejeita a seleção enquanto o alvo ainda está disponível e só
    /// depois remove esse alvo. A conclusão pula ambas as ações porque a adoção já foi confirmada.
    func homologationDismissed(
        clearPendingSelection: () -> Void,
        discardEphemeralTarget: () -> Void
    ) {
        if homologationCompleted {
            route = .profiles
            notice = homologationWasManual
                ? "Impressora instalada com a configuração que você informou. "
                    + "Faça um teste para conferir no papel."
                : "Impressora configurada e selecionada após a confirmação no papel."
        } else {
            clearPendingSelection()
            discardEphemeralTarget()
        }
        homologationWasManual = false
        homologationCompleted = false
        showsHomologation = false
        suppressesReceiptQuestion = false
        homologationPreparationAccepted = false
        homologationOpensManualConfiguration = false
    }
}

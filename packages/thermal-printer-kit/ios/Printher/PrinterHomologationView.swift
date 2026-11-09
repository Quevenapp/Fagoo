import SwiftUI
import ThermalPrinterKit

/// Contrato de apresentação mantido ao lado da View para que a ordem exibida seja a mesma ordem
/// dos bytes das sondas. Não existe relógio, prazo ou repetição automática nesta camada.
enum PrinterHomologationUIContract {
    static let preliminaryReceiptCount = 1
    static let geometryProbeCount = 0
    static let textEncodingProbeCount = 1
    /// Uma tira de meio tom em largura cheia, em toda impressora: vazão não se adivinha por modelo.
    static let rasterThroughputProbeCount = 1
    /// Uma tira com o QR e o código de barras nativos, em toda impressora: firmware não se
    /// adivinha por marca nem por modelo.
    static let nativeCodeProbeCount = 1
    static let finalReceiptCount = 1
    /// O piso do intervalo anunciado: largura, vazão, código nativo, texto e comprovante final.
    /// Eram três antes da tira da imagem e quatro antes da tira de código nativo — as duas saem em
    /// toda impressora, e por isso o piso sobe junto com elas.
    static var typicalPaperTestCount: Int { PrinterHomologationPaperCost.minimumStrips }
    static let preparationTitle = "Vamos testar sua impressora"
    static let preparationExplanation = "O caminho comum usa poucas tirinhas de papel."
    static let preparationOnce = "É uma vez só, para o app aprender a sua impressora."
    static let preparationResult = "Depois disso tudo sai certinho: acento, corte e tamanho."
    /**
     A frase do custo, montada da conta das sondas — nunca de um número escrito aqui.

     Ela dizia "São de 4 a 7 tiras, conforme a impressora." desde 12/08, e o teto ficou parado
     enquanto os seis dialetos de corte e a régua de oito avanços entravam. O Android, que já
     contava, anunciava 17 na mesma tela do mesmo assistente. A conta agora é uma só, e mora nas
     sondas: ver ``PrinterHomologationPaperCost``. O Android emite exatamente esta frase.
     */
    static var preparationCount: String {
        "São de \(PrinterHomologationPaperCost.minimumStrips) a "
            + "\(PrinterHomologationPaperCost.maximumStrips) tiras curtas de teste."
    }
    /// A tira de conexão ainda não saiu: sai ao tocar em "Começar o teste". É o estado do caminho
    /// que aceita o custo antes da busca, e não existe no Android — lá o assistente só abre depois
    /// do comprovante. A frase segue o papel, não a plataforma.
    static let preliminaryReceiptNotice = "A primeira sai agora, para conferir a conexão."
    /// O outro estado da mesma frase: a tira de conexão já está na mão de quem lê a tela.
    static let preliminaryReceiptAlreadyPrinted = "O comprovante preliminar já saiu."
    static let preparationPaper = "Deixe papel suficiente na impressora."
    /// O que a medição custa em permanência, dito antes de começar. O Android diz isto na mesma
    /// abertura desde sempre; o iOS não dizia nada, e é informação de produto, não enfeite.
    ///
    /// O literal saiu daqui e virou o **default** de ``PrinterHomologationLocalOnlyCopy``. Este
    /// nome continua sendo o contrato publicado da frase, e por isso as asserções que já a fixavam
    /// passaram a fixar, pelo mesmo caminho e sem mudar uma vírgula, o default do ponto de injeção.
    static let localOnlyTitle = PrinterHomologationLocalOnlyCopy.default.localOnlyTitle
    static let localOnlyBody = "Se o app for removido, ela também será apagada."
    static let startTitle = "Começar o teste"
    static let manualTitle = "Configuração manual"
    static let cancelTitle = "Agora não"
    /// Mesma história de ``localOnlyTitle``: o literal é o default do ponto de injeção.
    static let finishTitle = PrinterHomologationLocalOnlyCopy.default.finishTitle
    static let completionTitle = "Pronto! Sua impressora está configurada."
    static let completionReady = "Já dá para imprimir."
    static let steps = PrinterHomologationStep.allCases
    static let sequence = [
        "PAPER_WIDTH", "RASTER_THROUGHPUT", "NATIVE_CODE", "CUTTER_QUESTION", "CUT_PROTOCOL",
        "CUT_FEED", "CODE_PAGE", "DONE",
    ]
    static let codePageCandidates = PrinterProbePayloads.codePageCandidates
    static let cutProtocols = PrinterProbePayloads.cutProtocolCandidates.map(\.cutProtocol)
    static let cutFeedLines = PrinterProbePayloads.cutFeedCandidates
    static let cutFeedWarning = PrinterProbePayloads.cutFeedBenchWarning

    /// O que "Usar padrão" custa, dito sem alarmismo: nada regride para quem escolher isso.
    static let rasterThroughputDefaultNotice =
        "Sem régua por perto? \"Usar padrão\" mantém a impressora no ritmo atual. Em modelos que " +
        "perdem linhas, imagens grandes podem sair menores — dá para medir depois, homologando a " +
        "impressora de novo."

    /// Mantido como contrato da fronteira que nomeia o rascunho. A Fase 5 não expõe campo de
    /// marca/modelo; o helper continua garantindo o limite caso um nome seja injetado pelo host.
    static func normalizedDisplayName(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(80))
    }

    static func geometryColumnChoices(for width: PrinterPaperWidth) -> [Int] {
        Array(24...width.geometryProbeColumns)
    }

    static func acceptsHumanResponse(_ state: PrinterHomologationState) -> Bool {
        if case .awaitingResponse = state { return true }
        return false
    }

    /// O "Voltar" existe enquanto a instalação não foi confirmada e há o que desfazer.
    ///
    /// A resposta inteira é da máquina e da sessão; aqui ela só ganha o nome que o botão usa. A
    /// tela do comprovante final oferece até a confirmação humana — a letra de acento só se prova
    /// ali, e quem escolheu errado precisa corrigir antes de dizer "saiu certo". Depois dela não há
    /// retrocesso: instalação concluída é concluída. Envio no ar e comprovante que falhou também
    /// não voltam; ali se decide primeiro sobre o papel que talvez tenha saído.
    static func offersBack(
        _ state: PrinterHomologationSessionState,
        machineCanGoBack: Bool
    ) -> Bool {
        switch state {
        case .homologating, .finalReceiptReady, .awaitingFinalConfirmation:
            return machineCanGoBack
        case .sendingFinalReceipt, .finalReceiptFailed, .finished:
            return false
        }
    }

    /**
     A saída declarada continua alcançável enquanto a medição pode ser abandonada sem mentir
     sobre o papel.

     É a mesma regra do retrocesso, menos a exigência de haver decisão anterior para desfazer:
     quem chega pela confirmação do comprovante de teste ainda não respondeu nada, e é
     exatamente essa pessoa que precisa declarar em vez de atravessar as tiras. Envio no ar e
     falha pendente não oferecem — ali se decide primeiro sobre a tira que talvez tenha saído —,
     e instalação concluída é concluída.

     Medido no iPhone 7 em 20/08: no caminho que já pagou o comprovante preliminar o iOS entrava
     direto nas sondas, e a tela "Teste da impressora" não tinha por onde declarar. No Android a
     mesma resposta cai na abertura do assistente, que oferece "Configuração manual".
     */
    static func offersManualConfiguration(_ state: PrinterHomologationSessionState) -> Bool {
        switch state {
        case let .homologating(machineState):
            switch machineState {
            case .ready, .awaitingResponse, .done: return true
            case .sending, .failed: return false
            }
        case .finalReceiptReady, .awaitingFinalConfirmation:
            return true
        case .sendingFinalReceipt, .finalReceiptFailed, .finished:
            return false
        }
    }

    /// O que a pessoa lê antes de trocar a medição pela declaração.
    ///
    /// O formulário parte do perfil de descoberta, não do que a medição já apurou: tira que já
    /// saiu não vira campo preenchido. Quando há resposta guardada, a frase diz que instalar
    /// declarado a descarta, e diz também que voltar do formulário não descarta nada — o custo
    /// aparece antes do toque, como no aviso do "Voltar".
    static func manualConfigurationNotice(measurementStarted: Bool) -> String {
        let base = "Declare largura, colunas, acento, corte e avanço na mão, sem gastar as tiras."
        guard measurementStarted else { return base }
        return base + " O que já foi medido não vai junto: instalar com estas opções descarta as "
            + "respostas desta medição. Voltar do formulário devolve o teste onde parou."
    }

    /**
     O mesmo aviso, na abertura do assistente, onde a tira de conexão pode ainda não ter saído.

     Declarar não pula o comprovante preliminar: a instalação declarada precisa da candidata
     confirmada em memória — `adoptManualConfiguration` recusa sem ela — e essa candidata só existe
     depois que a primeira tira sai. Então esta saída paga essa tira, que é a mesma que a tela
     acabou de anunciar, e nenhuma sonda. Onde o comprovante já saiu, o aviso é o de sempre.
     */
    static func paperCostManualNotice(preliminaryReceiptPending: Bool) -> String {
        let base = manualConfigurationNotice(measurementStarted: false)
        guard preliminaryReceiptPending else { return base }
        return base + " Só o comprovante de conexão sai antes: é ele que prova qual impressora "
            + "está recebendo."
    }

    /// Rótulo curto do passo, para o aviso do "Voltar" dizer para onde o toque leva.
    static func stepLabel(_ step: PrinterHomologationStep) -> String {
        switch step {
        case .geometry: return "Largura e geometria"
        case .rasterThroughput: return "Velocidade da imagem"
        case .nativeCode: return "Código nativo"
        case .cutProtocol: return "Corte"
        case .cutFeed: return "Avanço"
        case .codePage: return "Texto"
        }
    }

    /// O que a pessoa lê antes de tocar em "Voltar".
    ///
    /// O papel gasto é anunciado antes: o passo reaberto imprime de novo quando ela avançar por
    /// ali, e a frase diz isso antes do toque, não depois de a tira sair.
    static func backNotice(to step: PrinterHomologationStep, reprintsProbes: Bool) -> String {
        let base = "Volta para \(stepLabel(step)) e apaga as respostas desta etapa em diante."
        return reprintsProbes ? base + " As tiras desta etapa sairão de novo." : base
    }
}

/**
 As duas frases da tela que descrevem **onde a configuração fica**, e não a impressora.

 Toda a superfície de homologação fala do papel que acabou de sair: largura, acento, corte, avanço.
 Estas duas são as únicas que falam do aparelho que roda o app — "só neste celular" —, e é
 exatamente por isso que elas não são do kit: quem sabe em que aparelho está é o hospedeiro, não a
 tela. A tela nunca pergunta em que sistema roda; ela recebe a frase pronta e a mostra.

 O default é o de hoje, byte a byte, e é aqui que o literal mora — as duas frases só existem uma
 vez no iOS inteiro. ``PrinterHomologationUIContract/localOnlyTitle`` e
 ``PrinterHomologationUIContract/finishTitle`` leem deste default, de modo que as asserções de
 contrato que já fixavam essas frases continuam valendo intactas e passaram a guardar o default
 junto. Quem não injeta nada — QRFesta, Vinki, o Printher de celular — não vê diferença nenhuma.

 O molde é o do B8 (`requiredInterfaceType`, `interfaceNames`): parâmetro com default, o
 comportamento de hoje preservado. Ele vem em um valor só, e não em dois parâmetros soltos, porque
 as duas frases são a mesma promessa dita em dois lugares — trocar uma e esquecer a outra deixaria
 a tela dizendo duas coisas diferentes sobre o mesmo aparelho — e porque assim o Android tem a
 mesma forma num tipo que teste de unidade JVM alcança sem árvore Compose.
 */
public struct PrinterHomologationLocalOnlyCopy: Equatable, Sendable {
    /// O título do aviso de permanência, na abertura do assistente.
    public let localOnlyTitle: String
    /// O rótulo do botão que encerra a homologação depois da adoção.
    public let finishTitle: String

    public init(
        localOnlyTitle: String = "Esta configuração fica só neste celular",
        finishTitle: String = "Usar só neste celular"
    ) {
        self.localOnlyTitle = localOnlyTitle
        self.finishTitle = finishTitle
    }

    /// O que a tela diz quando o hospedeiro não diz nada.
    public static let `default` = PrinterHomologationLocalOnlyCopy()
}

@available(iOS 15.0, macOS 12.0, *)
@MainActor
public struct PrinterHomologationView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var host: PrinterHomologationViewHost
    private let theme: ThermalPrinterTheme
    private let profileActions: PrinterProfileActionsSlot
    private let preparationAlreadyAccepted: Bool
    /// Abrir já no formulário declarado, porque a pessoa escolheu isso na abertura do custo em
    /// papel. Nenhuma sessão de sondas é aberta enquanto o formulário está de pé.
    private let opensManualConfiguration: Bool
    /// As frases do hospedeiro, ver ``PrinterHomologationLocalOnlyCopy``. Interna, e não privada,
    /// porque é o único jeito de a suíte provar que o que entra na porta pública chega inteiro à
    /// tela — SwiftUI em SPM não renderiza para ser lido.
    let localOnlyCopy: PrinterHomologationLocalOnlyCopy
    private let onAdoptionCommitted: () -> Void
    private let onManualAdoption: () -> Void
    private let onFinished: () -> Void

    /// O rascunho declarado, quando a pessoa escolheu configurar em vez de medir. Vive só aqui.
    @State private var manual: PrinterManualConfiguration?
    @State private var manualStatus: String?
    @State private var manualFailure: String?
    @State private var manualPrinting = false
    @State private var manualSaving = false
    /// A abertura automática do formulário acontece uma vez só. Sem isto, "Voltar" reabriria o
    /// formulário no desenho seguinte e a pessoa ficaria presa nele.
    @State private var didOpenManualAutomatically = false

    public init(
        printer: ThermalPrinterConfiguration,
        store: PrinterProfileStore,
        profileActions: ((MeasuredProfile) -> AnyView)? = nil,
        localOnlyCopy: PrinterHomologationLocalOnlyCopy = .default,
        onFinished: @escaping () -> Void
    ) {
        self.init(
            printer: printer,
            store: store,
            theme: .neutral,
            profileActions: PrinterProfileActionsSlot(profileActions),
            preparationAlreadyAccepted: false,
            opensManualConfiguration: false,
            localOnlyCopy: localOnlyCopy,
            onAdoptionCommitted: {},
            onManualAdoption: {},
            onFinished: onFinished
        )
    }

    init(
        printer: ThermalPrinterConfiguration,
        store: PrinterProfileStore,
        theme: ThermalPrinterTheme,
        profileActions: PrinterProfileActionsSlot = PrinterProfileActionsSlot(),
        preparationAlreadyAccepted: Bool = false,
        opensManualConfiguration: Bool = false,
        localOnlyCopy: PrinterHomologationLocalOnlyCopy = .default,
        onAdoptionCommitted: @escaping () -> Void = {},
        onManualAdoption: @escaping () -> Void = {},
        onFinished: @escaping () -> Void
    ) {
        _host = StateObject(
            wrappedValue: PrinterHomologationViewHost(printer: printer, store: store)
        )
        self.theme = theme
        self.profileActions = profileActions
        self.preparationAlreadyAccepted = preparationAlreadyAccepted
        self.opensManualConfiguration = opensManualConfiguration
        self.localOnlyCopy = localOnlyCopy
        self.onAdoptionCommitted = onAdoptionCommitted
        self.onManualAdoption = onManualAdoption
        self.onFinished = onFinished
    }

    public var body: some View {
        ScrollView {
            Group {
                // A configuração declarada tem precedência sobre a sessão de sondas, como no
                // Android: quem escolheu não gastar papel não pode cair no assistente de novo.
                if manual != nil {
                    manualContent
                } else if let session = host.session {
                    PrinterHomologationSessionContent(
                        session: session,
                        theme: theme,
                        profileActions: profileActions,
                        localOnlyCopy: localOnlyCopy,
                        sendDrawerKickPulse: host.sendDrawerKickPulse,
                        onAdoptionCommitted: onAdoptionCommitted,
                        onManualConfiguration: openManualConfiguration,
                        onFinished: onFinished
                    )
                } else if let errorMessage = host.errorMessage {
                    unavailableContent(errorMessage)
                } else if opensManualConfiguration, !didOpenManualAutomatically {
                    // Quem declarou na abertura não abre sessão de sondas nenhuma: o formulário
                    // aparece no lugar dela, no primeiro desenho. Voltar dele cai no teste, como
                    // em qualquer outro caminho — a abertura automática não se repete.
                    ProgressView("Abrindo a configuração manual")
                        .tint(theme.primary)
                        .onAppear {
                            didOpenManualAutomatically = true
                            openManualConfiguration()
                        }
                } else if preparationAlreadyAccepted {
                    ProgressView("Abrindo a sessão de teste")
                        .tint(theme.primary)
                        .onAppear { host.prepare(displayName: nil) }
                } else {
                    preparationContent
                }
            }
            .padding(20)
        }
        // O assistente também é página inteira, e o hospedeiro pode apresentá-lo sem barra: o
        // recuo do relógio é dele. Ver ``PrinterScreenInset``.
        .printerStatusBarInset()
        .background(theme.background.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("printerSetup.homologation.screen")
    }

    private var preparationContent: some View {
        PrinterPaperCostIntroduction(
            theme: theme,
            preliminaryReceiptPending: false,
            onStart: { host.prepare(displayName: nil) },
            onCancel: { dismiss() },
            // A saída de quem já conhece a impressora e não quer pagar as tiras. O Android a
            // oferece exatamente aqui, e pelo mesmo motivo: o custo em papel é a única razão de
            // esta tela existir.
            onManualConfiguration: openManualConfiguration,
            localOnlyCopy: localOnlyCopy
        )
    }

    /// Abre o formulário declarado a partir de onde a pessoa estiver.
    ///
    /// A sessão de sondas continua viva e intacta atrás dele: nada é enviado, nada é apagado na
    /// máquina, e `onBack` do formulário devolve a medição no passo em que ela parou. O que
    /// descarta a medição é instalar declarado, e isso o aviso da tela anuncia antes.
    private func openManualConfiguration() {
        manualStatus = nil
        manualFailure = nil
        manual = host.pendingConfiguration()
    }

    /// A rota declarada: os mesmos campos da engrenagem, e um comprovante opcional antes de
    /// instalar. Nenhuma sonda é enviada por aqui.
    @ViewBuilder
    private var manualContent: some View {
        if let rascunho = manual {
            PrinterManualConfigurationView(
                theme: theme,
                displayName: rascunho.displayName,
                configuration: Binding(
                    get: { manual ?? rascunho },
                    set: { manual = $0 }
                ),
                busy: manualPrinting,
                saving: manualSaving,
                printingUnavailable: nil,
                sharedInstallations: 0,
                status: manualStatus,
                failure: manualFailure,
                saveTitle: "Instalar com estas opções",
                transportAction: nil,
                onPrint: printManualConfiguration,
                onSave: adoptManualConfiguration,
                onBack: { manual = nil }
            )
            .printerHomologationCard(theme: theme)
        }
    }

    private func printManualConfiguration() {
        guard let rascunho = manual, !manualPrinting else { return }
        manualPrinting = true
        manualFailure = nil
        manualStatus = "Enviando o comprovante com estas opções…"
        let enviado = host.sendManualTestReceipt(rascunho) { resultado in
            manualPrinting = false
            manualStatus = resultado == .success
                ? "Comprovante enviado. Confira o papel antes de instalar."
                : "O comprovante não foi enviado. Confira se a impressora está ligada."
        }
        if !enviado {
            manualPrinting = false
            manualStatus = nil
            manualFailure = "A impressora não está mais disponível para receber o comprovante."
        }
    }

    private func adoptManualConfiguration() {
        guard let rascunho = manual, !manualSaving else { return }
        manualSaving = true
        manualFailure = nil
        do {
            try host.adopt(rascunho)
            manualSaving = false
            manual = nil
            onManualAdoption()
        } catch {
            manualSaving = false
            manualFailure = (error as? LocalizedError)?.errorDescription
                ?? "Confira os dados informados e tente de novo."
        }
    }

    private func unavailableContent(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Teste indisponível", systemImage: "exclamationmark.triangle")
                .font(.title3.weight(.bold))
                .foregroundColor(theme.warning)
            Text(message)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Text("Procure uma impressora e envie o comprovante de teste antes de abrir esta etapa.")
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
            Button("Voltar") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.close")
        }
        .printerHomologationCard(theme: theme)
    }
}

@available(iOS 15.0, macOS 12.0, *)
internal struct PrinterPaperCostIntroduction: View {
    let theme: ThermalPrinterTheme
    let preliminaryReceiptPending: Bool
    let onStart: () -> Void
    let onCancel: () -> Void
    /// Só o assistente a oferece: é lá que o custo em papel aparece, e é dele que a configuração
    /// declarada é a alternativa.
    var onManualConfiguration: (() -> Void)?
    /// A frase de permanência vem de fora, com o default de hoje. Ver
    /// ``PrinterHomologationLocalOnlyCopy``.
    var localOnlyCopy: PrinterHomologationLocalOnlyCopy = .default

    var body: some View {
        VStack(alignment: .leading, spacing: theme.usesPrintherLayout ? 22 : 14) {
            Text(PrinterHomologationUIContract.preparationTitle)
                .font(theme.usesPrintherLayout ? .largeTitle.weight(.bold) : .title3.weight(.bold))
                .foregroundColor(theme.text)
            Group {
                Text(PrinterHomologationUIContract.preparationExplanation)
                Text(PrinterHomologationUIContract.preparationOnce)
                Text(PrinterHomologationUIContract.preparationResult)
            }
            .font(theme.usesPrintherLayout ? .title3 : .subheadline)
            .foregroundColor(theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                Label(
                    PrinterHomologationUIContract.preparationCount,
                    systemImage: "printer.fill"
                )
                .font(theme.usesPrintherLayout ? .headline : .subheadline.weight(.semibold))
                Text(
                    preliminaryReceiptPending
                        ? PrinterHomologationUIContract.preliminaryReceiptNotice
                        : PrinterHomologationUIContract.preliminaryReceiptAlreadyPrinted
                )
                .font(.subheadline)
                Text(PrinterHomologationUIContract.preparationPaper)
                    .font(.subheadline)
            }
            .foregroundColor(theme.warning)
            .padding(theme.usesPrintherLayout ? 18 : 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            // O que a medição custa em permanência. O Android anuncia isto na mesma abertura, e o
            // iOS não anunciava nada: promessa de produto não pode existir num sistema só. Quem diz
            // *onde* a configuração fica é o hospedeiro; esta tela só mostra a frase que recebeu.
            VStack(alignment: .leading, spacing: 4) {
                Text(localOnlyCopy.localOnlyTitle)
                    .font(theme.usesPrintherLayout ? .headline : .subheadline.weight(.semibold))
                Text(PrinterHomologationUIContract.localOnlyBody)
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
            }
            .foregroundColor(theme.text)
            .fixedSize(horizontal: false, vertical: true)
            .padding(theme.usesPrintherLayout ? 18 : 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.primarySurface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityIdentifier("printerSetup.homologation.localOnly")

            Button(PrinterHomologationUIContract.startTitle, action: onStart)
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .font(theme.usesPrintherLayout ? .headline : .body)
                .frame(maxWidth: .infinity, minHeight: theme.usesPrintherLayout ? 68 : nil)
                .accessibilityIdentifier("printerSetup.homologation.start")

            if let onManualConfiguration {
                Button(PrinterHomologationUIContract.manualTitle, action: onManualConfiguration)
                    .buttonStyle(.bordered)
                    .tint(theme.primary)
                    .frame(maxWidth: .infinity, minHeight: theme.usesPrintherLayout ? 60 : nil)
                    .accessibilityIdentifier("printerSetup.homologation.manual")
                Text(
                    PrinterHomologationUIContract.paperCostManualNotice(
                        preliminaryReceiptPending: preliminaryReceiptPending
                    )
                )
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("printerSetup.homologation.manual.notice")
            }

            Button(PrinterHomologationUIContract.cancelTitle, action: onCancel)
                .buttonStyle(.plain)
                .foregroundColor(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.close")
        }
        .printerHomologationCard(theme: theme)
    }
}

@available(iOS 15.0, macOS 12.0, *)
@MainActor
private final class PrinterHomologationViewHost: ObservableObject {
    @Published private(set) var session: PrinterHomologationSession?
    @Published private(set) var errorMessage: String?

    private let printer: ThermalPrinterConfiguration
    private let store: PrinterProfileStore
    private var didPrepare = false

    init(printer: ThermalPrinterConfiguration, store: PrinterProfileStore) {
        self.printer = printer
        self.store = store
    }

    func prepare(displayName: String?) {
        guard !didPrepare else { return }
        didPrepare = true
        do {
            session = try printer.makeHomologationSession(
                store: store,
                displayName: displayName
            )
        } catch {
            // O erro de UI não inclui candidata, endereço ou identificador técnico.
            errorMessage = "Não há uma candidata de impressão disponível somente em memória."
        }
    }

    /// O ponto de partida da configuração declarada: o perfil de descoberta da candidata, que é
    /// conservador. Sem candidata, o conservador de 58 mm — o mesmo piso do resto do kit.
    func pendingConfiguration() -> PrinterManualConfiguration {
        printer.manualConfigurationForPendingPrinter()
            ?? PrinterManualConfiguration.conservative(displayName: "Impressora")
    }

    @discardableResult
    func sendManualTestReceipt(
        _ configuration: PrinterManualConfiguration,
        completion: @escaping (PrinterProbeSendResult) -> Void
    ) -> Bool {
        printer.sendManualConfigurationTestReceipt(configuration) { result in
            Task { @MainActor in completion(result) }
        }
    }

    func adopt(_ configuration: PrinterManualConfiguration) throws {
        _ = try printer.adoptManualConfiguration(configuration)
    }

    /// A conclusão do transporte não é convertida em capacidade: sem gaveta conhecida no cabo,
    /// nem sucesso nem silêncio dizem se a impressora oferece a porta.
    func sendDrawerKickPulse(completion: @escaping (PrinterProbeSendResult) -> Void) {
        guard let command = EscPos.drawerKickPulse(
            pin: drawerPin,
            onTime: drawerOnTime,
            offTime: drawerOffTime
        ) else {
            completion(.failure(.rejected))
            return
        }
        _ = printer.sendEphemeralCommand(command) { result in
            Task { @MainActor in completion(result) }
        }
    }

    private let drawerPin = 2
    private let drawerOnTime = 50
    private let drawerOffTime = 250
}

@available(iOS 15.0, macOS 12.0, *)
@MainActor
private struct PrinterHomologationSessionContent: View {
    @ObservedObject var session: PrinterHomologationSession

    let theme: ThermalPrinterTheme
    let profileActions: PrinterProfileActionsSlot
    /// A frase do botão que encerra, dita pelo hospedeiro. Ver
    /// ``PrinterHomologationLocalOnlyCopy``.
    let localOnlyCopy: PrinterHomologationLocalOnlyCopy
    let sendDrawerKickPulse: (@escaping (PrinterProbeSendResult) -> Void) -> Void
    let onAdoptionCommitted: () -> Void
    /// A rota declarada, alcançável de dentro do teste. Quem decide se ela cabe agora é
    /// ``PrinterHomologationUIContract/offersManualConfiguration(_:)``.
    let onManualConfiguration: () -> Void
    let onFinished: () -> Void

    /// Leitura da régua na tira de vazão, em milímetros. Começa na altura nominal porque é o caso
    /// comum; quem mediu outra coisa mexe no seletor, e quem não tem régua usa o padrão.
    @State private var selectedThroughputMillimetres =
        PrinterProbePayloads.rasterThroughputStripMillimetres
    /// O que a pessoa viu em cada bloco da tira de código nativo.
    ///
    /// Começam em "saiu figura" porque é o caso comum, e porque nenhum destes dois valores vira
    /// perfil sem alguém tocar em "Confirmar o que saiu": quem não sabe dizer usa a saída, que
    /// grava a ausência nos dois campos.
    @State private var nativeQrDrawn = true
    @State private var nativeBarcodeDrawn = true
    @State private var selectedWidth: PrinterPaperWidth?
    @State private var selectedColumns = PrinterPaperWidth.mm58.defaultPrintableColumns
    @State private var selectedDots = PrinterPaperWidth.mm58.defaultPrintableDots
    @State private var nomeDoPerfil: String = ""
    @State private var localError: String?
    @State private var showDrawerConfirmation = false
    @State private var drawerActionSending = false
    @State private var drawerActionResult: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            progress
            currentContent
            manualConfigurationContent
            if drawerActionVisible { drawerActionContent }
            if let message = localError ?? session.lastError?.errorDescription {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundColor(theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityIdentifier("printerSetup.homologation.error")
            }
        }
        .alert("Abrir a gaveta agora?", isPresented: $showDrawerConfirmation) {
            Button("Cancelar", role: .cancel) {}
            Button("Abrir gaveta agora") { performDrawerKickPulse() }
        } message: {
            Text(
                "A gaveta pode se abrir imediatamente e expor dinheiro. Afaste pessoas e " +
                "objetos da frente dela. O comando não mede nem salva a presença de gaveta."
            )
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Teste da impressora")
                .font(.title2.weight(.bold))
                .foregroundColor(theme.text)
            Text("Cada resposta descreve somente o papel que acabou de sair. Uma falha nunca repete a sonda sozinha.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A saída declarada dentro do teste, para quem já sabe as respostas da própria impressora.
    ///
    /// Ela existe aqui porque é aqui que a pessoa chega depois do comprovante de teste no caminho
    /// que não passa pela abertura do assistente. O botão é o secundário desta superfície, o mesmo
    /// do "Voltar", e leva ao formulário que já existe — nenhuma tela nova.
    @ViewBuilder
    private var manualConfigurationContent: some View {
        if PrinterHomologationUIContract.offersManualConfiguration(session.state) {
            VStack(alignment: .leading, spacing: 8) {
                Button(PrinterHomologationUIContract.manualTitle, action: onManualConfiguration)
                    .buttonStyle(.bordered)
                    .tint(theme.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("printerSetup.homologation.manual")
                Text(
                    PrinterHomologationUIContract.manualConfigurationNotice(
                        measurementStarted: session.previousStep != nil
                    )
                )
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("printerSetup.homologation.manual.notice")
            }
            .printerHomologationCard(theme: theme)
        }
    }

    private var drawerActionContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ação avulsa: gaveta")
                .font(.headline)
                .foregroundColor(theme.text)
            Text(
                "Não faz parte da homologação e não altera o perfil. Sem uma gaveta conhecida " +
                    "ligada, a ausência de movimento não permite concluir se esta impressora tem porta."
            )
            .font(.subheadline)
            .foregroundColor(theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            Button(drawerActionSending ? "Enviando comando…" : "Preparar abertura da gaveta") {
                showDrawerConfirmation = true
            }
            .buttonStyle(.bordered)
            .tint(theme.warning)
            .disabled(!drawerActionAvailable)
            .accessibilityIdentifier("printerSetup.homologation.drawer.prepare")
            if let drawerActionResult {
                Text(drawerActionResult)
                    .font(.footnote)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .printerHomologationCard(theme: theme)
        .accessibilityIdentifier("printerSetup.homologation.drawer")
    }

    private var drawerActionAvailable: Bool {
        guard !drawerActionSending else { return false }
        switch session.state {
        case let .homologating(state):
            if case .sending = state { return false }
            return true
        case .sendingFinalReceipt, .finished:
            return false
        case .finalReceiptReady, .awaitingFinalConfirmation, .finalReceiptFailed:
            return true
        }
    }

    private var drawerActionVisible: Bool {
        if case .finished = session.state { return false }
        return true
    }

    private func performDrawerKickPulse() {
        guard drawerActionAvailable else { return }
        drawerActionSending = true
        drawerActionResult = nil
        sendDrawerKickPulse { result in
            drawerActionSending = false
            switch result {
            case .success:
                drawerActionResult =
                    "O transporte concluiu o comando. Confira a gaveta: este retorno não prova " +
                    "que ela existe nem que abriu."
            case .failure:
                drawerActionResult =
                    "O transporte não concluiu. O pulso pode ter chegado; confira a gaveta antes " +
                    "de tentar novamente. Nada será repetido automaticamente."
            }
        }
    }

    @ViewBuilder
    private var progress: some View {
        if let step = currentHomologationStep,
           let stepIndex = PrinterHomologationUIContract.steps.firstIndex(of: step) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Etapa \(stepIndex + 1) de \(PrinterHomologationUIContract.steps.count)")
                    .font(.headline)
                    .foregroundColor(theme.text)
                HStack(spacing: 6) {
                    ForEach(0..<PrinterHomologationUIContract.steps.count, id: \.self) { index in
                        Capsule()
                            .fill(index <= stepIndex ? theme.primary : theme.primarySurface)
                            .frame(height: 6)
                    }
                }
            }
            .accessibilityIdentifier("printerSetup.homologation.progress")
        }
    }

    @ViewBuilder
    private var currentContent: some View {
        switch session.state {
        case let .homologating(machineState):
            homologatingContent(machineState)
        case .finalReceiptReady:
            finalReceiptReadyContent
        case .sendingFinalReceipt:
            sendingContent(
                title: "Enviando comprovante final",
                detail: "Aguarde o callback real do transporte antes de responder."
            )
        case .awaitingFinalConfirmation:
            finalConfirmationContent(callbackFailed: false)
        case .finalReceiptFailed:
            finalConfirmationContent(callbackFailed: true)
        case let .finished(profile):
            finishedContent(profile)
        }
    }

    @ViewBuilder
    private func homologatingContent(_ state: PrinterHomologationState) -> some View {
        switch state {
        case let .ready(step):
            readyContent(step)
        case let .sending(step):
            sendingContent(
                title: "Enviando \(title(for: step))",
                detail: "As respostas aparecem somente quando o transporte concluir o callback."
            )
        case let .awaitingResponse(step):
            responseContent(step)
        case let .failed(step):
            failureContent(
                // "A sonda as codificações de texto não foi concluída" — o rótulo do passo é
                // escrito para "Enviando ...", e colado aqui saía sem preposição. Visto no
                // iPhone 7, na etapa 2.
                title: "Não foi possível enviar \(title(for: step))",
                retryTitle: "Voltar à sonda",
                retry: { perform { try session.retryAfterFailure() } }
            )
        case .done:
            EmptyView()
        }
    }

    @ViewBuilder
    private func readyContent(_ step: PrinterHomologationStep) -> some View {
        switch step {
        case .geometry:
            VStack(alignment: .leading, spacing: 12) {
                Text("1. Descobrir a largura do papel")
                    .font(.headline)
                    .foregroundColor(theme.text)
                Text("Vamos imprimir uma comparação curta de 58 mm e 80 mm.")
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                Button("Imprimir réguas de 58 e 80 mm") {
                    perform { try session.sendPaperWidthRulers() }
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.paper.send")
                backStepButton
            }
            .printerHomologationCard(theme: theme)

        case .codePage:
            // O número é o desta impressora, e a conta é da própria sonda: com as maiúsculas a
            // amostra passou a ocupar duas linhas nas duas larguras, e contar candidatas mentiria.
            probeReadyCard(
                title: "6. Página de código",
                // Teto, não previsão: firmware que engole byte alto imprime a letra e mais nada, e
                // a tira sai bem menor. Medido na MTP-II em 12/08 — 21 linhas em branco.
                detail: "Sai uma tira de até \(codePageProbeLines) linhas, uma por letra, todas com os mesmos acentos — minúsculas e MAIÚSCULAS. Linha em branco é resposta: aquele endereço não imprimiu nada. A linha a) sai sem acento nenhum.",
                button: "Imprimir até \(codePageProbeLines) linhas",
                identifier: "printerSetup.homologation.send.codePage"
            )

        case .rasterThroughput:
            rasterThroughputReadyContent

        case .nativeCode:
            nativeCodeReadyContent

        case .cutProtocol:
            cutProtocolReadyContent

        case .cutFeed:
            cutFeedReadyContent
        }
    }

    private func paperWidthButton(_ width: PrinterPaperWidth, advanced: Bool) -> some View {
        Button(advanced ? "Medir \(width.rawValue) mm" : "\(width.rawValue) mm") {
            selectedWidth = width
            selectedColumns = width.defaultPrintableColumns
            selectedDots = width.defaultPrintableDots
            perform {
                if advanced {
                    try session.selectPaperWidth(width)
                } else {
                    try session.selectPaperWidthUsingDefaults(width)
                }
            }
        }
        .buttonStyle(.bordered)
        .tint(selectedWidth == width ? theme.primary : theme.secondaryText)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier(
            "printerSetup.homologation.paper.\(width.rawValue)" + (advanced ? ".advanced" : "")
        )
    }

    /// A etapa que mede vazão: uma tira de altura conhecida, e a régua responde.
    ///
    /// Nem a tira nem esta tela dizem quanto ela deveria medir: dizer isso antes é ensinar a
    /// resposta.
    private var rasterThroughputReadyContent: some View {
        probeReadyCard(
            title: "2. Velocidade da imagem",
            detail: "Sai uma tira cinza de largura cheia. Há impressora que perde linhas quando a imagem chega mais rápido do que ela imprime, e a foto sai menor sem avisar. Medir esta tira é o que descobre isso.",
            button: "Imprimir a tira cinza",
            identifier: "printerSetup.homologation.send.rasterThroughput"
        )
    }

    private var nativeCodeReadyContent: some View {
        probeReadyCard(
            title: "3. Código nativo",
            detail: "Sai uma tira com duas figuras: um QR e um código de barras, pedidos direto à impressora. Há firmware que não entende esses comandos e imprime letras no lugar da figura — esta tira é o que descobre isso.",
            button: "Imprimir a tira das duas figuras",
            identifier: "printerSetup.homologation.send.nativeCode"
        )
    }

    /// As duas perguntas da tira, em linguagem de quem está com o papel na mão.
    ///
    /// A pergunta precisa distinguir "saiu um código" de "saiu um monte de letras", e é por isso que
    /// as duas opções de cada bloco são exatamente essas. "Não saiu nada" fica **junto** de "saiu
    /// texto" porque as duas significam a mesma coisa para o perfil: o comando não produziu código.
    /// Separá-las pediria um julgamento que não muda o resultado.
    private var nativeCodeResponseContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("O que saiu em cada figura?")
                .font(.headline)
                .foregroundColor(theme.text)
            Text("Se no lugar da figura saiu a palavra SONDA em letras, ou não saiu nada, escolha a segunda opção.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            Picker("Figura 1", selection: $nativeQrDrawn) {
                Text("Saiu um QR quadrado").tag(true)
                Text("Saiu texto, ou não saiu nada").tag(false)
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("printerSetup.homologation.nativeCode.qr")

            Picker("Figura 2", selection: $nativeBarcodeDrawn) {
                Text("Saiu um código de barras").tag(true)
                Text("Saiu texto, ou não saiu nada").tag(false)
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("printerSetup.homologation.nativeCode.barcode")

            Button("Confirmar o que saiu") {
                perform {
                    try session.answer(
                        .nativeCode(
                            qrHonored: nativeQrDrawn,
                            barcodeHonored: nativeBarcodeDrawn
                        )
                    )
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.primary)
            .accessibilityIdentifier("printerSetup.homologation.answer.nativeCode")

            // Quem não sabe dizer não pode ser empurrado a escolher: palpite vira capacidade
            // gravada, e capacidade gravada errada faz o app mandar um comando que a firmware
            // imprimiria como texto no meio do cupom.
            Button("Não consigo dizer") {
                perform { try session.skipNativeCodeMeasurement() }
            }
            .homologationChoiceStyle(theme: theme)
            .accessibilityIdentifier("printerSetup.homologation.nativeCode.skip")

            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private var rasterThroughputResponseContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Quantos milímetros mediu nesta tira?")
                .font(.headline)
                .foregroundColor(theme.text)
            Text("Meça a altura do bloco cinza, do traço de cima ao traço de baixo. Se ele saiu do tamanho certo, use o botão abaixo.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            Picker("Altura medida", selection: $selectedThroughputMillimetres) {
                ForEach(throughputMillimetreChoices, id: \.self) { millimetres in
                    Text("\(millimetres) mm").tag(millimetres)
                }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("printerSetup.homologation.rasterThroughput.millimetres")

            Button("Confirmar a medida") {
                perform {
                    try session.answer(
                        .rasterThroughput(printedLengthMillimetres: selectedThroughputMillimetres)
                    )
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.primary)
            .accessibilityIdentifier("printerSetup.homologation.answer.rasterThroughput")

            Button("Saiu do tamanho certo") {
                perform { try session.answerRasterThroughputPrintedInFull() }
            }
            .homologationChoiceStyle(theme: theme)
            .accessibilityIdentifier("printerSetup.homologation.rasterThroughput.full")

            // Esta é a única etapa que pede uma régua de fora; as outras se leem na própria tira.
            // Sem saída, quem não tem régua chutaria um número — e chute vira teto gravado.
            Button("Usar padrão") {
                perform { try session.skipRasterThroughputMeasurement() }
            }
            .homologationChoiceStyle(theme: theme)
            .accessibilityIdentifier("printerSetup.homologation.rasterThroughput.skip")

            Text(PrinterHomologationUIContract.rasterThroughputDefaultNotice)
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private var throughputMillimetreChoices: [Int] {
        Array(1...PrinterProbePayloads.rasterThroughputStripMillimetres).reversed()
    }

    private var cutProtocolReadyContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("4. Sua impressora corta o papel sozinha?")
                .font(.headline)
                .foregroundColor(theme.text)
            if session.machine.currentCutProbeProtocol != nil {
                // Todos os dialetos saem antes de qualquer pergunta: comparar exige as tiras lado
                // a lado, e cada comando continua sozinho no seu envio.
                Text("Vamos imprimir \(PrinterHomologationMachine.allCutProtocols.count) tiras, uma por comando de corte, numeradas. Depois você escolhe qual corte ficou do jeito que você quer.")
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Imprimir as \(PrinterHomologationMachine.allCutProtocols.count) tiras de corte") {
                    perform { try session.sendAllCutProbes() }
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.send.cutProtocol")
            } else {
                Text("A resposta só decide se vale gastar papel; o perfil guarda apenas o protocolo realmente obtido.")
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                HStack(spacing: 8) {
                    cutterAnswerButton("Sim", answer: .yes)
                    cutterAnswerButton("Não", answer: .no)
                    cutterAnswerButton("Não sei", answer: .unknown)
                }
                Button("Avançado: testar dialetos um a um") {
                    perform { try session.useAdvancedCutProtocolProbe() }
                }
                .buttonStyle(.bordered)
                .tint(theme.warning)
                .accessibilityIdentifier("printerSetup.homologation.cut.advanced")
            }
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private func cutterAnswerButton(_ title: String, answer: PrinterCutterAnswer) -> some View {
        Button(title) { perform { try session.answerCutterQuestion(answer) } }
            .buttonStyle(.bordered)
            .tint(theme.primary)
            .accessibilityIdentifier("printerSetup.homologation.cut.question.\(answer.rawValue)")
    }

    private func probeReadyCard(
        title: String,
        detail: String,
        button: String,
        identifier: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline).foregroundColor(theme.text)
            Text(detail)
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button(button) { perform { try session.sendCurrentProbe() } }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier(identifier)
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    @ViewBuilder
    private var cutFeedReadyContent: some View {
        if let protocolValue = session.machine.resolvedCutProtocol,
           protocolValue == .none || protocolValue.hasEmbeddedFeed {
            VStack(alignment: .leading, spacing: 12) {
                Text("5. Avanço de corte")
                    .font(.headline)
                    .foregroundColor(theme.text)
                Text(
                    protocolValue == .none
                        ? (session.machine.cutMeasurementFailed
                            ? "Não foi possível medir corte com os comandos curtos. O avanço termina em zero; o caminho avançado continua disponível."
                            : "Sem guilhotina, o avanço medido termina em zero e nenhuma tira adicional é enviada.")
                        : "Este protocolo já contém alimentação. O avanço termina em zero sem um ESC d adicional."
                )
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                Button("Concluir avanço com zero") {
                    perform { try session.completeCutFeedWithoutProbe() }
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.cutFeed.zero")
                if session.machine.cutMeasurementFailed {
                    Button("Avançado: testar todos os dialetos") {
                        perform { try session.retryCutWithAdvancedProbe() }
                    }
                    .buttonStyle(.bordered)
                    .tint(theme.warning)
                    .accessibilityIdentifier("printerSetup.homologation.cut.retryAdvanced")
                }
                backStepButton
            }
            .printerHomologationCard(theme: theme)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("5. Avanço de corte")
                    .font(.headline)
                    .foregroundColor(theme.text)
                // O aviso diz o que vai sair e para quê; quem não quiser pagar as oito tiras agora
                // pula, e o botão diz o que pular custa.
                Text(PrinterHomologationUIContract.cutFeedWarning)
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Imprimir") {
                    perform {
                        try session.confirmBenchReadyForCutFeed()
                        try session.sendCurrentProbe()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.send.cutFeed")
                Button("Pular (usa 5 linhas, medido em outra impressora)") {
                    perform { try session.skipCutFeedMeasurement() }
                }
                .homologationChoiceStyle(theme: theme)
                .accessibilityIdentifier("printerSetup.homologation.cutFeed.skip")
                backStepButton
            }
            .printerHomologationCard(theme: theme)
        }
    }

    @ViewBuilder
    private func responseContent(_ step: PrinterHomologationStep) -> some View {
        switch step {
        case .geometry:
            if session.machine.paperWidth == nil {
                paperWidthResponseContent
            } else {
                geometryResponseContent
            }
        case .rasterThroughput:
            rasterThroughputResponseContent
        case .nativeCode:
            nativeCodeResponseContent
        case .codePage:
            codePageResponseContent
        case .cutProtocol:
            cutProtocolResponseContent
        case .cutFeed:
            cutFeedResponseContent
        }
    }

    private var paperWidthResponseContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Qual das duas réguas ficou certa no seu papel?")
                .font(.headline)
                .foregroundColor(theme.text)
            HStack(spacing: 10) {
                paperWidthChoice(.mm58)
                paperWidthChoice(.mm80)
            }
            Button("Nenhum") {
                selectedWidth = nil
                selectedColumns = 48
                selectedDots = 576
                perform { try session.selectNoPaperWidthFromPrintedRulers() }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.primary)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("printerSetup.homologation.paper.none")
            Text("Nenhum imprime uma única régua textual de 24 a 64 colunas e uma régua raster de 256 a 640 dots.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private func paperWidthChoice(_ width: PrinterPaperWidth) -> some View {
        Button("\(width.rawValue) mm") {
            selectedWidth = width
            selectedColumns = width.defaultPrintableColumns
            selectedDots = width.defaultPrintableDots
            perform { try session.selectPaperWidthFromPrintedRulers(width) }
        }
        .buttonStyle(.borderedProminent)
        .tint(theme.primary)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("printerSetup.homologation.paper.\(width.rawValue)")
    }

    private var geometryResponseContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Responda pela régua impressa")
                .font(.headline)
                .foregroundColor(theme.text)
            Text("Informe a última barra que saiu inteira, sem quebrar de linha, e a maior faixa cujas bordas esquerda e direita saíram completas.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            Picker("Última barra inteira", selection: $selectedColumns) {
                ForEach(columnChoices, id: \.self) { columns in
                    Text("\(columns) colunas").tag(columns)
                }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("printerSetup.homologation.geometry.columns")

            Picker("Maior faixa completa", selection: $selectedDots) {
                ForEach(selectedWidth?.geometryProbeDots ?? Array(stride(from: 256, through: 640, by: 32)), id: \.self) { dots in
                    Text("\(dots) dots").tag(dots)
                }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("printerSetup.homologation.geometry.dots")

            Button("Confirmar geometria") {
                perform {
                    try session.answer(
                        .geometry(printableColumns: selectedColumns, printableDots: selectedDots)
                    )
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.primary)
            .accessibilityIdentifier("printerSetup.homologation.answer.geometry")
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    /// Linhas de papel da tira de página nesta impressora, com o padrão da largura enquanto a
    /// régua não foi respondida.
    private var codePageProbeLines: Int {
        PrinterProbePayloads.codePageProbeLineCount(
            printableColumns: session.machine.printableColumns
                ?? session.machine.paperWidth?.defaultPrintableColumns
                ?? PrinterPaperWidth.mm58.defaultPrintableColumns
        )
    }

    private var codePageResponseContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Escolha a letra da primeira linha que saiu legível")
                .font(.headline)
                .foregroundColor(theme.text)
            Text("Todos os acentos precisam ter saído, as maiúsculas também. Se nenhuma outra saiu, a linha a) é a resposta.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
            // Só a letra, como no papel. Nome de página e endereço são vocabulário nosso e só
            // aparecem no comprovante final, onde servem ao catálogo.
            ForEach(PrinterHomologationUIContract.codePageCandidates, id: \.letter) { candidate in
                Button("Linha \(candidate.letter)") {
                    perform { try session.answer(.codePage(candidate.letter)) }
                }
                .homologationChoiceStyle(theme: theme)
                .accessibilityIdentifier(
                    "printerSetup.homologation.answer.codePage.\(candidate.letter)"
                )
            }
            Button("Nenhuma linha serviu") {
                perform { try session.answer(.codePage(nil)) }
            }
            .homologationChoiceStyle(theme: theme)
            .accessibilityIdentifier("printerSetup.homologation.answer.codePage.none")
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private var cutProtocolResponseContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Qual corte você quer usar?")
                .font(.headline)
                .foregroundColor(theme.text)
            // A escolha é à vista de todas as tiras. Perguntar tira a tira pedia julgamento sobre
            // uma tira só, e a pessoa não tinha com o que comparar.
            Text("Compare as tiras: o número está impresso em cada uma. O que você escolher passa a ser o corte de toda venda.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(PrinterHomologationMachine.allCutProtocols.enumerated()), id: \.element) { index, dialect in
                Button("Corte \(index + 1)") {
                    perform { try session.answer(.cutProtocol(dialect)) }
                }
                .homologationChoiceStyle(theme: theme)
                .accessibilityIdentifier("printerSetup.homologation.answer.cut.\(dialect.rawValue)")
            }
            Button("Nenhuma cortou") {
                perform { try session.answer(.cutProtocol(.none)) }
            }
            .homologationChoiceStyle(theme: theme)
            .accessibilityIdentifier("printerSetup.homologation.answer.cut.none")
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private var cutFeedResponseContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Escolha o menor avanço que não cortou texto")
                .font(.headline)
                .foregroundColor(theme.text)
            Text("Confira o número grande no início e imediatamente antes da linha de referência de cada tira.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(PrinterHomologationUIContract.cutFeedLines, id: \.self) { lines in
                Button("\(lines) linhas") {
                    perform { try session.answer(.cutFeed(lines)) }
                }
                .homologationChoiceStyle(theme: theme)
                .accessibilityIdentifier("printerSetup.homologation.answer.cutFeed.\(lines)")
            }
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private func sendingContent(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ProgressView()
            Text(title).font(.headline).foregroundColor(theme.text)
            Text(detail)
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .printerHomologationCard(theme: theme)
        .accessibilityIdentifier("printerSetup.homologation.sending")
    }

    private func failureContent(
        title: String,
        retryTitle: String,
        retry: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline).foregroundColor(theme.danger)
            Text("Nada será reenviado sem uma nova ação sua.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
            Button(retryTitle, action: retry)
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.retry")
        }
        .printerHomologationCard(theme: theme)
    }

    private var finalReceiptReadyContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Comprovante final")
                .font(.headline)
                .foregroundColor(theme.text)
            Text("A configuração está apenas no rascunho em memória. Ela ainda não foi salva nem selecionada.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button("Imprimir comprovante final") {
                perform { try session.sendFinalReceipt() }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.primary)
            .accessibilityIdentifier("printerSetup.homologation.final.send")
            // A tira de acentos é a última medida, e a letra escolhida nela só se prova no
            // comprovante. Quem viu que escolheu errado volta e refaz, aqui e depois do envio,
            // enquanto não disser "saiu certo".
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private func finalConfirmationContent(callbackFailed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("O comprovante final saiu correto?")
                .font(.headline)
                .foregroundColor(theme.text)
            if callbackFailed {
                Label(
                    "O transporte informou falha, mas o iOS não sabe se ela aconteceu antes ou " +
                        "depois do início do envio. Inspecione o papel antes de escolher.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.subheadline)
                .foregroundColor(theme.warning)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("printerSetup.homologation.final.uncertain")
            }
            Text("Somente “Saiu certo” salva a configuração neste aparelho e troca a seleção. As outras respostas não adotam nem repetem o envio.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            // Nomear no fim, e não no começo: é agora que a pessoa sabe qual impressora é esta —
            // acabou de ver o comprovante sair dela. Sem isto o perfil herdava o nome do perfil de
            // descoberta e nascia "Impressora temporária", sem distinguir duas do mesmo tamanho.
            Text("Nome desta impressora")
                .font(.subheadline)
                .foregroundColor(theme.text)
            TextField("Ex.: balcão, cozinha, T210", text: $nomeDoPerfil)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .accessibilityIdentifier("printerSetup.homologation.final.name")
                // O campo já vem com o nome que a impressora declarou na busca. Vinha vazio, e o
                // rodapé dizia "em branco mantém o nome atual" sem mostrar qual era — quem chegava
                // aqui via "Impressora temporária" no resumo e não sabia que o aparelho já tinha
                // se identificado.
                .onAppear {
                    if nomeDoPerfil.isEmpty {
                        nomeDoPerfil = (try? session.previewFinalProfile().displayName) ?? ""
                    }
                }
            Text("É este o nome que vai para a lista. Troque se quiser reconhecer pelo lugar.")
                .font(.footnote)
                .foregroundColor(theme.secondaryText)

            Button("Saiu certo") {
                perform {
                    try session.renameFinalProfile(nomeDoPerfil)
                    try session.confirmFinalReceipt()
                    onAdoptionCommitted()
                    if profileActions.isEmpty {
                        onFinished()
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.success)
            .accessibilityIdentifier("printerSetup.homologation.final.correct")

            Button("Saiu com problema") {
                rejectFinalReceipt(
                    message: "O rascunho foi preservado apenas nesta sessão. Corrija a bancada antes de enviar de novo."
                )
            }
            .buttonStyle(.bordered)
            .tint(theme.warning)
            .accessibilityIdentifier("printerSetup.homologation.final.problem")

            Button("Não saiu", role: .destructive) {
                rejectFinalReceipt(
                    message: "Nada foi adotado. O comprovante final só será reenviado por uma nova ação."
                )
            }
            .buttonStyle(.bordered)
            .tint(theme.danger)
            .accessibilityIdentifier("printerSetup.homologation.final.notPrinted")

            // Corrigir o acento errado vem antes de confirmar que o papel saiu certo. Some
            // sozinho quando o comprovante falhou — ali a decisão sobre o papel vem primeiro.
            backStepButton
        }
        .printerHomologationCard(theme: theme)
    }

    private func finishedContent(_ profile: MeasuredProfile) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(
                PrinterHomologationUIContract.completionTitle,
                systemImage: "checkmark.circle.fill"
            )
                .font(.headline)
                .foregroundColor(theme.success)
            Text(PrinterHomologationUIContract.completionReady)
                .font(.subheadline)
                .foregroundColor(theme.text)
            Text(profile.displayName)
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
            // O gesto que produz o pacote de contribuição mora aqui, e não numa tela própria nem
            // no slot do hospedeiro, porque quem acabou de homologar é quem tem o que contribuir:
            // o perfil medido está salvo, o papel já foi conferido, e a pessoa ainda está com a
            // impressora na frente. Ele decide sozinho se aparece — ver
            // `ExportacaoDeContribuicao.preparar` e o argumento em `ContribuicaoDaMedicaoPanel`.
            ContribuicaoDaMedicaoPanel(perfil: profile, theme: theme)
            profileActions.content(for: profile)
            // O rótulo diz em que aparelho a configuração ficou, e isso quem sabe é o hospedeiro.
            Button(localOnlyCopy.finishTitle, action: onFinished)
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .accessibilityIdentifier("printerSetup.homologation.finish")
        }
        .printerHomologationCard(theme: theme)
    }

    private var columnChoices: [Int] {
        selectedWidth.map(PrinterHomologationUIContract.geometryColumnChoices) ?? Array(24...64)
    }

    private var currentHomologationStep: PrinterHomologationStep? {
        switch session.state {
        case let .homologating(state):
            switch state {
            case let .ready(step), let .sending(step), let .awaitingResponse(step), let .failed(step):
                return step
            case .done:
                return nil
            }
        case .finalReceiptReady, .sendingFinalReceipt, .awaitingFinalConfirmation,
             .finalReceiptFailed, .finished:
            return nil
        }
    }

    private func title(for step: PrinterHomologationStep) -> String {
        switch step {
        case .geometry: return "a régua de geometria"
        case .rasterThroughput: return "a tira cinza de velocidade"
        case .nativeCode: return "a tira com as duas figuras"
        case .codePage: return "a tira de texto e acentos"
        case .cutProtocol: return "as tiras de corte"
        case .cutFeed:
            return "as oito tiras de avanço"
        }
    }

    private func rejectFinalReceipt(message: String) {
        do {
            try session.rejectFinalReceipt()
            localError = message
        } catch {
            localError = error.localizedDescription
        }
    }

    /// O "Voltar" do passo, onde as ações dele moram.
    ///
    /// Some sozinho quando não há o que desfazer — o primeiro passo, um envio em curso, uma falha
    /// esperando decisão, a instalação já confirmada —, porque quem responde isso é a máquina e a
    /// sessão, não uma contagem de passos guardada aqui. O aviso abaixo anuncia o papel antes do
    /// toque; voltar em si não imprime nada.
    @ViewBuilder
    private var backStepButton: some View {
        if PrinterHomologationUIContract.offersBack(
            session.state,
            machineCanGoBack: session.canGoBack
        ), let previous = session.previousStep {
            // `secondaryText` é o cinza que esta tela usa para o lado NÃO escolhido de um par —
            // veja o seletor de largura, onde a medida ativa é `primary` e a outra é este cinza.
            // O "Voltar" habilitado nascia com ele e lia-se como desabilitado: relatado no
            // iPhone 7 em 20/08, "cinza, não parece tocável". Botão secundário ativo desta
            // superfície é `.bordered` com `primary`, o mesmo de "Sim/Não/Não sei"; desabilitado o
            // SwiftUI apaga sozinho.
            Button("Voltar") { goBack() }
                .buttonStyle(.bordered)
                .tint(theme.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("printerSetup.homologation.back")
            Text(
                PrinterHomologationUIContract.backNotice(
                    to: previous,
                    reprintsProbes: session.backReprintsProbes
                )
            )
            .font(.footnote)
            .foregroundColor(theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("printerSetup.homologation.back.notice")
        }
    }

    private func goBack() {
        perform {
            try session.goBack()
            // A tela não pode continuar oferecendo as escolhas da premissa que acabou de ser
            // desfeita: a largura da máquina volta a mandar nos seletores da régua.
            selectedWidth = session.machine.paperWidth
            selectedColumns = session.machine.printableColumns
                ?? PrinterPaperWidth.mm58.defaultPrintableColumns
            selectedDots = session.machine.paperWidth?.defaultPrintableDots
                ?? PrinterPaperWidth.mm58.defaultPrintableDots
        }
    }

    private func perform(_ operation: () throws -> Void) {
        do {
            try operation()
            localError = nil
        } catch {
            localError = error.localizedDescription
        }
    }
}

/// Ilustração vetorial e decorativa: a bobina e as tirinhas antecipam o custo físico sem depender
/// de asset, emoji ou API posterior ao iOS 15.
@available(iOS 15.0, macOS 12.0, *)
private struct PrinterPaperTestIllustration: View {
    let theme: ThermalPrinterTheme

    private let samples = ["coração", "impressão", "exceção", "saúde"]

    var body: some View {
        ZStack(alignment: .top) {
            ForEach(samples.indices, id: \.self) { index in
                PrinterPaperTestStrip(text: samples[index], theme: theme)
                    .rotationEffect(.degrees(Double(index * 8 - 12)))
                    .offset(x: CGFloat(index * 42 - 63), y: 66)
            }

            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(theme.surface)
                    .frame(width: 128, height: 66)
                    .overlay(
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .stroke(theme.secondaryText, lineWidth: 1)
                    )
                Circle()
                    .fill(theme.background)
                    .frame(width: 58, height: 58)
                    .overlay(Circle().stroke(theme.primary, lineWidth: 2))
                Circle()
                    .fill(theme.primarySurface)
                    .frame(width: 20, height: 20)
            }
            .offset(y: 8)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 166)
        .accessibilityHidden(true)
    }
}

@available(iOS 15.0, macOS 12.0, *)
private struct PrinterPaperTestStrip: View {
    let text: String
    let theme: ThermalPrinterTheme

    var body: some View {
        VStack(spacing: 6) {
            Text(text)
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundColor(theme.text)
                .lineLimit(1)
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                .foregroundColor(theme.secondaryText)
                .frame(height: 1)
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(0..<6, id: \.self) { tick in
                    Rectangle()
                        .fill(theme.secondaryText)
                        .frame(width: 1, height: tick.isMultiple(of: 2) ? 8 : 5)
                }
            }
        }
        .padding(7)
        .frame(width: 58, height: 88, alignment: .top)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .stroke(theme.secondaryText, lineWidth: 0.5)
        )
    }
}

@available(iOS 15.0, macOS 12.0, *)
private extension View {
    func printerHomologationCard(theme: ThermalPrinterTheme) -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    func homologationChoiceStyle(theme: ThermalPrinterTheme) -> some View {
        buttonStyle(.bordered)
            .tint(theme.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

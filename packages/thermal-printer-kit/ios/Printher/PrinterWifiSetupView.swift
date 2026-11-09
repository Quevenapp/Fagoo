import Foundation
import SwiftUI
import ThermalPrinterKit

/**
 Configura a rede Wi-Fi da impressora a partir de campos, e nunca de bytes digitados.

 Gêmeo de `printher/src/main/java/br/com/thermalprinterkit/printher/PrinterWifiSetupPanel.kt`. As
 regras e as frases moram em ``PrinterWifiSetupContract``, que é gêmeo do contrato de lá; esta View
 só desenha o que aquele contrato decide, e **não escreve nenhuma frase própria** — frase escrita
 aqui fica fora das afirmações de segurança da suíte.

 Mora no kit, e não no app, pela mesma razão do comando cru e do scan: são dois públicos, não um —
 nós, com hardware na bancada, e a pessoa com um modelo que nunca teremos.

 **Ela existe por causa de um acidente medido.** Em 21/08/2026 um quadro de configuração foi
 digitado à mão no painel de comando cru, faltou um byte, e o quadro deslocado gravou assim mesmo:
 nome de rede truncado, byte de modo pego do lixo do buffer, e a impressora saiu da rede. Um byte a
 menos não vira erro, vira quadro válido errado. Por isso aqui **não existe caminho de hexadecimal
 digitado**: os campos vão para ``ThermalWifiFrame``, que valida tudo antes de emitir qualquer coisa.

 **O comprovante é o papel, nunca esta tela.** Depois do envio o app não vê resposta nenhuma — uma
 família imprime o cupom com o que ficou gravado, a outra só apita —, e a própria gravação derruba a
 conexão que entregou os bytes. Falha de transporte depois do envio é o caminho normal, e não é
 resposta sobre o papel.

 A senha é do cliente: ela não é logada, não é persistida, não aparece em hexadecimal e não entra em
 descrição de erro. Ela deixa a tela no instante em que o quadro pendente nasce, como
 ``RawHexCommand`` faz com o hexadecimal do comando cru — entre o preparo e a confirmação há um
 alerta aberto por tempo indefinido, e duas cópias vivas do segredo durante todo esse tempo é uma a
 mais.

 Não aplica `printerStatusBarInset()`: como o comando cru e o scan, o hospedeiro a apresenta dentro
 de um `NavigationLink`, e o topo seguro chega dele. Página que o hospedeiro desenha ponta a ponta é
 que paga o próprio recuo.
 */
@available(iOS 15.0, macOS 12.0, *)
@MainActor
public struct PrinterWifiSetupView: View {
    @ObservedObject var printer: ThermalPrinterConfiguration
    @StateObject private var model: WifiSetupModel

    public init(printer: ThermalPrinterConfiguration) {
        self.printer = printer
        _model = StateObject(wrappedValue: WifiSetupModel(printer: printer))
    }

    public var body: some View {
        // Uma leitura por desenho: a consulta desce ao store e, na rede, ao `getifaddrs`, e o
        // `body` reavalia a cada tecla digitada nos campos.
        let podeEnviar = printer.canSendEphemeralCommand
        let alvo = PrinterWifiSetupContract.target(
            hasEphemeralCandidate: printer.hasEphemeralProbeTarget,
            canSend: podeEnviar,
            hasAdoptedPrinter: !printer.coordinator.adoptedPrinters.isEmpty
        )

        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                riskHeader

                Text(PrinterWifiSetupContract.targetNotice(alvo))
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                // Só enquanto a resposta for a de antes: a partir da primeira resposta desta
                // sessão, a frase deixa de ser verdade.
                if model.showsStoredFamilyNotice {
                    Text(PrinterWifiSetupContract.storedFamilyNotice)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // O passo é estado de sessão e **não** função do alvo: perder o alvo fecha o botão
                // e mostra a frase acima, mas não apaga a pergunta respondida nem o formulário
                // digitado. A queda pós-escrita é o caminho normal desta tela, e ela derruba o alvo.
                // O perfil **semeia** esse estado no `init`, e não o define a cada desenho.
                switch model.stage {
                case .target:
                    targetStep(alvo)
                case .reading:
                    readingStep(alvo)
                case .choice(let resultado):
                    choiceStep(resultado, alvo)
                case .form(let familia):
                    formStep(familia, alvo)
                }

                if model.isSending {
                    ProgressView(PrinterWifiSetupContract.sendingNotice)
                }
                if let message = model.message {
                    Text(message)
                        .font(.footnote)
                        .foregroundColor(model.failed ? .red : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.stage != .target {
                    Button(PrinterWifiSetupContract.restartButtonTitle) { model.restart() }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("printer.diagnostics.wifi.restart")
                }
            }
            .padding(20)
        }
        .alert(model.confirmationTitle, isPresented: $model.showsConfirmation) {
            Button(PrinterWifiSetupContract.cancelButtonTitle, role: .cancel) { model.cancel() }
            Button(PrinterWifiSetupContract.confirmButtonTitle, role: .destructive) {
                model.confirm()
            }
        } message: {
            Text(model.confirmationWarning)
        }
        // Sair da tela zera o quadro pendente e esquece a senha: ela é do cliente, e a tela só a
        // guarda enquanto está viva.
        .onDisappear { model.forgetSecret() }
    }

    // MARK: - 1. o alvo

    private var riskHeader: some View {
        Label(
            PrinterWifiSetupContract.introNotice,
            systemImage: "exclamationmark.triangle.fill"
        )
        .font(.subheadline.weight(.semibold))
        .foregroundColor(.orange)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func targetStep(_ alvo: PrinterWifiSetupTarget) -> some View {
        Text(PrinterWifiSetupContract.probeExplanation)
            .font(.subheadline)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)

        Text(PrinterWifiSetupContract.probePaperCostNotice)
            .font(.caption)
            .foregroundColor(.secondary)

        Text(PrinterWifiSetupContract.portOutageNotice)
            .font(.caption)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)

        probeButton(
            PrinterWifiSetupContract.probeButtonTitle,
            systemImage: "doc.plaintext",
            identifier: "printer.diagnostics.wifi.probe",
            alvo
        )
    }

    // MARK: - 2. a leitura

    @ViewBuilder
    private func readingStep(_ alvo: PrinterWifiSetupTarget) -> some View {
        Text(PrinterWifiSetupContract.readingQuestion)
            .font(.headline)

        // As frases são as do kit, sem uma palavra a mais: a leitura é a medição, e uma medição que
        // muda de palavra entre as plataformas é outra medição. Elas interpolam os marcadores da
        // própria tira, então nunca descrevem uma tira que a sonda não emite.
        ForEach(ThermalWifiProbeReading.allCases, id: \.self) { leitura in
            Button {
                model.answer(leitura)
            } label: {
                Text(leitura.label)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("printer.diagnostics.wifi.reading.\(leitura.rawValue)")
        }

        probeButton(
            PrinterWifiSetupContract.probeAgainButtonTitle,
            systemImage: "arrow.clockwise",
            identifier: "printer.diagnostics.wifi.probe.again",
            alvo
        )
    }

    // MARK: - 3. a escolha da família

    @ViewBuilder
    private func choiceStep(
        _ resultado: ThermalWifiProbeResult,
        _ alvo: PrinterWifiSetupTarget
    ) -> some View {
        if let aviso = PrinterWifiSetupContract.unconfirmedNotice(resultado) {
            Text(aviso)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }

        // As duas saídas baratas vêm antes da decisão pesada. A tira custa papel; responder de novo
        // não custa nenhum, e é o caminho de quem só errou o botão.
        probeButton(
            PrinterWifiSetupContract.probeAgainButtonTitle,
            systemImage: "arrow.clockwise",
            identifier: "printer.diagnostics.wifi.probe.again",
            alvo
        )

        Button(PrinterWifiSetupContract.answerAgainButtonTitle) { model.answerAgain() }
            .buttonStyle(.bordered)
            .disabled(model.isSending)
            .accessibilityIdentifier("printer.diagnostics.wifi.answer.again")

        VStack(alignment: .leading, spacing: 8) {
            Text(PrinterWifiSetupContract.manualChoiceTitle)
                .font(.headline)
            Text(PrinterWifiSetupContract.manualChoiceExplanation)
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(PrinterWifiSetupContract.manualChoiceProofWarning)
                .font(.footnote)
                .foregroundColor(.orange)
                .fixedSize(horizontal: false, vertical: true)
            Button(PrinterWifiSetupContract.manualChoiceButtonTitle) { model.chooseOtherFamily() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("printer.diagnostics.wifi.manual")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - 4. o formulário

    @ViewBuilder
    private func formStep(
        _ familia: ThermalWifiProtocol,
        _ alvo: PrinterWifiSetupTarget
    ) -> some View {
        Text(PrinterWifiSetupContract.formProvenanceNotice(for: familia))
            .font(.subheadline)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)

        if familia == PrinterWifiSetupContract.manuallyChosenProtocol {
            Text(PrinterWifiSetupContract.manualChoiceProofWarning)
                .font(.footnote)
                .foregroundColor(.orange)
                .fixedSize(horizontal: false, vertical: true)
            // Dito antes do envio, e não depois: quem configura pela rede que a própria impressora
            // cria perde essa rede assim que ela entra na rede nova. Nesta família não há byte de
            // modo, então é o único efeito possível.
            Text(PrinterWifiSetupContract.accessPointHandoffNotice)
                .font(.footnote)
                .foregroundColor(.orange)
                .fixedSize(horizontal: false, vertical: true)
        }

        // O modo vem antes do nome da rede porque ele muda o sentido do campo seguinte: em ponto de
        // acesso a rede é criada, em cliente ela é procurada.
        if familia == .usW { modeSection }

        let rotuloDoNome = PrinterWifiSetupContract.ssidFieldLabel(
            for: familia == .usW ? model.mode : nil
        )
        VStack(alignment: .leading, spacing: 6) {
            Text(rotuloDoNome)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            TextField("", text: $model.ssid)
                .textFieldStyle(.roundedBorder)
                .disableAutocorrection(true)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .accessibilityLabel(rotuloDoNome)
                .accessibilityIdentifier("printer.diagnostics.wifi.ssid")
        }

        securitySection(familia)

        if model.requiresPassword {
            VStack(alignment: .leading, spacing: 6) {
                Text(PrinterWifiSetupContract.passwordFieldLabel)
                    .font(.subheadline)
                SecureField("", text: $model.password)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(PrinterWifiSetupContract.passwordFieldLabel)
                    .accessibilityIdentifier("printer.diagnostics.wifi.password")
                Text(PrinterWifiSetupContract.passwordNotice)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        // Enquanto falta escolha, a régua não tem o que responder — e botão cinza sem frase é o
        // defeito que já travou a lista de impressoras deste kit.
        if let pendente = PrinterWifiSetupContract.pendingChoiceNotice(
            for: familia,
            securityChosen: model.securityIsChosen,
            modeChosen: model.mode != nil
        ) {
            Text(pendente)
                .font(.footnote)
                .foregroundColor(.secondary)
        }

        // A frase de recusa é a da camada de quadro, e vai inteira: a régua saiu do firmware e do
        // emissor do fabricante, não da tela.
        if let recusa = model.validation?.rejection {
            Text(recusa.message)
                .font(.footnote)
                .foregroundColor(.red)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let bytes = model.validation?.byteCount {
            Text(PrinterWifiSetupContract.byteCountNotice(bytes))
                .font(.caption)
                .foregroundColor(.secondary)
        }

        Button(PrinterWifiSetupContract.prepareButtonTitle) {
            model.prepare(hasTarget: printer.canSendEphemeralCommand)
        }
        .buttonStyle(.borderedProminent)
        .disabled(
            !PrinterWifiSetupContract.allowsPreparing(
                target: alvo,
                isSending: model.isSending,
                validation: model.validation
            )
        )
        .accessibilityIdentifier("printer.diagnostics.wifi.prepare")

        // Voltar à pergunta sem gastar outra tira: o formulário aberto pela tira pode ter vindo de
        // uma leitura errada, e a correção não pode custar papel novo.
        Button(PrinterWifiSetupContract.answerAgainButtonTitle) { model.answerAgain() }
            .buttonStyle(.bordered)
            .disabled(model.isSending)
            .accessibilityIdentifier("printer.diagnostics.wifi.form.answer.again")
    }

    /// O gesto que gasta papel, num lugar só: o valor lido no topo do `body` é de um desenho atrás,
    /// e o gesto relê a permissão mais recente antes de mandar bytes.
    @ViewBuilder
    private func probeButton(
        _ title: String,
        systemImage: String,
        identifier: String,
        _ alvo: PrinterWifiSetupTarget
    ) -> some View {
        Button {
            model.sendProbe(hasTarget: printer.canSendEphemeralCommand)
        } label: {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isSending || !alvo.allowsSending)
        .accessibilityIdentifier(identifier)
    }

    /// Sem valor pré-selecionado, de propósito: este mapeamento já foi "corrigido" ao contrário uma
    /// vez neste projeto e tirou uma impressora da rede.
    ///
    /// A ordem é a de ``ThermalWifiMode/allCases``, que põe o ponto de acesso primeiro — o kit o
    /// chama de rota de volta garantida. Pôr o modo cliente na frente é oferecer primeiro o modo que
    /// derruba o ponto de acesso pelo qual a pessoa pode estar conectada.
    @ViewBuilder
    private var modeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(PrinterWifiSetupContract.modeLabel)
                .font(.subheadline)
            ForEach(ThermalWifiMode.allCases, id: \.self) { modo in
                Button {
                    model.select(mode: modo)
                } label: {
                    Text(
                        (model.mode == modo ? "✓ " : "")
                            + PrinterWifiSetupContract.label(for: modo)
                    )
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("printer.diagnostics.wifi.mode.\(modo.rawValue)")
            }
            if let modo = model.mode {
                Text(PrinterWifiSetupContract.modeWarning(for: modo))
                    .font(.footnote)
                    .foregroundColor(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Duas listas, e não uma com um `if`: são vocabulários diferentes, com fronteiras diferentes,
    /// e traduzir um no outro por posição é a armadilha que os dois docblocks do kit nomeiam.
    @ViewBuilder
    private func securitySection(_ familia: ThermalWifiProtocol) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(PrinterWifiSetupContract.securityLabel)
                .font(.subheadline)
            switch familia {
            case .usW:
                Picker(
                    PrinterWifiSetupContract.securityLabel,
                    selection: Binding(
                        get: { model.usWSecurity },
                        set: { model.select(usWSecurity: $0) }
                    )
                ) {
                    Text(PrinterWifiSetupContract.securityPlaceholder)
                        .tag(PrinterWifiSecurityChoice?.none)
                    ForEach(PrinterWifiSecurityChoice.allCases, id: \.self) { escolha in
                        Text(escolha.label).tag(PrinterWifiSecurityChoice?.some(escolha))
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("printer.diagnostics.wifi.security")
            case .usEscUs:
                Picker(
                    PrinterWifiSetupContract.securityLabel,
                    selection: Binding(
                        get: { model.keyType },
                        set: { model.select(keyType: $0) }
                    )
                ) {
                    Text(PrinterWifiSetupContract.securityPlaceholder)
                        .tag(ThermalWifiKeyType?.none)
                    ForEach(ThermalWifiKeyType.allCases, id: \.self) { tipo in
                        Text(PrinterWifiSetupContract.label(for: tipo))
                            .tag(ThermalWifiKeyType?.some(tipo))
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("printer.diagnostics.wifi.keyType")
            }
        }
    }
}

// MARK: - o estado da sessão de tela

/**
 O estado desta tela, e quase tudo nele morre com ela.

 **A exceção é uma só, e é nomeada: a família de configuração.** Ela custa uma tira de papel, e
 redescobri-la a cada abertura era cobrar papel por uma pergunta já respondida — por isso ela desce
 ao perfil, que é onde toda capacidade medida deste kit mora. Tudo o mais continua de sessão: o
 passo, os campos e, principalmente, a senha, que é do cliente e não é salva em lugar nenhum.

 **O passo é semeado do perfil e nunca derivado dele.** ``PrinterWifiSetupContract/initialStage(for:)``
 é chamada aqui, no `init`, e mais em lugar nenhum: passo derivado de qualquer coisa fora da sessão
 apaga a pergunta respondida quando a conexão cai — e a queda pós-escrita é o caminho normal desta
 tela.

 Os campos do formulário são **um só conjunto**, e não um por família: trocar de família não pode
 apagar o nome da rede já digitado, que costuma ser o mesmo nos dois formatos. A senha é a exceção,
 e sai em toda troca — segredo guardado para um formulário que a pessoa deixou é segredo guardado à
 toa.

 Todo `@Published` de resultado é `private(set)`; só os dois campos de texto e o portão de
 confirmação são de escrita livre. Os três seletores passam por métodos porque trocar de segurança
 pode tornar a senha inútil, e senha inútil é segredo guardado à toa.
 */
@available(iOS 15.0, macOS 12.0, *)
@MainActor
private final class WifiSetupModel: ObservableObject {
    @Published private(set) var stage: PrinterWifiSetupStage

    /// Enquanto o passo desenhado for o que veio do perfil, e não uma resposta desta sessão.
    @Published private(set) var showsStoredFamilyNotice: Bool

    @Published var ssid = ""
    @Published var password = ""
    @Published private(set) var usWSecurity: PrinterWifiSecurityChoice?
    @Published private(set) var keyType: ThermalWifiKeyType?
    @Published private(set) var mode: ThermalWifiMode?

    @Published var showsConfirmation = false
    @Published private(set) var confirmationTitle = ""
    @Published private(set) var confirmationWarning = ""
    @Published private(set) var message: String?
    @Published private(set) var isSending = false
    @Published private(set) var failed = false

    private weak var printer: ThermalPrinterConfiguration?
    private var pending: PrinterWifiPendingFrame?

    init(printer: ThermalPrinterConfiguration) {
        self.printer = printer
        // Uma leitura só, na construção do estado. O perfil da impressora em uso é o único lugar
        // onde esta resposta pode estar; sem ele — candidata retida, instalada sem perfil
        // resolvido — a tela abre como sempre abriu, no passo do alvo.
        let gravada = Self.storedFamily(of: printer)
        stage = PrinterWifiSetupContract.initialStage(for: gravada)
        showsStoredFamilyNotice = gravada != nil
    }

    /// Se a segurança desta família já foi escolhida. Os seletores nascem vazios de propósito, e a
    /// tela precisa saber disso para dizer o que falta em vez de só apagar o botão.
    var securityIsChosen: Bool {
        switch stage {
        case .form(.usW): return usWSecurity != nil
        case .form(.usEscUs): return keyType != nil
        case .target, .reading, .choice: return false
        }
    }

    /// Se o ramo escolhido tem onde guardar uma senha. Enquanto não há escolha, não há campo:
    /// pedir senha antes de saber se ela cabe no quadro é pedir segredo à toa.
    var requiresPassword: Bool {
        switch stage {
        case .form(.usW): return usWSecurity?.requiresPassword ?? false
        case .form(.usEscUs): return keyType?.requiresPassword ?? false
        case .target, .reading, .choice: return false
        }
    }

    /// A régua é a da camada de quadro, chamada e não reconstruída. `nil` enquanto falta escolha
    /// sem valor padrão — e é assim que "não escolhi ainda" deixa de parecer "escolhi o primeiro".
    var validation: ThermalWifiValidation? {
        switch stage {
        case .form(.usW):
            guard let usWSecurity, mode != nil else { return nil }
            return ThermalWifiFrame.validate(
                ssid: ssid,
                security: usWSecurity.security(password: password)
            )
        case .form(.usEscUs):
            guard let keyType else { return nil }
            return ThermalWifiFrame.validate(keyType: keyType, ssid: ssid, password: password)
        case .target, .reading, .choice:
            return nil
        }
    }

    // MARK: seletores

    func select(usWSecurity escolha: PrinterWifiSecurityChoice?) {
        usWSecurity = escolha
        discardUselessPassword()
    }

    func select(keyType tipo: ThermalWifiKeyType?) {
        keyType = tipo
        discardUselessPassword()
    }

    func select(mode modo: ThermalWifiMode) {
        mode = modo
    }

    // MARK: a tira

    func sendProbe(hasTarget: Bool) {
        guard hasTarget else {
            fail(PrinterWifiSetupContract.noTargetAtGesture)
            return
        }
        message = nil
        failed = false
        isSending = true
        send(ThermalWifiProbe.usWFamilyStrip) { [weak self] desfecho in
            guard let self else { return }
            self.isSending = false
            // A tira derruba a conexão que a entregou. Queda depois do envio é o caminho normal:
            // não é falha da sonda e não vira leitura. Só quando nada saiu do telefone é que a
            // frase muda de sentido, e aí a pergunta do papel **não** abre.
            self.failed = desfecho != .reachedPrinter
            self.message = PrinterWifiSetupContract.probeDispatchNotice(desfecho)
            if let proximo = PrinterWifiSetupContract.stageAfterProbe(desfecho) {
                self.stage = proximo
            }
        }
    }

    func answer(_ reading: ThermalWifiProbeReading) {
        stage = PrinterWifiSetupContract.stage(after: reading)
        showsStoredFamilyNotice = false
        // A resposta desce ao perfil aqui, e só aqui: depois de a pessoa responder, nunca antes de
        // a tira sair. Os dois indeterminados devolvem `nil` e não gravam nada — "não saiu nada"
        // não é resposta sobre a impressora.
        record(PrinterWifiSetupContract.recordableFamily(after: reading))
        // O desfecho da leitura é mostrado pelo próprio passo seguinte; repeti-lo na linha de
        // mensagem daria duas frases para a mesma medição.
        message = nil
        failed = false
    }

    /// Volta à pergunta sem gastar outra tira. A tira já saiu; o que se desfaz é a resposta.
    ///
    /// **A senha sai junto, e o resto do formulário fica.** Esta é a única porta de saída de um
    /// formulário fora do recomeço, e portanto o único caminho para trocar de família: o nome da
    /// rede costuma servir aos dois formatos, mas segredo guardado para um formulário que a pessoa
    /// deixou é segredo guardado à toa.
    func answerAgain() {
        cancel()
        stage = .reading
        showsStoredFamilyNotice = false
        password = ""
        message = nil
        failed = false
    }

    func chooseOtherFamily() {
        stage = .form(PrinterWifiSetupContract.manuallyChosenProtocol)
        showsStoredFamilyNotice = false
        // Escolha da pessoa, gravada como escolha: o perfil registra que ninguém mediu isto, e é
        // essa distinção que impede uma sessão futura de ler declaração como medição.
        record(PrinterWifiSetupContract.manuallyChosenFamily)
        message = nil
        failed = false
    }

    // MARK: o portão de dois gestos

    func prepare(hasTarget: Bool) {
        guard case .form(let familia) = stage else { return }
        guard hasTarget else {
            fail(PrinterWifiSetupContract.noTargetAtGesture)
            return
        }
        guard let bytes = frame(for: familia) else {
            // A régua já disse aceito: `nil` aqui é defeito desta tela, não recusa de campo. Frase
            // de recusa inventada mandaria a pessoa mexer num campo que está certo.
            assertionFailure("Quadro nulo depois de validação aceita.")
            fail(PrinterWifiSetupContract.frameConstructionFailure)
            return
        }
        pending?.clear()
        let pendente = PrinterWifiPendingFrame(bytes)
        pending = pendente
        confirmationTitle = PrinterWifiSetupContract.confirmationTitle(
            frameByteCount: pendente.byteCount
        )
        confirmationWarning = PrinterWifiSetupContract.confirmationWarning(
            for: familia,
            mode: familia == .usW ? mode : nil
        )
        // A senha deixa a tela assim que o quadro existe, no molde do `hexText = ""` do comando
        // cru: daqui em diante ela vive num buffer só, que é zerado no fim do envio. Entre este
        // gesto e a confirmação há um alerta aberto por tempo indefinido.
        password = ""
        message = nil
        failed = false
        showsConfirmation = true
    }

    func confirm() {
        showsConfirmation = false
        guard case .form(let familia) = stage, let pendente = pending else {
            fail(PrinterWifiSetupContract.frameConstructionFailure)
            return
        }
        pending = nil
        message = nil
        failed = false
        isSending = true
        pendente.send(
            using: { [weak self] buffer, desfecho in
                guard let self else {
                    desfecho(.noTarget)
                    return
                }
                self.send(buffer as Data, completion: desfecho)
            },
            completion: { [weak self] desfecho in
                guard let self else { return }
                self.isSending = false
                // Nem o sucesso nem a queda provam papel, e a queda é esperada: gravar derruba o
                // canal. Nada é repetido automaticamente. Só "não começou a escrever" autoriza
                // mandar de novo sem olhar o papel.
                self.failed = desfecho != .reachedPrinter
                self.message = PrinterWifiSetupContract.sendOutcomeNotice(
                    dispatch: desfecho,
                    wifiProtocol: familia
                )
            }
        )
    }

    func cancel() {
        pending?.clear()
        pending = nil
        showsConfirmation = false
    }

    // MARK: o fim da sessão

    /// Volta ao começo e esquece tudo: outra impressora pode ser outra família.
    ///
    /// **O que fica no perfil não é apagado aqui.** Aquela resposta custou uma tira de papel, e um
    /// toque em "começar de novo" não é motivo para jogá-la fora — ela é substituída quando a
    /// pessoa responder de novo, que é o que este gesto abre caminho para fazer.
    func restart() {
        cancel()
        stage = .target
        showsStoredFamilyNotice = false
        ssid = ""
        password = ""
        usWSecurity = nil
        keyType = nil
        mode = nil
        message = nil
        failed = false
    }

    /// Sair da tela zera o quadro pendente e a senha. O resto do formulário não é segredo e fica —
    /// o campo de senha vazio é visível, e a régua bloqueia o envio até ele voltar.
    func forgetSecret() {
        cancel()
        password = ""
    }

    // MARK: o transporte, e o que ele não prova

    /**
     Entrega os bytes e devolve só o que dá para afirmar sobre eles.

     **O `Bool` do agregado não é descartado.** Era o `_ =` daqui que fazia "não havia remetente
     algum" chegar à tela como "a conexão caiu, e isso é esperado" — e, no caminho da tira, ainda
     perguntava o que saiu no papel sem papel nenhum. `sendEphemeralCommand` devolve `false` e
     chama a conclusão com ``PrinterProbeFailure/rejected`` no mesmo caso; a tela lê os dois.

     A ordem é segura pelos dois lados. Quando não há remetente, a conclusão é chamada de forma
     **síncrona** e só então o `Bool` é devolvido — mas o corpo do `Task` só roda depois de este
     método retornar, porque já estamos no MainActor, então `houveRemetente` está lido quando o
     desfecho é classificado. E se algum dia a ordem mudar, o valor inicial `true` faz a
     classificação cair no `.rejected` do callback, que diz a mesma coisa.
     */
    private func send(_ bytes: Data, completion: @escaping (PrinterWifiDispatch) -> Void) {
        guard let printer else {
            completion(.noTarget)
            return
        }
        var houveRemetente = true
        let entregou = printer.sendEphemeralCommand(
            bytes,
            // `fallingBackToAdopted` tem padrão `false` e é **pedido**: sem ele a tela só
            // funcionaria com candidata efêmera retida, e o público desta tela é quem já tem
            // impressora instalada.
            fallingBackToAdopted: true
        ) { resultado in
            Task { @MainActor in
                completion(
                    PrinterWifiSetupContract.dispatch(
                        result: resultado,
                        hadSender: houveRemetente
                    )
                )
            }
        }
        houveRemetente = entregou
    }

    // MARK: - o que sobrevive à tela

    /**
     A família já gravada no perfil da impressora em uso, ou `nil` quando não há o que ler.

     **Só a instalada e ativa tem perfil para consultar.** A candidata retida vive em memória e o
     perfil dela nunca foi persistido; sem `profileId` resolvido também não há registro. Nos dois
     casos a tela abre no passo do alvo, exatamente como abria antes deste campo existir.

     **Síncrona aqui, e assíncrona no gêmeo, de propósito.** Este agregado é `@MainActor` e todo o
     resto do kit já consulta o store assim — `saveManualConfiguration` e a recomposição do layout
     operacional fazem o mesmo. No Android o store é chamado de dentro de uma `@Composable`, e lá a
     política escrita é a oposta: leitura fora da composição, em `Dispatchers.IO`. Cada lado segue a
     regra da própria plataforma; o que os dois têm de compartilhar é **o disco**, e é isso que a
     paridade de formato garante.
     */
    private static func storedFamily(
        of printer: ThermalPrinterConfiguration
    ) -> PrinterWifiConfigurationFamily? {
        guard let profileId = activeProfileId(of: printer) else { return nil }
        return printer.profileStore.profile(id: profileId)?.wifiConfigurationFamily
    }

    /**
     O perfil que recebe a resposta — e `nil` quando não dá para saber que perfil é.

     **Com candidata retida em memória, este método não responde**, e é a correção mais importante
     desta camada. Os bytes saem pela candidata: `ephemeralCommandSender` devolve o sender dela
     antes de qualquer queda para a adotada. Mas o perfil da candidata só existe depois da adoção,
     e ler ou escrever no da instalada significaria **medir uma impressora e gravar a resposta no
     perfil de outra** — duas unidades diferentes, com a tela mostrando uma e o disco guardando a
     outra.

     É a mesma classe de defeito que a revisão pegou no comando cru em 21/08, quando a queda para a
     adotada não era escopada ao transporte e os bytes saíam pela impressora errada. Ali custou
     bytes no fio; aqui custaria uma resposta de papel atribuída a quem não a deu.

     Sem perfil, a resposta continua valendo na sessão — só não sobrevive ao fechamento do app.
     */
    private static func activeProfileId(of printer: ThermalPrinterConfiguration) -> String? {
        guard !printer.hasEphemeralProbeTarget else { return nil }
        return printer.coordinator.adoptedPrinters.first { $0.active }?.profileId
    }

    /**
     Desce a resposta ao perfil, quando há perfil.

     **Não vira mensagem de tela, nem em caso de falha.** A resposta continua valendo na sessão de
     qualquer jeito — o passo já avançou —, e a única coisa que se perde sem perfil é a sobrevivência
     ao fechamento do app. Anunciar isso a cada resposta encheria a tela de uma linha sobre
     armazenamento no meio de um fluxo que fala de papel; o que a tela nunca faz é o contrário,
     afirmar que gravou.

     O `nil` chega aqui de propósito, e é o caso indeterminado: ele existe para ser recusado num
     lugar só, em vez de cada chamador lembrar de não gravá-lo.
     */
    private func record(_ family: PrinterWifiConfigurationFamily?) {
        guard let family, let printer, let profileId = Self.activeProfileId(of: printer) else {
            return
        }
        printer.profileStore.recordWifiConfigurationFamily(family, forProfileId: profileId)
    }

    // MARK: régua interna

    private func frame(for familia: ThermalWifiProtocol) -> Data? {
        switch familia {
        case .usW:
            guard let usWSecurity, let mode else { return nil }
            return ThermalWifiFrame.usW(
                ssid: ssid,
                security: usWSecurity.security(password: password),
                mode: mode
            )
        case .usEscUs:
            guard let keyType else { return nil }
            // Só o quadro que grava rede. O que reescreve IP, máscara e gateway fica de fora desta
            // tela: ele reescreve os três sempre, não tem "não mexa neste campo", e endereço errado
            // tira a impressora da rede sem DHCP para socorrer.
            return ThermalWifiFrame.usEscUsWifiOnly(
                keyType: keyType,
                ssid: ssid,
                password: password
            )
        }
    }

    /// Senha que o ramo escolhido não carrega é segredo guardado à toa — e, na segunda família,
    /// seria recusa de quadro por um campo que a tela nem mostra mais.
    private func discardUselessPassword() {
        guard !requiresPassword else { return }
        password = ""
    }

    private func fail(_ reason: String) {
        failed = true
        message = reason
    }
}

/**
 O quadro já montado, esperando o segundo gesto.

 Guarda a senha em bytes, e por isso segue a disciplina de ``RawHexCommand``: descrição redigida,
 zeragem depois do callback e no `deinit`. **Não é caminho de hexadecimal** — os bytes vêm de
 ``ThermalWifiFrame`` a partir de campos tipados, e esta classe não sabe montá-los nem lê-los de
 texto; ela só segura e apaga.
 */
private final class PrinterWifiPendingFrame: CustomStringConvertible {
    /// Quem entrega os bytes. Fica de fora porque o transporte é do agregado, e esta classe existe
    /// só para o buffer ter dono e fim — o mesmo desenho de `RawHexCommand.send(using:)`.
    typealias Delivery = (NSMutableData, @escaping (PrinterWifiDispatch) -> Void) -> Void

    private let buffer: NSMutableData
    private var consumed = false

    let byteCount: Int
    var description: String { "PrinterWifiPendingFrame(byteCount: \(byteCount), content: [REDACTED])" }

    init(_ bytes: Data) {
        buffer = NSMutableData(data: bytes)
        byteCount = bytes.count
    }

    func send(using deliver: Delivery, completion: @escaping (PrinterWifiDispatch) -> Void) {
        precondition(!consumed, "O quadro de configuração já foi consumido.")
        consumed = true
        // Retém o próprio quadro até o callback: capturando só o buffer, o `deinit` poderia zerá-lo
        // enquanto o transporte ainda estivesse preparando o envio.
        deliver(buffer) { [self] desfecho in
            buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
            completion(desfecho)
        }
    }

    func clear() {
        guard !consumed else { return }
        consumed = true
        buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
    }

    deinit {
        buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
    }
}

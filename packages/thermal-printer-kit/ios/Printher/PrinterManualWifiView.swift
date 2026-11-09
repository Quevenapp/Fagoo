import SwiftUI
import ThermalPrinterKit

/// O que falta para um endereço digitado poder receber o comprovante de teste.
enum PrinterManualAddressCheck: Equatable {
    case incomplete
    case invalidPort
    case invalidAddress
    case ready
}

/**
 Endereço manual de impressora de rede.

 A regra de endereço aceitável é uma só e mora em ``LocalWifiPrinterEndpoint``: RFC1918, quatro
 octetos, porta de 1 a 65535. Esta camada não a repete — ela pergunta —, porque duas respostas
 sobre o que é um endereço válido é como se aceita na tela o que o transporte vai recusar depois.
 */
enum PrinterManualAddress {
    /// Porta ESC/POS de fábrica em praticamente toda impressora de rede.
    static let defaultPort = "9100"

    static func normalized(_ address: String) -> String {
        address.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func check(address: String, portText: String) -> PrinterManualAddressCheck {
        let ip = normalized(address)
        let porta = normalized(portText)
        guard !ip.isEmpty, !porta.isEmpty else { return .incomplete }
        guard let port = Int(porta), (1...65_535).contains(port) else { return .invalidPort }
        guard LocalWifiPrinterEndpoint(ipAddress: ip, port: port) != nil else { return .invalidAddress }
        return .ready
    }

    static func message(for check: PrinterManualAddressCheck) -> String? {
        switch check {
        case .ready:
            return nil
        case .incomplete:
            return "Informe o IP e a porta da impressora."
        case .invalidPort:
            return "A porta vai de 1 a 65535. Na maioria das impressoras é 9100."
        case .invalidAddress:
            return "O endereço precisa ser um IP privado: 10.x, de 172.16.x a 172.31.x, ou 192.168.x."
        }
    }
}

/// Se a configuração manual está instalando uma impressora nova ou refazendo o endereço de uma
/// unidade que já está na lista.
struct ThermalPrinterManualTarget: Equatable {
    /// Preenchido só na reconfiguração: qual unidade a engrenagem abriu.
    let installationId: String?
    let profileID: String?
    let displayName: String?

    static func newPrinter(profileID: String?) -> Self {
        Self(installationId: nil, profileID: profileID, displayName: nil)
    }

    static func reconfigure(_ printer: AdoptedPrinter) -> Self {
        Self(
            installationId: printer.installationId,
            profileID: printer.profileId,
            displayName: printer.displayName
        )
    }

    var isReconfiguration: Bool { installationId != nil }
}

/// O que fazer com a unidade anterior quando a reconfiguração termina.
enum PrinterReconfigurationOutcome: Equatable {
    /// Ainda não há substituta confirmada no papel. A anterior continua sendo a impressora.
    case pending
    /// A anterior sai: a nova unidade aponta para a mesma medição, então nada se perde com ela.
    case replaced(previousInstallationId: String, displayName: String)
    /// A anterior fica, e a pessoa decide pela lixeira.
    case keptPrevious(displayName: String)
}

/**
 Conciliação de uma reconfiguração de rede.

 A chave da instalação é perfil mais identidade, então endereço novo é **outra** unidade — sem
 conciliar, a lista fica com duas linhas de mesmo nome e nenhuma forma de saber qual é qual.

 A anterior só sai quando a nova aponta para a mesma medição: excluir uma instalação apaga o perfil
 medido que ninguém mais usa, e reconfigurar endereço não pode custar a medição da bancada. Quando
 a configuração mudou junto — o caminho que passa pelas sondas —, as duas ficam e a pessoa escolhe
 qual excluir, com o aviso que a lixeira já traz.
 */
enum PrinterReconfiguration {
    static func outcome(
        of target: ThermalPrinterManualTarget,
        installed: [AdoptedPrinter]
    ) -> PrinterReconfigurationOutcome {
        guard let anterior = target.installationId,
              let ativa = installed.first(where: { $0.active }),
              ativa.installationId != anterior,
              installed.contains(where: { $0.installationId == anterior })
        else { return .pending }
        guard ativa.profileId == target.profileID else {
            return .keptPrevious(displayName: target.displayName ?? "A impressora anterior")
        }
        return .replaced(previousInstallationId: anterior, displayName: ativa.displayName)
    }
}

/**
 O que um endereço digitado instala: a entrada escolhida, ou uma medição declarada.

 Quem não mexeu em nada entra pela própria entrada que escolheu. Criar uma medição local idêntica
 a ela seria inventar um perfil que ninguém pediu — e, quando a escolha é uma medição de bancada,
 seria pior: uma cópia dela com outro identificador, que o `AGENTS.md` chama de perfil duplicado e
 a lista chama de dois cards para a mesma impressora.
 */
enum PrinterManualInstallation {
    static func declaredProfile(
        from configuration: PrinterManualConfiguration?,
        chosen: PrinterProfile,
        transport: PrinterCapabilityTransport = .localWifi,
        id: String = UUID().uuidString.lowercased()
    ) -> MeasuredProfile? {
        guard let configuration, !configuration.matches(chosen) else { return nil }
        return try? configuration.profile(id: id, transports: [transport])
    }
}

/**
 Configuração manual de impressora Wi-Fi: IP, porta e qual configuração usar.

 Existe porque procurar não é o único caminho — a varredura bate na porta 9100 de cada endereço da
 sub-rede, e impressora em VLAN separada, com porta trocada ou fora da faixa varrida simplesmente
 não aparece. No iPhone 7 de 20/08 não havia nenhuma alternativa: sem a busca achar, não havia
 impressora.

 Não existe equivalente Bluetooth, e não é omissão: BLE só se alcança por anúncio, e digitar o
 identificador de um periférico não conecta em nada.
 */
@available(iOS 15.0, macOS 12.0, *)
struct PrinterManualWifiView: View {
    let theme: ThermalPrinterTheme
    let target: ThermalPrinterManualTarget
    let profiles: [ThermalPrinterReadyProfile]
    let statusMessage: String
    let busy: Bool
    let onBack: () -> Void
    let onTest: (
        _ address: String,
        _ portText: String,
        _ profileID: String,
        _ configuration: PrinterManualConfiguration?
    ) -> Void

    @State private var address = ""
    @State private var portText = PrinterManualAddress.defaultPort
    @State private var chosenProfileID: String?
    /// As opções declaradas nesta instalação. Nascem do perfil escolhido e a pessoa ajusta o que
    /// souber; na reconfiguração de endereço elas não existem, porque ali a medição não se troca.
    @State private var configuration: PrinterManualConfiguration?

    private var check: PrinterManualAddressCheck {
        PrinterManualAddress.check(address: address, portText: portText)
    }

    private var selectedProfileID: String? {
        chosenProfileID ?? target.profileID
    }

    private var selectedProfile: ThermalPrinterReadyProfile? {
        profiles.first { $0.id == selectedProfileID }
    }

    private var canTest: Bool {
        !busy && check == .ready && selectedProfileID != nil
    }

    /// Botão desabilitado sem dizer por quê é tela quebrada: o que falta aparece escrito.
    private var blockingHint: String? {
        if let problema = PrinterManualAddress.message(for: check) { return problema }
        guard selectedProfileID == nil else { return nil }
        return "Escolha qual é a sua impressora para enviar o comprovante."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            heading
            addressFields
            // Reconfigurar não troca a medição — mas uma instalação cuja configuração não resolve
            // mais não tem o que preservar, e aí a escolha volta a ser a da instalação nova.
            if target.isReconfiguration, target.profileID != nil {
                installedProfileNotice
            } else {
                profileChoice
                options
            }
            if let pendencia = blockingHint {
                Text(pendencia)
                    .font(.caption)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !statusMessage.isEmpty {
                Text(statusMessage)
                    .font(.footnote)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            testButton
        }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onBack) {
                Label("Voltar", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundColor(theme.primary)
            .disabled(busy)

            Text(target.isReconfiguration ? "Trocar o endereço" : "Configuração manual")
                .font(theme.usesPrintherLayout ? .largeTitle.weight(.bold) : .title2.weight(.bold))
                .foregroundColor(theme.text)
            Text(
                target.isReconfiguration
                    ? "Informe onde \(target.displayName ?? "a impressora") está agora."
                    : "Use quando a impressora não aparece na busca. Ela precisa estar na Wi-Fi atual."
            )
            .font(theme.usesPrintherLayout ? .title3 : .subheadline)
            .foregroundColor(theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var addressFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("IP da impressora", text: $address)
                .printerAddressKeyboard()
                .textFieldStyle(.roundedBorder)
                .disabled(busy)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualAddress)
            TextField("Porta", text: $portText)
                .printerPortKeyboard()
                .textFieldStyle(.roundedBorder)
                .disabled(busy)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualPort)
            // O endereço digitado vive só nesta tela e no registro cifrado da instalação. Ele não
            // volta para cá depois: a tela não tem por onde lê-lo.
            Text("O IP existe apenas durante esta configuração e não aparece em nenhuma lista.")
                .font(.caption)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .printerSection(theme: theme)
    }

    private var profileChoice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Qual é a sua impressora?")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(theme.text)
            Text("A escolha preenche largura, acento e corte abaixo. Você ajusta o que souber antes de testar.")
                .font(.caption)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(profiles) { profile in
                Button {
                    chosenProfileID = profile.id
                    // Escolher outra impressora reabre as opções nas dela. Carregar as anteriores
                    // seria o palpite herdado que faz o cupom sair torto sem erro nenhum.
                    configuration = PrinterManualConfiguration(
                        capabilities: profile.capabilities,
                        displayName: profile.displayName
                    )
                } label: {
                    profileRow(profile, selected: profile.id == selectedProfileID)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualProfile(profile.id))
            }
        }
        .printerSection(theme: theme)
    }

    /**
     As opções operacionais, ao lado do endereço.

     Instalar por endereço digitado é o caminho de quem a busca não acha, e até aqui ele obrigava a
     aceitar inteira uma entrada de catálogo — que é conservadora de propósito: sem página e sem
     corte. A pessoa que sabe a tabela da impressora dela não tinha onde dizer, e descobria no
     primeiro cupom.
     */
    @ViewBuilder
    private var options: some View {
        if let selected = selectedProfile {
            optionsSection(for: selected)
        }
    }

    private func optionsSection(for selected: ThermalPrinterReadyProfile) -> some View {
        let declarada = Binding(
            get: { declaredConfiguration(for: selected) },
            set: { configuration = $0 }
        )
        return VStack(alignment: .leading, spacing: 14) {
            Text("Como ela imprime")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(theme.text)
            Text("Já vem preenchido pelo que sabemos de \(selected.displayName). Mude o que você souber.")
                .font(.caption)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            PrinterManualOptions(theme: theme, configuration: declarada, busy: busy)
            if let aviso = declarada.wrappedValue.warning {
                Label(aviso, systemImage: "textformat.abc.dottedunderline")
                    .font(.caption)
                    .foregroundColor(theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualWarning)
            }
        }
        .printerSection(theme: theme)
    }

    private func declaredConfiguration(
        for profile: ThermalPrinterReadyProfile
    ) -> PrinterManualConfiguration {
        configuration ?? PrinterManualConfiguration(
            capabilities: profile.capabilities,
            displayName: profile.displayName
        )
    }

    /// Na reconfiguração a medição não se troca por aqui.
    ///
    /// A chave da instalação é o perfil mais a identidade, então trocar de perfil grava outra
    /// unidade — e a antiga, se ninguém mais apontasse para a medição dela, levaria a medição
    /// junto. Medição de bancada não se perde por efeito colateral de uma tela de endereço.
    private var installedProfileNotice: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("A configuração medida continua a mesma")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(theme.text)
            Text("Só o endereço muda aqui. Para refazer largura, acento e corte, teste a impressora de novo.")
                .font(.caption)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .printerSection(theme: theme)
    }

    /// O catálogo é escolha visual, não medição: chamar de homologada uma entrada conservadora
    /// prometeria acento e corte que ninguém provou nesta impressora.
    private func sourceLabel(_ profile: ThermalPrinterReadyProfile) -> String {
        profile.source == .measured ? "Medida neste aparelho" : "Do catálogo, ainda não medida"
    }

    private func profileRow(_ profile: ThermalPrinterReadyProfile, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundColor(selected ? theme.primary : theme.secondaryText)
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(theme.text)
                Text("\(profile.detail) · \(sourceLabel(profile))")
                    .font(.caption)
                    .foregroundColor(theme.secondaryText)
            }
            Spacer(minLength: 0)
        }
        .padding(theme.usesPrintherLayout ? 16 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(selected ? theme.primary : Color.gray.opacity(0.22), lineWidth: selected ? 1.5 : 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    /// O papel vem antes da instalação, como em qualquer outro caminho: quem confirma que a
    /// impressora é aquela é o comprovante, nunca o endereço ter sido aceito.
    private var testButton: some View {
        Button {
            guard let profileID = selectedProfileID else { return }
            // Na reconfiguração de endereço a medição não se troca por aqui, então nada é
            // declarado; instalando, o comprovante sai com o que está na tela.
            let declarada = target.isReconfiguration
                ? nil
                : selectedProfile.map(declaredConfiguration(for:))
            onTest(
                PrinterManualAddress.normalized(address),
                PrinterManualAddress.normalized(portText),
                profileID,
                declarada
            )
        } label: {
            Label("Enviar comprovante de teste", systemImage: "printer")
                .frame(maxWidth: .infinity, minHeight: theme.usesPrintherLayout ? 60 : 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(theme.primary)
        .disabled(!canTest)
        .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualTest)
    }
}

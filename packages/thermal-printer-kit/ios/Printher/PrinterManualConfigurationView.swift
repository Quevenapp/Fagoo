import SwiftUI
import ThermalPrinterKit

/**
 Os campos da configuração manual: o que a pessoa declara sobre a impressora dela.

 Mesmo conjunto, mesma ordem e mesmos rótulos do `ManualConfigurationForm` do Android — nome,
 largura do papel, colunas, largura da imagem, guilhotina, comando de corte, avanço e a tira de
 texto e acentos. Nem mais nem menos: um campo a mais aqui é uma pergunta que o Android não faz, e
 um a menos é uma impressora que só se configura numa das duas plataformas.

 Diferente da homologação, aqui os nomes das páginas aparecem na tela. Lá a resposta é uma letra
 porque a pessoa está com a tira na mão e o papel é a fonte; aqui não há tira, e esconder `CP850`
 de quem sabe qual é a sua tabela seria pedir que ela adivinhasse a letra.
 */
@available(iOS 15.0, macOS 12.0, *)
struct PrinterManualOptions: View {
    let theme: ThermalPrinterTheme
    @Binding var configuration: PrinterManualConfiguration
    let busy: Bool

    @State private var columnsText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            name
            choice(
                "Largura do papel",
                PrinterPaperWidth.allCases,
                selected: configuration.paperWidth,
                label: { "\($0.rawValue) mm" },
                identifier: { ThermalPrinterSetupAccessibility.manualPaperWidth($0.rawValue) },
                select: { configuration.selectPaperWidth($0) }
            )
            columns
            choice(
                "Largura da imagem",
                configuration.paperWidth.geometryProbeDots,
                selected: configuration.printableDots,
                label: { "\($0) dots" },
                identifier: { ThermalPrinterSetupAccessibility.manualPrintableDots($0) },
                select: { configuration.printableDots = $0 }
            )
            choice(
                "Sua impressora tem guilhotina?",
                [false, true],
                selected: configuration.hasCutter,
                label: { $0 ? "Sim" : "Não" },
                identifier: { ThermalPrinterSetupAccessibility.manualCutter($0) },
                select: { configuration.selectCutter($0) }
            )
            if configuration.hasCutter {
                choice(
                    "Comando de corte",
                    PrinterManualConfiguration.cutProtocolChoices,
                    selected: configuration.cutProtocol,
                    label: \.manualLabel,
                    identifier: { ThermalPrinterSetupAccessibility.manualCutProtocol($0.rawValue) },
                    select: { configuration.selectCutProtocol($0) }
                )
                choice(
                    "Avanço antes do corte",
                    configuration.allowedCutFeedLines,
                    selected: configuration.cutFeedLines,
                    label: { $0 == 0 ? "Sem avanço separado" : "\($0) linhas" },
                    identifier: { ThermalPrinterSetupAccessibility.manualCutFeed($0) },
                    select: { configuration.selectCutFeedLines($0) }
                )
            }
            encodings
        }
        .onAppear { columnsText = String(configuration.printableColumns) }
        .onChange(of: configuration.paperWidth) { _ in
            columnsText = String(configuration.printableColumns)
        }
        .onChange(of: columnsText) { novo in
            let digitos = String(novo.filter(\.isNumber).prefix(2))
            if digitos != novo { columnsText = digitos }
            configuration.printableColumns = Int(digitos) ?? 0
        }
    }

    private var name: some View {
        VStack(alignment: .leading, spacing: 8) {
            title("Nome da impressora")
            TextField("Nome da impressora", text: nameBinding)
                .textFieldStyle(.roundedBorder)
                .disabled(busy)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualName)
        }
    }

    private var nameBinding: Binding<String> {
        Binding(
            get: { configuration.displayName },
            set: { configuration.displayName = String($0.prefix(80)) }
        )
    }

    private var columns: some View {
        VStack(alignment: .leading, spacing: 8) {
            title("Colunas imprimíveis")
            TextField("Colunas imprimíveis", text: $columnsText)
                .printerPortKeyboard()
                .textFieldStyle(.roundedBorder)
                .disabled(busy)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualColumns)
            Text("É quantos caracteres cabem numa linha do comprovante que você já tem.")
                .font(.caption)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var encodings: some View {
        VStack(alignment: .leading, spacing: 8) {
            title("Texto e acentos")
            ForEach(PrinterProbePayloads.codePageCandidates, id: \.letter) { candidate in
                let selecionada = candidate.letter == configuration.codePageCandidate?.letter
                Button {
                    configuration.select(candidate)
                } label: {
                    row("\(candidate.letter)) \(candidate.label)", selected: selecionada)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityIdentifier(
                    ThermalPrinterSetupAccessibility.manualEncoding(candidate.letter)
                )
            }
        }
    }

    private func choice<T: Hashable>(
        _ heading: String,
        _ choices: [T],
        selected: T,
        label: @escaping (T) -> String,
        identifier: @escaping (T) -> String,
        select: @escaping (T) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            title(heading)
            ForEach(choices, id: \.self) { choice in
                Button {
                    select(choice)
                } label: {
                    row(label(choice), selected: choice == selected)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityIdentifier(identifier(choice))
            }
        }
    }

    private func title(_ value: String) -> some View {
        Text(value)
            .font(.subheadline.weight(.semibold))
            .foregroundColor(theme.text)
    }

    private func row(_ label: String, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundColor(selected ? theme.primary : theme.secondaryText)
            Text(label)
                .font(.subheadline)
                .foregroundColor(theme.text)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .padding(theme.usesPrintherLayout ? 14 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(selected ? theme.primary : Color.gray.opacity(0.22), lineWidth: selected ? 1.5 : 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/**
 A tela inteira da configuração manual de uma unidade instalada.

 O comprovante de teste é opcional de propósito. Esta rota existe justamente para quem **já tem** o
 comprovante anterior na mão — foi assim que o Android a escreveu, e cobrar uma tira nova de quem
 sabe a resposta é gastar papel para confirmar o que ela veio digitar. Quem quiser conferir antes,
 confere: o comprovante sai com as opções desta tela, não com as que estão gravadas.
 */
@available(iOS 15.0, macOS 12.0, *)
struct PrinterManualConfigurationView: View {
    let theme: ThermalPrinterTheme
    let displayName: String
    @Binding var configuration: PrinterManualConfiguration
    let busy: Bool
    let saving: Bool
    /// Por que o comprovante não pode sair agora, quando não pode. Botão apagado sem texto é tela
    /// quebrada: a pessoa toca de novo achando que errou o alvo.
    let printingUnavailable: String?
    /// Quantas outras unidades instaladas dividem esta medição.
    let sharedInstallations: Int
    let status: String?
    let failure: String?
    /// "Salvar configuração" quando a unidade já existe; instalar é outro verbo.
    var saveTitle = "Salvar configuração"
    let transportAction: TransportAction?
    let onPrint: () -> Void
    let onSave: () -> Void
    let onBack: () -> Void

    /// O que só existe num transporte: trocar o endereço da de rede, refazer as sondas da BLE.
    struct TransportAction {
        let title: String
        let detail: String
        let symbol: String
        let perform: () -> Void
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading
            PrinterManualOptions(theme: theme, configuration: $configuration, busy: busy)
                .printerSection(theme: theme)
            notices
            if let status {
                Text(status)
                    .font(.footnote)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            printButton
            saveButton
            if let transportAction { self.transportRow(transportAction) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualConfiguration)
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onBack) {
                Label("Voltar", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundColor(theme.primary)
            .disabled(busy)

            Text("Configuração manual")
                .font(theme.usesPrintherLayout ? .largeTitle.weight(.bold) : .title2.weight(.bold))
                .foregroundColor(theme.text)
            Text("As opções que \(displayName) usa para imprimir. Nada muda até você salvar.")
                .font(theme.usesPrintherLayout ? .title3 : .subheadline)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var notices: some View {
        if let aviso = configuration.warning {
            notice(aviso, systemImage: "textformat.abc.dottedunderline", tone: theme.warning)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualWarning)
        }
        if sharedInstallations > 0 {
            // Duas iguais no balcão dividem a medição: mudar aqui muda o papel das duas, e
            // descobrir isso na impressora errada é o defeito silencioso de sempre.
            notice(
                sharedInstallations == 1
                    ? "Outra impressora instalada usa esta mesma configuração e muda junto."
                    : "Outras \(sharedInstallations) impressoras instaladas usam esta mesma configuração e mudam junto.",
                systemImage: "square.on.square",
                tone: theme.secondaryText
            )
        }
        if let failure {
            notice(failure, systemImage: "exclamationmark.triangle", tone: theme.warning)
        }
    }

    private func notice(_ text: String, systemImage: String, tone: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundColor(tone)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// O botão continua tocável mesmo com a impressora fora de alcance: ela pode ter ligado desde
    /// que a tela abriu, e apagar o botão por um estado que envelhece é a tela quebrada de novo.
    private var printButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onPrint) {
                Label("Imprimir comprovante de teste", systemImage: "printer")
                    .frame(maxWidth: .infinity, minHeight: theme.usesPrintherLayout ? 56 : 44)
            }
            .buttonStyle(.bordered)
            .tint(theme.primary)
            .disabled(busy)
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualPrint)
            Text(
                printingUnavailable
                    ?? "Sai com as opções desta tela, para você conferir o acento e o corte antes de salvar."
            )
            .font(.caption)
            .foregroundColor(theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var saveButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onSave) {
                Text(saving ? "Salvando…" : saveTitle)
                    .frame(maxWidth: .infinity, minHeight: theme.usesPrintherLayout ? 60 : 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.primary)
            .disabled(busy || saving || configuration.blockingHint != nil)
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualSave)
            if let pendencia = configuration.blockingHint {
                Text(pendencia)
                    .font(.caption)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func transportRow(_ action: TransportAction) -> some View {
        Button(action: action.perform) {
            HStack(spacing: 12) {
                Image(systemName: action.symbol)
                    .foregroundColor(theme.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(theme.text)
                    Text(action.detail)
                        .font(.caption)
                        .foregroundColor(theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(theme.secondaryText)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.gray.opacity(0.25)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

/// O rótulo de cada dialeto na tela, igual ao do Android: o comando e o que ele faz no papel.
extension CutProtocol {
    var manualLabel: String {
        switch self {
        case .gsV0: return "GS V 0 · corte total"
        case .gsV1: return "GS V 1 · corte parcial"
        case .gsV65: return "GS V 65 · total com avanço"
        case .gsV66: return "GS V 66 · parcial com avanço"
        case .escI: return "ESC i · corte total"
        case .escM: return "ESC m · corte parcial"
        case .none: return "Sem guilhotina"
        }
    }
}

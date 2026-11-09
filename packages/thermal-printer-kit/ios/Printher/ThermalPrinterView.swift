import SwiftUI
import ThermalPrinterKit

/// Superfície neutra e reutilizável para escolher ou configurar uma impressora. Endereços e
/// candidatas vivem apenas no estado efêmero da tela e dos controllers; a seleção só muda depois
/// de uma resposta explícita sobre o papel.
@available(iOS 15.0, macOS 12.0, *)
@MainActor
public struct ThermalPrinterView: View {
    @ObservedObject private var printer: ThermalPrinterConfiguration
    @StateObject private var flow: ThermalPrinterSetupFlow

    private let theme: ThermalPrinterTheme
    private let profileActions: PrinterProfileActionsSlot

    @State private var showsManualAddress = false
    @State private var manualAddress = ""
    @State private var manualPort = "9100"
    @State private var selectedCandidateID: Int?
    @State private var pendingPreliminaryTest: PendingPreliminaryTest?
    @State private var profileToForget: MeasuredProfile?
    @State private var forgetNotice: String?
    @State private var printerToRemove: AdoptedPrinter?
    @State private var reconfiguring: ThermalPrinterManualTarget?
    @State private var editing: ManualConfigurationEditing?

    /// O rascunho da engrenagem. Ele vive só nesta tela até a pessoa salvar — nada aqui chega ao
    /// disco antes disso.
    private struct ManualConfigurationEditing {
        let installationId: String
        var configuration: PrinterManualConfiguration
        var failure: String?
        var status: String?
        var saving = false
        var printing = false
    }

    public init(
        printer: ThermalPrinterConfiguration,
        theme: ThermalPrinterTheme = .neutral,
        profileActions: ((MeasuredProfile) -> AnyView)? = nil
    ) {
        _printer = ObservedObject(wrappedValue: printer)
        _flow = StateObject(wrappedValue: ThermalPrinterSetupFlow())
        self.theme = theme
        self.profileActions = PrinterProfileActionsSlot(profileActions)
    }

    public var body: some View {
        ScrollView {
            content
                .padding(theme.usesPrintherLayout ? 24 : 20)
                .frame(maxWidth: theme.usesPrintherLayout ? 760 : .infinity)
                .frame(maxWidth: .infinity)
        }
        // Página inteira: quando o hospedeiro esconde a barra de navegação, o recuo do relógio é
        // desta view. Ver ``PrinterScreenInset``.
        .printerStatusBarInset()
        .background(theme.background.ignoresSafeArea())
        .alert(
            "Como saiu o comprovante de teste?",
            isPresented: Binding(
                get: { awaitingInitialReceipt && !flow.suppressesReceiptQuestion },
                set: { _ in flow.receiptQuestionDismissalWasRequested() }
            )
        ) {
            // A conciliação da reconfiguração espera o desfecho final: enquanto a configuração
            // segue aberta, a unidade antiga ainda não tem substituta confirmada no papel.
            Button("Saiu certo") {
                flow.answerInitialReceipt(.printedCorrectly, resolve: printer.handleInitialReceipt)
                if !flow.showsHomologation { finishReconfiguration() }
            }
            .accessibilityIdentifier("printerSetup.confirmation.correct")

            Button("Saiu com problema") {
                flow.answerInitialReceipt(.printedWithProblem, resolve: printer.handleInitialReceipt)
                if !flow.showsHomologation { finishReconfiguration() }
            }
            .accessibilityIdentifier("printerSetup.confirmation.problem")

            Button("Não saiu", role: .destructive) {
                flow.answerInitialReceipt(.notPrinted, resolve: printer.handleInitialReceipt)
                if !flow.showsHomologation { finishReconfiguration() }
            }
            .accessibilityIdentifier("printerSetup.confirmation.notPrinted")
        } message: {
            Text(
                "Confira o papel na impressora escolhida. Problemas de largura, acentos ou corte " +
                    "precisam de uma configuração própria."
            )
        }
        .alert(
            // Apagar medição é irreversível e não tem desfazer: o disco é a única cópia. O alerta
            // mostra o que vai embora — geometria inclusive — porque foi exatamente a geometria
            // errada que fez esta saída existir.
            "Apagar a medição de \(profileToForget?.displayName ?? "")?",
            isPresented: Binding(
                get: { profileToForget != nil },
                set: { if !$0 { profileToForget = nil } }
            ),
            presenting: profileToForget
        ) { measured in
            Button("Apagar", role: .destructive) {
                profileToForget = nil
                do {
                    try printer.forgetMeasuredProfile(id: measured.id)
                    forgetNotice = "\(measured.displayName) saiu da lista. Meça de novo quando quiser usá-la."
                } catch {
                    forgetNotice = "A medição continua neste celular. Tente de novo."
                }
            }
            .accessibilityIdentifier("printerSetup.profile.forget.confirm")
            Button("Cancelar", role: .cancel) { profileToForget = nil }
                .accessibilityIdentifier("printerSetup.profile.forget.cancel")
        } message: { measured in
            Text(
                "Some deste celular: \(measured.paperWidthMm) mm, \(measured.printableColumns) colunas, "
                    + "\(measured.printableDots) dots. Se esta impressora estiver em uso, ela é solta "
                    + "junto e volta a precisar de medição. Não dá para desfazer."
            )
        }
        .alert(
            // Nomeia a impressora porque duas iguais no balcão são duas linhas idênticas: sem o
            // nome, confirmar a exclusão é apostar em qual delas a lixeira era.
            "Excluir \(printerToRemove?.displayName ?? "")?",
            isPresented: Binding(
                get: { printerToRemove != nil },
                set: { if !$0 { printerToRemove = nil } }
            ),
            presenting: printerToRemove
        ) { entry in
            Button("Excluir", role: .destructive) {
                printerToRemove = nil
                printer.coordinator.removeInstallation(entry.installationId)
                flow.installationRemoved(
                    entry.displayName,
                    succeeded: !printer.coordinator.adoptedPrinters.contains {
                        $0.installationId == entry.installationId
                    }
                )
            }
            .accessibilityIdentifier("printerSetup.remove.confirm")
            Button("Cancelar", role: .cancel) { printerToRemove = nil }
                .accessibilityIdentifier("printerSetup.remove.cancel")
        } message: { entry in
            // A medição só some quando ninguém mais aponta para ela: duas impressoras iguais
            // dividem a mesma medição de bancada, e prometer que ela vai embora seria mentira
            // justamente no caso em que a irmã continuaria imprimindo torto sem erro nenhum.
            Text(
                "\(entry.displayName) deixará de aparecer como instalada neste aparelho. A conexão "
                    + "dela sai junto, e a configuração medida também — a menos que outra "
                    + "impressora instalada ainda use a mesma medição."
            )
        }
        .alert(
            "Medição apagada",
            isPresented: Binding(
                get: { forgetNotice != nil },
                set: { if !$0 { forgetNotice = nil } }
            )
        ) {
            Button("Entendi", role: .cancel) { forgetNotice = nil }
        } message: {
            Text(forgetNotice ?? "")
        }
        .sheet(isPresented: $flow.showsHomologation, onDismiss: {
            flow.homologationDismissed(
                clearPendingSelection: {
                    _ = printer.handleInitialReceipt(.notPrinted)
                },
                discardEphemeralTarget: printer.discardEphemeralProbeTarget
            )
            finishReconfiguration()
        }) {
            PrinterHomologationView(
                printer: printer,
                store: printer.profileStore,
                theme: theme,
                profileActions: profileActions,
                preparationAlreadyAccepted: flow.homologationPreparationAccepted,
                opensManualConfiguration: flow.homologationOpensManualConfiguration,
                onAdoptionCommitted: flow.homologationAdoptionCommitted,
                onManualAdoption: flow.manualConfigurationAdopted,
                onFinished: flow.homologationFinished
            )
        }
        .overlay(connectingOverlay)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(ThermalPrinterSetupAccessibility.screen)
    }

    @ViewBuilder
    private var content: some View {
        switch flow.route {
        case .profiles:
            profilesContent
        case let .readyConnections(profileID):
            if let profile = readyProfiles.first(where: { $0.id == profileID }) {
                readyConnectionsContent(profile)
            } else {
                missingProfileContent
            }
        case .newConnections:
            newConnectionsContent
        case let .search(mode, profileID):
            searchContent(mode: mode, profileID: profileID)
        case let .paperCost(mode, profileID):
            paperCostContent(mode: mode, profileID: profileID)
        case .modelGrid:
            knownPrinterGrid
        case let .manualWifi(target):
            manualWifiContent(target)
        case let .manualConfiguration(target):
            manualConfigurationContent(target)
        }
    }

    private var profilesContent: some View {
        VStack(alignment: .leading, spacing: theme.usesPrintherLayout ? 20 : 16) {
            screenHeading(
                title: "Impressoras",
                subtitle: theme.usesPrintherLayout ? "" : "Escolha primeiro a impressora pronta. A forma de conexão vem depois."
            )

            adoptedSection
            if printer.coordinator.adoptedPrinters.isEmpty {
                Text("Você ainda não adicionou uma impressora. Toque em Adicionar impressora para começar.")
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                    .printerSection(theme: theme)
            }
            noticeSection
            addPrinterButton
        }
    }

    private func profileButton(_ profile: ThermalPrinterReadyProfile) -> some View {
        let active = printer.coordinator.adoptedPrinters.contains {
            $0.active && $0.displayName == profile.displayName
        }
        return Button {
            flow.selectProfile(profile.id)
        } label: {
            HStack(alignment: .center, spacing: theme.usesPrintherLayout ? 20 : 12) {
                Image(systemName: "printer")
                    .font(theme.usesPrintherLayout ? .system(size: 34) : .title3)
                    .foregroundColor(theme.primary)
                    .frame(width: theme.usesPrintherLayout ? 54 : 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text(profile.displayName)
                        .font(.headline)
                        .foregroundColor(theme.text)
                    Text(profile.detail)
                        .font(.subheadline)
                        .foregroundColor(theme.secondaryText)
                    if !profile.badge.isEmpty && !theme.usesPrintherLayout {
                        Text(profile.badge)
                            .font(.caption.weight(.semibold))
                            .foregroundColor(badgeColor(for: profile))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(theme.primarySurface)
                            .clipShape(Capsule())
                    }
                }
                Spacer(minLength: 0)
                if theme.usesPrintherLayout {
                    Text(profile.source == .bundled ? "Testada por nós" : "Só neste celular")
                        .font(.caption.weight(.medium))
                        .foregroundColor(profile.source == .bundled ? theme.success : theme.secondaryText)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(profile.source == .bundled ? Color.green.opacity(0.12) : Color.gray.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    if active {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title2)
                            .foregroundColor(theme.primary)
                    }
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(theme.secondaryText)
                }
            }
            .padding(theme.usesPrintherLayout ? 20 : 14)
            .frame(minHeight: theme.usesPrintherLayout ? 112 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(active ? theme.primary : Color.gray.opacity(0.25), lineWidth: active ? 1.5 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(setupIsOpen)
    }

    private func badgeColor(for profile: ThermalPrinterReadyProfile) -> Color {
        switch profile.source {
        case .bundled: return theme.success
        default: return theme.secondaryText
        }
    }

    private var addPrinterButton: some View {
        Button {
            flow.addNewPrinter()
        } label: {
            Label("Adicionar impressora", systemImage: "printer.fill.badge.plus")
                .font(theme.usesPrintherLayout ? .headline : .body)
                .frame(maxWidth: .infinity, minHeight: theme.usesPrintherLayout ? 68 : 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(theme.primary)
        // Saída de emergência: com a ativa inalcançável, é por aqui que a pessoa volta a ter
        // impressora. Ver ``PrinterUnitAvailability/allowsAddingPrinter(_:)``.
        .disabled(!PrinterUnitAvailability.allowsAddingPrinter(PrinterUnitActivity()))
        .accessibilityIdentifier("printerSetup.homologate")
    }

    private func readyConnectionsContent(_ profile: ThermalPrinterReadyProfile) -> some View {
        VStack(alignment: .leading, spacing: theme.usesPrintherLayout ? 22 : 16) {
            screenHeading(
                title: "Como conectar",
                subtitle: profile.displayName,
                showsBack: true
            )
            Text("Escolha uma conexão compatível com esta impressora.")
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)
            let modes = ThermalPrinterConnectionMode.allCases.filter {
                $0.isShown(for: profile.capabilities)
            }
            if modes.isEmpty {
                incompatibleProfileContent
            } else {
                ForEach(modes) { mode in
                    connectionButton(mode, profile: profile)
                }
            }
            if profile.capabilities.transports.contains(.localWifi) {
                manualConfigurationButton(profileID: profile.id)
            }
            if profile.source == .measured,
               let measured = measuredProfiles.first(where: { $0.id == profile.id }) {
                profileActions.content(for: measured)
                // Só medição local se apaga. A embutida veio da bancada e não é desta pessoa;
                // apagá-la seria remover uma impressora suportada, não desfazer uma medição.
                Button(role: .destructive) {
                    profileToForget = measured
                } label: {
                    Text("Apagar medição")
                }
                .accessibilityIdentifier("printerSetup.profile.\(measured.id).forget")
            }
            platformConnectionNotice
            noticeSection
        }
    }

    private var newConnectionsContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            screenHeading(
                title: "Adicionar impressora",
                subtitle: "Como essa impressora se liga ao celular?",
                showsBack: true
            )
            ForEach(ThermalPrinterConnectionMode.allCases) { mode in
                connectionButton(mode, profile: nil)
            }
            manualConfigurationButton(profileID: nil)
            Label("Não sabe? Comece pelo Bluetooth.", systemImage: "questionmark.circle")
                .font(theme.usesPrintherLayout ? .body : .footnote)
                .foregroundColor(theme.secondaryText)
            platformConnectionNotice
            noticeSection
        }
    }

    private func connectionButton(
        _ mode: ThermalPrinterConnectionMode,
        profile: ThermalPrinterReadyProfile?
    ) -> some View {
        let reason = mode.unavailabilityReason(for: profile?.capabilities)
        return Button {
            startSearch(mode: mode, profileID: profile?.id)
        } label: {
            HStack(alignment: .center, spacing: theme.usesPrintherLayout ? 20 : 14) {
                Image(systemName: mode.symbol)
                    .font(theme.usesPrintherLayout ? .system(size: 34) : .title2)
                    .foregroundColor(reason == nil ? theme.primary : theme.secondaryText)
                    .frame(width: theme.usesPrintherLayout ? 56 : 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text(mode.title)
                        .font(.headline)
                        .foregroundColor(reason == nil ? theme.text : theme.secondaryText)
                    Text(mode.detail)
                        .font(.subheadline)
                        .foregroundColor(theme.secondaryText)
                    if let reason {
                        Text(reason)
                            .font(.caption.weight(.semibold))
                            .foregroundColor(theme.secondaryText)
                    }
                }
                Spacer(minLength: 0)
                if reason == nil {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(theme.secondaryText)
                }
            }
            .padding(theme.usesPrintherLayout ? 22 : 16)
            .frame(minHeight: theme.usesPrintherLayout ? 118 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.gray.opacity(0.25)))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(reason != nil || setupIsBusy(mode.operationalTransport))
    }

    /**
     Entrada da configuração manual, ao lado da busca.

     Só Wi-Fi: BLE se alcança por anúncio, e não há endereço para digitar. Ela fica ao lado das
     conexões porque procurar não acha impressora fora da faixa varrida, em outra VLAN ou com a
     porta trocada — e sem esta entrada não havia caminho nenhum para essas.
     */
    private func manualConfigurationButton(profileID: String?) -> some View {
        Button {
            flow.configureManually(.newPrinter(profileID: profileID))
        } label: {
            HStack(alignment: .center, spacing: theme.usesPrintherLayout ? 20 : 14) {
                Image(systemName: "keyboard")
                    .font(theme.usesPrintherLayout ? .system(size: 34) : .title2)
                    .foregroundColor(theme.primary)
                    .frame(width: theme.usesPrintherLayout ? 56 : 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Configuração manual")
                        .font(.headline)
                        .foregroundColor(theme.text)
                    Text("Digite o IP e a porta, e escolha como ela imprime")
                        .font(.subheadline)
                        .foregroundColor(theme.secondaryText)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(theme.secondaryText)
            }
            .padding(theme.usesPrintherLayout ? 22 : 16)
            .frame(minHeight: theme.usesPrintherLayout ? 118 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.gray.opacity(0.25)))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(setupIsBusy(.localWifi))
        .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualEntry)
    }

    private func manualWifiContent(_ target: ThermalPrinterManualTarget) -> some View {
        PrinterManualWifiView(
            theme: theme,
            target: target,
            profiles: manualWifiProfiles,
            // Antes de qualquer tentativa o transporte só sabe dizer "procure uma impressora", que
            // é justamente o caminho que esta tela substitui.
            statusMessage: printer.localWifi.state == .idle ? "" : printer.localWifi.state.message,
            busy: setupIsBusy(.localWifi),
            onBack: {
                reconfiguring = nil
                flow.goBack()
            },
            onTest: { address, portText, profileID, declarada in
                requestPreliminaryTest(
                    manualTest(
                        address: address,
                        portText: portText,
                        profileID: profileID,
                        declared: declarada
                    ),
                    mode: .localNetwork,
                    profileID: profileID
                )
            }
        )
    }

    /// Endereço digitado: com as opções declaradas, ou pelo perfil escolhido tal e qual. A regra
    /// de qual dos dois mora em ``PrinterManualInstallation``, que é onde dá para prová-la.
    private func manualTest(
        address: String,
        portText: String,
        profileID: String,
        declared: PrinterManualConfiguration?
    ) -> PendingPreliminaryTest {
        guard let perfil = PrinterManualInstallation.declaredProfile(
            from: declared,
            chosen: operationalProfile(profileID: profileID, transport: .localWifi)
        ) else {
            return .manualAddress(address: address, portText: portText, profileID: profileID)
        }
        return .manualDeclared(address: address, portText: portText, profile: perfil)
    }

    /// Catálogo embutido mais o que esta pessoa mediu, só o que fala por rede. A escolha aqui é a
    /// mesma coisa que o card do modelo faz na busca: ela decide largura, acento e corte do
    /// comprovante que vai sair antes de qualquer instalação.
    private var manualWifiProfiles: [ThermalPrinterReadyProfile] {
        let medidos = measuredProfiles
            .filter { $0.capabilities.transports.contains(.localWifi) }
            .map(ThermalPrinterReadyProfile.init)
        let embutidos = BundledPrinterProfiles.all
            .filter { $0.capabilities.transports.contains(.localWifi) }
            .map(ThermalPrinterReadyProfile.init)
        return medidos + embutidos
    }

    private var platformConnectionNotice: some View {
        Text(
            "No iPhone e no iPad, cabo USB e Bluetooth clássico (SPP) não estão disponíveis. " +
                "A opção Bluetooth usa BLE. " + ThermalPrinterSetupCopy.iOSNetworkLimit
        )
        .font(.footnote)
        .foregroundColor(theme.secondaryText)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var incompatibleProfileContent: some View {
        Label(
            "Esta impressora não tem uma conexão compatível com este aparelho.",
            systemImage: "exclamationmark.triangle"
        )
        .font(.subheadline)
        .foregroundColor(theme.warning)
        .printerSection(theme: theme)
    }

    private var missingProfileContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            screenHeading(
                title: "A lista mudou",
                subtitle: "Volte e escolha a impressora novamente.",
                showsBack: true
            )
        }
    }

    private func searchContent(
        mode: ThermalPrinterConnectionMode,
        profileID: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            screenHeading(
                title: "Procurar impressora",
                subtitle: "Procurando por \(mode.title)",
                showsBack: true
            )
            Text(searchInstruction(for: mode))
                .font(theme.usesPrintherLayout ? .title3 : .body)
                .foregroundColor(theme.text)
                .fixedSize(horizontal: false, vertical: true)

            if mode == .bluetooth {
                if theme.usesPrintherLayout { searchRadar }
                bluetoothSearchContent(profileID: profileID)
            } else {
                localWifiSearchContent(mode: mode, profileID: profileID)
            }

            Text(ThermalPrinterSetupCopy.searchAlternative)
                .font(.footnote)
                .foregroundColor(theme.secondaryText)

            privacyNotice
            noticeSection
        }
    }

    private var searchRadar: some View {
        ZStack {
            ForEach([220.0, 160.0, 100.0], id: \.self) { size in
                Circle()
                    .fill(theme.primary.opacity(size == 100 ? 0.05 : 0.08))
                    .frame(width: size, height: size)
            }
            Circle().fill(theme.surface).frame(width: 82, height: 82)
            Image(systemName: "printer")
                .font(.system(size: 38))
                .foregroundColor(theme.primary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func bluetoothSearchContent(profileID: String?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(printer.bluetooth.state.message)
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)

            Button {
                restartSearch(.bluetooth)
            } label: {
                Label("Procurar de novo", systemImage: "dot.radiowaves.left.and.right")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(theme.primary)
            .disabled(setupIsBusy(.bluetooth))
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.bluetoothSearch)

            if !printer.bluetooth.candidates.isEmpty {
                let selectedCandidate = printer.bluetooth.candidates.first {
                    $0.id == selectedCandidateID
                }
                Text("Impressoras encontradas")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(theme.text)
                ForEach(printer.bluetooth.candidates) { candidate in
                    Button {
                        selectedCandidateID = candidate.id
                    } label: {
                        candidateRow(
                            title: candidate.label,
                            detail: nil,
                            selected: candidate.id == selectedCandidateID
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(setupIsBusy(.bluetooth))
                    .accessibilityIdentifier(
                        ThermalPrinterSetupAccessibility.bluetoothCandidate(candidate.id)
                    )
                }
                Button(ThermalPrinterSetupCopy.continueTitle) {
                    guard let selectedCandidate else { return }
                    let test = PendingPreliminaryTest.bluetooth(
                        candidateID: selectedCandidate.id,
                        profileID: profileID
                    )
                    requestPreliminaryTest(test, mode: .bluetooth, profileID: profileID)
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .disabled(setupIsBusy(.bluetooth) || selectedCandidate == nil)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.candidateContinue)
            }
        }
        .printerSection(theme: theme)
    }

    private func localWifiSearchContent(
        mode: ThermalPrinterConnectionMode,
        profileID: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(printer.localWifi.state.message)
                .font(.subheadline)
                .foregroundColor(theme.secondaryText)

            Button {
                restartSearch(mode)
            } label: {
                Label("Procurar de novo", systemImage: "magnifyingglass")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(theme.primary)
            .disabled(setupIsBusy(.localWifi))
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.search)

            if !printer.localWifi.candidates.isEmpty {
                let selectedCandidate = printer.localWifi.candidates.first {
                    $0.id == selectedCandidateID
                }
                Text("Impressoras encontradas")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(theme.text)
                ForEach(printer.localWifi.candidates) { candidate in
                    Button {
                        selectedCandidateID = candidate.id
                    } label: {
                        candidateRow(
                            title: candidate.label,
                            detail: "IP: \(candidate.ipAddress)",
                            selected: candidate.id == selectedCandidateID
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(setupIsBusy(.localWifi))
                    .accessibilityIdentifier(ThermalPrinterSetupAccessibility.candidate(candidate.id))
                }
                Button(ThermalPrinterSetupCopy.continueTitle) {
                    guard let selectedCandidate else { return }
                    let test = PendingPreliminaryTest.localWifi(
                        candidateID: selectedCandidate.id,
                        profileID: profileID
                    )
                    requestPreliminaryTest(test, mode: mode, profileID: profileID)
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.primary)
                .disabled(setupIsBusy(.localWifi) || selectedCandidate == nil)
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.candidateContinue)
            }

            Button(showsManualAddress ? "Ocultar endereço avançado" : "Informar IP e porta") {
                showsManualAddress.toggle()
                if !showsManualAddress {
                    manualAddress = ""
                    manualPort = operationalProfile(
                        profileID: profileID,
                        transport: .localWifi
                    ).capabilities.tcpPort.map(String.init) ?? "9100"
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundColor(theme.primary)
            .disabled(setupIsBusy(.localWifi))
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualToggle)

            if showsManualAddress {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("IP da impressora", text: $manualAddress)
                        .printerAddressKeyboard()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualAddress)
                    TextField("Porta", text: $manualPort)
                        .printerPortKeyboard()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualPort)
                    Button("Testar endereço") {
                        let test = PendingPreliminaryTest.manualAddress(
                            address: manualAddress,
                            portText: manualPort,
                            profileID: profileID
                        )
                        requestPreliminaryTest(test, mode: mode, profileID: profileID)
                    }
                    .buttonStyle(.bordered)
                    .tint(theme.primary)
                    .disabled(setupIsBusy(.localWifi))
                    .accessibilityIdentifier(ThermalPrinterSetupAccessibility.manualTest)
                    Text("O endereço precisa pertencer à Wi-Fi privada atual. A porta ESC/POS mais comum é 9100.")
                        .font(.caption)
                        .foregroundColor(theme.secondaryText)
                }
            }
        }
        .printerSection(theme: theme)
    }

    private func candidateRow(
        title: String,
        detail: String?,
        selected: Bool
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(theme.text)
                if let detail {
                    Text(detail)
                        .font(.caption.monospaced())
                        .foregroundColor(theme.secondaryText)
                }
            }
            Spacer()
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.body.weight(.semibold))
                .foregroundColor(selected ? theme.primary : theme.secondaryText)
        }
        .padding(theme.usesPrintherLayout ? 18 : 12)
        .frame(minHeight: theme.usesPrintherLayout ? 66 : nil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.gray.opacity(0.22)))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func paperCostContent(
        mode: ThermalPrinterConnectionMode,
        profileID: String?
    ) -> some View {
        PrinterPaperCostIntroduction(
            theme: theme,
            preliminaryReceiptPending: true,
            onStart: {
                flow.acceptPaperCost()
                runPendingPreliminaryTest()
            },
            onCancel: {
                pendingPreliminaryTest = nil
                flow.cancelPaperCost()
            },
            // A mesma saída que o Android oferece na abertura do assistente, e que aqui faltava:
            // esta tela existe por causa do custo em papel, e declarar é a alternativa a pagá-lo.
            // Ela não pula o comprovante de conexão — instalar declarado exige a candidata
            // confirmada em memória, e o core recusa sem ela —, então sai essa tira e mais nenhuma.
            onManualConfiguration: {
                flow.acceptPaperCostDeclaringConfiguration()
                runPendingPreliminaryTest()
            }
        )
        .accessibilityIdentifier("printerSetup.paperCost")
    }

    private var knownPrinterGrid: some View {
        VStack(alignment: .leading, spacing: 16) {
            screenHeading(
                title: "Qual é a sua impressora?",
                subtitle: "Toque na que mais parece com a sua.",
                showsBack: true
            )
            let profiles = BundledPrinterProfiles.all
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3),
                spacing: 12
            ) {
                ForEach(profiles) { profile in
                    Button {
                        // O card preserva foto e nome, mas a configuração antiga foi removida.
                        flow.selectProfileForHomologation()
                    } label: {
                        VStack(spacing: 8) {
                            if let imageName = theme.printerImageNames[profile.id] {
                                Image(imageName)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 120)
                            } else {
                                Image(systemName: "printer")
                                    .font(.system(size: 64))
                                    .frame(height: 140)
                            }
                            Text(theme.printerDisplayNames[profile.id] ?? profile.displayName)
                                .font(.subheadline.weight(.bold))
                                .foregroundColor(theme.text)
                                .multilineTextAlignment(.center)
                                .lineLimit(3)
                                .frame(minHeight: 57)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, minHeight: 215)
                        .background(theme.surface)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.gray.opacity(0.25)))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("printerSetup.model.\(profile.id)")
                }
                Button {
                    flow.selectProfileForHomologation()
                } label: {
                    VStack(spacing: 18) {
                        Image(systemName: "plus")
                            .font(.system(size: 58, weight: .light))
                            .foregroundColor(theme.primary)
                        Text("Nova impressora")
                            .font(.subheadline.weight(.bold))
                            .foregroundColor(theme.text)
                    }
                    .frame(maxWidth: .infinity, minHeight: 215)
                    .background(theme.surface)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.gray.opacity(0.25)))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("printerSetup.model.new")
            }
        }
    }

    private func requestPreliminaryTest(
        _ test: PendingPreliminaryTest,
        mode: ThermalPrinterConnectionMode,
        profileID: String?
    ) {
        if profileID == nil {
            pendingPreliminaryTest = test
            flow.requestPaperCost(mode: mode, profileID: profileID)
        } else {
            pendingPreliminaryTest = test
            flow.willStartTest()
            runPendingPreliminaryTest()
        }
    }

    private func runPendingPreliminaryTest(profileOverride: PrinterProfile? = nil) {
        guard let test = pendingPreliminaryTest else { return }
        pendingPreliminaryTest = nil
        switch test {
        case let .bluetooth(candidateID, profileID):
            guard let candidate = printer.bluetooth.candidates.first(where: { $0.id == candidateID }) else {
                flow.preliminaryTestCouldNotStart()
                return
            }
            printer.test(
                candidate,
                profile: profileOverride ?? operationalProfile(profileID: profileID, transport: .bluetooth)
            )
        case let .localWifi(candidateID, profileID):
            guard let candidate = printer.localWifi.candidates.first(where: { $0.id == candidateID }) else {
                flow.preliminaryTestCouldNotStart()
                return
            }
            printer.test(
                candidate,
                profile: profileOverride ?? operationalProfile(profileID: profileID, transport: .localWifi)
            )
        case let .manualAddress(address, portText, profileID):
            printer.testManual(
                ipAddress: address,
                portText: portText,
                profile: profileOverride ?? operationalProfile(profileID: profileID, transport: .localWifi)
            )
        case let .manualDeclared(address, portText, profile):
            printer.testManual(ipAddress: address, portText: portText, declaring: profile)
        }
    }

    private var privacyNotice: some View {
        Text("O IP e os identificadores técnicos existem apenas durante esta configuração. Eles não são persistidos.")
            .font(.footnote)
            .foregroundColor(theme.primary)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var adoptedSection: some View {
        if !printer.coordinator.adoptedPrinters.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Impressoras deste aparelho")
                    .font(.headline)
                    .foregroundColor(theme.text)
                Text("Os recibos saem na impressora marcada. Testar uma linha não troca a ativa.")
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                // Um card por **instalação**: duas portáteis iguais no balcão são duas unidades, e
                // a lista antiga não deixava escolher entre elas — medido no iPhone 7 em 20/08.
                ForEach(printer.coordinator.adoptedPrinters) { entry in
                    installationCard(entry)
                }
            }
            .printerSection(theme: theme)
        }
    }

    private func installationCard(_ entry: AdoptedPrinter) -> some View {
        let slug = ThermalPrinterSetupAccessibility.installationSlug(
            entry,
            among: printer.coordinator.adoptedPrinters
        )
        let atividade = activity(for: entry)
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                // Pela unidade: com duas do mesmo meio físico instaladas, ativar por
                // transporte escolheria a primeira da lista, não a que foi tocada.
                activate(entry)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: entry.active ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundColor(entry.active ? theme.primary : theme.secondaryText)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(theme.text)
                        Text(entry.active ? "\(entry.transportLabel) · recebe os recibos" : entry.transportLabel)
                            .font(.caption)
                            .foregroundColor(theme.secondaryText)
                        if let warning = entry.warning {
                            Text(warning)
                                .font(.caption)
                                .foregroundColor(theme.warning)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier(
                                    ThermalPrinterSetupAccessibility.warning(slug: slug)
                                )
                        }
                        // Enquanto o transporte procura esta impressora, o card diz isso — e diz
                        // também quando ele desistiu. Cinza silencioso é o que faz a pessoa achar
                        // que o app travou.
                        if let alcance = reachMessage(for: entry) {
                            Text(alcance)
                                .font(.caption)
                                .foregroundColor(theme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier(
                                    ThermalPrinterSetupAccessibility.reach(slug: slug)
                                )
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!PrinterUnitAvailability.allowsActivation(atividade))
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.adopted(slug: slug))

            let testando = flow.testing?.installationId == entry.installationId
            HStack(spacing: 8) {
                Button {
                    test(entry)
                } label: {
                    if testando {
                        HStack(spacing: 6) {
                            ProgressView()
                            Text("Enviando…")
                        }
                    } else {
                        Text("Testar")
                    }
                }
                .buttonStyle(.bordered)
                .tint(theme.primary)
                // Nenhum card **deste transporte** aceita toque enquanto um comprovante está a
                // caminho por ele: mirar a unidade parada mexe na conexão em memória, que é uma só
                // por meio físico. A do outro transporte não tem nada com isso.
                .disabled(!PrinterUnitAvailability.allowsTest(atividade))
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.test(slug: slug))

                Spacer(minLength: 0)

                Button {
                    reconfigure(entry)
                } label: {
                    Image(systemName: "gearshape")
                        .font(.body.weight(.semibold))
                        .frame(minWidth: 30, minHeight: 28)
                }
                .buttonStyle(.bordered)
                .tint(theme.primary)
                .disabled(!PrinterUnitAvailability.allowsConfiguration(atividade))
                .accessibilityLabel("Reconfigurar \(entry.displayName)")
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.edit(slug: slug))

                Button(role: .destructive) {
                    printerToRemove = entry
                } label: {
                    Image(systemName: "trash")
                        .font(.body.weight(.semibold))
                        .frame(minWidth: 30, minHeight: 28)
                }
                .buttonStyle(.bordered)
                .tint(theme.danger)
                // Nunca desabilita. Foi a lixeira cinza que deixou a pessoa sem saída quando a
                // ativa estava desligada: sem ela não há como tirar da frente a que trava.
                .disabled(!PrinterUnitAvailability.allowsRemoval(atividade))
                .accessibilityLabel("Excluir \(entry.displayName)")
                .accessibilityIdentifier(ThermalPrinterSetupAccessibility.remove(slug: slug))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    entry.active ? theme.primary : Color.gray.opacity(0.25),
                    lineWidth: entry.active ? 1.5 : 1
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    /**
     Troca a impressora que recebe os recibos.

     A lista muda no mesmo toque — quem publica é o coordenador —, e o que esta espera cobre é só a
     reconexão. Ela roda numa Task porque ativar volta na hora: a prontidão chega pelo estado do
     transporte, e é ele que decide quando o aviso sai da tela.
     */
    private func activate(_ entry: AdoptedPrinter) {
        flow.activationStarted(entry)
        printer.coordinator.activateInstallation(entry.installationId)
        Task { await awaitActivation(of: entry) }
    }

    /**
     O comprovante de teste sai **nesta** unidade.

     Era por transporte, e o controlador guarda uma conexão por transporte: a da que está servindo.
     Com duas portáteis instaladas, tocar em Testar no card da parada imprimia na irmã ativa —
     medido no iPhone 7 em 20/08, e é a impressão silenciosa na impressora errada que a casa não
     admite. Quem sabe alcançar a unidade é o coordenador; a tela só diz qual card foi tocado.

     A ativa não muda por causa de um teste: continua marcada, e continua sendo quem recebe os
     recibos quando ele acaba.
     */
    private func test(_ entry: AdoptedPrinter) {
        flow.testStarted(entry)
        Task {
            let resultado = await printer.coordinator.testInstallation(entry.installationId)
            flow.testFinished(entry, result: resultado)
        }
    }

    private func awaitActivation(of entry: AdoptedPrinter) async {
        // Ativação recusada não tem reconexão para esperar: a unidade saiu da lista entre o toque
        // e o registro, e prender a tela por quinze segundos não a traria de volta.
        guard printer.coordinator.adoptedPrinters.contains(where: {
            $0.installationId == entry.installationId && $0.active
        }) else {
            flow.activationFinished(entry, connected: false)
            return
        }
        await flow.awaitActivation(
            of: entry,
            samples: PrinterConnectionReadiness.attemptSamples(for: entry.transport),
            progress: { connectionProgress(of: entry.transport) },
            wait: { try? await Task.sleep(nanoseconds: 100_000_000) }
        )
    }

    /**
     A engrenagem de uma unidade instalada.

     Ela abre as opções operacionais, nos dois transportes — é o que a engrenagem do Android sempre
     abriu, e página, corte, avanço e largura não dependem de rádio nem de endereço. O que só
     existe em um transporte fica lá dentro, como saída secundária: na rede, trocar o endereço; no
     Bluetooth, refazer as sondas, que é a única forma de **medir** de novo o que aqui se declara.

     A candidata em memória é preparada em segundo plano só para o comprovante de teste. Ela pode
     não vir — impressora desligada, rede trocada —, e isso não impede configurar: impede imprimir,
     e a tela diz qual dos dois.
     */
    private func reconfigure(_ entry: AdoptedPrinter) {
        editing = ManualConfigurationEditing(
            installationId: entry.installationId,
            configuration: printer.manualConfiguration(for: entry.installationId)
                ?? PrinterManualConfiguration.conservative(displayName: entry.displayName)
        )
        flow.configureOptions(.reconfigure(entry))
        prepareManualTestReceipt(for: entry)
    }

    /**
     A candidata em memória do comprovante, e só quando ela é **esta** unidade.

     O controlador guarda uma impressora por transporte, a que está servindo. Com duas portáteis
     instaladas, preparar a candidata ao editar a que está parada devolveria a irmã — e o
     comprovante das opções novas sairia na impressora errada, que é o defeito silencioso de sempre
     com outra roupa.
     */
    private func prepareManualTestReceipt(for entry: AdoptedPrinter) {
        guard entry.active else { return }
        printer.prepareHomologationForAdoptedPrinter(transport: entry.transport)
    }

    private func manualConfigurationContent(_ target: ThermalPrinterManualTarget) -> some View {
        let entry = printer.coordinator.adoptedPrinters.first {
            $0.installationId == target.installationId
        }
        return Group {
            if let entry, let rascunho = editing, rascunho.installationId == entry.installationId {
                PrinterManualConfigurationView(
                    theme: theme,
                    displayName: entry.displayName,
                    configuration: Binding(
                        get: { editing?.configuration ?? rascunho.configuration },
                        set: { editing?.configuration = $0 }
                    ),
                    // Ocupação do transporte **desta** unidade: a engrenagem edita página, corte e
                    // avanço, que não dependem do rádio da outra.
                    busy: setupIsBusy(entry.transport) || rascunho.printing,
                    saving: rascunho.saving,
                    printingUnavailable: printingUnavailableReason(for: entry),
                    sharedInstallations: printer.coordinator.adoptedPrinters.filter {
                        $0.installationId != entry.installationId && $0.profileId == entry.profileId
                    }.count,
                    status: rascunho.status,
                    failure: rascunho.failure,
                    transportAction: transportAction(for: entry),
                    onPrint: { printManualConfiguration(entry) },
                    onSave: { saveManualConfiguration(entry) },
                    onBack: {
                        editing = nil
                        printer.discardEphemeralProbeTarget()
                        flow.goBack()
                    }
                )
            } else {
                missingProfileContent
            }
        }
    }

    /// Por que o comprovante não pode sair agora. `nil` quando pode.
    private func printingUnavailableReason(for entry: AdoptedPrinter) -> String? {
        guard !entry.active else {
            guard !printer.hasEphemeralProbeTarget else { return nil }
            switch entry.transport {
            case .bluetooth:
                return "Ligue \(entry.displayName) e deixe ela perto do celular para imprimir o comprovante."
            case .localWifi:
                return "Ligue \(entry.displayName) na mesma Wi-Fi do celular para imprimir o comprovante."
            }
        }
        // Salvar não depende disso; só o papel depende.
        return "Marque \(entry.displayName) como a impressora em uso para imprimir o comprovante."
    }

    private func transportAction(
        for entry: AdoptedPrinter
    ) -> PrinterManualConfigurationView.TransportAction? {
        switch entry.transport {
        case .localWifi:
            return .init(
                title: "Trocar o endereço",
                detail: "Quando a impressora mudou de IP na rede.",
                symbol: "keyboard"
            ) {
                editing = nil
                printer.discardEphemeralProbeTarget()
                reconfiguring = .reconfigure(entry)
                flow.configureManually(.reconfigure(entry))
            }
        case .bluetooth:
            return .init(
                title: "Testar e configurar de novo",
                detail: "Mede tudo outra vez no papel, em vez de declarar.",
                symbol: "printer.dotmatrix"
            ) {
                editing = nil
                Task { await reconfigureBluetooth(entry) }
            }
        }
    }

    private func printManualConfiguration(_ entry: AdoptedPrinter) {
        guard var rascunho = editing, !rascunho.printing else { return }
        // A impressora pode ter ligado depois que a tela abriu: tentar de novo aqui é mais barato
        // que obrigar a pessoa a sair e voltar para o botão despertar.
        if !printer.hasEphemeralProbeTarget { prepareManualTestReceipt(for: entry) }
        rascunho.printing = true
        rascunho.failure = nil
        rascunho.status = "Enviando o comprovante com estas opções…"
        editing = rascunho
        let enviado = printer.sendManualConfigurationTestReceipt(rascunho.configuration) { resultado in
            Task { @MainActor in
                editing?.printing = false
                editing?.status = resultado == .success
                    ? "Comprovante enviado. Confira o papel antes de salvar."
                    : "O comprovante não foi enviado. Confira se a impressora está ligada."
            }
        }
        if !enviado {
            editing?.printing = false
            editing?.status = nil
            editing?.failure = printingUnavailableReason(for: entry)
        }
    }

    private func saveManualConfiguration(_ entry: AdoptedPrinter) {
        guard var rascunho = editing, !rascunho.saving else { return }
        rascunho.saving = true
        rascunho.failure = nil
        editing = rascunho
        do {
            _ = try printer.saveManualConfiguration(
                rascunho.configuration,
                for: entry.installationId
            )
            editing = nil
            printer.discardEphemeralProbeTarget()
            flow.manualConfigurationSaved(rascunho.configuration.displayName)
        } catch {
            editing?.saving = false
            editing?.failure = (error as? LocalizedError)?.errorDescription
                ?? "Confira os dados informados e tente de novo."
        }
    }

    private func reconfigureBluetooth(_ entry: AdoptedPrinter) async {
        if !entry.active {
            flow.activationStarted(entry)
            printer.coordinator.activateInstallation(entry.installationId)
            await awaitActivation(of: entry)
            // A recusa já explicou que a escolha ficou e a conexão não; repetir aqui só trocaria
            // o aviso honesto por um genérico.
            guard printer.bluetooth.state == .ready else { return }
        }
        flow.reconfigurationRequested(
            entry.displayName,
            hasEphemeralTarget: printer.prepareHomologationForAdoptedPrinter(transport: .bluetooth)
        )
    }

    /// Fecha uma reconfiguração de rede depois do desfecho no papel. A regra de qual unidade sai
    /// mora em ``PrinterReconfiguration``, que é onde dá para prová-la.
    private func finishReconfiguration() {
        guard let alvo = reconfiguring else { return }
        switch PrinterReconfiguration.outcome(
            of: alvo,
            installed: printer.coordinator.adoptedPrinters
        ) {
        case .pending:
            reconfiguring = nil
        case let .replaced(anterior, nome):
            reconfiguring = nil
            printer.coordinator.removeInstallation(anterior)
            flow.reconfigurationFinished(nome)
        case let .keptPrevious(nome):
            reconfiguring = nil
            flow.reconfigurationLeftPreviousInstallation(nome)
        }
    }

    private func connectionProgress(of transport: PrinterTransport) -> PrinterConnectionProgress {
        switch transport {
        case .bluetooth: return PrinterConnectionReadiness.progress(of: printer.bluetooth.state)
        case .localWifi: return PrinterConnectionReadiness.progress(of: printer.localWifi.state)
        }
    }

    /**
     Aviso de conexão em andamento.

     Sem botão de dispensa: a operação é curta e fechar o aviso não a interromperia — só devolveria
     a sensação de tela travada que ele existe para evitar. É `overlay` e não `alert` porque um
     alerta do SwiftUI sem botão nenhum ganha um botão padrão de volta.
     */
    @ViewBuilder
    private var connectingOverlay: some View {
        if let connecting = flow.connecting {
            ZStack {
                Color.black.opacity(0.32).ignoresSafeArea()
                VStack(spacing: 14) {
                    ProgressView()
                    Text("Conectando…")
                        .font(.headline)
                        .foregroundColor(theme.text)
                    Text(
                        "Procurando \(connecting.displayName) por perto. "
                            + "Isso pode levar alguns segundos."
                    )
                    .font(.subheadline)
                    .foregroundColor(theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(24)
                .frame(maxWidth: 320)
                .background(theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(28)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(ThermalPrinterSetupAccessibility.connecting)
        }
    }

    @ViewBuilder
    private var noticeSection: some View {
        if let notice = flow.notice {
            Text(notice)
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("printerSetup.notice")
        }
    }

    private func screenHeading(
        title: String,
        subtitle: String,
        showsBack: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsBack {
                Button {
                    flow.goBack()
                } label: {
                    Label("Voltar", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .foregroundColor(theme.primary)
                // Voltar é saída, não envio: desabilitá-la enquanto o transporte trabalha
                // prende a pessoa numa tela que ela não pediu.
            }
            Text(title)
                .font(theme.usesPrintherLayout ? .largeTitle.weight(.bold) : .title2.weight(.bold))
                .foregroundColor(theme.text)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(theme.usesPrintherLayout ? .title3 : .subheadline)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func searchInstruction(for mode: ThermalPrinterConnectionMode) -> String {
        switch mode {
        case .usb:
            return "Cabo USB não está disponível neste aparelho."
        case .bluetooth:
            return theme.usesPrintherLayout
                ? "Ligue a impressora e deixe ela perto do celular."
                : "Ligue a impressora e deixe ela perto do celular. O iOS procura somente por Bluetooth BLE."
        case .directWifi:
            return "Conecte o celular à Wi-Fi criada pela impressora e procure por ela."
        case .localNetwork:
            return "Ligue a impressora na mesma rede do celular e procure por ela."
        }
    }

    private func startSearch(mode: ThermalPrinterConnectionMode, profileID: String?) {
        pendingPreliminaryTest = nil
        guard mode.operationalTransport != nil else { return }
        showsManualAddress = false
        manualAddress = ""
        manualPort = "9100"
        flow.selectConnection(mode, profileID: profileID)
        restartSearch(mode)
    }

    private func restartSearch(_ mode: ThermalPrinterConnectionMode) {
        selectedCandidateID = nil
        flow.willStartTest()
        printer.discardEphemeralProbeTarget()
        switch mode.operationalTransport {
        case .bluetooth:
            printer.bluetooth.search()
        case .localWifi:
            // A diferença entre AP direto e rede do local ainda é somente de apresentação. O
            // vínculo e a estratégia próprios de cada rede pertencem à Fase 6.
            printer.localWifi.search()
        case nil:
            break
        }
    }

    private func operationalProfile(
        profileID: String?,
        transport: PrinterTransport
    ) -> PrinterProfile {
        guard let profileID else {
            return PrinterProfileResolver(measured: [], bundled: []).resolve(
                profileId: nil,
                transport: transport
            )
        }
        return PrinterProfileResolver(measured: measuredProfiles)
            .resolve(profileId: profileID, transport: transport)
    }

    private var measuredProfiles: [MeasuredProfile] {
        printer.profileStore.profiles()
    }

    private var readyProfiles: [ThermalPrinterReadyProfile] {
        ThermalPrinterSetupFlow.readyProfiles(measured: measuredProfiles)
    }

    private var awaitingInitialReceipt: Bool {
        printer.localWifi.state == .awaitingConfirmation ||
            printer.bluetooth.state == .awaitingConfirmation
    }

    /**
     A instalação em curso tomou a tela.

     Continua valendo para todo mundo, e é o bloqueio legítimo: a pergunta do papel e o assistente
     precisam de uma resposta antes de a pessoa mexer em outra coisa.
     */
    private var setupIsOpen: Bool {
        awaitingInitialReceipt || flow.showsHomologation || flow.connecting != nil
    }

    /**
     Bytes a caminho por **este** transporte.

     Procurar ficou de fora de propósito: varredura não escreve no fio. Enquanto `.searching`
     contava como ocupação, uma retomada atrás de uma impressora desligada desabilitava a tela
     inteira — inclusive as unidades do outro transporte, a lixeira e o "Adicionar impressora".
     Ver ``PrinterUnitAvailability``.
     */
    private func transportIsSending(_ transport: PrinterTransport) -> Bool {
        switch transport {
        case .bluetooth:
            return printer.bluetooth.state == .connecting || printer.bluetooth.state == .testing
                || printer.bluetooth.state == .printing
        case .localWifi:
            return printer.localWifi.state == .testing || printer.localWifi.state == .printing
        }
    }

    /// Ocupação do transporte para as telas de instalação, onde procurar realmente atrapalha: pedir
    /// uma segunda varredura no mesmo rádio não acha nada e ainda derruba a primeira.
    private func transportIsBusy(_ transport: PrinterTransport?) -> Bool {
        switch transport {
        case .bluetooth: return printer.bluetooth.state.isBusy
        case .localWifi: return printer.localWifi.state.isBusy
        case nil: return false
        }
    }

    /// O que a tela de instalação daquele transporte aceita. Por transporte, e não pela tela toda.
    private func setupIsBusy(_ transport: PrinterTransport?) -> Bool {
        setupIsOpen || transportIsBusy(transport)
    }

    /// O comprovante do card está a caminho por este transporte, de qualquer unidade dele.
    private func receiptIsUnderway(on transport: PrinterTransport) -> Bool {
        guard let testing = flow.testing else { return false }
        return printer.coordinator.adoptedPrinters.first {
            $0.installationId == testing.installationId
        }?.transport == transport
    }

    private func activity(for entry: AdoptedPrinter) -> PrinterUnitActivity {
        PrinterUnitActivity(
            isActive: entry.active,
            transportIsSending: transportIsSending(entry.transport),
            receiptIsUnderwayOnTransport: receiptIsUnderway(on: entry.transport),
            setupIsOpen: setupIsOpen
        )
    }

    /// O card diz o que está acontecendo com **esta** unidade. Antes era cinza silencioso, que a
    /// pessoa lê como app travado.
    private func reachMessage(for entry: AdoptedPrinter) -> String? {
        PrinterUnitReachCopy.message(
            PrinterUnitReachCopy.reach(
                of: connectionProgress(of: entry.transport),
                isTheUnitBeingReached: reconnectingInstallationId(of: entry.transport)
                    == entry.installationId
            ),
            displayName: entry.displayName,
            transport: entry.transport
        )
    }

    private func reconnectingInstallationId(of transport: PrinterTransport) -> String? {
        switch transport {
        case .bluetooth: return printer.bluetooth.reconnectingInstallationId
        case .localWifi: return printer.localWifi.reconnectingInstallationId
        }
    }
}

private enum PendingPreliminaryTest {
    case bluetooth(candidateID: Int, profileID: String?)
    case localWifi(candidateID: Int, profileID: String?)
    case manualAddress(address: String, portText: String, profileID: String?)
    /// Endereço digitado com as opções que a pessoa declarou. O perfil vai junto e ainda não está
    /// no disco: quem o grava é a resposta sobre o papel.
    case manualDeclared(address: String, portText: String, profile: MeasuredProfile)
}

@available(iOS 15.0, macOS 12.0, *)
extension View {
    func printerSection(theme: ThermalPrinterTheme) -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.primarySurface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    func printerAddressKeyboard() -> some View {
#if os(iOS)
        textInputAutocapitalization(.never)
            .keyboardType(.numbersAndPunctuation)
#else
        self
#endif
    }

    @ViewBuilder
    func printerPortKeyboard() -> some View {
#if os(iOS)
        keyboardType(.numberPad)
#else
        self
#endif
    }
}

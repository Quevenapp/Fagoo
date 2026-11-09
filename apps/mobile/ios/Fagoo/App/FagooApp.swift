import SwiftUI

@main
struct FagooApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var container = AppContainer.shared
    var body: some Scene { WindowGroup { RootView().environmentObject(container).task { await container.boot() } } }
}

struct RootView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var phase
    @State private var address = ""
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    var body: some View {
        Group {
            if let panel = container.panel, !container.authorizingExit, let url = URL(string: panel.api_url) {
                FagooPanelView(apiBaseURL: url, deviceToken: panel.token, onExitRequested: container.requestPanelExit)
            } else if container.isLoggedIn { MobileWorkspace().id(container.epoch) }
            else {
                AppNavigationStack {
                    Form {
                        Section { Text(container.authorizingExit ? "Autorizar saída do painel" : "Entre no Fagoo da sua empresa").font(.title2.bold()) }
                        if container.session.configuration == nil {
                            Section("Endereço da empresa") {
                                TextField("https://empresa.exemplo.com.br",text:$address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                Button("Conectar") { Task { await container.configure(address) } }.disabled(container.busy || address.isEmpty)
                            }
                        } else if container.requiresMFA {
                            Section("Verificação em duas etapas") {
                                TextField("Código do autenticador",text:$code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                                Button("Verificar") { let value = code; code = ""; Task { await container.verifyMFA(value) } }.disabled(container.busy || code.count != 6)
                            }
                        } else {
                            Section(container.session.webURL?.host ?? "Fagoo") {
                                TextField("E-mail",text:$email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                                SecureField("Senha",text:$password).textContentType(.password)
                                Button("Entrar") { let secret = password; password = ""; Task { await container.login(email: email,password: secret) } }.disabled(container.busy || email.isEmpty || password.isEmpty)
                            }
                            if !container.authorizingExit { Section("Outra empresa") { TextField("Endereço HTTPS",text:$address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled(); Button("Conectar a este endereço") { Task { await container.configure(address) } }.disabled(container.busy || address.isEmpty) } }
                        }
                        if container.busy { ProgressView("Conectando ao Fagoo…") }
                        if let error = container.error { Text(error).foregroundColor(.red) }
                        if container.authorizingExit { Button("Voltar ao painel", action: container.cancelPanelExit).disabled(container.busy) }
                        Section { Label("O Fagoo precisa de internet para funcionar.",systemImage:"network").font(.footnote) }
                    }.navigationTitle("Fagoo")
                }
            }
        }
        .overlay { if phase != .active && container.panel == nil { Color(uiColor: .systemBackground).ignoresSafeArea().overlay(Text("Fagoo").font(.title.bold())) } }
        .task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled { await container.refreshTokenIfNeeded(); do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { break } }
        }
    }
}

struct MobileWorkspace: View {
    @EnvironmentObject private var container: AppContainer
    var body: some View {
        TabView {
            if container.currentUnit?.capabilities.contains("communication.read") == true {
                AppNavigationStack { ConversationsView() }.tabItem { Label("WhatsApp",systemImage:"message") }
            }
            if container.currentUnit?.capabilities.contains("team.chat") == true {
                AppNavigationStack { TeamView() }.tabItem { Label("Chat interno",systemImage:"person.2") }
            }
            AppNavigationStack {
                Form {
                    Section("Unidade") {
                        ForEach(container.context?.units ?? []) { unit in Button { Task { await container.selectUnit(unit.id) } } label: { HStack { Text(unit.name); Spacer(); if unit.id == container.profileId { Image(systemName:"checkmark") } } } }
                    }
                    Section("Comunicação") { Button("Ativar notificações") { Task { _ = await PushManager.shared.requestPermission() } } }
                    if container.context?.role == "admin" {
                        Section("Modo painel") { NavigationLink("Vincular este aparelho a um painel") { PanelEnrollmentView() } }
                    }
                    if let error = container.error { Text(error).foregroundColor(.red) }
                    Button("Sair ou trocar usuário",role:.destructive) { Task { await container.logout() } }
                }.navigationTitle("Minha conta")
            }.tabItem { Label("Conta e painel",systemImage:"person.crop.circle") }
        }
    }
}

struct PanelEnrollmentView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var devices: [FagooSetup.Device] = []
    @State private var error: String?
    @State private var printer = false
    var body: some View {
        List {
            Section { Text("Escolha o aparelho cadastrado no Fagoo web. A vinculação encerra a comunicação pessoal neste aparelho.") }
            ForEach(devices.filter { $0.active && $0.capabilities.contains("panel.read") }) { device in
                Button { Task { await container.enroll(device) } } label: { VStack(alignment:.leading) { Text(device.name); Text(container.context?.units.first { $0.id == device.unit_id }?.name ?? "Unidade").font(.caption).foregroundStyle(.secondary) } }.disabled(container.busy)
            }
            if devices.isEmpty { Text("Cadastre o aparelho em Configurar Fagoo, pelo navegador, e atualize esta lista.") }
            Button("Configurar impressora deste aparelho") { Task {
                do { let _: FagooSetup = try await container.api.request(.get,"v1/fagoo/setup"); printer = true } catch { self.error = APIError.describe(error) }
            } }
            if let message = error ?? container.error { Text(message).foregroundColor(.red) }
        }.navigationTitle("Vincular painel").task { await load() }.refreshable { await load() }
            .sheet(isPresented:$printer) { AppNavigationStack { FagooPanelPrinterSettingsView().navigationTitle("Impressora").toolbar { ToolbarItem(placement:.confirmationAction) { Button("Concluir") { printer = false } } } } }
    }
    private func load() async { do { let result: FagooSetup = try await container.api.request(.get,"v1/fagoo/setup"); devices = result.devices; error = nil } catch { self.error = APIError.describe(error) } }
}

struct EmptyStateView: View {
    let title: String; let systemImage: String; var message: String? = nil
    var body: some View { VStack(spacing:12) { Image(systemName:systemImage).font(.largeTitle); Text(title).font(.headline); if let message { Text(message).font(.footnote).multilineTextAlignment(.center) } }.padding().frame(maxWidth:.infinity) }
}

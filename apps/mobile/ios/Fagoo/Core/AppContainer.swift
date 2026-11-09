import Foundation
import Combine

struct FagooUnit: Decodable, Identifiable { let id: String; let name: String; let capabilities: [String]; let team_ids: [String] }
struct FagooContext: Decodable { let user_id: String; let role: String; let units: [FagooUnit] }
struct FagooSetup: Decodable {
    struct Device: Decodable, Identifiable { let id: String; let unit_id: String; let name: String; let capabilities: [String]; let active: Bool }
    let devices: [Device]
}

@MainActor
final class AppContainer: ObservableObject {
    static let shared = AppContainer()
    let session = SessionStore()
    @Published private(set) var isLoggedIn = false
    @Published private(set) var user: User?
    @Published private(set) var context: FagooContext?
    @Published var profileId: String? { didSet { session.profileId = profileId } }
    @Published private(set) var panel: PanelEnrollment?
    @Published private(set) var busy = false
    @Published var error: String?
    @Published var requiresMFA = false
    @Published var authorizingExit = false
    @Published private(set) var epoch = UUID()
    @Published var pendingConversation: String?
    @Published var pendingInternalChat: String?
    private let authClient = FagooAuthClient()
    private var client: APIClient?
    private var factor: String?
    private var pendingAuth: FagooAuthSession?
    private var pendingRefresh: FagooAuthSession?
    private var restoring = false
    private var operation = UUID()
    var currentUnit: FagooUnit? { context?.units.first { $0.id == profileId } }
    var api: APIClient {
        if let client { return client }
        let value = APIClient(baseURL: session.serverURL ?? URL(string: "https://not-configured.invalid")!) { [weak self] in
            guard let self, self.isLoggedIn, self.panel == nil else { return nil }; return self.session.token
        }
        client = value; return value
    }
    private func begin() -> UUID { operation=UUID(); busy=true; return operation }
    @discardableResult private func finish(_ id: UUID) -> Bool { guard operation==id else { return false }; busy=false; return true }
    private func check(_ id: UUID, _ config: MobileConfiguration? = nil) throws {
        try Task.checkCancellation()
        guard operation==id, config==nil || session.configuration==config else { throw CancellationError() }
    }
    private func report(_ failure: Error, _ id: UUID) { if operation==id, !(failure is CancellationError) { error=APIError.describe(failure) } }
    func boot() async {
        guard !restoring, !isLoggedIn, !busy else { return }
        restoring=true; let id=begin(); defer { restoring=false; finish(id) }
        await MediaLoader.shared.clear()
        do {
            try check(id)
            if let saved=try session.panel() {
                try session.clearSession(); panel=saved; return
            }
            guard let config=session.configuration, let saved=try session.savedAuth() else { return }
            try config.validate()
            let refreshed=try await authClient.refresh(config,token:saved.refresh_token); try check(id,config)
            try await establish(refreshed, config:config, operation:id, expectedUser:saved.userID)
            if finish(id) { await PushManager.shared.register() }
        } catch { report(error,id) }
    }
    func configure(_ address: String) async {
        guard panel==nil, !isLoggedIn, !busy, let origin=SessionStore.normalizeServer(address) else { error="Informe o endereço HTTPS do Fagoo da empresa."; return }
        let id=begin(); defer { finish(id) }
        do {
            let config=try await authClient.discover(origin); try check(id)
            try await clearPrivate(operation:id); try check(id)
            session.configuration=config; session.webURL=origin; error=nil
        } catch { report(error,id) }
    }
    func login(email: String,password: String) async {
        guard let config=session.configuration, !busy, panel==nil || authorizingExit else { return }
        let id=begin(); defer { finish(id) }
        do {
            let result=try await authClient.password(config,email:email.trimmingCharacters(in:.whitespacesAndNewlines),password:password); try check(id,config)
            let factors=try await authClient.factors(config,token:result.access_token); try check(id,config)
            if let selected=factors.first { pendingAuth=result;factor=selected;requiresMFA=true;error=nil }
            else { try await establish(result,config:config,operation:id); if finish(id) { await PushManager.shared.register() } }
        } catch { report(error,id) }
    }
    func verifyMFA(_ code: String) async {
        guard let config=session.configuration, let pendingAuth, let factor, !busy, panel==nil || authorizingExit else { return }
        let id=begin(); defer { finish(id) }
        do {
            let result=try await authClient.verify(config,token:pendingAuth.access_token,factor:factor,code:code); try check(id,config)
            try await establish(result,config:config,operation:id)
            if finish(id) { await PushManager.shared.register() }
        } catch { report(error,id) }
    }
    /// A candidate token stays in memory until the canonical API confirms its identity and MFA/access policy.
    private func establish(_ auth: FagooAuthSession,config: MobileConfiguration,operation id: UUID,expectedUser: String? = nil) async throws {
        try check(id,config)
        let candidate=APIClient(baseURL:URL(string:config.api_url)!) { auth.access_token }
        defer { candidate.invalidate() }
        let validated: FagooContext=try await candidate.request(.get,"v1/fagoo/context"); try check(id,config)
        guard auth.userID==validated.user_id, expectedUser==nil || expectedUser==validated.user_id else { throw URLError(.userAuthenticationRequired) }
        if let protected=panel {
            guard authorizingExit else { throw CancellationError() }
            let result: JSONValue=try await candidate.request(.post,"v1/fagoo/device/exit",body:["device_id":protected.id]); try check(id,config)
            guard result["allowed"]?.boolValue==true else { throw URLError(.userAuthenticationRequired) }
            try session.removePanel(); panel=nil; authorizingExit=false
        }
        try check(id,config); try session.saveAuth(auth)
        client?.invalidate();client=nil
        context=validated
        let mobileUser=User(id:validated.user_id,name:"Usuário Fagoo",email:"",role:"operator",profiles:validated.units.map(\.id))
        user=mobileUser;session.user=mobileUser
        profileId=validated.units.first(where:{$0.capabilities.contains("communication.read") || $0.capabilities.contains("team.chat")})?.id
        pendingAuth=nil;pendingRefresh=nil;factor=nil;requiresMFA=false;error=nil;epoch=UUID();isLoggedIn=true
    }
    func refreshTokenIfNeeded() async {
        guard isLoggedIn, panel==nil, let config=session.configuration, let auth=session.auth, auth.expiresAt.timeIntervalSinceNow<90, !busy else { return }
        let id=begin(), expected=user?.id; defer { finish(id) }
        do {
            let refreshed: FagooAuthSession
            if let saved=pendingRefresh { refreshed=saved } else { refreshed=try await authClient.refresh(config,token:auth.refresh_token) }
            try check(id,config)
            guard refreshed.userID==expected else { throw URLError(.userAuthenticationRequired) }
            // Rotation is recoverable in memory if PostgreSQL is temporarily unavailable; never persist an unchecked identity.
            pendingRefresh=refreshed
            let candidate=APIClient(baseURL:URL(string:config.api_url)!) { refreshed.access_token }
            defer { candidate.invalidate() }
            let current: FagooContext=try await candidate.request(.get,"v1/fagoo/context");try check(id,config)
            guard isLoggedIn, panel==nil, current.user_id==expected else { throw CancellationError() }
            try session.saveAuth(refreshed);pendingRefresh=nil
            context=current
            if let selected=profileId, !current.units.contains(where:{$0.id==selected}) {
                let snapshot=PushManager.shared.registrationSnapshot();client?.invalidate();client=nil;profileId=current.units.first?.id;epoch=UUID();PushManager.shared.clearAllNotifications()
                await MediaLoader.shared.clear();try check(id,config);await PushManager.shared.unregister(snapshot);try check(id,config)
            }
        } catch {
            report(error,id)
            if operation==id, let status=(error as? APIError)?.status, [400,401,403].contains(status) { try? await clearPrivate(operation:id) }
        }
    }
    func selectUnit(_ unit: String?) async {
        guard isLoggedIn, panel==nil, !busy, unit==nil || context?.units.contains(where:{$0.id==unit})==true else { return }
        let id=begin(),snapshot=PushManager.shared.registrationSnapshot();defer { finish(id) }
        client?.invalidate();client=nil;profileId=unit;epoch=UUID();session.registeredUnits=[];PushManager.shared.clearAllNotifications()
        await MediaLoader.shared.clear()
        await PushManager.shared.unregister(snapshot)
        do { try check(id); if finish(id) { await PushManager.shared.register() } } catch { report(error,id) }
    }
    func enroll(_ device: FagooSetup.Device) async {
        guard context?.role=="admin",device.active,device.capabilities.contains("panel.read"),!busy,panel==nil else { return }
        let id=begin();defer { finish(id) }
        do {
            let result: JSONValue=try await api.request(.post,"v1/fagoo/commands",body:["command_id":JSONValue.string(UUID().uuidString.lowercased()),"action":.string("device.issue"),"payload":.object(["id":.string(device.id)])]);try check(id)
            guard let token=result["token"]?.stringValue,let origin=session.serverURL else { throw APIError(status:409,code:"rotation_required",message:"A vinculação não foi confirmada. Selecione o aparelho novamente para emitir uma nova autorização.") }
            let enrolled=PanelEnrollment(id:device.id,unit_id:device.unit_id,token:token,api_url:origin.absoluteString)
            try await clearPrivate(operation:id);try check(id)
            try session.savePanel(enrolled);panel=enrolled;epoch=UUID()
        } catch { report(error,id) }
    }
    func requestPanelExit() { guard panel != nil,!busy else { return };operation=UUID();authorizingExit=true;requiresMFA=false;pendingAuth=nil;error=nil }
    func cancelPanelExit() {
        operation=UUID();busy=false;authorizingExit=false;requiresMFA=false;pendingAuth=nil;factor=nil;session.auth=nil;client?.invalidate();client=nil;error=nil
    }
    func logout() async {
        let id=begin();defer { finish(id) }
        do { try await clearPrivate(operation:id) } catch { report(error,id) }
    }
    func handleUnauthorized() {
        let id=begin()
        // Hide and invalidate immediately, before the asynchronously scheduled cleanup gets its first turn.
        isLoggedIn=false;client?.invalidate();client=nil;epoch=UUID()
        Task { do { try await clearPrivate(operation:id) } catch { report(error,id) };finish(id) }
    }
    private func clearPrivate(operation id: UUID) async throws {
        try check(id)
        let snapshot=PushManager.shared.registrationSnapshot()
        isLoggedIn=false;epoch=UUID();client?.invalidate();client=nil
        user=nil;context=nil;profileId=nil;pendingAuth=nil;pendingRefresh=nil;factor=nil;requiresMFA=false;pendingConversation=nil;pendingInternalChat=nil
        PushManager.shared.clearAllNotifications()
        var storageFailure: Error?
        do { try session.clearSession() } catch { storageFailure=error }
        await MediaLoader.shared.clear();try check(id)
        await PushManager.shared.unregister(snapshot);try check(id)
        await PushManager.shared.deactivateToken();try check(id)
        if let storageFailure { throw storageFailure }
    }
}

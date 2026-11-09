import Foundation
import UIKit
import UserNotifications
import FirebaseCore
import FirebaseMessaging

struct PrivatePushIdentity: Equatable {
    let epoch: UUID; let loggedIn: Bool; let panel: Bool
    let user: String?; let unit: String?; let server: String?
    var canRegister: Bool { loggedIn && !panel && user != nil && unit != nil && server != nil }
    func accepts(_ data: [AnyHashable: Any]) -> Bool {
        canRegister &&
        data["user_id"] as? String == user && data["unit_id"] as? String == unit && data["server"] as? String == server
    }
}
/// APNs must acknowledge this human session before Firebase registration can start.
struct PushRegistrationGate {
    enum Action { case none, requestAPNS, fetchFCM }
    private var pending: PrivatePushIdentity?
    private var ready: PrivatePushIdentity?
    static func authorized(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }
    mutating func next(_ identity: PrivatePushIdentity, authorization: UNAuthorizationStatus, hasAPNSToken: Bool) -> Action {
        guard identity.canRegister, Self.authorized(authorization) else { reset(); return .none }
        if ready == identity, hasAPNSToken { return .fetchFCM }
        if pending == identity { return .none }
        ready = nil; pending = identity; return .requestAPNS
    }
    mutating func acceptAPNS(_ identity: PrivatePushIdentity) -> Bool {
        guard identity.canRegister, pending == identity || ready == identity else { reset(); return false }
        pending = nil; ready = identity; return true
    }
    mutating func reset() { pending = nil; ready = nil }
}
struct PushRegistrationSnapshot {
    let origin: URL; let token: String; let device: String; let units: Set<String>
}

@MainActor
final class PushManager: NSObject, MessagingDelegate {
    static let shared = PushManager()
    private(set) var configured = false
    private var registrationGate = PushRegistrationGate()
    private var registrationInFlight: PrivatePushIdentity?
    var visibleConversationId: String?
    func configure() {
        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let options = FirebaseOptions(contentsOfFile: path), options.bundleID == Bundle.main.bundleIdentifier else { return }
        if FirebaseApp.app() == nil { FirebaseApp.configure(options: options) }
        Messaging.messaging().delegate = self; configured = true
    }
    func requestPermission() async -> Bool {
        let app=AppContainer.shared, before=identity()
        guard configured, app.isLoggedIn, app.panel == nil, !app.busy else { return false }
        let accepted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert,.sound,.badge])) ?? false
        guard before == identity() else { return false }
        if accepted { await register() }
        return accepted
    }
    func didRegister(_ token: Data) {
        guard configured, registrationGate.acceptAPNS(identity()) else { return }
        Messaging.messaging().apnsToken = token
        Task { await register() }
    }
    func didFailRegistration() { registrationGate.reset() }
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) { Task { @MainActor in
        let app=AppContainer.shared
        guard fcmToken != nil, app.isLoggedIn, app.panel == nil, !app.busy else { return }
        // Fetch afresh after the APNs/identity gate; never save a delayed delegate token.
        await self.register()
    } }
    func register() async {
        let app = AppContainer.shared
        guard configured, app.isLoggedIn, app.panel == nil, !app.busy, let unit = app.profileId else { return }
        let before = identity()
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard before == identity(), !app.busy, registrationInFlight != before else { return }
        switch registrationGate.next(before, authorization: settings.authorizationStatus, hasAPNSToken: Messaging.messaging().apnsToken != nil) {
        case .none: return
        case .requestAPNS: UIApplication.shared.registerForRemoteNotifications(); return
        case .fetchFCM: break
        }
        registrationInFlight = before
        defer { if registrationInFlight == before { registrationInFlight = nil } }
        let token: String? = await withCheckedContinuation { callback in Messaging.messaging().token { token, _ in callback.resume(returning: token) } }
        guard before == identity(), !app.busy, let token, let snapshot=registrationSnapshot() else { return }
        do {
            let body: [String: JSONValue] = ["token":.string(token),"name":.string("Fagoo iOS"),"platform":.string("ios"),"app_version":.string("1.0.0"),"profiles":.array([.string(unit)]),"enabled":.bool(true)]
            let _: JSONValue = try await app.api.request(.put,"v1/communication/units/\(unit)/devices/\(app.session.deviceId)",body:body)
            guard before == identity() else { await unregister(snapshot); return }; app.session.pushToken = token; app.session.registeredUnits.insert(unit)
        } catch { if before != identity() { await unregister(snapshot) } }
    }
    func registrationSnapshot() -> PushRegistrationSnapshot? {
        let app=AppContainer.shared
        guard let origin=app.session.serverURL, let token=app.session.token else { return nil }
        return PushRegistrationSnapshot(origin:origin,token:token,device:app.session.deviceId,units:app.session.registeredUnits.union(app.profileId.map { [$0] } ?? []))
    }
    func unregister(_ snapshot: PushRegistrationSnapshot?) async {
        guard let snapshot else { return }
        let client=APIClient(baseURL:snapshot.origin) { snapshot.token }
        defer { client.invalidate() }
        for unit in snapshot.units { let _: OK? = try? await client.request(.delete,"v1/communication/units/\(unit)/devices/\(snapshot.device)") }
    }
    func unregister() async {
        let app = AppContainer.shared, epoch=app.epoch, snapshot=registrationSnapshot()
        await unregister(snapshot)
        if app.epoch == epoch { app.session.registeredUnits = [] }
    }
    func deactivateToken() async {
        UIApplication.shared.unregisterForRemoteNotifications()
        if configured { await withCheckedContinuation { (callback: CheckedContinuation<Void,Never>) in Messaging.messaging().deleteToken { _ in callback.resume() } } }
        clearAllNotifications()
    }
    func clearAllNotifications() {
        registrationGate.reset(); registrationInFlight = nil
        let center = UNUserNotificationCenter.current(); center.removeAllDeliveredNotifications(); center.removeAllPendingNotificationRequests()
        UIApplication.shared.applicationIconBadgeNumber = 0; visibleConversationId = nil
    }
    private func identity() -> PrivatePushIdentity {
        let app=AppContainer.shared
        return PrivatePushIdentity(epoch:app.epoch,loggedIn:app.isLoggedIn,panel:app.panel != nil,user:app.user?.id,unit:app.profileId,server:app.session.serverURL?.absoluteString)
    }
    /// Managed pushes are data-only. Even a delayed old push cannot display private content in panel mode.
    func receive(_ data: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        let app = AppContainer.shared
        guard app.panel == nil else { return .noData }
        if !app.isLoggedIn { await app.boot() }
        await app.refreshTokenIfNeeded()
        let before=identity()
        guard before.accepts(data), let unit = app.profileId else { return .noData }
        let epoch = app.epoch
        do {
            var target: String?
            if data["type"] as? String == "queue", let id=data["conversation_id"] as? String {
                let queue: JSONValue = try await app.api.request(.get,"v1/communication/units/\(unit)/queue")
                guard queue["data"]?.arrayValue?.contains(where: { $0["id"]?.stringValue == id }) == true else { return .noData }; target=id
            } else if let id = data["conversation_id"] as? String {
                let _: ConversationDetail = try await app.api.conversation(unit,id:id)
                if visibleConversationId == id { return .noData }; target = id
            } else if let id = data["chat_id"] as? String ?? data["internal_chat_id"] as? String {
                let _: InternalChat = try await app.api.internalChat(unit,id:id); target = id
            } else { return .noData }
            guard before == identity(), before.accepts(data), let target else { return .noData }
            let content = UNMutableNotificationContent(); content.title = "Fagoo"; content.body = "Você recebeu uma nova mensagem ou atribuição."; content.sound = .default
            content.userInfo = ["fagoo_session":epoch.uuidString,"target":target,"unit_id":unit]
            let notificationID=UUID().uuidString
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notificationID,content:content,trigger:nil))
            guard before == identity() else {
                let center=UNUserNotificationCenter.current();center.removeDeliveredNotifications(withIdentifiers:[notificationID]);center.removePendingNotificationRequests(withIdentifiers:[notificationID]);return .noData
            }
            return .newData
        } catch { return .noData }
    }
}

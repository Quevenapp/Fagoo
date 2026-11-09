import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey:Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task { @MainActor in PushManager.shared.configure() }; return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Task { @MainActor in PushManager.shared.didRegister(deviceToken) } }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Task { @MainActor in PushManager.shared.didFailRegistration() } }
    func application(_ application: UIApplication, didReceiveRemoteNotification data: [AnyHashable:Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult)->Void) {
        Task { @MainActor in completionHandler(await PushManager.shared.receive(data)) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions)->Void) {
        Task { @MainActor in
            let app = AppContainer.shared
            let valid = app.isLoggedIn && app.panel == nil && notification.request.content.userInfo["fagoo_session"] as? String == app.epoch.uuidString
            completionHandler(valid ? [.banner,.sound] : [])
        }
    }
}

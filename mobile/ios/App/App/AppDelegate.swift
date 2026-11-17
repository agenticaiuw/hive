import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem, item.type == "eye-typing" {
            // Opened from the icon's "Eye typing": show it once the dashboard is up.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { EyeTypingViewController.present() }
            return false
        }
        return true
    }

    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        completionHandler(shortcutItem.type == "eye-typing" && EyeTypingViewController.present())
    }

}

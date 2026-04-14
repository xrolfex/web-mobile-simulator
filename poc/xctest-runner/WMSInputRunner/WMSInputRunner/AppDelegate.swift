import UIKit

/// Minimal stub application — exists only to satisfy the UI test host requirement.
/// WMSInputRunner is controlled entirely via the XCTest command loop in WMSInputRunnerUITests.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = UIViewController()
        window?.backgroundColor = .black
        window?.makeKeyAndVisible()
        return true
    }
}

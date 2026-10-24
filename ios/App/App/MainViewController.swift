import UIKit
import Capacitor

/// Bridge-View-Controller der App: registriert app-eigene Plugins (Capacitor 8, ohne npm-Paket).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppExpiryPlugin())
    }
}

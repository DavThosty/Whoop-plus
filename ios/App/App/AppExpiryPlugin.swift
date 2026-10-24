import Foundation
import Capacitor

/// App-eigenes Capacitor-Plugin: liest das Ablaufdatum der Signatur aus `embedded.mobileprovision`.
/// Die Datei legt erst SideStore beim Signieren in das App-Bundle (kostenlose Apple-ID: 7 Tage gültig).
/// Ohne Datei (Simulator, unsignierter CI-Build) liefert `getExpiry` ein leeres Objekt (JS-Seite: null).
@objc(AppExpiryPlugin)
public class AppExpiryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppExpiryPlugin"
    public let jsName = "AppExpiry"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getExpiry", returnType: CAPPluginReturnPromise)
    ]

    @objc func getExpiry(_ call: CAPPluginCall) {
        guard let date = AppExpiryPlugin.readExpirationDate() else {
            call.resolve([:]) // JS: expiresAt fehlt → null
            return
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        call.resolve(["expiresAt": formatter.string(from: date)])
    }

    /// `embedded.mobileprovision` ist eine CMS-signierte Datei; das XML-Plist steht darin im Klartext
    /// zwischen "<?xml" und "</plist>".
    static func readExpirationDate() -> Date? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), options: [], in: start.lowerBound..<data.endIndex)
        else { return nil }
        let plistData = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any]
        else { return nil }
        return plist["ExpirationDate"] as? Date
    }
}

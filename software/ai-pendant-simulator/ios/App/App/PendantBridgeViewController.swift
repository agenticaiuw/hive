import Capacitor

@objc(PendantBridgeViewController)
final class PendantBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PendantSecureStoragePlugin())
    }
}

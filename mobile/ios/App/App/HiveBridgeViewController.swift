import Capacitor
import WebKit

/// Capacitor's own `WKUIDelegate` grants every media-capture request from every
/// origin. The web UI is loaded remotely now, so narrow that to the dashboard
/// origin over https and deny anything else (a third-party iframe, an injected
/// frame, a downgraded http load). Every other `WKUIDelegate` responsibility is
/// forwarded to Capacitor untouched.
final class HiveMediaCaptureUIDelegate: NSObject, WKUIDelegate {
    private let wrapped: WKUIDelegate
    /// The only origin this app is allowed to hand the microphone to: the host of
    /// `server.url` in capacitor.config.json, which the build points at the owner's
    /// own Hive cloud. Empty (so nothing is granted) when the config has no host.
    private let dashboardHost: String

    init(wrapping wrapped: WKUIDelegate, dashboardHost: String) {
        self.wrapped = wrapped
        self.dashboardHost = dashboardHost.lowercased()
        super.init()
    }

    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let isDashboardOrigin = origin.`protocol`.lowercased() == "https"
            && !dashboardHost.isEmpty
            && origin.host.lowercased() == dashboardHost
        decisionHandler(isDashboardOrigin ? .grant : .deny)
    }

    // MARK: - Pass-through

    func webView(_ webView: WKWebView,
                 requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let forwarded: Void? = wrapped.webView?(webView,
                                                requestDeviceOrientationAndMotionPermissionFor: origin,
                                                initiatedByFrame: frame,
                                                decisionHandler: decisionHandler)
        if forwarded == nil {
            decisionHandler(.deny)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let forwarded: Void? = wrapped.webView?(webView,
                                                runJavaScriptAlertPanelWithMessage: message,
                                                initiatedByFrame: frame,
                                                completionHandler: completionHandler)
        if forwarded == nil {
            completionHandler()
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let forwarded: Void? = wrapped.webView?(webView,
                                                runJavaScriptConfirmPanelWithMessage: message,
                                                initiatedByFrame: frame,
                                                completionHandler: completionHandler)
        if forwarded == nil {
            completionHandler(false)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let forwarded: Void? = wrapped.webView?(webView,
                                                runJavaScriptTextInputPanelWithPrompt: prompt,
                                                defaultText: defaultText,
                                                initiatedByFrame: frame,
                                                completionHandler: completionHandler)
        if forwarded == nil {
            completionHandler(nil)
        }
    }

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        return wrapped.webView?(webView,
                                createWebViewWith: configuration,
                                for: navigationAction,
                                windowFeatures: windowFeatures) ?? nil
    }
}

@objc(HiveBridgeViewController)
final class HiveBridgeViewController: CAPBridgeViewController {
    /// `WKWebView.uiDelegate` is weak, so the wrapper has to be retained here.
    private var mediaCaptureDelegate: HiveMediaCaptureUIDelegate?

    override func capacitorDidLoad() {
        if let webView = webView, let capacitorDelegate = webView.uiDelegate {
            let delegate = HiveMediaCaptureUIDelegate(wrapping: capacitorDelegate,
                                                         dashboardHost: bridge?.config.serverURL.host ?? "")
            mediaCaptureDelegate = delegate
            webView.uiDelegate = delegate
        }
    }
}

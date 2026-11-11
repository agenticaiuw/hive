import Capacitor
import WebKit

/// The only origin this app is allowed to hand the microphone to. It matches the
/// `server.url` / `server.allowNavigation` entries in capacitor.config.json.
private let pendantDashboardHost = "ai-pendant-dashboard.evan20050827.workers.dev"

/// Capacitor's own `WKUIDelegate` grants every media-capture request from every
/// origin. The web UI is loaded remotely now, so narrow that to the dashboard
/// origin over https and deny anything else (a third-party iframe, an injected
/// frame, a downgraded http load). Every other `WKUIDelegate` responsibility is
/// forwarded to Capacitor untouched.
final class PendantMediaCaptureUIDelegate: NSObject, WKUIDelegate {
    private let wrapped: WKUIDelegate

    init(wrapping wrapped: WKUIDelegate) {
        self.wrapped = wrapped
        super.init()
    }

    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let isDashboardOrigin = origin.`protocol`.lowercased() == "https"
            && origin.host.lowercased() == pendantDashboardHost
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

@objc(PendantBridgeViewController)
final class PendantBridgeViewController: CAPBridgeViewController {
    /// `WKWebView.uiDelegate` is weak, so the wrapper has to be retained here.
    private var mediaCaptureDelegate: PendantMediaCaptureUIDelegate?

    override func capacitorDidLoad() {
        if let webView = webView, let capacitorDelegate = webView.uiDelegate {
            let delegate = PendantMediaCaptureUIDelegate(wrapping: capacitorDelegate)
            mediaCaptureDelegate = delegate
            webView.uiDelegate = delegate
        }
    }
}

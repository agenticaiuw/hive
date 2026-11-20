import Capacitor
import WebKit

/// Capacitor's own `WKUIDelegate` grants every media-capture request from every
/// origin. The web UI is loaded remotely, so narrow that to the member's dashboard:
/// the page the app is showing, over https, on a workers.dev host (what
/// capacitor.config.json allowNavigation lets the app show), asked by that page
/// itself. Anything else (a third-party iframe, an injected frame, a downgraded
/// http load, a page that isn't a dashboard) is denied. Every other `WKUIDelegate`
/// responsibility is forwarded to Capacitor untouched.
final class HiveMediaCaptureUIDelegate: NSObject, WKUIDelegate {
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
        let host = origin.host.lowercased()
        let isDashboard = origin.`protocol`.lowercased() == "https"
            && frame.isMainFrame
            && host == webView.url?.host?.lowercased()
            && host.hasSuffix(".workers.dev")
            && host.split(separator: ".").count == 4
        decisionHandler(isDashboard ? .grant : .deny)
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
            let delegate = HiveMediaCaptureUIDelegate(wrapping: capacitorDelegate)
            mediaCaptureDelegate = delegate
            webView.uiDelegate = delegate
        }
    }
}

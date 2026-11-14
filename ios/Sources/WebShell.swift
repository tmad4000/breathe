import AVFoundation
import SwiftUI
import UIKit
import WebKit

/// Shows the Breathe web app and gives it one thing a browser cannot: both cameras at once.
/// The page asks for them with `webkit.messageHandlers.breathe.postMessage({cmd: "start"})`
/// and receives `__breatheNative.frame(jpegBase64, seconds)` for the front camera and
/// `__breatheNative.pulse(seconds, r, g, b)` for the fingertip on the rear camera.
struct WebShell: UIViewRepresentable {
    func makeCoordinator() -> ShellCoordinator { ShellCoordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class ShellCoordinator: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, DualCameraDelegate {
    /// The page to show. Override for testing with the launch argument `-BreatheURL https://…`.
    static let home: URL = {
        let fallback = "https://jacobcole.ai/breathe/"
        let configured = UserDefaults.standard.string(forKey: "BreatheURL")
            ?? Bundle.main.object(forInfoDictionaryKey: "BreatheURL") as? String
        return URL(string: configured ?? fallback) ?? URL(string: fallback)!
    }()

    private var webView: WKWebView?
    private let camera = DualCamera()

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let shell = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let dual = AVCaptureMultiCamSession.isMultiCamSupported
        let info = "window.__breatheNativeInfo = { dual: \(dual), shell: '\(shell)' };"
        config.userContentController.addUserScript(
            WKUserScript(source: info, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "breathe")

        let view = WKWebView(frame: .zero, configuration: config)
        view.uiDelegate = self
        view.navigationDelegate = self
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        view.isOpaque = false
        view.backgroundColor = .white
        camera.delegate = self
        webView = view
        view.load(URLRequest(url: Self.home))
        return view
    }

    // MARK: Page → shell

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the Breathe page itself may drive the cameras.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == Self.home.host,
              let body = message.body as? [String: Any],
              let command = body["cmd"] as? String else { return }
        switch command {
        case "start":
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        UIApplication.shared.isIdleTimerDisabled = true
                        self.camera.start()
                    } else {
                        self.call("error", ["Camera access is off. Allow it in Settings → Breathe, then tap Start."])
                    }
                }
            }
        case "stop":
            UIApplication.shared.isIdleTimerDisabled = false
            camera.stop()
        default:
            break
        }
    }

    // MARK: Shell → page

    /// Calls `window.__breatheNative.<name>(…args)`. Arguments are JSON-encoded, never spliced in raw.
    private func call(_ name: String, _ args: [Any], done: (() -> Void)? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8) else { done?(); return }
        let script = "window.__breatheNative && window.__breatheNative.\(name).apply(null, \(json)); null"
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else { done?(); return }
            webView.evaluateJavaScript(script) { _, _ in done?() }
        }
    }

    func dualCamera(_ camera: DualCamera, frontJPEG: Data, at seconds: Double) {
        call("frame", [frontJPEG.base64EncodedString(), seconds]) { camera.frameDelivered() }
    }

    func dualCamera(_ camera: DualCamera, fingerRed red: Double, green: Double, blue: Double, at seconds: Double) {
        call("pulse", [seconds, red, green, blue])
    }

    func dualCamera(_ camera: DualCamera, note: String) { call("note", [note]) }

    func dualCamera(_ camera: DualCamera, failed message: String) {
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
        call("error", [message])
    }

    // MARK: Web view policy

    /// The other modes use the page's own camera access; allow it for the Breathe page only.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == Self.home.host ? .grant : .deny)
    }

    /// Links that leave the Breathe site open in Safari.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, action.targetFrame?.isMainFrame ?? true,
              let scheme = url.scheme, scheme.hasPrefix("http"), url.host != Self.home.host else {
            decisionHandler(.allow)
            return
        }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let page = """
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font: 17px -apple-system; padding: 80px 24px; color: #202124">
        <p>Breathe could not load. Check your connection.</p>
        <p><a href="\(Self.home.absoluteString)">Try again</a></p></body>
        """
        webView.loadHTMLString(page, baseURL: nil)
    }
}

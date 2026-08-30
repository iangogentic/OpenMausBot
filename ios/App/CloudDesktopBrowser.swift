// The cloud provider's noVNC viewer, contained inside one ephemeral WebKit
// data store. The short-lived URL is a bearer credential: there is no address
// bar, sharing UI, popup window, external navigation, or persistent cookie and
// cache jar from which it can be recovered later.
import CompanionCore
import SwiftUI
import WebKit

struct CloudDesktopBrowser: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(origin: url)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsAirPlayForMediaPlayback = false

        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.navigationDelegate = context.coordinator
        browser.uiDelegate = context.coordinator
        browser.allowsBackForwardNavigationGestures = false
        browser.allowsLinkPreview = false
        browser.isInspectable = false
        browser.scrollView.keyboardDismissMode = .interactive
        browser.accessibilityLabel = "Live cloud computer"
        browser.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        return browser
    }

    func updateUIView(_ browser: WKWebView, context: Context) {}

    static func dismantleUIView(_ browser: WKWebView, coordinator: Coordinator) {
        browser.stopLoading()
        browser.navigationDelegate = nil
        browser.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let origin: URL

        init(origin: URL) {
            self.origin = origin
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // A nil target frame asks WebKit to create a popup. The viewer is
            // intentionally one top-level surface, so it has nowhere to go.
            guard let frame = navigationAction.targetFrame,
                  !navigationAction.shouldPerformDownload,
                  let destination = navigationAction.request.url,
                  cloudDesktopNavigationIsAllowed(
                    destination: destination,
                    originalURL: origin,
                    isMainFrame: frame.isMainFrame
                  )
            else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            guard navigationResponse.canShowMIMEType,
                  let destination = navigationResponse.response.url,
                  cloudDesktopNavigationIsAllowed(
                    destination: destination,
                    originalURL: origin,
                    isMainFrame: navigationResponse.isForMainFrame
                  )
            else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.deny)
        }

        func webView(
            _ webView: WKWebView,
            requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.deny)
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                completionHandler(.performDefaultHandling, nil)
            } else {
                // The minted URL/cookies are the only credential this surface
                // may use; never display or satisfy HTTP credential prompts.
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        }
    }
}

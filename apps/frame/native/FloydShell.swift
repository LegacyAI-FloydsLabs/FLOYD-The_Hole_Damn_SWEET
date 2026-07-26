// FloydShell — native WebKit window hosting the FLOYD frame.
// Single WKWebView, no tabs, no chrome. Solo-use packaged surface.
// Presents like Chrome to the page (UA + desktop behaviors) so the frame's
// layout/classification code takes the same paths it does in Chrome.
// The agents' internal browser (Chrome + extensions, frame-server managed)
// is a separate thing and is untouched by this shell.
// Build: swiftc -O -framework Cocoa -framework WebKit FloydShell.swift -o FloydShell
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    // Chrome-stable UA (macOS). Keeps sites and the frame on their Chrome code
    // paths: same layouts, same feature gates, same styling decisions.
    static let chromeUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Frame + apps are same-machine loopback; media (mic for apps) allowed without prompt storms.
        config.mediaTypesRequiringUserActionForPlayback = []
        // Persistent store: cookies/localStorage survive relaunch, like a browser profile.
        config.websiteDataStore = WKWebsiteDataStore.default()

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.allowsBackForwardNavigationGestures = true   // two-finger swipe like Chrome
        webView.customUserAgent = Self.chromeUA

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = NSWindow(
            contentRect: NSRect(x: screen.midX - 720, y: screen.midY - 450, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "FLOYD"
        // Real titlebar: a grabbable strip so the window can be moved like any app.
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = webView
        window.setFrameAutosaveName("FloydShellMain")        // remember size/position
        window.makeKeyAndOrderFront(nil)

        buildMenu()

        let port = ProcessInfo.processInfo.environment["FRAME_PORT"] ?? "13030"
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
        NSApp.activate(ignoringOtherApps: true)
    }

    // Chrome-parity keyboard surface: full Edit menu (copy/paste/undo works in
    // web inputs), View menu with reload + zoom, History back/forward.
    private func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About FLOYD", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide FLOYD", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit FLOYD", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        let hardReload = NSMenuItem(title: "Hard Reload", action: #selector(hardReloadPage), keyEquivalent: "r")
        hardReload.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(hardReload)
        view.addItem(.separator())
        view.addItem(withTitle: "Actual Size", action: #selector(zoomActual), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(.separator())
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)
        let devTools = NSMenuItem(title: "Developer Tools", action: #selector(openDevTools), keyEquivalent: "i")
        devTools.keyEquivalentModifierMask = [.command, .option]
        view.addItem(devTools)
        let viewItem = NSMenuItem(); viewItem.submenu = view; main.addItem(viewItem)

        let history = NSMenu(title: "History")
        history.addItem(withTitle: "Back", action: #selector(goBack), keyEquivalent: "[")
        history.addItem(withTitle: "Forward", action: #selector(goForward), keyEquivalent: "]")
        history.addItem(.separator())
        history.addItem(withTitle: "Home (Frame)", action: #selector(goHome), keyEquivalent: "H")
        let histItem = NSMenuItem(); histItem.submenu = history; main.addItem(histItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let winItem = NSMenuItem(); winItem.submenu = windowMenu; main.addItem(winItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc func reloadPage() { webView.reload() }
    @objc func hardReloadPage() { webView.reloadFromOrigin() }
    @objc func zoomActual() { webView.pageZoom = 1.0 }
    @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 3.0) }
    @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func goBack() { if webView.canGoBack { webView.goBack() } }
    @objc func goForward() { if webView.canGoForward { webView.goForward() } }
    @objc func goHome() {
        let port = ProcessInfo.processInfo.environment["FRAME_PORT"] ?? "13030"
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }
    @objc func openDevTools() {
        // developerExtrasEnabled gives the context-menu Inspect Element; this
        // surfaces it from the keyboard too.
        webView.evaluateJavaScript("undefined") { _, _ in }
        if let inspector = self.webView.perform(Selector(("_inspector")))?.takeUnretainedValue() as? NSObject {
            _ = inspector.perform(Selector(("show")))
        }
    }

    // Keep window.open / target=_blank inside the one surface.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let html = "<body style='background:#08090c;color:#9aa1b2;font:14px -apple-system;display:grid;place-items:center;height:100vh'><div>FLOYD frame unreachable — is frame-server running on 13030?<br><code style='color:#22d3ee'>node apps/frame/server/frame-server.mjs</code></div></body>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

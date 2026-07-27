import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var server: Process?
  private var outputBuffer = ""
  private var logHandle: FileHandle?

  func applicationDidFinishLaunching(_ notification: Notification) {
    do { try launchServer() }
    catch {
      let alert = NSAlert(); alert.messageText = "CURSEM could not start"; alert.informativeText = error.localizedDescription
      alert.runModal(); NSApplication.shared.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    server?.terminate(); logHandle?.closeFile()
  }

  private func launchServer() throws {
    guard let resources = Bundle.main.resourceURL else { throw LauncherError("Application resources are unavailable.") }
    let environment = ProcessInfo.processInfo.environment
    let argument = CommandLine.arguments.dropFirst().first
    let workspace: String
    if let argument, !argument.isEmpty { workspace = URL(fileURLWithPath: argument).standardizedFileURL.path }
    else if let configured = environment["CURSEM_WORKSPACE_ROOT"], !configured.isEmpty { workspace = configured }
    else {
      let picker = NSOpenPanel(); picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.allowsMultipleSelection = false
      picker.prompt = "Open in CURSEM"; picker.message = "Choose the project folder for this CURSEM workspace."
      guard picker.runModal() == .OK, let selected = picker.url else { NSApplication.shared.terminate(nil); return }
      workspace = selected.path
    }

    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CURSEM", isDirectory: true)
    let logs = support.appendingPathComponent("logs", isDirectory: true)
    try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    let log = logs.appendingPathComponent("launcher.log")
    if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
    logHandle = try FileHandle(forWritingTo: log); try logHandle?.seekToEnd()

    let process = Process(); let pipe = Pipe()
    process.executableURL = resources.appendingPathComponent("runtime/bin/node")
    process.currentDirectoryURL = resources.appendingPathComponent("runtime")
    process.arguments = ["server/cursem-server.mjs", "--workspace", workspace]
    var serverEnvironment = environment
    serverEnvironment["CURSEM_PACKAGED"] = "1"
    serverEnvironment["CURSEM_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
    process.environment = serverEnvironment
    process.standardOutput = pipe; process.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData; if data.isEmpty { return }
      self?.logHandle?.write(data)
      guard let text = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async { self?.consume(text, openBrowser: environment["CURSEM_NO_OPEN"] != "1") }
    }
    process.terminationHandler = { _ in DispatchQueue.main.async { NSApplication.shared.terminate(nil) } }
    try process.run(); server = process
  }

  private func consume(_ text: String, openBrowser: Bool) {
    outputBuffer += text
    guard let range = outputBuffer.range(of: #"http://127\.0\.0\.1:\d+/"#, options: .regularExpression) else { return }
    let value = String(outputBuffer[range]); outputBuffer = ""
    if openBrowser, let url = URL(string: value) { NSWorkspace.shared.open(url) }
  }
}

struct LauncherError: LocalizedError {
  let message: String; init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.activate(ignoringOtherApps: true)
application.run()

import CoreServices
import Foundation

let mode = CommandLine.arguments[1]
let scheme = CommandLine.arguments[2]
if mode == "request" {
    let status = LSSetDefaultHandlerForURLScheme(scheme as CFString, "com.google.Chrome" as CFString)
    print("Browser change request:", scheme, "OSStatus:", status)
    if status != 0 { exit(1) }
} else {
    print(LSCopyDefaultHandlerForURLScheme(scheme as CFString)?.takeRetainedValue() as String? ?? "none")
}

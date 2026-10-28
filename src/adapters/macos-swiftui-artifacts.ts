export type MacosArtifact = { readonly path: string; readonly contents: string }

export const MACOS_APP_NAME = "AppHarnessMac"

export const MACOS_ARTIFACTS = [
  {
    path: "Package.swift",
    contents: `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "${MACOS_APP_NAME}",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "${MACOS_APP_NAME}", targets: ["${MACOS_APP_NAME}"])],
  targets: [
    .executableTarget(name: "${MACOS_APP_NAME}"),
    .testTarget(name: "${MACOS_APP_NAME}Tests", dependencies: ["${MACOS_APP_NAME}"])
  ]
)
`,
  },
  {
    path: `Sources/${MACOS_APP_NAME}/${MACOS_APP_NAME}App.swift`,
    contents: `import SwiftUI

@main
struct ${MACOS_APP_NAME}App: App {
  var body: some Scene {
    WindowGroup { ContentView() }
  }
}

struct ContentView: View {
  var body: some View {
    Text("macOS app ready")
      .frame(minWidth: 480, minHeight: 320)
  }
}
`,
  },
  {
    path: `Tests/${MACOS_APP_NAME}Tests/${MACOS_APP_NAME}Tests.swift`,
    contents: `import XCTest
@testable import ${MACOS_APP_NAME}

final class ${MACOS_APP_NAME}Tests: XCTestCase {
  func testModuleLoads() { XCTAssertTrue(true) }
}
`,
  },
] as const satisfies readonly MacosArtifact[]

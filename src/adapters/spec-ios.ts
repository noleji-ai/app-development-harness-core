import { IOS_PROJECT } from "./ios-pbxproj"
import { type OfficialAdapterSpec, STATELESS_PERSISTENCE } from "./official-types"

const APP_NAME = "HarnessIOS"
const PROJECT = `${APP_NAME}.xcodeproj`
const DESTINATION = "platform=iOS Simulator,name=iPhone 16 Pro"

const SCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2660" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="000000000000000000000050" BuildableName="HarnessIOS.app" BlueprintName="HarnessIOS" ReferencedContainer="container:HarnessIOS.xcodeproj"/>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables>
      <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="000000000000000000000051" BuildableName="HarnessIOSTests.xctest" BlueprintName="HarnessIOSTests" ReferencedContainer="container:HarnessIOS.xcodeproj"/></TestableReference>
      <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="000000000000000000000052" BuildableName="HarnessIOSUITests.xctest" BlueprintName="HarnessIOSUITests" ReferencedContainer="container:HarnessIOS.xcodeproj"/></TestableReference>
    </Testables>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="000000000000000000000050" BuildableName="HarnessIOS.app" BlueprintName="HarnessIOS" ReferencedContainer="container:HarnessIOS.xcodeproj"/></BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"/>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`

const IOS_TEST_ARGS = [
  "-project",
  PROJECT,
  "-scheme",
  APP_NAME,
  "-destination",
  DESTINATION,
  "-derivedDataPath",
  ".app-harness/xcode-derived",
  "test",
] as const

export const IOS_SPEC = {
  id: "ios-swiftui",
  platform: "ios",
  version: "26.6",
  observedAt: "2026-07-13",
  capabilities: ["build", "test", "manual-qa", "deploy-ready", "ios-app", "swiftui", "native"],
  persistence: STATELESS_PERSISTENCE,
  marker: {
    path: `${PROJECT}/project.pbxproj`,
    contains: "com.apple.product-type.application",
  },
  artifacts: [
    { path: `${PROJECT}/project.pbxproj`, contents: IOS_PROJECT },
    { path: `${PROJECT}/xcshareddata/xcschemes/${APP_NAME}.xcscheme`, contents: SCHEME },
    {
      path: `${APP_NAME}/${APP_NAME}App.swift`,
      contents: `import SwiftUI

@main
struct HarnessIOSApp: App {
  var body: some Scene { WindowGroup { LaunchView() } }
}
`,
    },
    {
      path: `${APP_NAME}/LaunchView.swift`,
      contents: `import SwiftUI

enum LaunchCopy { static let title = "Service ready" }

struct LaunchView: View {
  var body: some View { Text(LaunchCopy.title).accessibilityAddTraits(.isHeader) }
}
`,
    },
    {
      path: "Tests/LaunchViewTests.swift",
      contents: `import XCTest
@testable import HarnessIOS

final class LaunchViewTests: XCTestCase {
  func testLaunchTitle() { XCTAssertEqual(LaunchCopy.title, "Service ready") }
}
`,
    },
    {
      path: "UITests/HarnessIOSUITests.swift",
      contents: `import XCTest

@MainActor
final class HarnessIOSUITests: XCTestCase {
  func testLaunchSurface() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["Service ready"].waitForExistence(timeout: 5))
  }
}
`,
    },
  ],
  probe: { executable: "xcodebuild", args: ["-version"] },
  probeOutput: "Xcode 26.6",
  build: {
    executable: "xcodebuild",
    args: [
      "-project",
      PROJECT,
      "-scheme",
      APP_NAME,
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      ".app-harness/xcode-derived",
      "build",
    ],
    writablePaths: [".app-harness/xcode-derived"],
  },
  test: {
    executable: "xcodebuild",
    args: IOS_TEST_ARGS,
    writablePaths: [".app-harness/xcode-derived"],
  },
  manualQa: {
    executable: "xcodebuild",
    args: IOS_TEST_ARGS,
    writablePaths: [".app-harness/xcode-derived"],
  },
  package: {
    executable: "xcodebuild",
    args: [
      "archive",
      "-project",
      PROJECT,
      "-scheme",
      APP_NAME,
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      ".app-harness/releases/ios-swiftui/HarnessIOS.xcarchive",
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
    ],
    writablePaths: [".app-harness/releases/ios-swiftui/HarnessIOS.xcarchive"],
  },
  testSources: ["Tests/LaunchViewTests.swift", "UITests/HarnessIOSUITests.swift"],
  requiredXcodeVersion: "26.6",
} as const satisfies OfficialAdapterSpec

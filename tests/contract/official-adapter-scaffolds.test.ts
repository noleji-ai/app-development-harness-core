import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createOfficialAdapterFixture } from "../support/official-adapter-fixture"

const { cleanup, fixtureFor, official: OFFICIAL } = createOfficialAdapterFixture()
afterEach(cleanup)

describe("official scaffold surfaces", () => {
  test.each([
    ["web-next", "app/layout.tsx", "RootLayout"],
    ["web-next", "tests/http-qa.ts", "Bun.spawn"],
    ["web-vite-react-pwa", "src/main.tsx", "createRoot"],
    ["backend-fastapi-postgres", "tests/test_health.py", "TestClient"],
    ["backend-nestjs-postgres", "src/app.ts", "NestFactory"],
    ["ios-swiftui", "HarnessIOS.xcodeproj/project.pbxproj", "com.apple.product-type.application"],
    ["ios-swiftui", "UITests/HarnessIOSUITests.swift", "XCUIApplication"],
    ["android-compose", "app/src/test/java/com/example/harness/GreetingTest.kt", "Greeting"],
    [
      "android-compose",
      "app/src/androidTest/java/com/example/harness/MainActivityTest.kt",
      "createAndroidComposeRule",
    ],
  ] as const)("%s scaffolds runnable surface artifact %s", async (adapterId, path, contract) => {
    const adapter = OFFICIAL.find((candidate) => candidate.id === adapterId)
    expect(adapter).toBeDefined()
    if (adapter === undefined) return
    const { context } = await fixtureFor(adapter)
    expect((await adapter.scaffold(context)).status).toBe("passed")

    const artifact = await readFile(join(context.projectRoot, path), "utf8")

    expect(artifact).toContain(contract)
  })
})

import { type OfficialAdapterSpec, STATELESS_PERSISTENCE } from "./official-types"
import { IOS_SPEC } from "./spec-ios"

const OBSERVED_AT = "2026-07-13"

export const MOBILE_SPECS = [
  IOS_SPEC,
  {
    id: "android-compose",
    platform: "android",
    version: "9.2.1",
    observedAt: OBSERVED_AT,
    capabilities: [
      "build",
      "test",
      "manual-qa",
      "deploy-ready",
      "android-app",
      "compose",
      "native",
    ],
    persistence: STATELESS_PERSISTENCE,
    marker: { path: "build.gradle.kts", contains: 'version "9.2.1"' },
    artifacts: [
      {
        path: "settings.gradle.kts",
        contents:
          'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = "HarnessAndroid"\ninclude(":app")\n',
      },
      {
        path: "build.gradle.kts",
        contents: 'plugins { id("com.android.application") version "9.2.1" apply false }\n',
      },
      {
        path: "gradle.properties",
        contents: "android.useAndroidX=true\nandroid.builtInKotlin=true\n",
      },
      {
        path: "app/build.gradle.kts",
        contents: `plugins { id("com.android.application") }

android {
  namespace = "com.example.harness"
  compileSdk = 36
  defaultConfig {
    applicationId = "com.example.harness"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  buildFeatures { compose = true }
}

dependencies {
  implementation(platform("androidx.compose:compose-bom:2026.06.01"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation(platform("androidx.compose:compose-bom:2026.06.01"))
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  androidTestImplementation("androidx.test.ext:junit:1.3.0")
  androidTestImplementation("androidx.test:runner:1.7.0")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}
`,
      },
      {
        path: "app/src/main/AndroidManifest.xml",
        contents:
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>\n',
      },
      {
        path: "app/src/main/java/com/example/harness/MainActivity.kt",
        contents: `package com.example.harness

import android.app.Activity
import android.os.Bundle
import androidx.compose.material3.Text
import androidx.compose.ui.platform.ComposeView

object Greeting { const val title = "Service ready" }

class MainActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setContentView(ComposeView(this).apply { setContent { Text(Greeting.title) } })
  }
}
`,
      },
      {
        path: "app/src/test/java/com/example/harness/GreetingTest.kt",
        contents: `package com.example.harness

import org.junit.Assert.assertEquals
import org.junit.Test

class GreetingTest {
  @Test fun titleIsStable() { assertEquals("Service ready", Greeting.title) }
}
`,
      },
      {
        path: "app/src/androidTest/java/com/example/harness/MainActivityTest.kt",
        contents: `package com.example.harness

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
  @get:Rule val compose = createAndroidComposeRule<MainActivity>()

  @Test fun launchSurfaceIsVisible() {
    compose.onNodeWithText(Greeting.title).assertIsDisplayed()
  }
}
`,
      },
    ],
    probe: { executable: "gradle", args: ["--version"] },
    probeOutput: "Gradle 9.2.1",
    build: {
      executable: "gradle",
      args: ["--offline", ":app:assembleDebug"],
      writablePaths: [".gradle", "app/build"],
    },
    test: {
      executable: "gradle",
      args: ["--offline", ":app:testDebugUnitTest"],
      writablePaths: [".gradle", "app/build"],
    },
    manualQa: {
      executable: "gradle",
      args: ["--offline", ":app:connectedDebugAndroidTest"],
      writablePaths: [".gradle", "app/build"],
    },
    package: {
      executable: "gradle",
      args: ["--offline", ":app:bundleRelease"],
      writablePaths: [".gradle", "app/build"],
    },
    testSources: [
      "app/src/test/java/com/example/harness/GreetingTest.kt",
      "app/src/androidTest/java/com/example/harness/MainActivityTest.kt",
    ],
  },
] as const satisfies readonly OfficialAdapterSpec[]

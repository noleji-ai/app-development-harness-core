import type { Scores, TechnologyCandidate } from "../domain/technology"
import { createConcreteAdapter } from "./concrete-adapter"
import { MACOS_SWIFTUI_ADAPTER } from "./macos-swiftui"
import { GO_BACKEND_SPEC } from "./spec-backend-go"
import { SCRIPT_BACKEND_SPECS } from "./spec-backend-js"
import { MOBILE_SPECS } from "./spec-mobile"
import { WEB_SPECS } from "./spec-web"

const score = (
  productExperience: number,
  securityCompliance: number,
  performanceIntegration: number,
  maintainability: number,
  ecosystem: number,
  scheduleBudget: number,
  reversibility: number,
): Scores => ({
  productExperience,
  securityCompliance,
  performanceIntegration,
  maintainability,
  ecosystem,
  scheduleBudget,
  reversibility,
})

const candidates = [
  ["web-next", "Next.js", "web", score(90, 85, 82, 88, 95, 82, 78), ["interactive"]],
  ["web-astro", "Astro", "web", score(82, 88, 92, 90, 86, 90, 88), ["content"]],
  [
    "web-vite-react-pwa",
    "Vite React PWA",
    "web",
    score(84, 82, 92, 85, 90, 86, 90),
    ["pwa", "offline"],
  ],
  [
    "backend-go-postgres",
    "Go PostgreSQL",
    "backend",
    score(78, 96, 96, 86, 86, 68, 78),
    ["api", "regulated"],
  ],
  [
    "backend-fastapi-postgres",
    "FastAPI PostgreSQL",
    "backend",
    score(78, 82, 74, 84, 92, 86, 86),
    ["ai-data", "ai"],
  ],
  [
    "backend-nestjs-postgres",
    "NestJS PostgreSQL",
    "backend",
    score(84, 84, 78, 90, 90, 92, 80),
    ["bff", "budget"],
  ],
  ["ios-swiftui", "SwiftUI", "ios", score(100, 96, 100, 88, 96, 68, 78), ["interactive", "native"]],
  [
    "ios-flutter",
    "Flutter for iOS",
    "ios",
    score(76, 82, 82, 90, 86, 94, 72),
    ["interactive", "single-codebase"],
  ],
  [
    "ios-react-native",
    "React Native for iOS",
    "ios",
    score(72, 80, 78, 86, 90, 92, 74),
    ["interactive", "single-codebase"],
  ],
  [
    "macos-swiftui",
    "SwiftUI for macOS",
    "macos",
    score(100, 96, 100, 88, 96, 68, 78),
    ["desktop", "interactive", "native"],
  ],
  [
    "android-compose",
    "Kotlin Compose",
    "android",
    score(100, 96, 100, 88, 96, 68, 78),
    ["interactive", "native"],
  ],
  [
    "android-flutter",
    "Flutter for Android",
    "android",
    score(76, 82, 82, 90, 86, 94, 72),
    ["interactive", "single-codebase"],
  ],
  [
    "android-react-native",
    "React Native for Android",
    "android",
    score(72, 80, 78, 86, 90, 92, 74),
    ["interactive", "single-codebase"],
  ],
] as const

export const TECHNOLOGY_CANDIDATES: readonly TechnologyCandidate[] = candidates.map(
  ([id, label, platform, baseScores, tags]) => ({
    id,
    label,
    platform,
    baseScores,
    tags,
    reversible: true,
    highExternalCost: false,
    capabilities: ["build", "test", "manual-qa", "deploy-ready"],
  }),
)

export const OFFICIAL_SPECS = [
  ...WEB_SPECS,
  GO_BACKEND_SPEC,
  ...SCRIPT_BACKEND_SPECS,
  ...MOBILE_SPECS,
] as const

export const ADAPTERS = [
  ...OFFICIAL_SPECS.map((definition) => createConcreteAdapter(definition)),
  MACOS_SWIFTUI_ADAPTER,
] as const

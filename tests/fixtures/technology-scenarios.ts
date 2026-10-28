import type { ProductContext } from "../../src/domain/technology"

const BASE = {
  regulated: false,
  offlineRequired: false,
  aiProcessing: false,
  budgetConstrained: false,
  singleCodebasePriority: false,
} as const

export const SCENARIOS = {
  regulatedApi: { ...BASE, platform: "backend", productKind: "api", regulated: true },
  aiApi: { ...BASE, platform: "backend", productKind: "ai-data", aiProcessing: true },
  budgetBff: { ...BASE, platform: "backend", productKind: "bff", budgetConstrained: true },
  qualityWeb: { ...BASE, platform: "web", productKind: "interactive" },
  offlineWeb: { ...BASE, platform: "web", productKind: "pwa", offlineRequired: true },
  ios: { ...BASE, platform: "ios", productKind: "interactive" },
  android: { ...BASE, platform: "android", productKind: "interactive" },
  macos: { ...BASE, platform: "macos", productKind: "desktop" },
} satisfies Record<string, ProductContext>

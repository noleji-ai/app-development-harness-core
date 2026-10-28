import { type OfficialAdapterSpec, STATELESS_PERSISTENCE } from "./official-types"
import { surfaceQaCommand } from "./surface-command"
import { httpQa, SURFACE_TEST, webPackage } from "./web-artifacts"

const BASE_CAPABILITIES = ["build", "test", "manual-qa", "deploy-ready", "web"] as const
const OBSERVED_AT = "2026-07-13"

export const WEB_SPECS = [
  {
    id: "web-next",
    platform: "web",
    version: "16.2.10",
    observedAt: OBSERVED_AT,
    capabilities: [...BASE_CAPABILITIES, "interactive", "ssr"],
    persistence: STATELESS_PERSISTENCE,
    marker: { path: "package.json", contains: '"next": "16.2.10"' },
    artifacts: [
      {
        path: "package.json",
        contents: webPackage({
          name: "harness-next-app",
          build: "next build",
          development: "next dev",
          production: "next start",
          dependencies: {
            next: "16.2.10",
            react: "19.2.7",
            "react-dom": "19.2.7",
          },
        }),
      },
      {
        path: "app/layout.tsx",
        contents: `import type { ReactNode } from "react"

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
`,
      },
      {
        path: "app/page.tsx",
        contents: `export default function Home() {
  return <main><h1>Service ready</h1><p>Decision-led launch workspace.</p></main>
}
`,
      },
      {
        path: "app/generated/page.tsx",
        contents: `export default function Generated() { return <main>Generated stage ready</main> }
`,
      },
      { path: "tests/surface.test.ts", contents: SURFACE_TEST },
      {
        path: "tests/http-qa.ts",
        contents: httpQa(["--hostname", "127.0.0.1", "--port"], "<main"),
      },
      { path: "next-env.d.ts", contents: '/// <reference types="next" />\n' },
    ],
    probe: { executable: "next", args: ["--version"] },
    probeOutput: "16.2.10",
    build: { executable: "next", args: ["build"], writablePaths: [".next"] },
    test: { executable: "bun", args: ["test", "tests/surface.test.ts"] },
    manualQa: surfaceQaCommand({
      executable: "next",
      args: ["start", "--hostname", "127.0.0.1", "--port", "{port}"],
      path: "/",
      expected: "<main",
      format: "bun",
    }),
    package: { executable: "next", args: ["build"], writablePaths: [".next"] },
    testSources: ["tests/surface.test.ts"],
  },
  {
    id: "web-astro",
    platform: "web",
    version: "7.0.7",
    observedAt: OBSERVED_AT,
    capabilities: [...BASE_CAPABILITIES, "content", "static-html"],
    persistence: STATELESS_PERSISTENCE,
    marker: { path: "package.json", contains: '"astro": "7.0.7"' },
    artifacts: [
      {
        path: "package.json",
        contents: webPackage({
          name: "harness-astro-app",
          build: "astro build",
          development: "astro dev",
          production: "astro preview",
          dependencies: { astro: "7.0.7" },
        }),
      },
      {
        path: "src/pages/index.astro",
        contents: `---
const title = "Service ready"
---
<main><h1>{title}</h1><p>Content launch surface.</p></main>
`,
      },
      {
        path: "tests/surface.test.ts",
        contents: SURFACE_TEST.replace("app/page.tsx", "src/pages/index.astro"),
      },
      {
        path: "tests/http-qa.ts",
        contents: httpQa(["--host", "127.0.0.1", "--port"], "<main"),
      },
      {
        path: "astro.config.mjs",
        contents: 'import { defineConfig } from "astro/config"\nexport default defineConfig({})\n',
      },
    ],
    probe: { executable: "astro", args: ["--version"] },
    probeOutput: "7.0.7",
    build: { executable: "astro", args: ["build"], writablePaths: ["dist"] },
    test: { executable: "bun", args: ["test", "tests/surface.test.ts"] },
    manualQa: surfaceQaCommand({
      executable: "astro",
      args: ["preview", "--host", "127.0.0.1", "--port", "{port}"],
      path: "/",
      expected: "<main",
      format: "bun",
    }),
    package: { executable: "astro", args: ["build"], writablePaths: ["dist"] },
    testSources: ["tests/surface.test.ts"],
  },
  {
    id: "web-vite-react-pwa",
    platform: "web",
    version: "8.1.4",
    observedAt: OBSERVED_AT,
    capabilities: [...BASE_CAPABILITIES, "pwa", "offline"],
    persistence: STATELESS_PERSISTENCE,
    marker: { path: "package.json", contains: '"vite": "8.1.4"' },
    artifacts: [
      {
        path: "package.json",
        contents: webPackage({
          name: "harness-vite-pwa",
          build: "vite build",
          development: "vite",
          production: "vite preview",
          dependencies: {
            react: "19.2.7",
            "react-dom": "19.2.7",
            vite: "8.1.4",
          },
        }),
      },
      {
        path: "src/App.tsx",
        contents: `export function App() { return <main><h1>Offline service ready</h1></main> }
`,
      },
      {
        path: "src/main.tsx",
        contents: `import { createRoot } from "react-dom/client"
import { App } from "./App"

const root = document.getElementById("root")
if (root === null) throw new TypeError("root element is missing")
createRoot(root).render(<App />)
`,
      },
      { path: "public/sw.js", contents: 'self.addEventListener("fetch", () => {})\n' },
      {
        path: "tests/surface.test.ts",
        contents: SURFACE_TEST.replace("app/page.tsx", "src/App.tsx"),
      },
      {
        path: "tests/http-qa.ts",
        contents: httpQa(["--host", "127.0.0.1", "--port"], 'id="root"'),
      },
      {
        path: "index.html",
        contents:
          '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Service ready</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
      },
    ],
    probe: { executable: "vite", args: ["--version"] },
    probeOutput: "8.1.4",
    build: { executable: "vite", args: ["build"], writablePaths: ["dist"] },
    test: { executable: "bun", args: ["test", "tests/surface.test.ts"] },
    manualQa: surfaceQaCommand({
      executable: "vite",
      args: ["preview", "--host", "127.0.0.1", "--port", "{port}"],
      path: "/",
      expected: 'id="root"',
      format: "bun",
    }),
    package: { executable: "vite", args: ["build"], writablePaths: ["dist"] },
    testSources: ["tests/surface.test.ts"],
  },
] as const satisfies readonly OfficialAdapterSpec[]

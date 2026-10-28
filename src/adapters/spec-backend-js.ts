import { type OfficialAdapterSpec, POSTGRESQL_PERSISTENCE } from "./official-types"
import { surfaceQaCommand } from "./surface-command"

const OBSERVED_AT = "2026-07-13"

export const SCRIPT_BACKEND_SPECS = [
  {
    id: "backend-fastapi-postgres",
    platform: "backend",
    version: "0.139.0",
    observedAt: OBSERVED_AT,
    capabilities: ["build", "test", "manual-qa", "deploy-ready", "api", "postgres", "ai"],
    persistence: POSTGRESQL_PERSISTENCE,
    marker: { path: "pyproject.toml", contains: "fastapi[standard]==0.139.0" },
    artifacts: [
      {
        path: "pyproject.toml",
        contents: `[project]
name = "harness-service"
version = "0.1.0"
requires-python = ">=3.14.6"
dependencies = ["fastapi[standard]==0.139.0"]
`,
      },
      {
        path: "app/main.py",
        contents: `from fastapi import FastAPI

app = FastAPI()

@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
`,
      },
      { path: "app/__init__.py", contents: "" },
      {
        path: "tests/test_health.py",
        contents: `import unittest
from fastapi.testclient import TestClient

from app.main import app

class HealthTest(unittest.TestCase):
    def test_health_surface(self) -> None:
        response = TestClient(app).get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
`,
      },
      { path: "tests/__init__.py", contents: "" },
      {
        path: "migrations/0001_bootstrap.sql",
        contents:
          "CREATE TABLE IF NOT EXISTS service_metadata (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());\n",
      },
      { path: ".env.example", contents: "DATABASE_URL=postgresql://localhost/service\n" },
    ],
    probe: { executable: "python3", args: ["--version"] },
    probeOutput: "Python 3.14.6",
    build: {
      executable: "python3",
      args: ["-m", "compileall", "-q", "app"],
      writablePaths: ["app/__pycache__"],
    },
    test: {
      executable: "python3",
      args: ["-m", "unittest", "discover", "-s", "tests"],
      writablePaths: ["tests/__pycache__"],
    },
    manualQa: surfaceQaCommand({
      executable: "python3",
      args: ["-m", "fastapi", "run", "app/main.py", "--host", "127.0.0.1", "--port", "{port}"],
      path: "/healthz",
      expected: '"status":"ok"',
      format: "unittest",
    }),
    package: {
      executable: "python3",
      args: ["-m", "compileall", "-q", "app"],
      writablePaths: ["app/__pycache__"],
    },
    testSources: ["tests/test_health.py"],
  },
  {
    id: "backend-nestjs-postgres",
    platform: "backend",
    version: "11.1.28",
    observedAt: OBSERVED_AT,
    capabilities: ["build", "test", "manual-qa", "deploy-ready", "api", "postgres", "bff"],
    persistence: POSTGRESQL_PERSISTENCE,
    marker: { path: "package.json", contains: '"@nestjs/core": "11.1.28"' },
    artifacts: [
      {
        path: "package.json",
        contents: `${JSON.stringify(
          {
            name: "harness-bff",
            private: true,
            type: "module",
            scripts: {
              build: "tsc -p tsconfig.json",
              dev: "bun src/main.ts",
              start: "bun dist/main.js",
              test: "bun test test/health.test.ts",
              "qa:surface": "bun test test/health.test.ts",
            },
            dependencies: {
              "@nestjs/common": "11.1.28",
              "@nestjs/core": "11.1.28",
              "@nestjs/platform-express": "11.1.28",
              "reflect-metadata": "0.2.2",
              rxjs: "7.8.2",
            },
            devDependencies: { typescript: "6.0.2" },
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "src/app.ts",
        contents: `import "reflect-metadata"
import { Controller, Get, Module } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"

@Controller()
export class HealthController {
  @Get("healthz")
  health(): { readonly status: "ok" } { return { status: "ok" } }
}

@Module({ controllers: [HealthController] })
export class AppModule {}

export async function bootstrap(port = 3000): Promise<void> {
  const app = await NestFactory.create(AppModule)
  await app.listen(port, "127.0.0.1")
}
`,
      },
      {
        path: "src/main.ts",
        contents: `import { bootstrap } from "./app"

await bootstrap(Number(process.env.PORT ?? "3000"))
`,
      },
      {
        path: "test/health.test.ts",
        contents: `import { expect, test } from "bun:test"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "../src/app"

test("HTTP health contract", async () => {
  const app = await NestFactory.create(AppModule, { logger: false })
  await app.listen(0, "127.0.0.1")
  try {
    const response = await fetch(
      new URL("/healthz", await app.getUrl()),
      { signal: AbortSignal.timeout(5_000) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  } finally {
    await app.close()
  }
})
`,
      },
      {
        path: "tsconfig.json",
        contents: `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2023",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              noUncheckedIndexedAccess: true,
              exactOptionalPropertyTypes: true,
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
              outDir: "dist",
            },
            include: ["src"],
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "migrations/0001_bootstrap.sql",
        contents:
          "CREATE TABLE IF NOT EXISTS service_metadata (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());\n",
      },
      {
        path: ".env.example",
        contents: "PORT=3000\nDATABASE_URL=postgresql://localhost/service\n",
      },
    ],
    probe: { executable: "tsc", args: ["--version"] },
    probeOutput: "6.0.2",
    build: { executable: "tsc", args: ["-p", "tsconfig.json"], writablePaths: ["dist"] },
    test: { executable: "bun", args: ["test", "test/health.test.ts"] },
    manualQa: surfaceQaCommand({
      executable: "bun",
      args: ["dist/main.js"],
      environment: { PORT: "{port}" },
      path: "/healthz",
      expected: '"status":"ok"',
      format: "bun",
    }),
    package: { executable: "tsc", args: ["-p", "tsconfig.json"], writablePaths: ["dist"] },
    testSources: ["test/health.test.ts"],
  },
] as const satisfies readonly OfficialAdapterSpec[]

import { type OfficialAdapterSpec, POSTGRESQL_PERSISTENCE } from "./official-types"
import { surfaceQaCommand } from "./surface-command"

export const GO_BACKEND_SPEC = {
  id: "backend-go-postgres",
  platform: "backend",
  version: "1.26.5",
  observedAt: "2026-07-13",
  capabilities: ["build", "test", "manual-qa", "deploy-ready", "api", "postgres", "regulated"],
  persistence: POSTGRESQL_PERSISTENCE,
  marker: { path: "go.mod", contains: "module example.com/harness/service" },
  artifacts: [
    { path: "go.mod", contents: "module example.com/harness/service\n\ngo 1.26.5\n" },
    {
      path: "cmd/server/main.go",
      contents: `package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
)

func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok"}); err != nil {
			slog.Error("write health response", "error", err)
		}
	})
	return mux
}

func main() {
	address := os.Getenv("HTTP_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	if err := http.ListenAndServe(address, handler()); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
`,
    },
    {
      path: "cmd/server/main_test.go",
      contents: `package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthSurface(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK { t.Fatalf("status = %d", response.Code) }
}
`,
    },
    {
      path: ".env.example",
      contents: "HTTP_ADDR=127.0.0.1:8080\nDATABASE_URL=postgres://localhost/service\n",
    },
    {
      path: "migrations/0001_bootstrap.sql",
      contents:
        "CREATE TABLE IF NOT EXISTS service_metadata (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());\n",
    },
  ],
  probe: { executable: "go", args: ["version"] },
  probeOutput: "go version go1.26.5",
  build: { executable: "go", args: ["build", "./cmd/server"], writablePaths: ["server"] },
  test: { executable: "go", args: ["test", "-json", "./..."] },
  manualQa: surfaceQaCommand({
    executable: "./server",
    args: [],
    environment: { HTTP_ADDR: "127.0.0.1:{port}" },
    path: "/healthz",
    expected: '"status":"ok"',
    format: "go-json",
  }),
  package: {
    executable: "go",
    args: [
      "build",
      "-trimpath",
      "-o",
      ".app-harness/releases/backend-go-postgres/server",
      "./cmd/server",
    ],
    writablePaths: [".app-harness/releases/backend-go-postgres/server"],
  },
  testSources: ["cmd/server/main_test.go"],
} as const satisfies OfficialAdapterSpec

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

export const DASHBOARD_HOST = "127.0.0.1"
export const MAX_JSON_BYTES = 64 * 1024

export class DashboardRequestError extends Error {
  readonly name = "DashboardRequestError"

  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export function createDashboardToken(): string {
  return randomBytes(32).toString("base64url")
}

export function dashboardSecurityHeaders(): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === "string" ? value : undefined
}

function equalSecret(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest()
  const expectedHash = createHash("sha256").update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash) && actual === expected
}

export function assertLocalRequest(request: IncomingMessage, origin: string): void {
  const expectedHost = new URL(origin).host
  if (singleHeader(request, "host") !== expectedHost) {
    throw new DashboardRequestError(403, "invalid_host")
  }
  const remoteAddress = request.socket.remoteAddress
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
    throw new DashboardRequestError(403, "non_loopback_client")
  }
}

export function assertApiRequest(
  request: IncomingMessage,
  origin: string,
  token: string,
  mutation: boolean,
): void {
  assertLocalRequest(request, origin)
  const requestOrigin = singleHeader(request, "origin")
  if ((mutation || requestOrigin !== undefined) && requestOrigin !== origin) {
    throw new DashboardRequestError(403, "invalid_origin")
  }
  const authorization = singleHeader(request, "authorization") ?? ""
  if (!equalSecret(authorization, `Bearer ${token}`)) {
    throw new DashboardRequestError(401, "invalid_token")
  }
}

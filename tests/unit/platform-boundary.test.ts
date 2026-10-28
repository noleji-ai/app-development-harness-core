import { expect, test } from "bun:test"
import * as technology from "../../src/domain/technology"

type Parser = { readonly safeParse: (input: unknown) => { readonly success: boolean } }

function isParser(value: unknown): value is Parser {
  return typeof value === "object" && value !== null && "safeParse" in value
}

test("platform boundary accepts macOS and rejects malformed shell-like input", () => {
  // Given
  const parser = Reflect.get(technology, "PlatformSchema")

  // When
  const available = isParser(parser)

  // Then
  expect(available).toBe(true)
  if (!available) return
  expect(parser.safeParse("macos").success).toBe(true)
  expect(parser.safeParse("macos; rm -rf /").success).toBe(false)
})

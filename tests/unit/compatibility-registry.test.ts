import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { ADAPTERS } from "../../src/adapters/registry"

const RegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.iso.date(),
    entries: z
      .array(
        z
          .object({
            id: z.string().min(1),
            version: z.string().min(1),
            strategy: z.string().min(1),
            source: z.url(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

test("compatibility registry pins reviewed versions without latest aliases", async () => {
  const raw = JSON.parse(await readFile("registry/compatibility.v1.json", "utf8"))
  const registry = RegistrySchema.parse(raw)
  expect(registry.entries.some((entry) => /latest/i.test(entry.version))).toBe(false)
  expect(new Set(registry.entries.map((entry) => entry.id)).size).toBe(registry.entries.length)
  expect(registry.entries.some((entry) => entry.id === "macos-swiftui")).toBe(true)
  const versions = new Map(registry.entries.map((entry) => [entry.id, entry.version]))
  for (const adapter of ADAPTERS) expect(versions.get(adapter.id)).toBe(adapter.version)
})

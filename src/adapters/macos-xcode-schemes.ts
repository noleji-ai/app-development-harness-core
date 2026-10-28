import { z } from "zod"

import { MACOS_APP_NAME } from "./macos-swiftui-artifacts"

const SchemeContainerSchema = z.object({ schemes: z.array(z.string()) })
const XcodeListSchema = z.object({
  workspace: SchemeContainerSchema.optional(),
  project: SchemeContainerSchema.optional(),
  package: SchemeContainerSchema.optional(),
})

const TEST_SCHEME_CANDIDATES = [`${MACOS_APP_NAME}-Package`, MACOS_APP_NAME] as const

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function selectMacosTestScheme(xcodeListOutput: string): string | undefined {
  const parsed = XcodeListSchema.safeParse(parseJson(xcodeListOutput))
  if (!parsed.success) return undefined
  const listedSchemes = new Set([
    ...(parsed.data.workspace?.schemes ?? []),
    ...(parsed.data.project?.schemes ?? []),
    ...(parsed.data.package?.schemes ?? []),
  ])
  return TEST_SCHEME_CANDIDATES.find((scheme) => listedSchemes.has(scheme))
}

import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"

const SOURCE = `
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
let prompt = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { prompt += chunk })
process.stdin.on("end", () => {
  const match = prompt.match(/<app-harness-context>\\n([\\s\\S]*?)\\n<\\/app-harness-context>/)
  if (!match) process.exit(41)
  const context = JSON.parse(match[1])
  const project = args[args.indexOf("-C") + 1]
  const output = args[args.indexOf("-o") + 1]
  const artifact = path.join(project, "artifacts", context.stage + ".json")
  const correlated = {
    schemaVersion: 1,
    runId: context.runId,
    stage: context.stage,
    inputHash: context.inputHash,
  }
  const documents = {
    "request-analysis": {
      ...correlated,
      users: ["fixture user"],
      problem: "A focused workflow is needed.",
      outcomes: ["A verified result"],
      platforms: ["web"],
      constraints: ["Local only"],
      nonFunctionalRequirements: ["Accessible"],
    },
    "research-prd": {
      ...correlated,
      product: "Fixture product",
      problem: "A focused workflow is needed.",
      successMetrics: ["Core flow completes"],
      inScope: ["Core flow"],
      outOfScope: ["External deployment"],
      constraints: ["Provider neutral"],
      nonFunctionalRequirements: ["Accessible"],
    },
    "design-candidates": {
      ...correlated,
      directions: [
        { id: "clarity-first", name: "Clarity first", informationArchitecture: "Task-led", interactionModel: "Guided", visualLanguage: "Quiet" },
        { id: "workflow-first", name: "Workflow first", informationArchitecture: "Queue-led", interactionModel: "Keyboard", visualLanguage: "Dense" },
      ],
    },
    "technology-optimization": {
      ...correlated,
      selectedAdapterId: "web-next",
      confidence: 0.92,
      rationale: "The fixture selects a supported web adapter.",
      alternatives: [
        { adapterId: "web-next", score: 92, reason: "Best fit for the fixture web surface." },
      ],
    },
  }
  fs.mkdirSync(path.dirname(artifact), { recursive: true })
  fs.writeFileSync(artifact, JSON.stringify(documents[context.stage] || correlated) + "\\n")
  const artifactId = context.stage === "research-prd" ? "prd" : context.stage
  fs.writeFileSync(output, JSON.stringify({
    ...correlated,
    status: "completed",
    summary: context.stage + " complete",
    evidence: [{ id: artifactId, path: path.relative(project, artifact), description: "fixture" }],
    decisionIds: [],
    missingCapabilities: [],
    error: "",
  }))
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "fixture stage completed" },
  }) + "\\n")
})
`

export async function createGateCodexFixture(projectRoot: string): Promise<string> {
  const path = join(projectRoot, ".gate-codex-fixture.cjs")
  await writeFile(path, `#!${process.execPath}\n${SOURCE}`, { mode: 0o700 })
  await chmod(path, 0o700)
  return path
}

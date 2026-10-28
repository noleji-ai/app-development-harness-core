import { expect, test } from "bun:test"

import { artifactInstruction } from "../../src/execution/stage-artifacts"

test("PRD generation receives scalar and strict-key constraints from its artifact contract", () => {
  // Given the stage whose real model output previously used objects and extra metadata.
  const stage = "research-prd"
  // When its generation instruction is built.
  const instruction = artifactInstruction(stage)
  const match = instruction.match(/<artifact-json-schema>([\s\S]*?)<\/artifact-json-schema>/)
  if (match?.[1] === undefined) throw new Error("Missing machine-readable artifact schema")
  const schema: unknown = JSON.parse(match[1])
  // Then the model receives the same strict value shapes required by the validator.
  expect(schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { const: 1 },
      product: { type: "string", minLength: 3, maxLength: 4000 },
      successMetrics: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "string", minLength: 3, maxLength: 4000 },
      },
    },
  })
})

for (const stage of ["request-analysis", "design-candidates", "technology-optimization"] as const) {
  test(`${stage} receives its own structured artifact contract`, () => {
    // Given a typed artifact stage; when its model instruction is built.
    const match = artifactInstruction(stage).match(
      /<artifact-json-schema>([\s\S]*?)<\/artifact-json-schema>/,
    )
    if (match?.[1] === undefined) throw new Error("Missing machine-readable artifact schema")
    const schema: unknown = JSON.parse(match[1])
    // Then the contract prohibits extra metadata and requires correlation fields.
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["schemaVersion", "runId", "stage", "inputHash"]),
    })
  })
}

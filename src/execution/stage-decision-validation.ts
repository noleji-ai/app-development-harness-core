import type { RunManifest } from "../domain/manifest"
import type { StageResult } from "../engine/pipeline"
import { DecisionLedger } from "../state/decision-ledger"
import type { ProjectStore } from "../state/project-store"

export async function assertTrustedUnchanged(restore: () => Promise<boolean>): Promise<void> {
  if (await restore()) throw new Error("Trusted execution state changed after transport cleanup")
}

export async function validateBlockedResult(
  store: ProjectStore,
  manifest: Readonly<RunManifest>,
  result: StageResult,
): Promise<void> {
  if (result.kind !== "blocked") return
  const decisions = await new DecisionLedger(store.projectRoot).list()
  const unknown = result.decisionIds.some(
    (id) =>
      !decisions.some(
        (decision) =>
          decision.id === id &&
          decision.runId === manifest.runId &&
          decision.blocking &&
          decision.status !== "approved",
      ),
  )
  if (unknown) throw new Error("Codex referenced an unknown blocking decision")
}

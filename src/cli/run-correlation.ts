import { DecisionLedger } from "../state/decision-ledger"
import type { ProjectStore } from "../state/project-store"
import { option } from "./arguments"
import { CliUsageError } from "./contracts"

export async function assertRunCorrelation(
  store: ProjectStore,
  argv: readonly string[],
): Promise<void> {
  const runId = option(argv, "--run-id")
  if (runId === undefined) return
  const active = await store.activeRun()
  if (active.runId !== runId) throw new CliUsageError("Requested run is not the active run")
  const eventId = option(argv, "--decision-event-id")
  if (eventId !== undefined) {
    const events = await new DecisionLedger(store.projectRoot).events()
    if (!events.some((event) => event.runId === runId && event.eventHash === eventId)) {
      throw new CliUsageError("Requested decision event is not recorded for this run")
    }
  }
}

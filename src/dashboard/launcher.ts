import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { atomicWriteStateFile } from "../state/atomic-state-file"
import { DecisionLedger } from "../state/decision-ledger"
import { ProjectStore } from "../state/project-store"
import { assertSafeStateDirectory } from "../state/safe-path"
import { type DashboardServer, startDashboardServer } from "./server"
import { renderDashboardSnapshot } from "./snapshot"
import { buildDashboardViewModel } from "./view-model"

const ASSET_NAMES = ["index.html", "dashboard.css", "dashboard.js"] as const

export type LaunchedDashboard = {
  readonly url: string
  readonly snapshot: string
  readonly server: DashboardServer
}

export type DashboardLaunchOptions = {
  readonly projectRoot: string
  readonly pluginRoot: string
  readonly open: boolean
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open"
  const child = spawn(command, [url], { detached: true, shell: false, stdio: "ignore" })
  child.unref()
}

export async function launchDashboard(options: DashboardLaunchOptions): Promise<LaunchedDashboard> {
  const dashboardDirectory = join(options.projectRoot, ".app-harness", "dashboard")
  await assertSafeStateDirectory(options.projectRoot, dashboardDirectory)
  for (const name of ASSET_NAMES) {
    const contents = await readFile(join(options.pluginRoot, "assets", "dashboard", name))
    const destination = join(dashboardDirectory, name)
    await atomicWriteStateFile(options.projectRoot, destination, contents)
  }
  const ledger = new DecisionLedger(options.projectRoot)
  const store = new ProjectStore(options.projectRoot)
  const manifest = await store.reconcileDecisionEvents(await ledger.events())
  const snapshot = join(dashboardDirectory, "snapshot.html")
  await atomicWriteStateFile(
    options.projectRoot,
    snapshot,
    renderDashboardSnapshot(
      buildDashboardViewModel(await ledger.list(), new Date(), {
        ...(manifest === undefined ? {} : { manifest }),
      }),
    ),
  )
  const server = await startDashboardServer({
    assetsDirectory: dashboardDirectory,
    ledger,
    manifest: async () => {
      const active = await store.activeRun()
      return active.runId === null ? undefined : store.loadManifest(active.runId)
    },
    onDecisionSaved: async (decision) => {
      await store.reconcileDecisionEvents([decision])
    },
  })
  if (options.open) await openBrowser(server.url)
  return { url: server.url, snapshot, server }
}

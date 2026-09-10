import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { duplicateTarget } from './duplicate-driver.js'
import { DockerLifecycleAdapter } from './lifecycle-adapter.js'
import { runLifecycle, type LifecycleReport, type Scenario } from './lifecycle-driver.js'

for (const scenario of [
  'crash-recovery',
  'long-heartbeat',
] as const satisfies readonly Scenario[]) {
  test(`@${scenario} actual worker lifecycle`, async ({}, testInfo) => {
    test.setTimeout(150000)
    let report: LifecycleReport | undefined
    let destination: string | undefined
    const evidence: Record<string, unknown> = {
      scenario,
      status: 'unverified',
      scenarioStarted: false,
      liveResourcesVerified: false,
      reason: 'Lifecycle authorization or setup did not complete',
    }
    try {
      // Direct Playwright invocation uses the same gate as the Python runner.
      const boundary = verifyLiveBoundary()
      evidence.liveResourcesVerified = true
      evidence.verification = boundary
      evidence.persistenceBoundary = boundary.database
      const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
      report = {
        target: duplicateTarget(runId),
        scenario,
        status: 'running',
        scenarioStarted: false,
        cleanup: 'pending',
        restoration: 'not-needed',
        observations: [],
        events: [],
        heartbeats: [],
        operations: [],
      }
      const adapter = new DockerLifecycleAdapter(boundary, scenario)
      evidence.clockSkewMs = adapter.clockSkewMs
      test.setTimeout(
        6 * adapter.processingMs +
          5 * adapter.deliveryMs +
          2 * adapter.recoveryMs +
          Number(process.env.E2E_UPLOAD_TIMEOUT_MS) +
          180000,
      )
      const directory = process.env.E2E_RUN_ID
        ? process.env.E2E_EVIDENCE_DIR!
        : join(process.env.E2E_EVIDENCE_DIR!, runId)
      await mkdir(directory, { recursive: true })
      const file = join(directory, `${scenario}-evidence.json`)
      const initial: Record<string, unknown> = { ...evidence, ...report }
      await writeFile(file, JSON.stringify(safeDiagnostic(initial)), { flag: 'wx' })
      destination = file
      await runLifecycle(adapter, report)
    } catch {
      if (report?.status === 'running') {
        report.status = 'unverified'
        report.reason = 'Lifecycle setup or evidence creation failed before execution'
      }
      throw new Error('Lifecycle scenario did not pass; inspect the redacted run evidence')
    } finally {
      if (report) {
        Object.assign(evidence, report, { runId: report.target.runId })
        if (report.status === 'passed') delete evidence.reason
      }
      const safe = safeDiagnostic(evidence)
      if (destination) await writeFile(destination, JSON.stringify(safe, null, 2) + '\n')
      await attachSafeDiagnostic(testInfo, `${scenario}-evidence`, safe)
    }
  })
}

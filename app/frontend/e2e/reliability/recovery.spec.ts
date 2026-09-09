import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { DockerRecoveryAdapter } from './recovery-adapter.js'
import { runRecovery, targetForRun, type RecoveryReport, type Scenario } from './recovery-driver.js'

async function scenario(name: Scenario, info: Parameters<typeof attachSafeDiagnostic>[0]): Promise<void> {
  test.setTimeout(150000)
  let report: RecoveryReport | undefined, evidencePath: string | undefined
  try {
    const boundary = verifyLiveBoundary()
    const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
    const target = targetForRun(runId)
    report = { runId, scenario: name, target, status: 'running', scenarioStarted: false,
      cleanup: 'pending', restored: false, events: [], observations: [], verification: boundary }
    const directory = process.env.E2E_RUN_ID ? process.env.E2E_EVIDENCE_DIR! : join(process.env.E2E_EVIDENCE_DIR!, runId)
    await mkdir(directory, { recursive: true })
    const destination = join(directory, `${name}-evidence.json`)
    await writeFile(destination, JSON.stringify(report), { flag: 'wx' })
    evidencePath = destination
    const adapter = new DockerRecoveryAdapter(boundary)
    // Include preflight, both processing attempts, bounded cleanup, expiry observation and command overhead.
    test.setTimeout(4 * adapter.processingTimeoutMs + adapter.recoveryTimeoutMs + 360000)
    await runRecovery(name, adapter, report)
  } catch (error) {
    if (report?.status === 'running') {
      report.status = 'failed'
      report.reason = 'Recovery setup or evidence creation failed before scenario completion.'
    }
    throw error
  } finally {
    const record: Record<string, unknown> = report ? { ...report } : { scenario: name, status: 'blocked', scenarioStarted: false,
      reason: 'Live authorization did not complete.' }
    const evidence = safeDiagnostic(record)
    if (evidencePath) await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
    await attachSafeDiagnostic(info, `${name}-evidence`, evidence)
  }
}

test.describe('@crash-recovery', () => {
  test('recovers original redelivery after both expiry gates and completes publication', async ({}, info) => {
    await scenario('crash-recovery', info)
  })
})
test.describe('@long-heartbeat', () => {
  test('observes repeated successful heartbeats during a real encode with one owner', async ({}, info) => {
    await scenario('long-heartbeat', info)
  })
})

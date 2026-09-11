import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { duplicateTarget } from './duplicate-driver.js'
import { DockerPoisonIsolationAdapter } from './poison-isolation-adapter.js'
import { runPoisonIsolation, poisonIsolationReport } from './poison-isolation-driver.js'

test.describe('@poison-isolation', () => {
  test('routes malformed and unknown-job poison while a valid job completes', async ({}, testInfo) => {
    test.setTimeout(900000)
    let report: Record<string, unknown> = { scenario: 'poison-isolation', status: 'unverified', scenarioStarted: false, liveResourcesVerified: false, runId: process.env.E2E_RUN_ID }
    let destination: string | undefined
    let evidenceCreated = false
    try {
      const boundary = verifyLiveBoundary()
      const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
      const target = duplicateTarget(runId)
      destination = join(process.env.E2E_EVIDENCE_DIR!, 'poison-isolation-evidence.json')
      await mkdir(process.env.E2E_EVIDENCE_DIR!, { recursive: true })
      const adapter = new DockerPoisonIsolationAdapter(boundary)
      test.setTimeout(3 * adapter.processingMs + 2 * adapter.deliveryMs + adapter.dlqMs + Number(process.env.E2E_UPLOAD_TIMEOUT_MS) + 180000)
      const result = poisonIsolationReport(target)
      report = { ...report, liveResourcesVerified: true, runId, target, result, dlqCleanup: 'retained-for-human-cleanup' }
      await writeFile(destination, JSON.stringify(safeDiagnostic(report), null, 2) + '\n', { flag: 'wx' })
      evidenceCreated = true
      report.scenarioStarted = true
      await runPoisonIsolation(adapter, target, result)
      report.status = 'passed'
    } catch (error) {
      report = { ...report, reason: error instanceof Error ? error.message : 'Poison isolation failed' }
      throw new Error('Poison isolation did not pass; inspect redacted run evidence')
    } finally {
      const safe = safeDiagnostic(report)
      if (destination && evidenceCreated) await writeFile(destination, JSON.stringify(safe, null, 2) + '\n')
      await attachSafeDiagnostic(testInfo, 'poison-isolation-evidence', safe)
    }
  })
})

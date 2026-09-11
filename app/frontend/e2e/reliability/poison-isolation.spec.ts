import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { duplicateTarget } from './duplicate-driver.js'
import { DockerPoisonIsolationAdapter } from './poison-isolation-adapter.js'
import { runPoisonIsolation, type PoisonIsolationReport } from './poison-isolation-driver.js'

test.describe('@poison-isolation', () => {
  test('routes malformed and unknown-job poison while a valid job completes', async ({}, testInfo) => {
    test.setTimeout(900000)
    let report: Record<string, unknown> = { scenario: 'poison-isolation', status: 'unverified', scenarioStarted: false, liveResourcesVerified: false, runId: process.env.E2E_RUN_ID }
    let destination: string | undefined
    try {
      const boundary = verifyLiveBoundary()
      const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
      const target = duplicateTarget(runId)
      destination = join(process.env.E2E_EVIDENCE_DIR!, 'poison-isolation-evidence.json')
      await mkdir(process.env.E2E_EVIDENCE_DIR!, { recursive: true })
      const adapter = new DockerPoisonIsolationAdapter(boundary)
      test.setTimeout(adapter.processingMs + adapter.deliveryMs + adapter.dlqMs + 180000)
      report = { ...report, liveResourcesVerified: true, runId, target, scenarioStarted: true, phase: 'scenario' }
      const result: PoisonIsolationReport = await runPoisonIsolation(adapter, target)
      report = { ...report, ...result, status: 'passed', cleanup: 'valid-run-owned-resources-only; dlq-retained-for-human-cleanup' }
    } catch (error) {
      report = { ...report, reason: error instanceof Error ? error.message : 'Poison isolation failed' }
      throw new Error('Poison isolation did not pass; inspect redacted run evidence')
    } finally {
      const safe = safeDiagnostic(report)
      if (destination) await writeFile(destination, JSON.stringify(safe, null, 2) + '\n')
      await attachSafeDiagnostic(testInfo, 'poison-isolation-evidence', safe)
    }
  })
})

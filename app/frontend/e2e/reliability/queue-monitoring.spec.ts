import { test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { observeQueueMonitoring } from './queue-monitoring.js'

test.describe('@queue-monitoring', () => {
  test('records read-only queue metrics and alarm states correlated with failure evidence', async ({}, testInfo) => {
    test.setTimeout(900000)
    let report: Record<string, unknown> = { scenario: 'queue-monitoring', status: 'outstanding', scenarioStarted: false, liveResourcesVerified: false, runId: process.env.E2E_RUN_ID }
    const directory = process.env.E2E_EVIDENCE_DIR!
    const destination = join(directory, 'queue-monitoring-evidence.json')
    try {
      const boundary = verifyLiveBoundary()
      await mkdir(directory, { recursive: true })
      report = { ...report, liveResourcesVerified: true, scenarioStarted: true }
      const result = await observeQueueMonitoring({
        region: boundary.region, sourceQueueArn: boundary.sourceQueue, deadLetterQueueArn: boundary.deadLetterQueue,
        alarmIdentifiers: boundary.alarms, evidenceDir: directory, runId: process.env.E2E_RUN_ID!, timeoutMs: 300000,
      })
      report = { ...report, ...result }
      await writeFile(destination, JSON.stringify(safeDiagnostic(report), null, 2) + '\n', { flag: 'wx' })
    } catch (error) {
      report = { ...report, reason: error instanceof Error ? error.message : 'queue monitoring failed' }
      throw new Error('Queue monitoring did not complete; inspect redacted run evidence')
    } finally {
      await attachSafeDiagnostic(testInfo, 'queue-monitoring-evidence', safeDiagnostic(report))
    }
  })
})


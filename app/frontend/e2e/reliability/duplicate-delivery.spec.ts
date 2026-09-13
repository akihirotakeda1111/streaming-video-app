import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { DockerDuplicateAdapter } from './duplicate-adapter.js'
import { duplicateTarget, runDuplicate, type DuplicateReport } from './duplicate-driver.js'

test.describe('@duplicate-delivery', () => {
  test('active and completed redelivery do not repeat media processing', async ({}, testInfo) => {
    test.setTimeout(150000)
    let report: DuplicateReport | undefined
    let destination: string | undefined
    const evidence: Record<string, unknown> = {
      scenario: 'duplicate-delivery',
      runId: process.env.E2E_RUN_ID,
      status: 'unverified',
      scenarioStarted: false,
      liveResourcesVerified: false,
      reason: 'Live authorization did not complete.',
      timestamps: [new Date().toISOString()],
    }
    try {
      // Direct Playwright selection performs the same verification before any mutation.
      const boundary = verifyLiveBoundary()
      evidence.liveResourcesVerified = true
      evidence.verification = boundary
      evidence.persistenceBoundary = boundary.database
      const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
      const target = duplicateTarget(runId)
      report = {
        target,
        status: 'running',
        scenarioStarted: false,
        cleanup: 'pending',
        messages: {},
        events: [],
        observations: [],
      }
      const directory = process.env.E2E_RUN_ID
        ? process.env.E2E_EVIDENCE_DIR!
        : join(process.env.E2E_EVIDENCE_DIR!, runId)
      await mkdir(directory, { recursive: true })
      const file = join(directory, 'duplicate-delivery-evidence.json')
      const initial: Record<string, unknown> = { ...report }
      await writeFile(file, JSON.stringify(safeDiagnostic(initial)), { flag: 'wx' })
      destination = file
      const adapter = new DockerDuplicateAdapter(boundary)
      test.setTimeout(
        4 * adapter.processingMs +
          3 * adapter.deliveryMs +
          Number(process.env.E2E_UPLOAD_TIMEOUT_MS) +
          150000,
      )
      await runDuplicate(adapter, report)
    } catch {
      if (report?.status === 'running') {
        report.status = 'unverified'
        report.reason = 'Duplicate setup or evidence creation failed before execution'
      }
      throw new Error('Duplicate delivery did not pass; inspect the redacted run evidence')
    } finally {
      if (report) {
        Object.assign(evidence, report, { runId: report.target.runId })
        delete evidence.reason
        if (report.reason) evidence.reason = report.reason
      }
      const safe = safeDiagnostic(evidence)
      if (destination) await writeFile(destination, JSON.stringify(safe, null, 2) + '\n')
      await attachSafeDiagnostic(testInfo, 'duplicate-delivery-evidence', safe)
    }
  })
})

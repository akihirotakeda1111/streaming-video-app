import { test } from '@playwright/test'
import { assertReliabilityAuthorization } from '../config.js'
import { attachSafeDiagnostic } from '../diagnostics.js'

test.describe('@duplicate-delivery', () => {
  test('requires correlated duplicate observation before creating resources', async ({}, testInfo) => {
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
      // Direct Playwright selection must retain the same live authorization gate.
      assertReliabilityAuthorization()
      evidence.liveResourcesVerified = true
      // The existing deleted log has no job/message ID; nearby log records are
      // not a reliable correlation under concurrent processing. Spec 43 requires
      // stopping before mutation when safe observation is unavailable.
      evidence.reason = 'Duplicate delivery is unverified: correlated acknowledgement, '
        + 'encode/publication observations and run-scoped remote cleanup are not implemented.'
      throw new Error(String(evidence.reason))
    } finally {
      await attachSafeDiagnostic(testInfo, 'duplicate-delivery-evidence', evidence)
    }
  })
})

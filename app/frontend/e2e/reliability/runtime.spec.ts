import { test } from '@playwright/test'
import { assertReliabilityAuthorization } from '../config.js'
import { attachSafeDiagnostic } from '../diagnostics.js'

test.describe('@reliability', () => {
  test('requires explicit disposable runtime authorization', async ({}, testInfo) => {
    try {
      assertReliabilityAuthorization()
    } catch (error) {
      await attachSafeDiagnostic(testInfo, 'reliability-preflight-blocked', {
        status: 2,
        message: error instanceof Error ? error.message : 'live preflight blocked',
        liveResourcesVerified: false,
        scenarioStarted: false,
      })
      throw error
    }
  })
})

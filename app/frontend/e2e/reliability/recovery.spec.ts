import { test } from '@playwright/test'
import { assertReliabilityAuthorization } from '../config.js'
import { attachSafeDiagnostic } from '../diagnostics.js'

/**
 * The selectors are intentionally gated until the task-owned adapters are present.
 * Keeping the entry points explicit prevents discovery, type-checking, and helper
 * runs from ever stopping a worker or submitting a live encode.
 */
async function blockedScenario(
  scenario: 'crash-recovery' | 'long-heartbeat',
  testInfo: Parameters<typeof attachSafeDiagnostic>[0],
): Promise<never> {
  const evidence: Record<string, unknown> = {
    scenario,
    status: 'blocked',
    scenarioStarted: false,
    liveResourcesVerified: false,
    reason: 'Scoped worker-control, queue-observation, database-observation, and cleanup adapters are not implemented.',
    timestamps: [new Date().toISOString()],
  }
  try {
    assertReliabilityAuthorization()
    evidence.liveResourcesVerified = true
    throw new Error(String(evidence.reason))
  } finally {
    await attachSafeDiagnostic(testInfo, `${scenario}-evidence`, evidence)
  }
}

test.describe('@crash-recovery', () => {
  test('requires correlated crash recovery adapters before mutating a disposable target', async ({}, testInfo) => {
    await blockedScenario('crash-recovery', testInfo)
  })
})

test.describe('@long-heartbeat', () => {
  test('requires correlated heartbeat observation adapters before starting an encode', async ({}, testInfo) => {
    await blockedScenario('long-heartbeat', testInfo)
  })
})

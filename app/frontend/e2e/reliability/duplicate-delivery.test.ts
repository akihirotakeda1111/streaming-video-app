import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  authorize: vi.fn(),
  attach: vi.fn(),
  run: undefined as undefined | ((fixtures: object, info: object) => Promise<void>),
}))

// Execute the actual registered scenario, replacing only its external boundaries.
vi.mock('@playwright/test', () => ({
  test: Object.assign(
    (_name: string, run: typeof boundary.run) => { boundary.run = run },
    { describe: (_name: string, register: () => void) => register() },
  ),
}))
vi.mock('../config.js', () => ({ assertReliabilityAuthorization: boundary.authorize }))
vi.mock('../diagnostics.js', () => ({ attachSafeDiagnostic: boundary.attach }))
import './duplicate-delivery.spec.js'

describe('duplicate delivery prerequisite', () => {
  beforeEach(() => {
    boundary.authorize.mockReset()
    boundary.attach.mockReset().mockResolvedValue(undefined)
  })

  it('fails even after successful authorization, without using browser or API fixtures', async () => {
    boundary.authorize.mockReturnValue({})
    const fixtures = new Proxy({}, { get() { throw new Error('must not access live fixtures') } })
    await expect(boundary.run!(fixtures, {})).rejects.toThrow('Duplicate delivery is unverified')
    expect(boundary.authorize).toHaveBeenCalledOnce()
    expect(boundary.attach).toHaveBeenCalledWith({}, 'duplicate-delivery-evidence', expect.objectContaining({
      status: 'unverified', scenarioStarted: false, liveResourcesVerified: true,
    }))
  })

  it('preserves authorization failure and records no successful live verification', async () => {
    const failure = new Error('authorization refused')
    boundary.authorize.mockImplementation(() => { throw failure })
    await expect(boundary.run!({}, {})).rejects.toBe(failure)
    expect(boundary.attach).toHaveBeenCalledWith({}, 'duplicate-delivery-evidence', expect.objectContaining({
      status: 'unverified', scenarioStarted: false, liveResourcesVerified: false,
      reason: 'Live authorization did not complete.',
    }))
  })
})

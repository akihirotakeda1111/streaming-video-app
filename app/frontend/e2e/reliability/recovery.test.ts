import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  authorize: vi.fn(), attach: vi.fn(), suite: '',
  runs: new Map<string, (fixtures: object, info: object) => Promise<void>>(),
}))
vi.mock('@playwright/test', () => ({
  test: Object.assign(
    (_name: string, run: (fixtures: object, info: object) => Promise<void>) => {
      boundary.runs.set(boundary.suite, run)
    },
    { describe: (name: string, register: () => void) => { boundary.suite = name; register() } },
  ),
}))
vi.mock('../config.js', () => ({ assertReliabilityAuthorization: boundary.authorize }))
vi.mock('../diagnostics.js', () => ({ attachSafeDiagnostic: boundary.attach }))
import './recovery.spec.js'

describe('blocked recovery entry points', () => {
  beforeEach(() => {
    boundary.authorize.mockReset()
    boundary.attach.mockReset().mockResolvedValue(undefined)
  })

  it.each(['crash-recovery', 'long-heartbeat'])('keeps authorized %s blocked without live fixtures', async (scenario) => {
    const fixtures = new Proxy({}, { get() { throw new Error('must not access live fixtures') } })
    await expect(boundary.runs.get(`@${scenario}`)!(fixtures, {})).rejects.toThrow('adapters are not implemented')
    expect(boundary.authorize).toHaveBeenCalledOnce()
    expect(boundary.attach).toHaveBeenCalledWith({}, `${scenario}-evidence`, expect.objectContaining({
      scenario, status: 'blocked', scenarioStarted: false, liveResourcesVerified: true,
    }))
  })

  it.each(['crash-recovery', 'long-heartbeat'])('preserves authorization failure for %s', async (scenario) => {
    const failure = new Error('authorization refused')
    boundary.authorize.mockImplementation(() => { throw failure })
    await expect(boundary.runs.get(`@${scenario}`)!({}, {})).rejects.toBe(failure)
    expect(boundary.attach).toHaveBeenCalledWith({}, `${scenario}-evidence`, expect.objectContaining({
      scenario, status: 'blocked', scenarioStarted: false, liveResourcesVerified: false,
      reason: 'Live authorization did not complete.',
    }))
  })
})

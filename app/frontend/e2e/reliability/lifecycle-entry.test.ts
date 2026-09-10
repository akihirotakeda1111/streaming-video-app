import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  authorize: vi.fn(),
  attach: vi.fn(),
  run: vi.fn(),
  create: vi.fn(),
  registered: new Map<string, (fixtures: object, info: object) => Promise<void>>(),
}))
vi.mock('@playwright/test', () => ({
  test: Object.assign(
    (name: string, run: (fixtures: object, info: object) => Promise<void>) => {
      state.registered.set(name, run)
    },
    { setTimeout: vi.fn() },
  ),
}))
vi.mock('./safety.mjs', () => ({ verifyLiveBoundary: state.authorize }))
vi.mock('../diagnostics.js', () => ({
  attachSafeDiagnostic: state.attach,
  safeDiagnostic: (v: unknown) => v,
}))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
vi.mock('./lifecycle-adapter.js', () => ({
  DockerLifecycleAdapter: class {
    processingMs = 1000
    deliveryMs = 1000
    recoveryMs = 1000
    clockSkewMs = 10
    constructor(...args: unknown[]) {
      state.create(...args)
    }
  },
}))
vi.mock('./lifecycle-driver.js', () => ({ runLifecycle: state.run }))
import './lifecycle.spec.js'

describe('independent gated lifecycle entry points', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.authorize.mockReset()
    state.run.mockReset()
    vi.stubEnv('E2E_EVIDENCE_DIR', '/unused')
    vi.stubEnv('E2E_UPLOAD_TIMEOUT_MS', '1000')
    vi.stubEnv('E2E_RUN_ID', '')
  })
  afterEach(() => vi.unstubAllEnvs())
  it('registers exactly the two dedicated tags without live authorization at discovery', () => {
    expect([...state.registered.keys()]).toEqual([
      '@crash-recovery actual worker lifecycle',
      '@long-heartbeat actual worker lifecycle',
    ])
    expect(state.authorize).not.toHaveBeenCalled()
  })
  it.each(['crash-recovery', 'long-heartbeat'])(
    'blocks direct %s invocation before constructing an adapter',
    async (scenario) => {
      state.authorize.mockImplementation(() => {
        throw new Error('private-authorization-details')
      })
      await expect(
        state.registered.get(`@${scenario} actual worker lifecycle`)!({}, {}),
      ).rejects.toThrow('did not pass')
      expect(state.create).not.toHaveBeenCalled()
      expect(state.run).not.toHaveBeenCalled()
      expect(state.attach).toHaveBeenCalledWith(
        {},
        `${scenario}-evidence`,
        expect.objectContaining({
          status: 'unverified',
          liveResourcesVerified: false,
          scenarioStarted: false,
        }),
      )
      expect(JSON.stringify(state.attach.mock.calls)).not.toContain('private-authorization-details')
    },
  )
  it.each(['crash-recovery', 'long-heartbeat'])(
    'dispatches only %s after authorization and records completion',
    async (scenario) => {
      state.authorize.mockReturnValue({ status: 'verified' })
      state.run.mockImplementation(async (_adapter, report) => {
        report.status = 'passed'
        report.scenarioStarted = true
        report.cleanup = 'complete'
      })
      await state.registered.get(`@${scenario} actual worker lifecycle`)!({}, {})
      expect(state.create).toHaveBeenCalledWith({ status: 'verified' }, scenario)
      expect(state.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scenario }),
      )
      expect(state.attach).toHaveBeenCalledWith(
        {},
        `${scenario}-evidence`,
        expect.objectContaining({
          status: 'passed',
          liveResourcesVerified: true,
          scenarioStarted: true,
        }),
      )
    },
  )
  it('preserves failed restoration and retained resources as unverified', async () => {
    state.authorize.mockReturnValue({ status: 'verified' })
    state.run.mockImplementation(async (_adapter, report) => {
      Object.assign(report, {
        status: 'unverified',
        restoration: 'failed',
        cleanup: 'retained',
        reason: 'Worker restoration failed',
      })
      throw new Error('failure')
    })
    await expect(
      state.registered.get('@crash-recovery actual worker lifecycle')!({}, {}),
    ).rejects.toThrow('did not pass')
    expect(state.attach).toHaveBeenCalledWith(
      {},
      'crash-recovery-evidence',
      expect.objectContaining({ status: 'unverified', restoration: 'failed', cleanup: 'retained' }),
    )
  })
})

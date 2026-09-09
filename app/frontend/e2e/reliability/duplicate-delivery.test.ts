import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({
  authorize: vi.fn(),
  attach: vi.fn(),
  run: vi.fn(),
  registered: undefined as undefined | ((fixtures: object, info: object) => Promise<void>),
}))
vi.mock('@playwright/test', () => ({
  test: Object.assign(
    (_name: string, run: typeof boundary.registered) => {
      boundary.registered = run
    },
    { describe: (_name: string, register: () => void) => register(), setTimeout: vi.fn() },
  ),
}))
vi.mock('./safety.mjs', () => ({ verifyLiveBoundary: boundary.authorize }))
vi.mock('../diagnostics.js', () => ({
  attachSafeDiagnostic: boundary.attach,
  safeDiagnostic: (v: unknown) => v,
}))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
vi.mock('./duplicate-adapter.js', () => ({
  DockerDuplicateAdapter: class {
    processingMs = 1000
    deliveryMs = 1000
  },
}))
vi.mock('./duplicate-driver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runDuplicate: boundary.run,
}))
import './duplicate-delivery.spec.js'

describe('duplicate entry point', () => {
  beforeEach(() => {
    boundary.authorize.mockReset()
    boundary.run.mockReset()
    boundary.attach.mockReset()
    vi.stubEnv('E2E_EVIDENCE_DIR', '/unused')
    vi.stubEnv('E2E_UPLOAD_TIMEOUT_MS', '1000')
  })
  afterEach(() => vi.unstubAllEnvs())
  it('refuses before scenario execution when authorization fails', async () => {
    boundary.authorize.mockImplementation(() => {
      throw new Error('private-authorization-error')
    })
    await expect(boundary.registered!({}, {})).rejects.toThrow('did not pass')
    expect(boundary.run).not.toHaveBeenCalled()
    expect(boundary.attach).toHaveBeenCalledWith(
      {},
      'duplicate-delivery-evidence',
      expect.objectContaining({
        status: 'unverified',
        scenarioStarted: false,
        liveResourcesVerified: false,
      }),
    )
    expect(JSON.stringify(boundary.attach.mock.calls)).not.toContain('private-authorization-error')
  })
  it('dispatches after authorization and records a completed run', async () => {
    boundary.authorize.mockReturnValue({ status: 'verified' })
    boundary.run.mockImplementation(async (_adapter, report) => {
      report.status = 'passed'
      report.scenarioStarted = true
      report.cleanup = 'complete'
    })
    await boundary.registered!(
      new Proxy(
        {},
        {
          get() {
            throw new Error('unexpected browser access')
          },
        },
      ),
      {},
    )
    expect(boundary.run).toHaveBeenCalledOnce()
    expect(boundary.attach).toHaveBeenCalledWith(
      {},
      'duplicate-delivery-evidence',
      expect.objectContaining({
        status: 'passed',
        cleanup: 'complete',
        liveResourcesVerified: true,
      }),
    )
  })
  it('propagates scenario failure and resource retention', async () => {
    boundary.authorize.mockReturnValue({ status: 'verified' })
    boundary.run.mockImplementation(async (_adapter, report) => {
      report.status = 'unverified'
      report.cleanup = 'retained'
      report.reason = 'pending messages'
      throw new Error('pending messages')
    })
    await expect(boundary.registered!({}, {})).rejects.toThrow('did not pass')
    expect(boundary.attach).toHaveBeenCalledWith(
      {},
      'duplicate-delivery-evidence',
      expect.objectContaining({
        status: 'unverified',
        cleanup: 'retained',
        reason: 'pending messages',
      }),
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({
  authorize: vi.fn(), attach: vi.fn(), run: vi.fn(), suite: '',
  runs: new Map<string, (fixtures: object, info: object) => Promise<void>>(),
}))
vi.mock('@playwright/test', () => ({ test: Object.assign(
  (_name: string, run: (fixtures: object, info: object) => Promise<void>) => boundary.runs.set(boundary.suite, run),
  { describe: (name: string, register: () => void) => { boundary.suite = name; register() }, setTimeout: vi.fn() },
) }))
vi.mock('./safety.mjs', () => ({ verifyLiveBoundary: boundary.authorize }))
vi.mock('../diagnostics.js', () => ({ attachSafeDiagnostic: boundary.attach, safeDiagnostic: (v: unknown) => v }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
vi.mock('./recovery-adapter.js', () => ({ DockerRecoveryAdapter: class { processingTimeoutMs = 1000; recoveryTimeoutMs = 2000 } }))
vi.mock('./recovery-driver.js', async (importOriginal) => ({ ...await importOriginal<object>(), runRecovery: boundary.run }))
import './recovery.spec.js'

describe('recovery entry authorization', () => {
  beforeEach(() => { boundary.authorize.mockReset(); boundary.run.mockReset(); boundary.attach.mockReset(); vi.stubEnv('E2E_EVIDENCE_DIR', '/unused') })
  it.each(['crash-recovery', 'long-heartbeat'])('refuses %s before execution when authorization fails', async name => {
    const failure = new Error('authorization refused')
    boundary.authorize.mockImplementation(() => { throw failure })
    await expect(boundary.runs.get(`@${name}`)!({}, {})).rejects.toBe(failure)
    expect(boundary.run).not.toHaveBeenCalled()
    expect(boundary.attach).toHaveBeenCalledWith({}, `${name}-evidence`, expect.objectContaining({ status: 'blocked', scenarioStarted: false }))
  })
  it.each(['crash-recovery', 'long-heartbeat'])('dispatches authorized %s without browser fixtures', async name => {
    boundary.authorize.mockReturnValue({})
    await boundary.runs.get(`@${name}`)!(new Proxy({}, { get() { throw new Error('live fixture accessed') } }), {})
    expect(boundary.run).toHaveBeenCalledWith(name, expect.anything(), expect.objectContaining({ scenario: name }))
  })
})

import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  run: undefined as any,
  writes: [] as string[],
  attachment: undefined as any,
  cleanupFails: false,
}))
vi.mock('@playwright/test', () => {
  const test = Object.assign(
    (_name: string, run: any) => {
      state.run = run
    },
    { describe: (_name: string, run: () => void) => run(), setTimeout: vi.fn() },
  )
  return { test }
})
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: async (_path: string, data: string) => {
    state.writes.push(data)
  },
}))
vi.mock('./safety.mjs', () => ({ verifyLiveBoundary: () => ({ status: 'verified' }) }))
vi.mock('./ffmpeg-exhaustion-adapter.js', () => ({
  DockerFfmpegExhaustionAdapter: class {
    exhaustionMs = 5000
    stabilityMs = 2000
    processingMs = 1000
    observe = async () => ({ job: { status: 'FAILED' }, events: [], dlq: [] })
    cleanup = async () => {
      throw new Error('cleanup failed')
    }
  },
}))
vi.mock('./ffmpeg-exhaustion-driver.js', () => ({
  runFfmpegExhaustion: async (adapter: any) => {
    await adapter.observe()
    if (!state.cleanupFails) throw new Error('observation failed')
  },
}))
import './ffmpeg-exhaustion.spec.js'

it.each([false, true])(
  'retains IDs, observations and started state on failure (cleanup=%s)',
  async (cleanupFails) => {
    state.cleanupFails = cleanupFails
    state.writes = []
    vi.stubEnv('E2E_EVIDENCE_DIR', '/run-evidence')
    vi.stubEnv('E2E_RUN_ID', 'e2e-11111111-1111-4111-8111-111111111111')
    vi.stubEnv('E2E_UPLOAD_TIMEOUT_MS', '1000')
    try {
      await expect(
        state.run(
          {},
          {
            attach: async (_name: string, attachment: any) => {
              state.attachment = JSON.parse(attachment.body.toString())
            },
          },
        ),
      ).rejects.toThrow('did not pass')
      const report = JSON.parse(state.writes.at(-1)!)
      expect(report.target.jobId).toBeTruthy()
      expect(report.snapshots).toHaveLength(1)
      expect(report.scenarioStarted).toBe(true)
      expect(report.phase).toBe(cleanupFails ? 'cleanup' : 'scenario')
      expect(report.reason).toBe(cleanupFails ? 'cleanup failed' : 'observation failed')
      expect(state.attachment).toEqual(report)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

import { describe, expect, it, vi } from 'vitest'
import { duplicateTarget, type DuplicateEvent } from './duplicate-driver.js'
import {
  runLifecycle,
  type LifecycleAdapter,
  type LifecycleReport,
  type LifecycleSnapshot,
  type Scenario,
} from './lifecycle-driver.js'
import type { HeartbeatObservation } from './lifecycle.js'
import { safeDiagnostic } from '../diagnostics.js'

const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
const event = (outcome: string, at: number, replacement = false): DuplicateEvent => ({
  outcome,
  at,
  workerId: replacement ? 'replacement' : 'original-owner',
  attempt: replacement ? 2 : 1,
  messageId: 'original-message',
  deliveryId: replacement ? 'delivery-2' : 'delivery-1',
})
function fixture(scenario: Scenario = 'crash-recovery') {
  let time = 1000,
    reads = 0,
    stopped = false,
    restarted = false,
    lease = 5000,
    restartAt = 0
  const original = ['acquired', 'download_started', 'source_downloaded', 'encode_started'].map(
    (o, i) => event(o, 900 + i),
  )
  const heartbeat = (cycle: number): HeartbeatObservation => ({
    outcome: 'heartbeat_succeeded',
    workerId: 'original-owner',
    attempt: 1,
    messageId: 'original-message',
    deliveryId: 'delivery-1',
    cycle,
    at: 1000 + cycle * 200,
    startedAtMs: 990 + cycle * 200,
    visibilityObservedAtMs: 1000 + cycle * 200,
    leaseExpiresAtMs: 4990 + cycle * 200,
    visibilityExpiresAtMs: 4990 + cycle * 200,
  })
  const adapter: LifecycleAdapter = {
    clockSkewMs: 10,
    heartbeatMs: 100,
    leaseMs: 4000,
    visibilityMs: 4000,
    maximumVisibilityMs: 4000,
    recoveryMs: 10000,
    processingMs: 5000,
    deliveryMs: 5000,
    attempts: 3,
    prepare: vi.fn(),
    upload: vi.fn(),
    verifyOutput: vi.fn(),
    cleanup: vi.fn(),
    stop: vi.fn(async () => {
      stopped = true
      return time
    }),
    restore: vi.fn(async () => {
      if (stopped) {
        stopped = false
        restarted = true
        restartAt = time
      }
    }),
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    observe: vi.fn(async (): Promise<LifecycleSnapshot> => {
      time += 100
      reads++
      if (!stopped && !restarted) lease = time + 4000
      const done = restarted || (scenario === 'long-heartbeat' && reads > 3)
      const heartbeats = [heartbeat(1), heartbeat(2)].slice(0, Math.max(0, Math.min(reads - 1, 2)))
      const events = [...original]
      if (done) {
        if (restarted)
          events.push(
            ...['acquired', 'download_started', 'source_downloaded', 'encode_started'].map((o, i) =>
              event(o, restartAt + 20 + i, true),
            ),
          )
        events.push(
          ...[
            'encode_finished',
            'segment_upload_started',
            'segment_published',
            'manifest_upload_started',
            'manifest_published',
            'completed',
            'deleted',
          ].map((o, i) => event(o, time - 20 + i, restarted)),
        )
      }
      return {
        job: {
          status: done ? 'COMPLETED' : 'PROCESSING',
          attempt: restarted ? 2 : 1,
          workerId: done ? null : 'original-owner',
          leaseMs: done ? null : lease,
          observedAtMs: time,
          updatedAtMs: time,
        },
        events,
        heartbeats,
        operations: heartbeats.flatMap((h) =>
          (['lease_renewal', 'visibility_extension'] as const).map((operation) => ({
            operation,
            messageId: h.messageId,
            deliveryId: h.deliveryId,
            cycle: h.cycle,
            startedAtMs: h.startedAtMs,
            observedAtMs: h.at,
            durationMs: 4000,
          })),
        ),
        localBeforeMs: time,
        localAfterMs: time,
      }
    }),
  }
  const report: LifecycleReport = {
    target,
    scenario,
    status: 'running',
    cleanup: 'pending',
    restoration: 'not-needed',
    scenarioStarted: false,
    events: [],
    heartbeats: [],
    operations: [],
    observations: [],
  }
  return { adapter, report }
}
describe('lifecycle execution with fake boundaries', () => {
  it('preserves database time and expiry evidence through redaction', async () => {
    const f = fixture()
    await runLifecycle(f.adapter, f.report)
    const record: Record<string, unknown> = {
      ...f.report,
      database_url: 'private',
      receipt_handle: 'private',
    }
    const safe = safeDiagnostic(record)
    expect(safe.observations).toEqual(f.report.observations)
    expect(safe.bounds).toEqual(f.report.bounds)
    expect(JSON.stringify(safe)).not.toContain('private')
  })
  it.each(['crash-recovery', 'long-heartbeat'] as const)(
    'runs %s and checks canonical publication',
    async (scenario) => {
      const f = fixture(scenario)
      await runLifecycle(f.adapter, f.report)
      expect(f.report.status).toBe('passed')
      expect(f.report.cleanup).toBe('complete')
      expect(f.adapter.verifyOutput).toHaveBeenCalledWith([
        target.prefix + 'hls/segment-00000.ts',
        target.prefix + 'hls/index.m3u8',
      ])
      expect(f.adapter.stop).toHaveBeenCalledTimes(scenario === 'crash-recovery' ? 1 : 0)
      if (scenario === 'crash-recovery') {
        expect(f.report.restartRequestedAtMs).toBeGreaterThanOrEqual(f.report.recoveryAfterMs!)
        expect(f.report.restoration).toBe('complete')
      }
    },
  )
  it('crashes after one renewal without waiting for repeated heartbeat cycles', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    f.adapter.observe = async () => {
      const s = await observe()
      s.heartbeats = s.heartbeats.slice(0, 1)
      s.operations = s.operations.filter((op) => op.cycle === 1)
      return s
    }
    await runLifecycle(f.adapter, f.report)
    expect(f.report.status).toBe('passed')
    expect(f.report.stoppedAtMs).toBeLessThan(1800)
  })
  it('still requires repeated renewals for long heartbeat', async () => {
    const f = fixture('long-heartbeat')
    const observe = f.adapter.observe
    f.adapter.observe = async () => {
      const s = await observe()
      s.heartbeats = s.heartbeats.slice(0, 1)
      return s
    }
    await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow('repeated renewals')
    expect(f.adapter.stop).not.toHaveBeenCalled()
  })
  it.each(['encode readiness', 'lease and visibility expiry', 'completion and acknowledgement'])(
    'identifies the %s timeout and restores the worker',
    async (phase) => {
      const f = fixture()
      const observe = f.adapter.observe
      if (phase === 'encode readiness') f.adapter.processingMs = 1
      if (phase === 'lease and visibility expiry') f.adapter.recoveryMs = 1
      if (phase === 'completion and acknowledgement') {
        f.adapter.observe = async () => {
          const s = await observe()
          if (s.job.attempt === 2) {
            s.job.status = 'PROCESSING'
            s.events = s.events.filter((e) => e.outcome !== 'deleted')
          }
          return s
        }
      }
      await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow(
        `Lifecycle ${phase} timed out after`,
      )
      expect(f.adapter.restore).toHaveBeenCalled()
      expect(f.report.status).toBe('unverified')
    },
  )
  it('never injects a final-attempt crash', async () => {
    const f = fixture()
    f.adapter.attempts = 1
    await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow('remaining attempt')
    expect(f.adapter.upload).not.toHaveBeenCalled()
    expect(f.adapter.stop).not.toHaveBeenCalled()
  })
  it.each(['short', 'failure', 'stale-db', 'extra-owner', 'no-heartbeat'])(
    'refuses %s evidence before stopping',
    async (mode) => {
      const f = fixture()
      const observe = f.adapter.observe
      f.adapter.observe = async () => {
        const s = await observe()
        if (mode === 'short') s.job.status = 'COMPLETED'
        if (mode === 'failure') s.events.push(event('ownership_lost', 1000))
        if (mode === 'stale-db') s.job.leaseMs = 10000
        if (mode === 'extra-owner') s.events.push(event('acquired', 1000, true))
        if (mode === 'no-heartbeat') s.heartbeats = []
        return s
      }
      await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow()
      expect(f.adapter.stop).not.toHaveBeenCalled()
      expect(f.report.status).toBe('unverified')
    },
  )
  it('restores after an uncertain stop and retains resources when restoration fails', async () => {
    const f = fixture()
    vi.mocked(f.adapter.stop).mockRejectedValue(new Error('Stop response unavailable'))
    vi.mocked(f.adapter.restore).mockRejectedValue(new Error('Start failed'))
    await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow('restoration failed')
    expect(f.adapter.restore).toHaveBeenCalled()
    expect(f.adapter.cleanup).not.toHaveBeenCalled()
    expect(f.report.restoration).toBe('failed')
    expect(f.report.cleanup).toBe('retained')
  })
  it('restores even when observation fails after stop', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    f.adapter.observe = async () => {
      if (vi.mocked(f.adapter.stop).mock.calls.length) throw new Error('Observation unavailable')
      return observe()
    }
    await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow('Observation unavailable')
    expect(f.adapter.restore).toHaveBeenCalled()
    expect(f.report.restoration).toBe('complete')
  })
  it('fails if interrupted processing actually completed before the stop', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    f.adapter.observe = async () => {
      const s = await observe()
      if (vi.mocked(f.adapter.stop).mock.calls.length) s.events.push(event('completed', 1900))
      return s
    }
    await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow()
    expect(f.report.status).toBe('unverified')
    expect(f.adapter.restore).toHaveBeenCalled()
  })
  it.each(['ownership_lost', 'new-message', 'early-acquisition', 'manifest-first'])(
    'rejects final %s evidence',
    async (mode) => {
      const f = fixture()
      const observe = f.adapter.observe
      f.adapter.observe = async () => {
        const s = await observe()
        if (s.job.status === 'COMPLETED') {
          if (mode === 'ownership_lost') s.events.push(event('ownership_lost', 9999, true))
          if (mode === 'new-message')
            s.events.find((e) => e.outcome === 'acquired' && e.attempt === 2)!.messageId = 'other'
          if (mode === 'early-acquisition')
            s.events.find((e) => e.outcome === 'acquired' && e.attempt === 2)!.at = 1000
          if (mode === 'manifest-first')
            s.events.find((e) => e.outcome === 'segment_upload_started')!.outcome =
              'manifest_upload_started'
        }
        return s
      }
      await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow()
      expect(f.report.status).toBe('unverified')
    },
  )
  it('does not report success if scoped cleanup fails', async () => {
    const f = fixture('long-heartbeat')
    vi.mocked(f.adapter.cleanup).mockRejectedValue(new Error('Pending work'))
    await expect(runLifecycle(f.adapter, f.report)).rejects.toThrow('retained')
    expect(f.report.cleanup).toBe('retained')
  })
})

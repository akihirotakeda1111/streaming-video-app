import { describe, expect, it, vi } from 'vitest'
import { duplicateTarget, type DuplicateJob } from './duplicate-driver.js'
import { poisonIsolationReport, runPoisonIsolation, type PoisonIsolationAdapter } from './poison-isolation-driver.js'
import { DockerPoisonIsolationAdapter } from './poison-isolation-adapter.js'
import type { PoisonDlqCorrelation } from './dlq-correlation.js'

const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
const poison: PoisonDlqCorrelation[] = [
  { messageId: 'malformed', kind: 'malformed', bodySha256: 'a'.repeat(64), receivedAt: '2026-09-11T00:00:00Z' },
  { messageId: 'unknown', kind: 'unknown-job', bodySha256: 'b'.repeat(64), receivedAt: '2026-09-11T00:00:01Z', canonicalIds: { videoId: target.videoId, jobId: target.jobId } },
]
function snapshot(job: Partial<DuplicateJob> = {}, messages = poison) {
  return { job: { status: 'COMPLETED', attempt: 1, workerId: null, leaseMs: null, observedAtMs: 1, updatedAtMs: 1, ...job }, poison: messages, events: [] as Array<{ at: number; outcome: string; messageId: string; deliveryId: string }> }
}
function fixture(snapshots = [snapshot()]) {
  let time = 0, index = 0
  const adapter = {
    processingMs: 1000, deliveryMs: 1000, dlqMs: 1000,
    prepare: vi.fn(async () => {}), sendPoison: vi.fn(), upload: vi.fn(async () => {}),
    poisonIdentities: vi.fn(() => poison.map(({ receivedAt, ...identity }) => ({ ...identity, sentAt: receivedAt }))),
    observeWithPoison: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!),
    unknownJobCount: vi.fn(() => 0), cleanup: vi.fn(async () => {}),
    now: () => time, sleep: async (ms: number) => { time += ms },
  } satisfies PoisonIsolationAdapter
  return { adapter, report: poisonIsolationReport(target) }
}

describe('poison isolation driver', () => {
  it('allows initial zero attempts and retains split, empty and repeated receives', async () => {
    const { adapter, report } = fixture([
      snapshot({ status: 'UPLOADING', attempt: 0 }, [poison[0]!]),
      snapshot({ status: 'QUEUED', attempt: 0 }, []),
      snapshot({ status: 'PROCESSING', workerId: 'worker', leaseMs: 100 }, [poison[0]!]),
      snapshot({}, [poison[1]!]),
    ])
    await runPoisonIsolation(adapter, target, report)
    expect(report.poison).toEqual(poison)
    expect(report.observations.map((s) => s.poisonCount)).toEqual([1, 1, 1, 2])
    expect(report.cleanup).toBe('complete')
    expect(adapter.cleanup).toHaveBeenCalledTimes(1)
  })

  it.each(['processing_error', 'retry_released', 'ownership_lost'])('rejects %s even when completion conditions match', async (outcome) => {
    const s = snapshot()
    s.events.push({ at: 1, outcome, messageId: 'valid', deliveryId: 'delivery' })
    const { adapter, report } = fixture([s])
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('affected the valid job')
    expect(adapter.cleanup).toHaveBeenCalledOnce()
  })

  it.each([snapshot({ attempt: 2 }), snapshot({ status: 'FAILED' }), snapshot({ attempt: 0 })])('rejects invalid attempts and terminal states', async (s) => {
    const { adapter, report } = fixture([s])
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('affected the valid job')
  })

  it('rejects a return to zero after acquisition', async () => {
    const { adapter, report } = fixture([snapshot({ status: 'PROCESSING' }, []), snapshot({ status: 'QUEUED', attempt: 0 })])
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('affected the valid job')
  })

  it('retains evidence on timeout and preserves the original error when cleanup refuses', async () => {
    const { adapter, report } = fixture([snapshot({}, [poison[0]!])])
    adapter.cleanup.mockRejectedValue(new Error('Uncertain remote mutation; manual inspection required'))
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('bounded wait')
    expect(report.poison).toEqual([poison[0]])
    expect(report.observations.length).toBeGreaterThan(1)
    expect(report.identities).toHaveLength(2)
    expect(report.cleanup).toBe('retained')
    expect(report.cleanupReason).toContain('manual inspection')
    expect(report.reason).toContain('bounded wait')
  })

  it.each(['prepare', 'upload'] as const)('attempts guarded cleanup after %s fails', async (method) => {
    const { adapter, report } = fixture()
    adapter[method].mockRejectedValue(new Error('partial mutation'))
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('partial mutation')
    expect(adapter.cleanup).toHaveBeenCalledOnce()
    expect(report.phase).toBe(method)
  })

  it('retains observations before a database observation error', async () => {
    const { adapter, report } = fixture()
    adapter.unknownJobCount.mockImplementation(() => { throw new Error('database unavailable') })
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('database unavailable')
    expect(report.poison).toEqual(poison)
    expect(report.observations).toHaveLength(1)
    expect(report.unknownJobCount).toBeNull()
  })

  it('rejects creation of an unknown job', async () => {
    const { adapter, report } = fixture()
    adapter.unknownJobCount.mockReturnValue(1)
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('created an unknown job')
  })

  it('does not pass when cleanup fails after successful observations', async () => {
    const { adapter, report } = fixture()
    adapter.cleanup.mockRejectedValue(new Error('retain resources'))
    await expect(runPoisonIsolation(adapter, target, report)).rejects.toThrow('retain resources')
    expect(report.cleanup).toBe('retained')
  })
})

class OfflinePoisonAdapter extends DockerPoisonIsolationAdapter {
  queries: string[] = []
  response: unknown = undefined
  sends = 0
  failSend = false
  protected sendQueueMessage(): string {
    if (this.failSend && this.sends === 1) throw new Error('uncertain send')
    return `message-${++this.sends}`
  }
  protected sql(query: string): any {
    this.queries.push(query)
    // Model psql's JSON parsing contract: a count SELECT emits a scalar.
    return this.response === undefined ? JSON.parse(query.includes('json_build_object') ? '{"count":0}' : '0') : this.response
  }
}
function offlineAdapter() {
  return new OfflinePoisonAdapter({} as ConstructorParameters<typeof DockerPoisonIsolationAdapter>[0], {
    E2E_PROCESSING_TIMEOUT_MS: '1000', E2E_VISIBILITY_TIMEOUT_MS: '1000', E2E_NAVIGATION_TIMEOUT_MS: '1000', E2E_DLQ_TIMEOUT_MS: '1000',
  })
}
describe('poison adapter database and recovery evidence', () => {
  it('reads zero and nonzero counts using the shared SQL response contract', () => {
    const adapter = offlineAdapter()
    adapter.sendPoison()
    expect(adapter.unknownJobCount()).toBe(0)
    adapter.response = { count: 1 }
    expect(adapter.unknownJobCount()).toBe(1)
  })
  it.each([0, {}, { count: -1 }, { count: '0' }, { count: 0.5 }])('rejects malformed database responses %j', (response) => {
    const adapter = offlineAdapter()
    adapter.sendPoison()
    adapter.response = response
    expect(() => adapter.unknownJobCount()).toThrow('observation unavailable')
  })
  it('retains canonical IDs for an uncertain second send without bodies or handles', () => {
    const adapter = offlineAdapter()
    adapter.failSend = true
    expect(() => adapter.sendPoison()).toThrow('uncertain send')
    const identities = adapter.poisonIdentities()
    expect(identities).toHaveLength(2)
    expect(identities[0]?.messageId).toBe('message-1')
    expect(identities[1]?.canonicalIds?.jobId).toMatch(/^[0-9a-f-]{36}$/)
    expect(identities[1]?.messageId).toBeUndefined()
    for (const identity of identities) {
      expect(identity.bodySha256).toMatch(/^[0-9a-f]{64}$/)
      expect(identity).not.toHaveProperty('body')
      expect(identity).not.toHaveProperty('receiptHandle')
    }
  })
})

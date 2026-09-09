import { describe, expect, it, vi } from 'vitest'
import { duplicateEvents } from './duplicate-adapter.js'
import {
  acknowledged,
  duplicateTarget,
  runDuplicate,
  validateDuplicateResult,
  type DuplicateAdapter,
  type DuplicateEvent,
  type DuplicateReport,
  type DuplicateSnapshot,
} from './duplicate-driver.js'

const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
const event = (
  outcome: string,
  at: number,
  extra: Partial<DuplicateEvent> = {},
): DuplicateEvent => ({
  outcome,
  at,
  messageId: 'original',
  deliveryId: 'original-1',
  workerId: 'owner',
  attempt: 1,
  ...extra,
})
function events(): DuplicateEvent[] {
  return [
    event('acquired', 10),
    event('download_started', 11),
    event('source_downloaded', 12),
    event('encode_started', 13),
    event('busy', 14, { messageId: 'busy', deliveryId: 'busy-1', attempt: undefined }),
    event('retained', 15, { messageId: 'busy', deliveryId: 'busy-1', attempt: undefined }),
    event('encode_finished', 20),
    event('segment_upload_started', 21),
    event('segment_published', 22),
    event('manifest_upload_started', 23),
    event('manifest_published', 24),
    event('completed', 25),
    event('deleted', 26),
    event('already_completed', 27, { messageId: 'busy', deliveryId: 'busy-2', attempt: undefined }),
    event('deleted', 28, { messageId: 'busy', deliveryId: 'busy-2', attempt: undefined }),
    event('already_completed', 30, { messageId: 'post', deliveryId: 'post-1', attempt: undefined }),
    event('deleted', 31, { messageId: 'post', deliveryId: 'post-1', attempt: undefined }),
  ]
}
function snapshot(completed = true): DuplicateSnapshot {
  return {
    job: {
      status: completed ? 'COMPLETED' : 'PROCESSING',
      attempt: 1,
      workerId: completed ? null : 'owner',
      leaseMs: completed ? null : 10000,
      observedAtMs: 100,
      updatedAtMs: completed ? 25 : 10,
    },
    events: events(),
  }
}
function report(): DuplicateReport {
  return {
    target,
    status: 'running',
    cleanup: 'pending',
    scenarioStarted: false,
    messages: { original: 'original', busy: 'busy', completed: 'post' },
    observations: [],
    events: [],
  }
}
function fixture() {
  let sent = 0,
    reads = 0,
    time = 100
  const adapter: DuplicateAdapter = {
    processingMs: 1000,
    deliveryMs: 1000,
    prepare: vi.fn(),
    upload: vi.fn(),
    verifyOutput: vi.fn(),
    cleanup: vi.fn(),
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    sendDuplicate: vi.fn(async () => (++sent === 1 ? 'busy' : 'post')),
    observe: vi.fn(async () => {
      reads++
      const s = snapshot(reads >= 3)
      s.events = s.events.slice(0, reads === 1 ? 4 : reads === 2 ? 6 : sent < 2 ? 15 : undefined)
      return s
    }),
  }
  const r = report()
  r.messages = {}
  return { adapter, report: r }
}

describe('duplicate observation assertions', () => {
  it('accepts one processing path and three independently acknowledged messages', () => {
    expect(validateDuplicateResult(snapshot(), report())).toEqual([
      target.prefix + 'hls/segment-00000.ts',
      target.prefix + 'hls/index.m3u8',
    ])
  })
  it.each([
    'acquired',
    'download_started',
    'source_downloaded',
    'encode_started',
    'encode_finished',
    'segment_published',
    'manifest_published',
    'completed',
    'busy',
  ])('rejects missing %s evidence', (outcome) => {
    const s = snapshot()
    s.events = s.events.filter((e) => e.outcome !== outcome)
    expect(() => validateDuplicateResult(s, report())).toThrow()
  })
  it.each(['download_started', 'encode_started', 'manifest_upload_started'])(
    'detects duplicate %s even with unchanged final status',
    (outcome) => {
      const s = snapshot()
      s.events.push(event(outcome, 30, { messageId: 'post', deliveryId: 'post-1' }))
      expect(() => validateDuplicateResult(s, report())).toThrow()
    },
  )
  it('rejects manifest-before-segments, wrong owners, false completion, and wrong acknowledgement', () => {
    const reorder = snapshot()
    ;[reorder.events[8], reorder.events[10]] = [reorder.events[10]!, reorder.events[8]!]
    expect(() => validateDuplicateResult(reorder, report())).toThrow()
    const owner = snapshot()
    owner.events[6]!.workerId = 'other'
    expect(() => validateDuplicateResult(owner, report())).toThrow('owner')
    const early = snapshot()
    early.events.find((e) => e.outcome === 'completed')!.at = 10
    expect(() => validateDuplicateResult(early, report())).toThrow('Completion')
    const ack = snapshot()
    ack.events.at(-1)!.messageId = 'unrelated'
    expect(() => validateDuplicateResult(ack, report())).toThrow('acknowledged')
  })
  it('does not treat an earlier deletion as acknowledgement of an unfinished new delivery', () => {
    const s = snapshot()
    s.events.push(event('already_completed', 32, { messageId: 'post', deliveryId: 'post-2' }))
    expect(acknowledged(s, 'post')).toBe(false)
    s.events.push(event('deleted', 33, { messageId: 'post', deliveryId: 'post-1' }))
    expect(acknowledged(s, 'post')).toBe(false)
  })
})

describe('duplicate scenario with fake service boundaries', () => {
  it('runs with the Spec 25 worker_delivery/worker_attempt JSON contract without logged keys', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    const media: Record<string, [string, string]> = {
      download_started: ['download', 'start'],
      source_downloaded: ['download', 'success'],
      encode_started: ['encode', 'start'],
      encode_finished: ['encode', 'success'],
      segment_upload_started: ['segment_upload', 'start'],
      segment_published: ['segment_upload', 'success'],
      manifest_upload_started: ['manifest_upload', 'start'],
      manifest_published: ['manifest_upload', 'success'],
    }
    f.adapter.observe = async () => {
      const s = await observe()
      const logs = s.events
        .map((e) => {
          const delivery = {
            name: 'worker_delivery',
            message_id: e.messageId,
            delivery_id: e.deliveryId,
          }
          const context = {
            job_id: target.jobId,
            video_id: target.videoId,
            worker_id: e.workerId,
            attempt: e.attempt,
          }
          const attempt = { name: 'worker_attempt', ...context }
          const operation = media[e.outcome]
          return JSON.stringify({
            timestamp: new Date(e.at).toISOString(),
            level: 'INFO',
            span: operation ? attempt : delivery,
            spans: operation ? [delivery, attempt] : [delivery],
            fields: operation
              ? { message: 'media operation', operation: operation[0], outcome: operation[1] }
              : ['deleted', 'retained'].includes(e.outcome)
                ? {
                    message: 'message outcome',
                    worker_id: e.workerId,
                    receive_count: 1,
                    outcome: e.outcome,
                  }
                : { message: 'record outcome', ...context, outcome: e.outcome },
          })
        })
        .join('\n')
      return { ...s, events: duplicateEvents(logs, target) }
    }
    await runDuplicate(f.adapter, f.report)
    expect(f.report.status).toBe('passed')
    expect(f.adapter.verifyOutput).toHaveBeenCalledWith([
      target.prefix + 'hls/segment-00000.ts',
      target.prefix + 'hls/index.m3u8',
    ])
    expect(f.report.events.some((e) => 'objectKey' in e || 'sourceKey' in e)).toBe(false)
  })
  it('performs both injections, output validation and cleanup', async () => {
    const f = fixture()
    await runDuplicate(f.adapter, f.report)
    expect(f.report).toMatchObject({
      status: 'passed',
      cleanup: 'complete',
      messages: { original: 'original', busy: 'busy', completed: 'post' },
    })
    expect(f.adapter.sendDuplicate).toHaveBeenCalledTimes(2)
    expect(f.adapter.verifyOutput).toHaveBeenCalledOnce()
    expect(f.adapter.cleanup).toHaveBeenCalledOnce()
  })
  it('rejects a workload that completes before injection and still cleans up', async () => {
    const f = fixture()
    f.adapter.observe = async () => snapshot()
    await expect(runDuplicate(f.adapter, f.report)).rejects.toThrow('longer fixture')
    expect(f.adapter.sendDuplicate).not.toHaveBeenCalled()
    expect(f.adapter.cleanup).toHaveBeenCalledOnce()
  })
  it('rejects busy delivery observed after completion', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    let reads = 0
    f.adapter.observe = async () => (++reads === 1 ? observe() : snapshot())
    await expect(runDuplicate(f.adapter, f.report)).rejects.toThrow('Busy delivery')
    expect(f.adapter.sendDuplicate).toHaveBeenCalledTimes(1)
  })
  it('times out missing acknowledgement and retains resources when cleanup refuses', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    f.adapter.observe = async () => {
      const s = await observe()
      s.events = s.events.filter((e) => e.outcome !== 'deleted')
      return s
    }
    f.adapter.cleanup = vi.fn(async () => {
      throw new Error('pending message')
    })
    await expect(runDuplicate(f.adapter, f.report)).rejects.toThrow('timed out')
    expect(f.report).toMatchObject({ status: 'unverified', cleanup: 'retained' })
  })
  it('detects same-state database overwrite on completed redelivery', async () => {
    const f = fixture()
    const observe = f.adapter.observe
    let reads = 0
    f.adapter.observe = async () => {
      const s = await observe()
      if (++reads >= 4) s.job.updatedAtMs++
      return s
    }
    await expect(runDuplicate(f.adapter, f.report)).rejects.toThrow('overwrote')
  })
  it('cleans partial setup without injection', async () => {
    const f = fixture()
    f.adapter.prepare = vi.fn(async () => {
      throw new Error('transaction response lost')
    })
    await expect(runDuplicate(f.adapter, f.report)).rejects.toThrow('transaction response lost')
    expect(f.adapter.upload).not.toHaveBeenCalled()
    expect(f.adapter.cleanup).toHaveBeenCalledOnce()
  })
})

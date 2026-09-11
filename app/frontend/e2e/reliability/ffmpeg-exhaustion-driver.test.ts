import { describe, expect, it } from 'vitest'
import {
  exhaustionBudget,
  runFfmpegExhaustion,
  type ExhaustionAdapter,
  validateExhaustionResult,
} from './ffmpeg-exhaustion-driver.js'

const target = {
  runId: 'e2e-11111111-1111-4111-8111-111111111111',
  videoId: '22222222-2222-4222-8222-222222222222',
  jobId: '11111111-1111-4111-8111-111111111111',
  prefix: 'videos/22222222-2222-4222-8222-222222222222/jobs/11111111-1111-4111-8111-111111111111/',
  sourceKey:
    'videos/22222222-2222-4222-8222-222222222222/jobs/11111111-1111-4111-8111-111111111111/source.mp4',
}
const good = {
  job: {
    status: 'FAILED',
    attempt: 3,
    failure: 'encode HLS: ffmpeg exited with status 1',
    updatedAtMs: 10,
  },
  events: [1, 2, 3].flatMap((attempt) =>
    ['acquired', 'encode_started', attempt === 3 ? 'final_failed' : 'retry_released'].map(
      (outcome, index) => ({
        at: attempt * 10 + index,
        outcome,
        attempt,
        messageId: 'message-1',
        deliveryId: 'delivery-' + attempt,
      }),
    ),
  ),
  dlq: [
    {
      messageId: 'message-1',
      receivedAt: '2026-01-01T00:00:00.000Z',
      jobId: target.jobId,
      videoId: target.videoId,
      sourceKey: target.sourceKey,
    },
  ],
}

describe('FFmpeg exhaustion result', () => {
  it('accepts clock rollback within a delivery without changing the recorded UTC timestamps', () => {
    const events = good.events.map((event) =>
      event.attempt === 2 && event.outcome !== 'acquired'
        ? { ...event, at: event.at - 370 }
        : { ...event },
    )
    const snapshot = { ...good, events }
    expect(() => validateExhaustionResult(snapshot, snapshot, target, 3)).not.toThrow()
    expect(events[4]!.at).toBeLessThan(events[3]!.at)
  })
  it('rejects reversed log order even when the timestamps appear ordered', () => {
    const events = [...good.events]
    ;[events[3], events[4]] = [events[4]!, events[3]!]
    expect(() => validateExhaustionResult(good, { ...good, events }, target, 3)).toThrow(
      'attempt 2',
    )
  })
  it('rejects encoding after terminal failure even when its UTC timestamp is earlier', () => {
    const events = [...good.events]
    const encode = events.splice(7, 1)[0]!
    events.push({ ...encode, at: 0 })
    expect(() => validateExhaustionResult(good, { ...good, events }, target, 3)).toThrow(
      'attempt 3',
    )
  })
  it('rejects missing, pre-encoding and miscorrelated evidence', () => {
    for (const bad of [
      { ...good, events: [] },
      { ...good, job: { ...good.job, failure: 'download source: denied' } },
      { ...good, job: { ...good.job, failure: 'encode HLS: run ffmpeg: not found' } },
      { ...good, events: good.events.filter((e) => e.outcome !== 'encode_started') },
      {
        ...good,
        events: good.events.map((e) =>
          e.outcome === 'encode_started' ? { ...e, deliveryId: 'wrong' } : e,
        ),
      },
      { ...good, events: [...good.events, { ...good.events[0]!, outcome: 'encode_finished' }] },
      {
        ...good,
        events: [...good.events, { ...good.events[0]!, outcome: 'encode_started', at: 100 }],
      },
    ])
      expect(() => validateExhaustionResult(good, bad, target, 3)).toThrow()
  })
  it('requires durable details, bounded attempt, and exact DLQ ownership', () => {
    expect(() =>
      validateExhaustionResult(
        { ...good, job: { ...good.job, status: 'PROCESSING' } },
        good,
        target,
        3,
      ),
    ).toThrow('durable FAILED')
    expect(() => validateExhaustionResult(good, { ...good, dlq: [] }, target, 3)).toThrow('DLQ')
    expect(() => validateExhaustionResult(good, good, target, 3)).not.toThrow()
  })
})

function adapter(observe: ExhaustionAdapter['observe']): ExhaustionAdapter {
  let now = 0
  return {
    attempts: 3,
    processingMs: 100,
    exhaustionMs: 5000,
    stabilityMs: 2000,
    prepare: async () => {},
    uploadInvalidMedia: async () => {},
    cleanup: async () => {},
    hasManifest: async () => false,
    observe,
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
}

it('retains the first DLQ receive throughout stability observations', async () => {
  const calls: boolean[] = []
  const fake = adapter(async (receive = true) => {
    calls.push(receive)
    return { ...good, dlq: calls.length === 1 ? good.dlq : [] }
  })
  await expect(runFfmpegExhaustion(fake, target)).resolves.toBeUndefined()
  expect(calls).toEqual([true, false, false])
  expect(fake.now()).toBe(2000)
})
it('rejects terminal mutation and late publication', async () => {
  let count = 0
  await expect(
    runFfmpegExhaustion(
      adapter(async () =>
        ++count === 1 ? good : { ...good, job: { ...good.job, updatedAtMs: 20 } },
      ),
      target,
    ),
  ).rejects.toThrow('changed')
  const fake = adapter(async () => good)
  count = 0
  fake.hasManifest = async () => ++count > 1
  await expect(runFfmpegExhaustion(fake, target)).rejects.toThrow('manifest')
})
it('bounds missing DLQ observations', async () => {
  const fake = adapter(async () => ({ ...good, dlq: [] }))
  await expect(runFfmpegExhaustion(fake, target)).rejects.toThrow('bounded wait')
  expect(fake.now()).toBe(5000)
})
it('budgets five attempts with 900-second retry delays', () => {
  expect(exhaustionBudget(5, 300000, 900000, 150000, 900000)).toBe(4950000)
  expect(() => exhaustionBudget(11, 1, 1, 1, 1)).toThrow('budgets')
})

it('allows short retries and redrive while retaining a bounded total wait', () => {
  expect(exhaustionBudget(3, 300000, 10000, 60000, 40000)).toBe(420000)
})

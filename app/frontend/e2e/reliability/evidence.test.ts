import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachSafeText, redactText } from '../diagnostics.js'
import type { TestInfo } from '@playwright/test'
import {
  assertCrashRecoveryEvidence,
  assertLongHeartbeatEvidence,
  createEvidence,
  expiryBounds,
  ObservationTimeout,
  observeUntil,
  RunResources,
  safeEvidence,
} from './evidence.js'

describe('reliability evidence helpers', () => {
  afterEach(() => vi.useRealTimers())

  it('creates a run ID and records required evidence fields', () => {
    const evidence = createEvidence(new RunResources().runId, { videoId: 'video-1', jobId: 'job-1', workerId: 'worker-1', attempt: 2 })
    expect(evidence).toMatchObject({ videoId: 'video-1', jobId: 'job-1', workerId: 'worker-1', attempt: 2 })
    expect(evidence.timestamps).toHaveLength(1)
  })

  it('derives recovery eligibility only after both independent expiry gates', () => {
    expect(expiryBounds(1_000, {
      visibilityTimeoutMs: 2_000,
      leaseTimeoutMs: 5_000,
      heartbeatIntervalMs: 500,
      retryDelayMs: 1_000,
    })).toMatchObject({
      visibilityExpiresAtMs: 3_000,
      leaseExpiresAtMs: 6_000,
      recoveryEligibleAtMs: 6_000,
      deadlineAtMs: 7_500,
    })
  })

  it('rejects uncorrelated crash recovery evidence', () => {
    const timing = { visibilityTimeoutMs: 2_000, leaseTimeoutMs: 5_000, heartbeatIntervalMs: 500 }
    expect(() => assertCrashRecoveryEvidence({
      acquiredAtMs: 1_000, crashAtMs: 1_500, recoveryAtMs: 5_000,
      visibilityExpiredAtMs: 3_000, leaseExpiredAtMs: 6_000,
      attempts: [1, 1], owners: ['old', 'new'], states: ['PROCESSING'],
      sourceKey: 'run/source.mp4', manifestPublishedLast: false,
    }, timing)).toThrow(/expiry|increment/)
  })

  it('rejects short or overlapping heartbeat evidence', () => {
    expect(() => assertLongHeartbeatEvidence({
      durationMs: 1_000, heartbeatIntervalMs: 500,
      visibilityExtensions: ['one', 'two'], leaseRenewals: ['one', 'two'],
      attempts: [1], owners: ['worker'],
    })).toThrow('too short')
    expect(() => assertLongHeartbeatEvidence({
      durationMs: 2_000, heartbeatIntervalMs: 500,
      visibilityExtensions: ['one', 'two'], leaseRenewals: ['one', 'two'],
      attempts: [1, 2], owners: ['worker'],
    })).toThrow('increment')
  })

  it('redacts credentials, receipt handles, database URLs, and URL queries', () => {
    const output = JSON.stringify(safeEvidence({
      message: 'https://example.test/a?X-Amz-Signature=secret postgres://user:pass@db.test/app',
      receiptHandle: 'receipt-secret',
    }))
    expect(output).not.toContain('secret')
    expect(output).not.toContain('receipt-secret')
    expect(output).not.toContain('postgres://')
  })

  it('bounds polling and includes the final observation in timeout evidence', async () => {
    let clock = 0
    await expect(observeUntil(async () => 'waiting', () => false, {
      timeoutMs: 10,
      intervalMs: 5,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
    })).rejects.toMatchObject({ evidence: { timeoutMs: 10, lastObservation: 'waiting' } })
    expect(new ObservationTimeout({ timeoutMs: 1, startedAt: '', endedAt: '' })).toMatchObject({
      name: 'ObservationTimeout',
      evidence: { timeoutMs: 1, startedAt: '', endedAt: '' },
    })
  })

  it.each([
    'receiptHandle=private-value',
    'receipt_handle="private-value"',
    "Receipt-Handle: 'private-value'",
    'databaseUrl=private-value',
    'GET /videos?cursor=private-value&x=y',
    'GET videos?cursor=private-value',
    'GET ../videos?cursor=private-value',
    'GET //example.test/videos?cursor=private-value',
    'GET //user:private-value@example.test/videos',
    'redis://user:private-value@cache.test/0',
    'ftp://user:private-value@example.test/file',
    'amqp://user:private-value@example.test/queue',
  ])('redacts text and nested evidence: %s', async (message) => {
    expect(redactText(message)).not.toContain('private-value')
    expect(JSON.stringify(safeEvidence({ nested: [{ message }] }))).not.toContain('private-value')
    const attach = vi.fn().mockResolvedValue(undefined)
    await attachSafeText({ attach } as unknown as TestInfo, 'diagnostic', message)
    expect(attach.mock.calls[0]![1].body.toString()).not.toContain('private-value')
  })

  it('preserves evidence structure and subsequent lines when redacting headers and URLs', () => {
    const evidence = safeEvidence({
      runId: 'e2e-abcd',
      message: 'Authorization: Bearer private-value\nnext line',
      nested: [{ message: 'Cookie: session=private-value', status: 200 }],
      urlMessage: 'https://example.test/a?token=private-value\nnext line',
      observation: 'GET /videos?cursor=private-value\nnext line',
    })
    expect(evidence).toEqual({
      runId: 'e2e-abcd',
      message: 'Authorization: [REDACTED]\nnext line',
      nested: [{ message: 'Cookie: [REDACTED]', status: 200 }],
      urlMessage: 'https://example.test/a',
      observation: 'GET /videos\nnext line',
    })
    expect(safeEvidence({ message: 'https://example.test/a?x=private-value\nnext line' }))
      .toEqual({ message: 'https://example.test/a\nnext line' })
    expect(() => JSON.stringify(evidence)).not.toThrow()
  })

  it('sanitizes preserved ID values without losing normal identifiers', () => {
    expect(safeEvidence({ videoId: 'video-1', jobId: 'receiptHandle=private-value' }))
      .toEqual({ videoId: 'video-1', jobId: 'receiptHandle=[REDACTED]' })
  })

  it('keeps the validated run ID authoritative even for untyped callers', () => {
    const runId = new RunResources().runId
    // @ts-expect-error Caller fields must not accept a runId override.
    expect(createEvidence(runId, { runId: 'other-run', workerId: 'worker-1' }))
      .toMatchObject({ runId, workerId: 'worker-1' })
  })

  it('aborts a hanging observation at the deadline and retains safe final evidence', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    let calls = 0
    const result = observeUntil(async (currentSignal) => {
      signal = currentSignal
      if (++calls === 1) return { message: 'receiptHandle=private-value' }
      return new Promise<never>(() => {})
    }, () => false, { timeoutMs: 10, intervalMs: 5 })
    const assertion = expect(result).rejects.toMatchObject({
      name: 'ObservationTimeout',
      evidence: { timeoutMs: 10, lastObservation: { message: 'receiptHandle=[REDACTED]' } },
    })
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    expect(signal?.aborted).toBe(true)
    expect(calls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a match returned after the deadline', async () => {
    let clock = 0
    await expect(observeUntil(async () => { clock = 11; return 'ready' }, () => true, {
      timeoutMs: 10, now: () => clock,
    })).rejects.toBeInstanceOf(ObservationTimeout)
  })

  it('returns an on-time match and clears its deadline timer', async () => {
    vi.useFakeTimers()
    await expect(observeUntil(async () => 'ready', () => true, { timeoutMs: 10 })).resolves.toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not process late observations after timing out', async () => {
    vi.useFakeTimers()
    let complete!: (value: string) => void
    const matches = vi.fn(() => true)
    const result = observeUntil(() => new Promise<string>((resolve) => { complete = resolve }), matches, { timeoutMs: 10 })
    const assertion = expect(result).rejects.toBeInstanceOf(ObservationTimeout)
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    complete('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(matches).not.toHaveBeenCalled()
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid polling interval %s', async (intervalMs) => {
    await expect(observeUntil(async () => 'ready', () => true, { timeoutMs: 10, intervalMs }))
      .rejects.toThrow('intervalMs must be positive and finite')
  })

  it('cleans only registered resources after partial setup', async () => {
    const resources = new RunResources()
    const cleaned: string[] = []
    resources.register({ kind: 'fixture', id: 'run/video-1', cleanup: () => { cleaned.push('fixture') } })
    resources.register({ kind: 'database-record', id: 'run/job-1', cleanup: () => { cleaned.push('job') } })
    expect(resources.has('fixture', 'run/video-1')).toBe(true)
    await resources.cleanup()
    expect(cleaned).toEqual(['job', 'fixture'])
    expect(resources.has('fixture', 'run/video-1')).toBe(false)
    expect(() => resources.register({ kind: 'bucket-object', id: 'run/*', cleanup: () => {} })).toThrow()
  })

  it('attempts every cleanup and retries only failed entries without exposing raw errors', async () => {
    const resources = new RunResources()
    const cleaned: string[] = []
    let fail = true
    for (const id of ['first', 'second', 'third', 'fourth']) {
      resources.register({ kind: 'fixture', id, cleanup: async () => {
        cleaned.push(id)
        if (fail && (id === 'second' || id === 'fourth')) throw new Error('unstructured private-value')
      } })
    }
    const error = await resources.cleanup().catch((error: AggregateError) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect(String(error) + (error as AggregateError).errors.map(String).join()).not.toContain('private-value')
    expect(cleaned).toEqual(['fourth', 'third', 'second', 'first'])
    expect(resources.has('fixture', 'third')).toBe(false)
    expect(resources.has('fixture', 'second')).toBe(true)
    fail = false
    await resources.cleanup()
    expect(cleaned).toEqual(['fourth', 'third', 'second', 'first', 'fourth', 'second'])
    expect(resources.has('fixture', 'second')).toBe(false)
    await resources.cleanup()
    expect(cleaned).toHaveLength(6)
  })
})

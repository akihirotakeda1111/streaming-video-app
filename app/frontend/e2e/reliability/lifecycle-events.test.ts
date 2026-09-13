import { describe, expect, it } from 'vitest'
import { duplicateEvents } from './duplicate-adapter.js'
import { duplicateTarget, type DuplicateEvent } from './duplicate-driver.js'
import { lifecycleEvents } from './lifecycle-events.js'
import { assertHeartbeats, expiryBounds } from './lifecycle.js'

const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
const acquired: DuplicateEvent = {
  outcome: 'acquired',
  at: 100,
  messageId: 'original',
  deliveryId: 'delivery',
  workerId: 'owner',
  attempt: 1,
}
function row(operation: string, cycle: number, extra: object = {}) {
  const start = cycle * 1000 + (operation === 'visibility_extension' ? 20 : 0)
  return {
    timestamp: new Date(start + 10).toISOString(),
    fields: {
      operation,
      outcome: 'success',
      heartbeat_cycle: cycle,
      message_id: acquired.messageId,
      delivery_id: acquired.deliveryId,
      ...(operation === 'lease_renewal'
        ? { job_id: target.jobId, video_id: target.videoId, worker_id: 'owner', attempt: 1 }
        : {}),
      request_started_at_unix_ms: start,
      response_observed_at_unix_ms: start + 10,
      duration_seconds: 4,
      elapsed_ms: 10,
      receipt_handle: 'private-handle',
      ...extra,
    },
  }
}
const parse = (rows: ReturnType<typeof row>[]) =>
  lifecycleEvents(
    rows.map((r) => JSON.stringify(r)).join('\n'),
    target,
    [acquired],
    { lease: 4, visibility: 4 },
    10,
  )
describe('Spec 26 lifecycle correlation', () => {
  it('accepts the observed -627 ms correction and keeps expiry bounds conservative', () => {
    const lease = row('lease_renewal', 15, { request_started_at_unix_ms: 1789205008035, response_observed_at_unix_ms: 1789205008040, elapsed_ms: 4, duration_seconds: 30 })
    lease.timestamp = '2026-09-12T09:23:28.040047Z'
    const visibility = row('visibility_extension', 15, { request_started_at_unix_ms: 1789205008040, response_observed_at_unix_ms: 1789205007961, elapsed_ms: 548, duration_seconds: 30 })
    visibility.timestamp = '2026-09-12T09:23:27.961136Z'
    const result = lifecycleEvents([lease, visibility].map((r) => JSON.stringify(r)).join('\n'), target, [acquired], { lease: 30, visibility: 30 }, 5000)
    expect(() => assertHeartbeats(result.heartbeats, 1, 5000)).not.toThrow()
    expect(result.operations[1]!.observedAtMs).toBe(1789205007961)
    expect(result.heartbeats[0]!.visibilityExpiresAtMs).toBe(1789205007961 + 30000 - 5000)
    const input = { databaseNowMs: 1789205008100, leaseExpiresAtMs: 1789205038000, localBeforeMs: 1789205008090, localAfterMs: 1789205008110, visibilityObservedAtMs: Math.max(result.operations[1]!.startedAtMs, result.operations[1]!.observedAtMs), visibilityDurationMs: 30000, stoppedAtMs: 1789205008100, maximumVisibilityMs: 30000, clockSkewMs: 5000 }
    expect(expiryBounds(input).visibilitySafeAfterMs).toBe(1789205008040 + 30000 + 5000)
  })
  it.each([-10, 10, -11, 11])('checks signed clock correction %s against the tolerance', (correction) => {
    const rows = [row('lease_renewal', 1, { response_observed_at_unix_ms: 1010 + correction })]
    if (Math.abs(correction) <= 10) expect(() => parse(rows)).not.toThrow()
    else expect(() => parse(rows)).toThrow('Heartbeat timing')
  })
  it('allows a slow request when monotonic and wall-clock durations agree', () => {
    const operation = row('lease_renewal', 1, { response_observed_at_unix_ms: 2000, elapsed_ms: 1000 })
    operation.timestamp = new Date(2000).toISOString()
    expect(() => parse([operation])).not.toThrow()
  })
  it('applies tolerance between lease and visibility operations', () => {
    expect(() => parse([row('lease_renewal', 1), row('visibility_extension', 1, { request_started_at_unix_ms: 1000, response_observed_at_unix_ms: 1010 })])).not.toThrow()
    expect(() => parse([row('lease_renewal', 1), row('visibility_extension', 1, { request_started_at_unix_ms: 999, response_observed_at_unix_ms: 1009 })])).toThrow('preceded lease')
  })
  it('pairs interleaved operations by cycle and retains only safe timing evidence', () => {
    const result = parse([
      row('lease_renewal', 1),
      row('lease_renewal', 2),
      row('visibility_extension', 1),
      row('visibility_extension', 2),
    ])
    expect(result.heartbeats.map((e) => e.cycle)).toEqual([1, 2])
    expect(result.heartbeats.every((e) => e.outcome === 'heartbeat_succeeded')).toBe(true)
    expect(result.heartbeats[0]!.leaseExpiresAtMs).toBe(4990)
    expect(JSON.stringify(result)).not.toContain('private-handle')
  })
  it('retains an incomplete cycle instead of fabricating successful renewal', () => {
    expect(parse([row('lease_renewal', 1)]).heartbeats[0]!.outcome).toBe('heartbeat_incomplete')
    expect(parse([row('lease_renewal', 1)]).heartbeats[0]!.visibilityExpiresAtMs).toBeNull()
  })
  it.each([
    { outcome: 'failed' },
    { worker_id: 'other' },
    { attempt: 2 },
    { message_id: 'other' },
    { heartbeat_cycle: 0 },
    { duration_seconds: 5 },
    { elapsed_ms: 1000 },
    { request_started_at_unix_ms: null },
    { response_observed_at_unix_ms: 1 },
  ])('rejects malformed or changed renewal evidence %j', (extra) => {
    expect(() => parse([row('lease_renewal', 1, extra)])).toThrow()
  })
  it('rejects duplicate operations and uncorrelated target renewals', () => {
    expect(() => parse([row('lease_renewal', 1), row('lease_renewal', 1)])).toThrow('Duplicate')
    expect(() => parse([row('lease_renewal', 1, { delivery_id: 'unknown' })])).toThrow(
      'no correlated',
    )
  })
  it('ignores other jobs without pairing their visibility with this job', () => {
    expect(
      parse([
        row('lease_renewal', 1, { job_id: 'other', video_id: 'other', delivery_id: 'other' }),
        row('visibility_extension', 1, { delivery_id: 'other' }),
      ]).heartbeats,
    ).toEqual([])
  })
  it('does not misclassify valid heartbeats as unsupported media operations', () => {
    const acquisition = {
      timestamp: new Date(100).toISOString(),
      span: { name: 'worker_delivery', message_id: 'original', delivery_id: 'delivery' },
      fields: {
        outcome: 'acquired',
        job_id: target.jobId,
        video_id: target.videoId,
        worker_id: 'owner',
        attempt: 1,
      },
    }
    const heartbeat = { ...row('lease_renewal', 1), span: acquisition.span }
    expect(
      duplicateEvents([acquisition, heartbeat].map((r) => JSON.stringify(r)).join('\n'), target),
    ).toEqual([acquired])
  })
})

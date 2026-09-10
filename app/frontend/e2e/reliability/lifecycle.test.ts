import { describe, expect, it } from 'vitest'
import { assertCrashRecovery, assertHeartbeats, expiryBounds, type RecoveryObservation } from './lifecycle.js'

describe('reliability lifecycle bounds', () => {
  it('waits for both SQS visibility and database lease expiry', () => {
    expect(expiryBounds({
      databaseNowMs: 1_000,
      localObservedAtMs: 1_050,
      visibilityTimeoutMs: 4_000,
      leaseDurationMs: 3_000,
      clockSkewMs: 100,
    })).toEqual({
      visibilityExpiresAtMs: 5_050,
      leaseExpiresAtMs: 4_000,
      recoveryAfterMs: 5_150,
    })
  })

  it('rejects malformed bounds and clock skew', () => {
    expect(() => expiryBounds({ databaseNowMs: 0, localObservedAtMs: 1, visibilityTimeoutMs: 1, leaseDurationMs: 1 })).toThrow()
    expect(() => expiryBounds({ databaseNowMs: 1, localObservedAtMs: 1, visibilityTimeoutMs: 1, leaseDurationMs: 1, clockSkewMs: -1 })).toThrow()
  })

  it('requires one replacement owner and no final-attempt false completion', () => {
    const observation = (at: number, status: string, attempt: number, workerId: string | null, events: RecoveryObservation['events']): RecoveryObservation => ({ at, status, attempt, workerId, leaseExpiresAtMs: status === 'COMPLETED' ? null : at + 100, databaseNowMs: at, events })
    expect(() => assertCrashRecovery([
      observation(1, 'PROCESSING', 1, 'worker-a', [{ outcome: 'acquired', at: 1, workerId: 'worker-a', deliveryId: 'delivery-a' }]),
      observation(2, 'PROCESSING', 2, 'worker-b', [{ outcome: 'acquired', at: 2, workerId: 'worker-b', deliveryId: 'delivery-b' }]),
      observation(3, 'COMPLETED', 2, null, []),
    ], 'worker-a', 'delivery-a')).not.toThrow()
    expect(() => assertCrashRecovery([
      observation(1, 'COMPLETED', 1, null, []),
    ], 'worker-a', 'delivery-a')).toThrow()
  })

  it('requires repeated successful renewals by one owner and attempt', () => {
    const events = [1, 2, 3].map((at) => ({ outcome: 'heartbeat_succeeded', workerId: 'worker-a', attempt: 1, at, leaseExpiresAtMs: at + 10, visibilityExpiresAtMs: at + 20 }))
    expect(() => assertHeartbeats(events, 2)).not.toThrow()
    expect(() => assertHeartbeats(events.slice(0, 1), 2)).toThrow()
    expect(() => assertHeartbeats(events.map((event, index) => ({ ...event, workerId: index === 2 ? 'worker-b' : event.workerId })), 2)).toThrow()
  })
})

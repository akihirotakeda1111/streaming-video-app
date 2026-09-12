import { describe, expect, it } from 'vitest'
import {
  assertCrashRecovery,
  assertHeartbeats,
  expiryBounds,
  type RecoveryObservation,
  type HeartbeatObservation,
} from './lifecycle.js'

const bounds = {
  databaseNowMs: 1_000,
  leaseExpiresAtMs: 4_000,
  localBeforeMs: 1_040,
  localAfterMs: 1_050,
  visibilityObservedAtMs: 900,
  visibilityDurationMs: 4_000,
  stoppedAtMs: 1_000,
  maximumVisibilityMs: 4_000,
  clockSkewMs: 100,
}
const recovery = (): RecoveryObservation[] => [
  {
    at: 100,
    status: 'PROCESSING',
    attempt: 1,
    workerId: 'worker-a',
    leaseExpiresAtMs: 500,
    dbNowMs: 100,
    events: [
      {
        outcome: 'acquired',
        at: 100,
        workerId: 'worker-a',
        attempt: 1,
        deliveryId: 'delivery-a',
        messageId: 'original',
      },
    ],
  },
  {
    at: 1100,
    status: 'PROCESSING',
    attempt: 2,
    workerId: 'worker-b',
    leaseExpiresAtMs: 2000,
    dbNowMs: 1100,
    events: [
      {
        outcome: 'acquired',
        at: 1100,
        workerId: 'worker-b',
        attempt: 2,
        deliveryId: 'delivery-b',
        messageId: 'original',
      },
    ],
  },
  {
    at: 1500,
    status: 'COMPLETED',
    attempt: 2,
    workerId: null,
    leaseExpiresAtMs: null,
    dbNowMs: 1500,
    events: [],
  },
]
const renewals = (): HeartbeatObservation[] =>
  [1, 2, 3].map((cycle) => ({
    outcome: 'heartbeat_succeeded',
    workerId: 'worker-a',
    attempt: 1,
    messageId: 'original',
    deliveryId: 'delivery-a',
    cycle,
    at: cycle * 100,
    startedAtMs: cycle * 100 - 10,
    visibilityObservedAtMs: cycle * 100,
    leaseExpiresAtMs: cycle * 100 + 1000,
    visibilityExpiresAtMs: cycle * 100 + 2000,
  }))
describe('lifecycle evidence assertions', () => {
  it('maps the actual DB lease and covers an unlogged in-flight visibility update', () => {
    expect(expiryBounds(bounds)).toEqual({
      leaseSafeAfterMs: 4050,
      visibilitySafeAfterMs: 5000,
      recoveryAfterMs: 5100,
    })
    expect(expiryBounds({ ...bounds, leaseExpiresAtMs: 10000 }).recoveryAfterMs).toBe(10150)
    expect(expiryBounds({ ...bounds, maximumVisibilityMs: 6000 }).recoveryAfterMs).toBe(7100)
  })
  it.each([0, -1, NaN, Infinity])('rejects malformed time evidence %s', (bad) => {
    expect(() => expiryBounds({ ...bounds, clockSkewMs: bad })).toThrow()
    expect(() => expiryBounds({ ...bounds, leaseExpiresAtMs: bad })).toThrow()
  })
  it('rejects clock drift and observations after the stopped worker', () => {
    expect(() => expiryBounds({ ...bounds, databaseNowMs: 500 })).toThrow('clock')
    expect(() => expiryBounds({ ...bounds, localBeforeMs: 1100 })).toThrow('clock')
    expect(() => expiryBounds({ ...bounds, visibilityObservedAtMs: 1200 })).toThrow('stopped')
  })
  it('accepts exactly one replacement redelivery at the clock-adjusted threshold', () => {
    expect(() => assertCrashRecovery(recovery(), 'worker-a', 'delivery-a', 1000, 100)).not.toThrow()
  })
  it('exercises false completion with otherwise valid acquisitions and terminal state', () => {
    const observations = recovery()
    observations.splice(1, 0, { ...observations[2]!, at: 500, attempt: 1, events: [] })
    expect(() => assertCrashRecovery(observations, 'worker-a', 'delivery-a', 1000, 100)).toThrow(
      'crashed attempt reported false completion',
    )
  })
  it('also rejects a transient false completion present only in the event stream', () => {
    const observations = recovery()
    observations[0]!.events = [
      ...observations[0]!.events,
      { outcome: 'completed', at: 200, workerId: 'worker-a', attempt: 1 },
    ]
    expect(() => assertCrashRecovery(observations, 'worker-a', 'delivery-a', 1000, 100)).toThrow(
      'false completion',
    )
  })
  it('rejects early, invalid, wrong-message and extra acquisitions', () => {
    for (const change of [
      { at: 1099 },
      { at: NaN },
      { messageId: 'new-message' },
      { workerId: 'worker-a' },
      { attempt: 3 },
    ]) {
      const observations = recovery()
      observations[1]!.events = [{ ...observations[1]!.events[0]!, ...change }]
      expect(() => assertCrashRecovery(observations, 'worker-a', 'delivery-a', 1000, 100)).toThrow()
    }
    const observations = recovery()
    observations[2]!.events = [
      { ...observations[1]!.events[0]!, workerId: 'third', deliveryId: 'third' },
    ]
    expect(() => assertCrashRecovery(observations, 'worker-a', 'delivery-a', 1000, 100)).toThrow(
      'exactly one',
    )
  })
  it('requires repeated renewal of both channels by one owner and attempt', () => {
    expect(() => assertHeartbeats(renewals(), 2)).not.toThrow()
    expect(() => assertHeartbeats(renewals().slice(0, 1), 2)).toThrow('too short')
    for (const change of [
      { workerId: 'other' },
      { attempt: 2 },
      { deliveryId: 'other' },
      { cycle: 1 },
      { at: 100 },
    ]) {
      const events = renewals()
      Object.assign(events[1]!, change)
      expect(() => assertHeartbeats(events, 2)).toThrow()
    }
  })
  it('tolerates bounded wall-clock regression while still requiring ordered cycles and live expiry', () => {
    const first = renewals()[0]!
    const second = { ...first, cycle: first.cycle + 1, startedAtMs: first.startedAtMs - 10, at: first.at - 10, leaseExpiresAtMs: first.leaseExpiresAtMs! - 10, visibilityExpiresAtMs: first.visibilityExpiresAtMs! - 10 }
    expect(() => assertHeartbeats([first, second], 2, 10)).not.toThrow()
    expect(() => assertHeartbeats([first, second], 2, 9)).toThrow()
    expect(() => assertHeartbeats([first, { ...second, cycle: first.cycle }], 2, 10)).toThrow()
    expect(() => assertHeartbeats([first, { ...second, leaseExpiresAtMs: second.at }], 2, 10)).toThrow('expired')
  })
  it.each(['heartbeat_failed', 'ownership_lost', 'heartbeat_incomplete'])(
    'rejects %s after enough successes',
    (outcome) => {
      expect(() => assertHeartbeats([...renewals(), { ...renewals()[2]!, outcome }], 2)).toThrow(
        'failure',
      )
    },
  )
  it.each(['leaseExpiresAtMs', 'visibilityExpiresAtMs'] as const)(
    'rejects stale, decreasing, expired or invalid %s',
    (key) => {
      for (const value of [renewals()[0]![key], 500, 199, NaN, Infinity, null]) {
        const events = renewals()
        events[1]![key] = value
        expect(() => assertHeartbeats(events, 2)).toThrow()
      }
    },
  )
})

import { describe, expect, it } from 'vitest'
import { assertCrashRecoveryEvidence, assertLongHeartbeatEvidence, expiryBounds } from './evidence.js'

const timing = { visibilityTimeoutMs: 2_000, leaseTimeoutMs: 5_000, heartbeatIntervalMs: 500 }
const source = 'videos/video-1/jobs/job-1/source.mp4'
const crash = {
  acquiredAtMs: 1_000, crashAtMs: 1_500, recoveryAtMs: 12_000,
  visibilityExpiredAtMs: 10_000, leaseExpiredAtMs: 12_000,
  attempts: [1, 2], owners: ['old', 'new'], states: ['PROCESSING', 'COMPLETED'],
  sourceKey: source, manifestPublishedLast: true,
}
const heartbeat = {
  durationMs: 2_000, heartbeatIntervalMs: 500,
  visibilityExtensions: ['one', 'two'], leaseRenewals: ['one', 'two'],
  attempts: [1, 1], owners: ['worker', 'worker'],
}

describe('recovery evidence invariants', () => {
  it('accepts completed recovery at both renewed expiry gates', () => {
    expect(() => assertCrashRecoveryEvidence(crash, timing, source)).not.toThrow()
  })

  it.each([
    { recoveryAtMs: 6_000 },
    { visibilityExpiredAtMs: 12_001 },
    { leaseExpiredAtMs: 12_001 },
    { visibilityExpiredAtMs: 2_999 },
    { leaseExpiredAtMs: 5_999 },
    { crashAtMs: 1_000 },
    { crashAtMs: 12_000 },
    { crashAtMs: 13_000 },
    { states: ['PROCESSING'], manifestPublishedLast: false },
    { states: ['PROCESSING'], manifestPublishedLast: true },
    { states: ['COMPLETED', 'PROCESSING', 'COMPLETED'] },
    { states: ['PROCESSING', 'FAILED'] },
    { manifestPublishedLast: false },
    { sourceKey: 'videos/other/jobs/job-1/source.mp4' },
    { sourceKey: '' },
    { attempts: [1, 1] },
    { attempts: [1, 3] },
    { attempts: [0.5, 1.5] },
    { owners: ['old', 'old'] },
    { owners: ['old', 'new', 'third'] },
  ])('rejects invalid recovery evidence %j', (patch) => {
    expect(() => assertCrashRecoveryEvidence({ ...crash, ...patch }, timing, source)).toThrow()
  })

  for (const field of ['acquiredAtMs', 'crashAtMs', 'recoveryAtMs', 'visibilityExpiredAtMs', 'leaseExpiredAtMs']) {
    it.each([NaN, Infinity, -Infinity, -1])(`rejects invalid ${field}: %s`, (value) => {
      expect(() => assertCrashRecoveryEvidence({ ...crash, [field]: value }, timing, source)).toThrow()
    })
  }

  it('requires an independently supplied nonempty expected source', () => {
    expect(() => assertCrashRecoveryEvidence(crash, timing, '')).toThrow('canonical source')
  })

  it('accepts multiple heartbeat cycles using verified settings', () => {
    expect(() => assertLongHeartbeatEvidence(heartbeat, timing)).not.toThrow()
  })

  it.each([0, -1, NaN, Infinity, 1, 499])('rejects invalid or mismatched interval %s', (interval) => {
    expect(() => assertLongHeartbeatEvidence({ ...heartbeat, heartbeatIntervalMs: interval }, timing)).toThrow()
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid verified interval %s', (interval) => {
    expect(() => assertLongHeartbeatEvidence(heartbeat, { ...timing, heartbeatIntervalMs: interval })).toThrow()
  })

  it.each([
    { durationMs: 3, heartbeatIntervalMs: 1 },
    { durationMs: 1_000 }, { durationMs: NaN }, { durationMs: Infinity },
    { visibilityExtensions: ['one'] }, { leaseRenewals: ['one'] },
    { attempts: [1, 2] }, { attempts: [] }, { attempts: [NaN] },
    { owners: ['first', 'second'] },
  ])('rejects invalid heartbeat evidence %j', (patch) => {
    expect(() => assertLongHeartbeatEvidence({ ...heartbeat, ...patch }, timing)).toThrow()
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid configured retry delay %s', (retryDelayMs) => {
    expect(() => expiryBounds(1_000, { ...timing, retryDelayMs })).toThrow()
  })

  it('rejects overflow in derived deadlines', () => {
    expect(() => expiryBounds(1_000, { ...timing, leaseTimeoutMs: Number.MAX_VALUE }, Number.MAX_VALUE)).toThrow('finite')
  })
})

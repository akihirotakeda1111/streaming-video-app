/** Pure assertions over run-scoped evidence. All times are milliseconds. */
export function fail(message: string): never {
  throw new Error(message)
}
export const positive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be positive`)
  return value
}
export interface ExpiryInput {
  databaseNowMs: number
  leaseExpiresAtMs: number
  localBeforeMs: number
  localAfterMs: number
  visibilityObservedAtMs: number
  visibilityDurationMs: number
  stoppedAtMs: number
  // Covers initial queue visibility and a possibly unlogged in-flight extension.
  maximumVisibilityMs: number
  clockSkewMs: number
}
/** Convert a DB lease into a local safe restart bound, not a claimed SQS expiry. */
export function expiryBounds(input: ExpiryInput) {
  for (const [key, value] of Object.entries(input)) positive(value, key)
  assertDatabaseClock(
    input.databaseNowMs,
    input.localBeforeMs,
    input.localAfterMs,
    input.clockSkewMs,
  )
  if (input.visibilityObservedAtMs > input.stoppedAtMs + input.clockSkewMs)
    fail('Visibility observation follows the stopped worker')
  const leaseSafeAfterMs =
    input.localAfterMs + Math.max(0, input.leaseExpiresAtMs - input.databaseNowMs)
  const visibilitySafeAfterMs = Math.max(
    input.visibilityObservedAtMs + input.visibilityDurationMs + input.clockSkewMs,
    input.stoppedAtMs + input.maximumVisibilityMs,
  )
  return {
    leaseSafeAfterMs,
    visibilitySafeAfterMs,
    recoveryAfterMs: Math.max(leaseSafeAfterMs, visibilitySafeAfterMs) + input.clockSkewMs,
  }
}
/** DB time is authoritative; reject observations outside the declared clock tolerance. */
export function assertDatabaseClock(
  databaseNowMs: number,
  before: number,
  after: number,
  skew: number,
): void {
  for (const value of [databaseNowMs, before, after, skew]) positive(value, 'clock evidence')
  if (after < before || databaseNowMs < before - skew || databaseNowMs > after + skew)
    fail('Database clock is outside the configured skew bound')
}
export interface LifecycleEvent {
  outcome: string
  at: number
  workerId?: string
  attempt?: number
  deliveryId?: string
  messageId?: string
}
export interface RecoveryObservation {
  at: number
  status: string
  attempt: number
  workerId: string | null
  leaseExpiresAtMs: number | null
  dbNowMs: number
  events: readonly LifecycleEvent[]
}
/** Require original-message recovery after a supplied absolute, local restart bound. */
export function assertCrashRecovery(
  observations: readonly RecoveryObservation[],
  originalWorkerId: string,
  originalDeliveryId: string,
  recoveryAfterMs: number,
  clockSkewMs: number,
): void {
  positive(recoveryAfterMs, 'recoveryAfterMs')
  positive(clockSkewMs, 'clockSkewMs')
  if (!observations.length) fail('crash recovery requires observations')
  const events = observations.flatMap((o) => o.events)
  const acquired = [
    ...new Map(
      events
        .filter((e) => e.outcome === 'acquired')
        .map((e) => [`${e.deliveryId}:${e.workerId}:${e.attempt}`, e]),
    ).values(),
  ]
  if (acquired.length !== 2) fail('crash recovery requires exactly one replacement acquisition')
  const [first, replacement] = acquired
  if (
    first?.workerId !== originalWorkerId ||
    first.deliveryId !== originalDeliveryId ||
    first.attempt !== 1
  )
    fail('original owner was not acquired')
  if (
    !replacement?.workerId ||
    replacement.workerId === originalWorkerId ||
    !first.messageId ||
    replacement.messageId !== first.messageId ||
    !replacement.deliveryId ||
    replacement.deliveryId === originalDeliveryId
  )
    fail('replacement must be a distinct owner and redelivery of the original message')
  positive(replacement.at, 'replacement acquisition time')
  if (replacement.at - clockSkewMs < recoveryAfterMs)
    fail('replacement acquired before recovery expiry bound')
  if (
    observations.some((o) => o.status === 'COMPLETED' && o.attempt === 1) ||
    events.some(
      (e) => e.outcome === 'completed' && (e.attempt === 1 || e.workerId === originalWorkerId),
    )
  )
    fail('crashed attempt reported false completion')
  if (replacement.attempt !== 2 || observations.some((o) => o.attempt > 2))
    fail('replacement did not increment attempt once')
  const final = observations.at(-1)!
  if (
    final.status !== 'COMPLETED' ||
    final.attempt !== 2 ||
    final.workerId !== null ||
    final.leaseExpiresAtMs !== null
  )
    fail('recovery did not complete cleanly')
}
export interface HeartbeatObservation {
  outcome: string
  workerId: string
  attempt: number
  messageId: string
  deliveryId: string
  cycle: number
  at: number
  startedAtMs: number
  // Conservative local lower bounds from requests, NOT service expiry timestamps.
  leaseExpiresAtMs: number | null
  visibilityExpiresAtMs: number | null
  visibilityObservedAtMs: number
}
export const failureOutcomes = new Set([
  'heartbeat_failed',
  'ownership_lost',
  'retry_released',
  'final_failed',
  'cancelled',
  'panicked',
  'processing_error',
  'infrastructure_failure',
  'queue_update_failed',
  'unsupported_media_operation',
])
/** Count complete, distinct renewal cycles and reject observed ownership failures. */
export function assertHeartbeats(
  events: readonly HeartbeatObservation[],
  minimumCycles: number,
): void {
  if (!Number.isSafeInteger(minimumCycles) || minimumCycles < 2)
    fail('at least two heartbeat cycles are required')
  if (events.some((e) => e.outcome !== 'heartbeat_succeeded'))
    fail('heartbeat failure or incomplete cycle observed')
  if (events.length < minimumCycles)
    fail('workload was too short for the required heartbeat cycles')
  const first = events[0]!
  for (const [index, event] of events.entries()) {
    if (
      !event.workerId ||
      !event.messageId ||
      !event.deliveryId ||
      !Number.isSafeInteger(event.attempt) ||
      event.attempt < 1 ||
      event.workerId !== first.workerId ||
      event.attempt !== first.attempt ||
      event.messageId !== first.messageId ||
      event.deliveryId !== first.deliveryId
    )
      fail('heartbeat ownership changed during renewal')
    positive(event.at, 'heartbeat time')
    positive(event.startedAtMs, 'heartbeat request time')
    if (!Number.isSafeInteger(event.cycle) || event.cycle < 1 || event.startedAtMs > event.at)
      fail('heartbeat cycle or request time is invalid')
    for (const expiry of [event.leaseExpiresAtMs, event.visibilityExpiresAtMs]) {
      if (expiry === null || !Number.isFinite(expiry) || expiry <= event.at)
        fail('heartbeat expiry evidence is incomplete or expired')
    }
    const previous = events[index - 1]
    if (previous && (event.at <= previous.at || event.cycle <= previous.cycle))
      fail('heartbeat timestamps or cycles are not ordered')
    if (
      previous &&
      (event.leaseExpiresAtMs! <= previous.leaseExpiresAtMs! ||
        event.visibilityExpiresAtMs! <= previous.visibilityExpiresAtMs!)
    )
      fail('heartbeat did not extend expiry')
  }
}

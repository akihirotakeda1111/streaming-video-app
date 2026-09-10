/** Pure lifecycle calculations shared by crash and heartbeat observations. */

export interface ExpiryInput {
  databaseNowMs: number
  localObservedAtMs: number
  visibilityTimeoutMs: number
  leaseDurationMs: number
  clockSkewMs?: number
}

export interface ExpiryBounds {
  visibilityExpiresAtMs: number
  leaseExpiresAtMs: number
  recoveryAfterMs: number
}

const finitePositive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

/** Database time is authoritative; local observation time is only a safety bound. */
export function expiryBounds(input: ExpiryInput): ExpiryBounds {
  const databaseNowMs = finitePositive(input.databaseNowMs, 'databaseNowMs')
  const localObservedAtMs = finitePositive(input.localObservedAtMs, 'localObservedAtMs')
  const visibilityTimeoutMs = finitePositive(input.visibilityTimeoutMs, 'visibilityTimeoutMs')
  const leaseDurationMs = finitePositive(input.leaseDurationMs, 'leaseDurationMs')
  const clockSkewMs = input.clockSkewMs ?? 0
  if (!Number.isFinite(clockSkewMs) || clockSkewMs < 0) throw new Error('clockSkewMs must be non-negative')

  const databaseExpiry = databaseNowMs + leaseDurationMs
  const localVisibilityExpiry = localObservedAtMs + visibilityTimeoutMs
  return {
    visibilityExpiresAtMs: localVisibilityExpiry,
    leaseExpiresAtMs: databaseExpiry,
    recoveryAfterMs: Math.max(localVisibilityExpiry, databaseExpiry) + clockSkewMs,
  }
}

export interface LifecycleEvent {
  outcome: string
  at: number
  workerId?: string
  attempt?: number
  deliveryId?: string
}

export interface RecoveryObservation {
  at: number
  status: string
  attempt: number
  workerId: string | null
  leaseExpiresAtMs: number | null
  databaseNowMs: number
  events: readonly LifecycleEvent[]
}

const fail = (message: string): never => { throw new Error(message) }

export function assertCrashRecovery(
  observations: readonly RecoveryObservation[],
  originalWorkerId: string,
  originalDeliveryId: string,
): void {
  if (observations.length === 0) fail('crash recovery requires observations')
  const acquired = [...new Map(
    observations.flatMap((o) => o.events
      .filter((e) => e.outcome === 'acquired')
      .map((e) => ({ ...e, attempt: e.attempt ?? o.attempt })))
      .map((e) => [`${e.deliveryId ?? ''}:${e.workerId ?? ''}:${e.attempt ?? ''}`, e] as const),
  ).values()]
  if (acquired.length !== 2) fail('crash recovery requires exactly one replacement acquisition')
  const [first, replacement] = acquired
  if (first?.workerId !== originalWorkerId || first.deliveryId !== originalDeliveryId) fail('original owner was not acquired')
  if (!replacement?.workerId || replacement.workerId === originalWorkerId) fail('replacement owner is not distinct')
  if (observations.some((o) => o.status === 'COMPLETED' && o.attempt === 1)) fail('crashed attempt reported false completion')
  if (replacement.attempt !== 2 || observations.at(-1)?.attempt !== 2) fail('replacement did not increment attempt once')
  const final = observations.at(-1)!
  if (final.status !== 'COMPLETED' || final.workerId !== null || final.leaseExpiresAtMs !== null) fail('recovery did not complete cleanly')
}

export interface HeartbeatObservation {
  outcome: string
  workerId: string
  attempt: number
  at: number
  leaseExpiresAtMs: number | null
  visibilityExpiresAtMs: number | null
}

export function assertHeartbeats(
  events: readonly HeartbeatObservation[],
  minimumCycles: number,
): void {
  if (!Number.isSafeInteger(minimumCycles) || minimumCycles < 2) fail('at least two heartbeat cycles are required')
  const renewals = events.filter((e) => e.outcome === 'heartbeat_succeeded')
  if (renewals.length < minimumCycles) fail('workload was too short for the required heartbeat cycles')
  const owner = renewals[0]?.workerId
  const attempt = renewals[0]?.attempt
  if (!owner || !attempt || renewals.some((e) => e.workerId !== owner || e.attempt !== attempt)) fail('heartbeat ownership changed during renewal')
  for (const event of renewals) {
    if (event.leaseExpiresAtMs === null || event.visibilityExpiresAtMs === null) fail('heartbeat expiry evidence is incomplete')
  }
  if (renewals.some((event, index) => index > 0 && event.at <= renewals[index - 1]!.at)) fail('heartbeat timestamps are not ordered')
}

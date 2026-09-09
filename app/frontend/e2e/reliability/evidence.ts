import { randomUUID } from 'node:crypto'
import { safeDiagnostic, type SafeDiagnostic } from '../diagnostics.js'

export interface EvidenceRecord {
  runId: string
  videoId?: string
  jobId?: string
  workerId?: string
  attempt?: number
  stateTransitions: readonly { state: string; at: string }[]
  objectKeys: readonly string[]
  queueObservations: readonly string[]
  alarmObservations: readonly string[]
  timestamps: readonly string[]
  [key: string]: unknown
}

export interface CanonicalResource {
  kind: 'queue' | 'bucket-object' | 'database-record' | 'alarm' | 'fixture'
  id: string
  cleanup: () => void | Promise<void>
}

/** Run-scoped registry: cleanup can only reach exact canonical IDs registered by this run. */
export class RunResources {
  readonly runId = `e2e-${randomUUID()}`
  private readonly resources = new Map<string, CanonicalResource>()

  register(resource: CanonicalResource): string {
    if (!resource.id.trim() || /[*]|(?:^|\/)\.\.(?:\/|$)/.test(resource.id)) {
      throw new Error('resource ID must be a non-empty canonical identifier')
    }
    const key = `${resource.kind}:${resource.id}`
    if (this.resources.has(key)) throw new Error(`resource already registered: ${resource.kind}`)
    this.resources.set(key, resource)
    return resource.id
  }

  has(kind: CanonicalResource['kind'], id: string): boolean {
    return this.resources.has(`${kind}:${id}`)
  }

  async cleanup(): Promise<void> {
    const resources = [...this.resources.entries()].reverse()
    const errors: Error[] = []
    for (const [key, resource] of resources) {
      try {
        await resource.cleanup()
        this.resources.delete(key)
      } catch {
        // Retain failed entries for retry, without exposing raw service errors.
        errors.push(new Error(`cleanup failed for ${resource.kind}`))
      }
    }
    if (errors.length) throw new AggregateError(errors, 'run resource cleanup failed')
  }
}

export interface PollTimeoutEvidence<T> {
  timeoutMs: number
  startedAt: string
  endedAt: string
  lastObservation?: T
}

export class ObservationTimeout<T> extends Error {
  constructor(readonly evidence: PollTimeoutEvidence<T>) {
    super(`bounded observation timed out after ${evidence.timeoutMs}ms`)
    this.name = 'ObservationTimeout'
  }
}

/** Polls with a hard deadline and returns timeout evidence instead of running indefinitely. */
export async function observeUntil<T>(
  observe: (signal: AbortSignal) => Promise<T>,
  matches: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const intervalMs = options.intervalMs ?? 250
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('intervalMs must be positive and finite')
  const started = now()
  const startedAt = new Date(started).toISOString()
  let lastObservation: T | undefined
  const controller = new AbortController()
  const timeout = () => new ObservationTimeout({
    timeoutMs: options.timeoutMs,
    startedAt,
    endedAt: new Date(now()).toISOString(),
    lastObservation: safeDiagnostic({ lastObservation }).lastObservation,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeout())
      controller.abort()
    }, options.timeoutMs)
  })
  const poll = async () => {
    while (!controller.signal.aborted && now() - started < options.timeoutMs) {
      const observation = await observe(controller.signal)
      if (controller.signal.aborted) throw timeout()
      lastObservation = observation
      if (now() - started >= options.timeoutMs) break
      const matched = matches(lastObservation)
      if (now() - started >= options.timeoutMs) break
      if (matched) return lastObservation
      await sleep(Math.min(intervalMs, options.timeoutMs - (now() - started)))
    }
    throw timeout()
  }
  try {
    return await Promise.race([poll(), deadline])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export function createEvidence(runId: string, fields: Partial<EvidenceRecord> & { runId?: never } = {}): EvidenceRecord {
  if (!/^e2e-[0-9a-f-]+$/.test(runId)) throw new Error('runId must be a generated E2E run ID')
  return {
    stateTransitions: [],
    objectKeys: [],
    queueObservations: [],
    alarmObservations: [],
    timestamps: [new Date().toISOString()],
    ...fields,
    runId,
  }
}

/** Sanitizes evidence before it is logged or attached; unsafe values are never preserved. */
export function safeEvidence(value: SafeDiagnostic): SafeDiagnostic {
  return safeDiagnostic(value)
}

export interface WorkerTiming {
  visibilityTimeoutMs: number
  leaseTimeoutMs: number
  heartbeatIntervalMs: number
  retryDelayMs?: number
}

export interface ExpiryBounds {
  acquiredAtMs: number
  visibilityExpiresAtMs: number
  leaseExpiresAtMs: number
  recoveryEligibleAtMs: number
  deadlineAtMs: number
}

/** Derives recovery bounds from observed acquisition time and verified worker settings. */
export function expiryBounds(
  acquiredAtMs: number,
  timing: WorkerTiming,
  marginMs = timing.heartbeatIntervalMs,
): ExpiryBounds {
  const values = [acquiredAtMs, timing.visibilityTimeoutMs, timing.leaseTimeoutMs,
    timing.heartbeatIntervalMs, timing.retryDelayMs ?? 0, marginMs]
  if (!values.every(Number.isFinite) || !Number.isInteger(acquiredAtMs) || acquiredAtMs < 0
    || timing.visibilityTimeoutMs <= 0 || timing.leaseTimeoutMs <= 0
    || timing.heartbeatIntervalMs <= 0
    || timing.heartbeatIntervalMs >= Math.min(timing.visibilityTimeoutMs, timing.leaseTimeoutMs)
    || (timing.retryDelayMs !== undefined && timing.retryDelayMs <= 0) || marginMs < 0) {
    throw new Error('worker expiry settings must be finite positive values')
  }
  const visibilityExpiresAtMs = acquiredAtMs + timing.visibilityTimeoutMs
  const leaseExpiresAtMs = acquiredAtMs + timing.leaseTimeoutMs
  const recoveryEligibleAtMs = Math.max(visibilityExpiresAtMs, leaseExpiresAtMs)
  const deadlineAtMs = recoveryEligibleAtMs + (timing.retryDelayMs ?? 0) + marginMs
  if (![visibilityExpiresAtMs, leaseExpiresAtMs, deadlineAtMs].every(Number.isFinite)) {
    throw new Error('worker expiry bounds must be finite')
  }
  return {
    acquiredAtMs,
    visibilityExpiresAtMs,
    leaseExpiresAtMs,
    recoveryEligibleAtMs,
    deadlineAtMs,
  }
}

export interface CrashRecoveryEvidence {
  acquiredAtMs: number
  crashAtMs: number
  recoveryAtMs: number
  visibilityExpiredAtMs: number
  leaseExpiredAtMs: number
  attempts: readonly number[]
  owners: readonly string[]
  states: readonly string[]
  sourceKey: string
  manifestPublishedLast: boolean
}

/** Checks the invariants that make crash evidence meaningful, rather than timing-only evidence. */
export function assertCrashRecoveryEvidence(
  evidence: CrashRecoveryEvidence,
  timing: WorkerTiming,
  expectedSourceKey: string,
): void {
  const bounds = expiryBounds(evidence.acquiredAtMs, timing)
  if (![evidence.crashAtMs, evidence.recoveryAtMs, evidence.visibilityExpiredAtMs,
    evidence.leaseExpiredAtMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('recovery timestamps must be finite and non-negative')
  }
  if (evidence.crashAtMs <= evidence.acquiredAtMs) throw new Error('crash must follow acquisition')
  if (evidence.crashAtMs >= evidence.recoveryAtMs) throw new Error('recovery must follow crash')
  if (evidence.recoveryAtMs < bounds.recoveryEligibleAtMs) throw new Error('recovery preceded expiry gates')
  if (evidence.visibilityExpiredAtMs < bounds.visibilityExpiresAtMs
    || evidence.leaseExpiredAtMs < bounds.leaseExpiresAtMs
    || evidence.recoveryAtMs < Math.max(evidence.visibilityExpiredAtMs, evidence.leaseExpiredAtMs)) {
    throw new Error('expiry evidence is not correlated')
  }
  if (evidence.states[0] !== 'PROCESSING' || evidence.states.at(-1) !== 'COMPLETED'
    || evidence.states.slice(0, -1).some((state) => state !== 'PROCESSING')
    || !evidence.manifestPublishedLast) {
    throw new Error('completion requires manifest-last publication')
  }
  if (evidence.attempts.length !== 2
    || !evidence.attempts.every((attempt) => Number.isSafeInteger(attempt) && attempt > 0)
    || evidence.attempts[1] !== evidence.attempts[0] + 1) {
    throw new Error('recovery must increment the attempt exactly once')
  }
  if (new Set(evidence.owners).size !== 2 || evidence.owners.some((owner) => !owner.trim())) {
    throw new Error('recovery must identify exactly one replacement owner')
  }
  if (!expectedSourceKey.trim() || evidence.sourceKey !== expectedSourceKey) {
    throw new Error('recovery must restart from the canonical source')
  }
}

export interface HeartbeatEvidence {
  durationMs: number
  heartbeatIntervalMs: number
  visibilityExtensions: readonly string[]
  leaseRenewals: readonly string[]
  attempts: readonly number[]
  owners: readonly string[]
}

/** Checks that a long workload actually crossed multiple heartbeat cycles without reacquisition. */
export function assertLongHeartbeatEvidence(evidence: HeartbeatEvidence, timing: WorkerTiming): void {
  expiryBounds(0, timing)
  if (!Number.isFinite(evidence.heartbeatIntervalMs) || evidence.heartbeatIntervalMs <= 0
    || evidence.heartbeatIntervalMs !== timing.heartbeatIntervalMs) {
    throw new Error('heartbeat interval must match verified worker timing')
  }
  if (!Number.isFinite(evidence.durationMs) || evidence.durationMs <= timing.heartbeatIntervalMs * 2) {
    throw new Error('workload was too short to prove multiple heartbeat cycles')
  }
  if (evidence.visibilityExtensions.length < 2 || evidence.leaseRenewals.length < 2) {
    throw new Error('repeated visibility extensions and lease renewals are required')
  }
  if (evidence.attempts.length === 0 || new Set(evidence.attempts).size !== 1
    || !evidence.attempts.every((attempt) => Number.isSafeInteger(attempt) && attempt > 0)) {
    throw new Error('heartbeat renewals must not increment the attempt')
  }
  if (new Set(evidence.owners).size !== 1 || !evidence.owners[0]?.trim()) {
    throw new Error('heartbeat workload must have one owner')
  }
}

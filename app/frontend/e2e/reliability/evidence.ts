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

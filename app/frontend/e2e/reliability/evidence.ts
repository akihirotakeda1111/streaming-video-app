import { randomUUID } from 'node:crypto'
import { redactText, safeDiagnostic, type SafeDiagnostic } from '../diagnostics.js'

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
    const resources = [...this.resources.values()].reverse()
    for (const resource of resources) await resource.cleanup()
    this.resources.clear()
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
  observe: () => Promise<T>,
  matches: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const intervalMs = options.intervalMs ?? 250
  const started = now()
  const startedAt = new Date(started).toISOString()
  let lastObservation: T | undefined
  while (now() - started <= options.timeoutMs) {
    lastObservation = await observe()
    if (matches(lastObservation)) return lastObservation
    const remaining = options.timeoutMs - (now() - started)
    if (remaining <= 0) break
    await sleep(Math.min(intervalMs, remaining))
  }
  throw new ObservationTimeout({
    timeoutMs: options.timeoutMs,
    startedAt,
    endedAt: new Date(now()).toISOString(),
    lastObservation,
  })
}

export function createEvidence(runId: string, fields: Partial<EvidenceRecord> = {}): EvidenceRecord {
  if (!/^e2e-[0-9a-f-]+$/.test(runId)) throw new Error('runId must be a generated E2E run ID')
  return {
    runId,
    stateTransitions: [],
    objectKeys: [],
    queueObservations: [],
    alarmObservations: [],
    timestamps: [new Date().toISOString()],
    ...fields,
  }
}

/** Sanitizes evidence before it is logged or attached; unsafe values are never preserved. */
export function safeEvidence(value: SafeDiagnostic): SafeDiagnostic {
  return safeDiagnostic(JSON.parse(redactText(JSON.stringify(value))) as SafeDiagnostic)
}

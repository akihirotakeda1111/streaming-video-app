import type { DuplicateTarget, DuplicateSnapshot } from './duplicate-driver.js'
import type { PoisonDlqCorrelation } from './dlq-correlation.js'

export interface PoisonIdentity {
  kind: PoisonDlqCorrelation['kind']
  messageId?: string
  canonicalIds?: { videoId: string; jobId: string }
  bodySha256: string
  sentAt: string
}

export interface PoisonIsolationAdapter {
  processingMs: number
  deliveryMs: number
  dlqMs: number
  prepare(target: DuplicateTarget): Promise<void>
  sendPoison(): void
  poisonIdentities(): PoisonIdentity[]
  upload(): Promise<void>
  observeWithPoison(): Promise<DuplicateSnapshot & { poison: PoisonDlqCorrelation[] }>
  unknownJobCount(): number
  cleanup(): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}

export interface PoisonIsolationReport {
  target: DuplicateTarget
  poison: PoisonDlqCorrelation[]
  identities: PoisonIdentity[]
  observations: Array<{ observedAt: string; status: string; attempt: number; poisonCount: number }>
  unknownJobCount: number | null
  phase: 'prepare' | 'send' | 'upload' | 'observe' | 'complete'
  cleanup: 'pending' | 'complete' | 'retained'
  reason?: string
  cleanupReason?: string
}

export function poisonIsolationReport(target: DuplicateTarget): PoisonIsolationReport {
  return { target, poison: [], identities: [], observations: [], unknownJobCount: null, phase: 'prepare', cleanup: 'pending' }
}

const fail = (reason: string): never => { throw new Error(reason) }
const unhealthy = new Set(['retry_released', 'final_failed', 'ownership_lost', 'cancelled', 'panicked', 'processing_error', 'infrastructure_failure', 'queue_update_failed', 'unsupported_media_operation'])

export async function runPoisonIsolation(
  adapter: PoisonIsolationAdapter,
  target: DuplicateTarget,
  report = poisonIsolationReport(target),
): Promise<PoisonIsolationReport> {
  let failed = false
  try {
    await adapter.prepare(target)
    report.phase = 'send'
    adapter.sendPoison()
    report.identities = adapter.poisonIdentities()
    report.phase = 'upload'
    await adapter.upload()
    report.phase = 'observe'
    const deadline = adapter.now() + adapter.processingMs + adapter.deliveryMs + adapter.dlqMs
    const received = new Map<string, PoisonDlqCorrelation>()
    let acquired = false
    while (true) {
      const latest = await adapter.observeWithPoison()
      for (const message of latest.poison) {
        if (!received.has(message.messageId)) received.set(message.messageId, message)
      }
      report.poison = [...received.values()]
      report.observations.push({ observedAt: new Date().toISOString(), status: latest.job.status, attempt: latest.job.attempt, poisonCount: received.size })
      if (report.observations.length > 4000) report.observations.shift()
      report.unknownJobCount = adapter.unknownJobCount()
      const job = latest.job
      const waiting = !acquired && job.attempt === 0 && ['UPLOADING', 'QUEUED'].includes(job.status) && job.workerId === null && job.leaseMs === null
      const active = job.attempt === 1 && ['PROCESSING', 'COMPLETED'].includes(job.status)
      if (report.unknownJobCount !== 0 || (!waiting && !active) || latest.events.some((event) => unhealthy.has(event.outcome)))
        fail('Poison input affected the valid job or created an unknown job')
      acquired ||= job.attempt === 1
      if (received.size > 2) fail('Unexpected poison DLQ correlations')
      if (job.status === 'COMPLETED' && job.workerId === null && job.leaseMs === null && received.size === 2) {
        const kinds = new Set(report.poison.map((message) => message.kind))
        if (!kinds.has('malformed') || !kinds.has('unknown-job')) fail('Both run-owned poison messages were not correlated in the DLQ')
        break
      }
      if (adapter.now() >= deadline) fail('Poison isolation exceeded its bounded wait')
      await adapter.sleep(1000)
    }
    report.phase = 'complete'
  } catch (error) {
    failed = true
    report.reason = error instanceof Error ? error.message : 'Poison isolation failed'
    throw error
  } finally {
    report.identities = adapter.poisonIdentities()
    // prepare may have registered rows before failing. The adapter proves ownership
    // and quiescence, and refuses deletion after uncertain remote mutations.
    try {
      await adapter.cleanup()
      report.cleanup = 'complete'
    } catch (error) {
      report.cleanup = 'retained'
      report.cleanupReason = error instanceof Error ? error.message : 'Manual inspection required'
      if (!failed) throw error
    }
  }
  return report
}

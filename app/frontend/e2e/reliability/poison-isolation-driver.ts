import type { DuplicateTarget } from './duplicate-driver.js'
import { type DuplicateSnapshot } from './duplicate-driver.js'
import type { PoisonDlqCorrelation } from './dlq-correlation.js'

export interface PoisonIsolationAdapter {
  processingMs: number
  deliveryMs: number
  dlqMs: number
  prepare(target: DuplicateTarget): Promise<void>
  sendPoison(): void
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
  observations: Array<{ observedAt: string; status: string; attempt: number; poisonCount: number }>
  unknownJobCount: number
}

const fail = (reason: string): never => { throw new Error(reason) }

export async function runPoisonIsolation(adapter: PoisonIsolationAdapter, target: DuplicateTarget): Promise<PoisonIsolationReport> {
  await adapter.prepare(target)
  adapter.sendPoison()
  await adapter.upload()
  const observations: PoisonIsolationReport['observations'] = []
  const deadline = adapter.now() + adapter.processingMs + adapter.deliveryMs + adapter.dlqMs
  let latest: DuplicateSnapshot & { poison: PoisonDlqCorrelation[] }
  while (true) {
    latest = await adapter.observeWithPoison()
    const unknownJobCount = adapter.unknownJobCount()
    observations.push({ observedAt: new Date().toISOString(), status: latest.job.status, attempt: latest.job.attempt, poisonCount: latest.poison.length })
    if (observations.length > 4000) observations.shift()
    if (latest.job.status === 'COMPLETED' && latest.job.attempt === 1 && latest.job.workerId === null && latest.job.leaseMs === null && latest.poison.length === 2 && unknownJobCount === 0) break
    if (unknownJobCount !== 0 || latest.job.attempt !== 1 || latest.job.status === 'FAILED' || latest.events.some((event) => ['retry_released', 'final_failed', 'processing_error', 'infrastructure_failure'].includes(event.outcome))) fail('Poison input affected the valid job or created an unknown job')
    if (adapter.now() >= deadline) fail('Poison isolation exceeded its bounded wait')
    await adapter.sleep(1000)
  }
  const kinds = new Set(latest.poison.map((message) => message.kind))
  if (kinds.size !== 2 || !kinds.has('malformed') || !kinds.has('unknown-job')) fail('Both run-owned poison messages were not correlated in the DLQ')
  await adapter.cleanup()
  return { target, poison: latest.poison, observations, unknownJobCount: adapter.unknownJobCount() }
}

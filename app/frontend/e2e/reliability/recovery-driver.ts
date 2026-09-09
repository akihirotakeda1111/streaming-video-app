import { randomUUID } from 'node:crypto'

export type Scenario = 'crash-recovery' | 'long-heartbeat'
export interface Event {
  at: number; outcome: string; worker_id?: string; attempt?: number; message_id?: string
  source_key?: string; object_key?: string; visibility_seconds?: number; lease_expires_at_ms?: number
}
export interface Job {
  status: string; attempt: number; worker_id: string | null; leaseMs: number | null; databaseNowMs: number
}
export interface Target { runId: string; videoId: string; jobId: string; sourceKey: string; prefix: string }
export interface Snapshot { events: Event[]; job: Job }
export interface RecoveryAdapter {
  heartbeatMs: number; maximumAttempts: number; processingTimeoutMs: number; recoveryTimeoutMs: number
  prepare(target: Target): Promise<void>
  upload(): Promise<void>
  observe(): Promise<Snapshot>
  crash(): Promise<void>
  restore(): Promise<void>
  verifyOutput(keys: string[]): Promise<void>
  cleanup(): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}
export interface RecoveryReport {
  runId: string; scenario: Scenario; target: Target; status: 'running' | 'passed' | 'failed'
  scenarioStarted: boolean; cleanup: 'pending' | 'complete' | 'retained'; restored: boolean
  events: Event[]; observations: Job[]; reason?: string
  verification?: unknown
  controls?: { action: string; at: string }[]
  expiryGates?: { visibilityAtMs: number; leaseAtMs: number }
}
const fail = (message: string): never => { throw new Error(message) }
export function targetForRun(runId: string): Target {
  if (!/^e2e-[0-9a-f-]{36}$/.test(runId)) fail('invalid generated run ID')
  const videoId = randomUUID(), jobId = randomUUID()
  const prefix = `videos/${videoId}/jobs/${jobId}/`
  return { runId, videoId, jobId, prefix, sourceKey: prefix + 'source.mp4' }
}
function records(events: Event[], outcome: string, attempt?: number) {
  return events.filter(e => e.outcome === outcome && (attempt === undefined || e.attempt === attempt))
}
export function validateCompletion(snapshot: Snapshot, target: Target, expectedAttempts: number, heartbeatMs: number): string[] {
  const { events, job } = snapshot
  if (job.status !== 'COMPLETED' || job.worker_id !== null || job.leaseMs !== null || job.attempt !== expectedAttempts) fail('durable completion or ownership does not match')
  const acquisitions = records(events, 'acquisition_observed')
  if (acquisitions.length !== expectedAttempts || acquisitions.some((e, i) => e.attempt !== i + 1)
    || new Set(acquisitions.map(e => e.worker_id)).size !== expectedAttempts) fail('unexpected acquisition or overlapping owner')
  const last = acquisitions.at(-1)!
  if (!last.worker_id) fail('missing acquired owner')
  if (events.some(e => e.attempt !== undefined && e.worker_id !== acquisitions[e.attempt - 1]?.worker_id)) fail('event owner does not match acquired attempt')
  const receipts = records(events, 'queue_received')
  if (!receipts.length || receipts.some(e => !e.message_id) || new Set(receipts.map(e => e.message_id)).size !== 1) fail('queue message identity is not correlated')
  const scoped = events.filter(e => e.attempt === expectedAttempts && e.worker_id === last.worker_id)
  const source = records(scoped, 'source_downloaded')
  const starts = records(scoped, 'encode_started'), finishes = records(scoped, 'encode_finished')
  if (source.length !== 1 || source[0]!.source_key !== target.sourceKey || starts.length !== 1 || finishes.length !== 1
    || source[0]!.at > starts[0]!.at || finishes[0]!.at < starts[0]!.at) fail('canonical source and real encode evidence missing')
  const published = scoped.filter(e => ['segment_published', 'manifest_published'].includes(e.outcome))
  const completed = records(scoped, 'completed')
  const segments = published.slice(0, -1)
  if (!segments.length || segments.some((e, i) => e.outcome !== 'segment_published' || e.object_key !== target.prefix + `hls/segment-${String(i).padStart(5, '0')}.ts`)
    || published.at(-1)?.outcome !== 'manifest_published' || published.at(-1)?.object_key !== target.prefix + 'hls/index.m3u8'
    || completed.length !== 1 || completed[0]!.at < published.at(-1)!.at
    || published[0]!.at < finishes[0]!.at) fail('manifest-last publication evidence missing')
  if (!records(events, 'record_acknowledged').length) fail('run message acknowledgement not observed')
  if (events.some(e => e.attempt && (e.attempt < 1 || e.attempt > expectedAttempts)
    || ['retry_released', 'final_failed', 'ownership_lost', 'processing_error', 'infrastructure_failure', 'panicked'].includes(e.outcome))) fail('unexpected attempt failure')
  if (expectedAttempts === 1) {
    if (finishes[0]!.at - starts[0]!.at <= 2 * heartbeatMs) fail('encode too short for multiple heartbeat cycles')
    for (const outcome of ['lease_renewed', 'visibility_extended']) {
      const ticks = records(scoped, outcome).filter(e => e.at >= starts[0]!.at && e.at <= finishes[0]!.at)
      if (ticks.length < 2 || ticks.at(-1)!.at <= ticks[0]!.at) fail('multiple successful heartbeat cycles not observed')
    }
  }
  return published.map(e => e.object_key!)
}

/** Bounded observations replace fixed expiry sleeps. */
export async function runRecovery(scenario: Scenario, adapter: RecoveryAdapter, report: RecoveryReport): Promise<void> {
  const { target } = report
  const control = (action: string) => (report.controls ??= []).push({ action, at: new Date(adapter.now()).toISOString() })
  let uploadAttempted = false, snapshot: Snapshot | undefined
  const read = async () => {
    snapshot = await adapter.observe()
    report.events = snapshot.events
    report.observations.push(snapshot.job)
    if (report.observations.length > 4000) report.observations.shift()
    return snapshot
  }
  const until = async (budget: number, matches: (s: Snapshot) => boolean) => {
    const deadline = adapter.now() + budget
    while (adapter.now() < deadline) {
      const s = await read()
      if (adapter.now() >= deadline) break
      if (matches(s)) return s
      await adapter.sleep(Math.min(250, deadline - adapter.now()))
    }
    return fail('bounded recovery observation timed out')
  }
  try {
    if (scenario === 'crash-recovery' && adapter.maximumAttempts < 2) fail('crash recovery needs remaining attempt budget')
    await adapter.prepare(target)
    report.scenarioStarted = true
    uploadAttempted = true
    await adapter.upload()
    if (scenario === 'crash-recovery') {
      const active = await until(adapter.processingTimeoutMs, s => {
        if (s.job.status === 'COMPLETED' || records(s.events, 'encode_finished', 1).length) fail('encode finished before safe crash injection')
        return s.job.status === 'PROCESSING' && s.job.attempt === 1 && records(s.events, 'encode_started', 1).length === 1
          && records(s.events, 'visibility_extended', 1).length > 0 && records(s.events, 'lease_renewed', 1).length > 0
      })
      if (!active.job.worker_id || !active.job.leaseMs || active.job.leaseMs <= active.job.databaseNowMs) fail('crash target is not an active owner')
      control('crash-requested')
      await adapter.crash()
      control('crash-confirmed')
      const stopped = await read()
      if (stopped.job.status !== 'PROCESSING' || stopped.job.attempt !== 1 || stopped.job.worker_id !== active.job.worker_id
        || records(stopped.events, 'completed', 1).length) fail('crash raced with completion')
      const receipts = records(stopped.events, 'queue_received')
      if (receipts.length !== 1 || !receipts[0]!.message_id) fail('original queue delivery is not uniquely correlated')
      const visibility = stopped.events.filter(e => e.outcome === 'queue_received' || e.outcome === 'visibility_extended')
      if (visibility.some(e => !Number.isFinite(e.at) || !e.visibility_seconds || e.visibility_seconds <= 0)) fail('visibility deadline evidence missing')
      const expires = Math.max(...visibility.map(e => e.at + e.visibility_seconds! * 1000))
      if (!stopped.job.leaseMs) fail('stopped owner lease expiry missing')
      report.expiryGates = { visibilityAtMs: expires, leaseAtMs: stopped.job.leaseMs! }
      await until(adapter.recoveryTimeoutMs, s => {
        if (s.job.status !== 'PROCESSING' || s.job.attempt !== 1 || s.job.worker_id !== active.job.worker_id) fail('unexpected owner while worker is stopped')
        return s.job.leaseMs !== null && s.job.databaseNowMs >= s.job.leaseMs && adapter.now() >= expires + 1000
      })
      control('restore-requested-after-expiry')
      await adapter.restore()
      control('restore-confirmed')
      report.restored = true
      const recovered = await until(adapter.processingTimeoutMs, s => s.job.status === 'COMPLETED' && records(s.events, 'record_acknowledged').length > 0)
      const redelivery = records(recovered.events, 'queue_received')
      if (redelivery.length < 2 || redelivery.some(e => e.message_id !== receipts[0]!.message_id)) fail('recovery did not use original message redelivery')
      const replacement = records(recovered.events, 'acquisition_observed', 2)
      if (replacement.length !== 1 || replacement[0]!.worker_id === active.job.worker_id || replacement[0]!.at < expires) fail('replacement owner or expiry correlation failed')
    } else {
      await until(adapter.processingTimeoutMs, s => s.job.status === 'COMPLETED' && records(s.events, 'record_acknowledged').length > 0)
    }
    const keys = validateCompletion(snapshot!, target, scenario === 'crash-recovery' ? 2 : 1, adapter.heartbeatMs)
    await adapter.verifyOutput(keys)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.reason = error instanceof Error ? error.message : 'recovery scenario failed'
  } finally {
    try { await adapter.restore(); report.restored = true } catch { report.reason = 'worker restoration failed'; report.status = 'failed' }
    try {
      if (uploadAttempted && !snapshot?.events.some(e => e.outcome === 'record_acknowledged')) {
        await until(adapter.processingTimeoutMs, s => s.job.status === 'COMPLETED' && records(s.events, 'record_acknowledged').length > 0)
      }
      await adapter.cleanup()
      report.cleanup = 'complete'
    } catch { report.cleanup = 'retained'; report.status = 'failed'; report.reason ??= 'run resources retained for scoped recovery' }
  }
  if (report.status !== 'passed') fail(report.reason || 'recovery scenario failed')
}

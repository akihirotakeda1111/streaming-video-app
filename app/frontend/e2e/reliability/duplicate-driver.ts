import { randomUUID } from 'node:crypto'

export interface DuplicateTarget {
  runId: string
  videoId: string
  jobId: string
  sourceKey: string
  prefix: string
}
export interface DuplicateEvent {
  at: number
  outcome: string
  messageId: string
  deliveryId: string
  workerId?: string
  attempt?: number
}
export interface DuplicateJob {
  status: string
  attempt: number
  workerId: string | null
  leaseMs: number | null
  observedAtMs: number
  updatedAtMs: number
}
export interface DuplicateSnapshot {
  job: DuplicateJob
  events: DuplicateEvent[]
}
export interface DuplicateAdapter {
  processingMs: number
  deliveryMs: number
  prepare(target: DuplicateTarget): Promise<void>
  upload(): Promise<void>
  sendDuplicate(): Promise<string>
  observe(): Promise<DuplicateSnapshot>
  verifyOutput(keys: string[]): Promise<void>
  cleanup(): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}
export interface DuplicateReport {
  target: DuplicateTarget
  status: 'running' | 'passed' | 'unverified'
  cleanup: 'pending' | 'complete' | 'retained'
  scenarioStarted: boolean
  messages: { original?: string; busy?: string; completed?: string }
  observations: DuplicateJob[]
  events: DuplicateEvent[]
  reason?: string
}
export function duplicateTarget(runId: string): DuplicateTarget {
  if (!/^e2e-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(runId)) throw new Error('Invalid generated run ID')
  const videoId = randomUUID(),
    jobId = randomUUID()
  const prefix = `videos/${videoId}/jobs/${jobId}/`
  return { runId, videoId, jobId, prefix, sourceKey: prefix + 'source.mp4' }
}
export const sideEffects = new Set([
  'download_started',
  'source_downloaded',
  'encode_started',
  'encode_finished',
  'segment_upload_started',
  'segment_published',
  'manifest_upload_started',
  'manifest_published',
])
const fail = (reason: string): never => {
  throw new Error(reason)
}
const records = (s: DuplicateSnapshot, outcome: string) =>
  s.events.filter((e) => e.outcome === outcome)

/** The latest observed delivery must actually finish deletion, not merely enter already_completed. */
export function acknowledged(s: DuplicateSnapshot, id: string): boolean {
  const events = s.events.filter((e) => e.messageId === id)
  const deliveries = [...new Set(events.map((e) => e.deliveryId))]
  const latest = deliveries.at(-1)
  return (
    latest !== undefined &&
    events.filter((e) => e.deliveryId === latest).at(-1)?.outcome === 'deleted'
  )
}
function healthy(s: DuplicateSnapshot): void {
  if (
    s.job.attempt > 1 ||
    s.job.status === 'FAILED' ||
    s.events.some((e) =>
      [
        'retry_released',
        'final_failed',
        'ownership_lost',
        'cancelled',
        'panicked',
        'processing_error',
        'infrastructure_failure',
        'queue_update_failed',
        'unsupported_media_operation',
      ].includes(e.outcome),
    )
  ) {
    fail('Unexpected retry, ownership loss, or processing failure')
  }
}
export function validateDuplicateResult(s: DuplicateSnapshot, report: DuplicateReport): string[] {
  healthy(s)
  const { original, busy, completed } = report.messages
  if (!original || !busy || !completed || new Set([original, busy, completed]).size !== 3)
    fail('Three distinct message identities are required')
  if (
    s.job.status !== 'COMPLETED' ||
    s.job.attempt !== 1 ||
    s.job.workerId !== null ||
    s.job.leaseMs !== null
  )
    fail('Durable completion changed')
  const acquired = records(s, 'acquired')
  if (
    acquired.length !== 1 ||
    acquired[0]!.attempt !== 1 ||
    !acquired[0]!.workerId ||
    acquired[0]!.messageId !== original
  )
    fail('Expected one acquired owner')
  const work = s.events.filter((e) => sideEffects.has(e.outcome) || e.outcome === 'completed')
  if (
    work.some(
      (e) =>
        e.messageId !== original ||
        e.deliveryId !== acquired[0]!.deliveryId ||
        e.workerId !== acquired[0]!.workerId ||
        e.attempt !== 1,
    )
  )
    fail('Duplicate performed media work or changed owner')
  for (const outcome of [
    'download_started',
    'source_downloaded',
    'encode_started',
    'encode_finished',
    'completed',
  ]) {
    if (records(s, outcome).length !== 1) fail('Media processing count is not exactly one')
  }
  const started = records(s, 'download_started')[0]!,
    downloaded = records(s, 'source_downloaded')[0]!
  const encode = records(s, 'encode_started')[0]!,
    encoded = records(s, 'encode_finished')[0]!
  if (!(
    acquired[0]!.at <= started.at &&
    started.at <= downloaded.at &&
    downloaded.at <= encode.at &&
    encode.at <= encoded.at
  ))
    fail('Processing order is invalid')
  const uploads = work.filter(
    (e) => e.outcome.includes('upload_started') || e.outcome.endsWith('_published'),
  )
  if (uploads.length < 4 || uploads.length % 2) fail('Publication evidence is incomplete')
  const keys: string[] = []
  // Spec 25 logs upload counts/order, not keys. Derive expected canonical keys;
  // verifyOutput must independently compare them with actual S3 objects.
  for (let i = 0; i < uploads.length; i += 2) {
    const last = i === uploads.length - 2
    const name = last ? 'manifest' : 'segment'
    const key =
      report.target.prefix +
      'hls/' +
      (last ? 'index.m3u8' : `segment-${String(i / 2).padStart(5, '0')}.ts`)
    const a = uploads[i]!,
      b = uploads[i + 1]!
    if (
      a.outcome !== `${name}_upload_started` ||
      b.outcome !== `${name}_published` ||
      a.at > b.at ||
      a.at < (i ? uploads[i - 1]!.at : encoded.at)
    )
      fail('Segments and manifest were not published once in order')
    keys.push(key)
  }
  const completion = records(s, 'completed')[0]!
  if (completion.at < uploads.at(-1)!.at) fail('Completion preceded manifest publication')
  for (const id of [original, busy, completed]) {
    if (!acknowledged(s, id!)) fail('A run message has not been acknowledged')
  }
  if (
    !s.events.some(
      (e) =>
        e.messageId === busy &&
        e.outcome === 'busy' &&
        e.at >= acquired[0]!.at &&
        e.at <= completion.at,
    )
  )
    fail('Active duplicate was not observed busy')
  const post = s.events.filter((e) => e.messageId === completed)
  if (
    !post.some((e) => e.outcome === 'already_completed') ||
    post.some((e) => e.at < completion.at || !['already_completed', 'deleted'].includes(e.outcome))
  )
    fail('Post-completion delivery did more than acknowledge')
  return keys
}

/** No queue-wide receive/purge and no process controls are needed for duplicate delivery. */
export async function runDuplicate(
  adapter: DuplicateAdapter,
  report: DuplicateReport,
): Promise<void> {
  const read = async () => {
    const s = await adapter.observe()
    report.events = s.events
    report.observations.push(s.job)
    if (report.observations.length > 4000) report.observations.shift()
    return s
  }
  const until = async (budget: number, accept: (s: DuplicateSnapshot) => boolean) => {
    const deadline = adapter.now() + budget
    while (adapter.now() < deadline) {
      const s = await read()
      healthy(s)
      if (adapter.now() >= deadline) break
      if (accept(s)) return s
      await adapter.sleep(Math.min(250, deadline - adapter.now()))
    }
    return fail('Bounded duplicate observation timed out')
  }
  try {
    await adapter.prepare(report.target)
    report.scenarioStarted = true
    await adapter.upload()
    const active = await until(adapter.processingMs, (s) => {
      if (s.job.status === 'COMPLETED')
        fail('Encode finished before duplicate injection; use a longer fixture')
      return s.job.status === 'PROCESSING' && records(s, 'encode_started').length === 1
    })
    const acquisition = records(active, 'acquired')
    if (
      acquisition.length !== 1 ||
      active.job.attempt !== 1 ||
      !active.job.workerId ||
      !active.job.leaseMs ||
      active.job.leaseMs <= active.job.observedAtMs ||
      acquisition[0]!.workerId !== active.job.workerId
    )
      fail('Active owner cannot be established')
    report.messages.original = acquisition[0]!.messageId
    report.messages.busy = await adapter.sendDuplicate()
    await until(adapter.deliveryMs, (s) => {
      if (
        s.job.status !== 'PROCESSING' ||
        s.job.attempt !== 1 ||
        s.job.workerId !== active.job.workerId ||
        !s.job.leaseMs ||
        s.job.leaseMs <= s.job.observedAtMs
      )
        fail('Busy delivery not proven while the original lease was active')
      const duplicate = s.events.filter((e) => e.messageId === report.messages.busy)
      if (
        duplicate.some(
          (e) => sideEffects.has(e.outcome) || e.outcome === 'acquired' || e.outcome === 'deleted',
        )
      )
        fail('Active duplicate performed work or was acknowledged')
      return duplicate.some((e) => e.outcome === 'busy') && duplicate.at(-1)?.outcome === 'retained'
    })
    const done = await until(
      adapter.processingMs + adapter.deliveryMs,
      (s) =>
        s.job.status === 'COMPLETED' &&
        acknowledged(s, report.messages.original!) &&
        acknowledged(s, report.messages.busy!),
    )
    if (done.job.workerId !== null || done.job.leaseMs !== null || done.job.attempt !== 1)
      fail('Completion did not clear ownership')
    report.messages.completed = await adapter.sendDuplicate()
    const final = await until(adapter.deliveryMs, (s) =>
      acknowledged(s, report.messages.completed!),
    )
    if (final.job.updatedAtMs !== done.job.updatedAtMs)
      fail('Completed redelivery overwrote the durable job')
    await adapter.verifyOutput(validateDuplicateResult(final, report))
    report.status = 'passed'
  } catch (error) {
    report.status = 'unverified'
    report.reason = error instanceof Error ? error.message : 'Duplicate scenario failed'
  } finally {
    try {
      await adapter.cleanup()
      report.cleanup = 'complete'
    } catch {
      report.cleanup = 'retained'
      report.status = 'unverified'
      report.reason ??= 'Run resources retained for manual recovery'
    }
  }
  if (report.status !== 'passed') fail(report.reason || 'Duplicate scenario unverified')
}

import type { DuplicateEvent, DuplicateTarget } from './duplicate-driver.js'
import type { DlqCorrelation } from './dlq-correlation.js'

export interface ExhaustionJob {
  status: string
  attempt: number
  failure: string | null
  updatedAtMs: number
}
export interface ExhaustionSnapshot { job: ExhaustionJob; events: DuplicateEvent[]; dlq: DlqCorrelation[] }
export interface ExhaustionAdapter {
  attempts: number
  processingMs: number
  prepare(target: DuplicateTarget): Promise<void>
  uploadInvalidMedia(): Promise<void>
  observe(): Promise<ExhaustionSnapshot>
  hasManifest(target: DuplicateTarget): Promise<boolean>
  cleanup(): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}

const fail = (reason: string): never => { throw new Error(reason) }
const failureOutcomes = new Set(['encode_started', 'encode_finished', 'segment_upload_started', 'segment_published', 'manifest_upload_started', 'manifest_published', 'completed'])

export function validateExhaustionResult(initial: ExhaustionSnapshot, final: ExhaustionSnapshot, target: DuplicateTarget, maximumAttempts = final.job.attempt): void {
  for (const snapshot of [initial, final]) {
    if (snapshot.job.status !== 'FAILED' || snapshot.job.attempt !== maximumAttempts || snapshot.job.attempt < 1 || !snapshot.job.failure?.trim()) fail('FFmpeg exhaustion did not produce durable FAILED with details')
  }
  if (final.events.filter((event) => failureOutcomes.has(event.outcome)).some((event) => event.messageId !== final.events.find((candidate) => candidate.outcome === 'acquired')?.messageId)) fail('Media work is not correlated to the owned message')
  if (final.dlq.length !== 1 || final.dlq[0]?.jobId !== target.jobId || final.dlq[0]?.videoId !== target.videoId || final.dlq[0]?.sourceKey !== target.sourceKey) fail('Run-owned DLQ message was not correlated exactly')
}

export async function runFfmpegExhaustion(adapter: ExhaustionAdapter, target: DuplicateTarget): Promise<void> {
  await adapter.prepare(target)
  await adapter.uploadInvalidMedia()
  const initial = await adapter.observe()
  const deadline = adapter.now() + adapter.processingMs
  let final = initial
  while (adapter.now() < deadline) {
    final = await adapter.observe()
    if (final.job.status === 'FAILED' && final.dlq.length === 1) break
    await adapter.sleep(250)
  }
  if (final.job.status !== 'FAILED' || final.dlq.length !== 1) fail('FFmpeg exhaustion or DLQ isolation exceeded its bounded wait')
  if (await adapter.hasManifest(target)) fail('Failed job exposed a manifest')
  const terminalAttempt = final.job.attempt
  await adapter.sleep(250)
  const stable = await adapter.observe()
  if (stable.job.status !== 'FAILED' || stable.job.attempt !== terminalAttempt) fail('Terminal failure continued processing or acquiring attempts')
  validateExhaustionResult(stable, stable, target, adapter.attempts)
}

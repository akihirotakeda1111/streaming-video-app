import type { DuplicateEvent, DuplicateTarget } from './duplicate-driver.js'
import type { DlqCorrelation } from './dlq-correlation.js'

export interface ExhaustionJob {
  status: string
  attempt: number
  failure: string | null
  updatedAtMs: number
}
export interface ExhaustionSnapshot {
  job: ExhaustionJob
  events: DuplicateEvent[]
  dlq: DlqCorrelation[]
}
export interface ExhaustionAdapter {
  attempts: number
  processingMs: number
  exhaustionMs: number
  stabilityMs: number
  prepare(target: DuplicateTarget): Promise<void>
  uploadInvalidMedia(): Promise<void>
  observe(receiveDlq?: boolean): Promise<ExhaustionSnapshot>
  hasManifest(target: DuplicateTarget): Promise<boolean>
  cleanup(): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}

const fail = (reason: string): never => {
  throw new Error(reason)
}
const unexpected = new Set([
  'encode_finished',
  'segment_upload_started',
  'segment_published',
  'manifest_upload_started',
  'manifest_published',
  'completed',
])

/** Shares the processing budget across attempts, then adds retry and redrive waits. */
export function exhaustionBudget(
  attempts: number,
  processingMs: number,
  retryMs: number,
  visibilityMs: number,
  dlqMs: number,
): number {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 10 ||
    ![processingMs, retryMs, visibilityMs, dlqMs].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 900000,
    )
  )
    fail('Invalid exhaustion wait budgets')
  return processingMs + (attempts - 1) * retryMs + visibilityMs + dlqMs
}

/** Requires encoding and failure on each acquired delivery, without publication. */
export function validateExhaustionResult(
  initial: ExhaustionSnapshot,
  final: ExhaustionSnapshot,
  target: DuplicateTarget,
  maximumAttempts: number,
): void {
  for (const snapshot of [initial, final]) {
    if (
      snapshot.job.status !== 'FAILED' ||
      snapshot.job.attempt !== maximumAttempts ||
      maximumAttempts < 1 ||
      !/^encode HLS: ffmpeg exited with status -?[1-9][0-9]*$/.test(snapshot.job.failure || '')
    )
      fail('FFmpeg exhaustion did not produce durable FAILED with encoding details')
  }
  if (
    initial.job.updatedAtMs !== final.job.updatedAtMs ||
    initial.job.failure !== final.job.failure
  )
    fail('Terminal failure changed after exhaustion')
  if (final.events.some((event) => unexpected.has(event.outcome)))
    fail('Invalid media unexpectedly encoded or published output')
  const acquired = final.events.filter((event) => event.outcome === 'acquired')
  if (
    acquired.length !== maximumAttempts ||
    new Set(acquired.map((e) => e.attempt)).size !== maximumAttempts
  )
    fail('Missing bounded acquisition evidence')
  if (final.events.filter((event) => event.outcome === 'encode_started').length !== maximumAttempts)
    fail('Unexpected encoding count')
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const owner = acquired.find((event) => event.attempt === attempt)
    if (!owner) return fail('Missing bounded acquisition evidence')
    const events = final.events.filter(
      (event) => event.deliveryId === owner.deliveryId && event.messageId === owner.messageId,
    )
    // One worker log stream preserves emission order; UTC clocks can move backwards.
    const ownerIndex = events.indexOf(owner)
    const encodeIndex = events.findIndex(
      (event) => event.outcome === 'encode_started' && event.attempt === attempt,
    )
    const outcome = attempt === maximumAttempts ? 'final_failed' : 'retry_released'
    const failureIndex = events.findIndex(
      (event) => event.outcome === outcome && event.attempt === attempt,
    )
    if (encodeIndex <= ownerIndex || failureIndex <= encodeIndex)
      fail(
        `Missing correlated FFmpeg failure evidence: attempt ${attempt}; expected acquired -> encode_started -> ${outcome} in log order`,
      )
  }
  const terminalIndex = final.events.findIndex(
    (event) => event.outcome === 'final_failed' && event.attempt === maximumAttempts,
  )
  if (
    terminalIndex < 0 ||
    final.events
      .slice(terminalIndex + 1)
      .some((event) => ['acquired', 'encode_started'].includes(event.outcome))
  )
    fail('Terminal failure continued processing')
  if (
    final.dlq.length !== 1 ||
    final.dlq[0]?.jobId !== target.jobId ||
    final.dlq[0]?.videoId !== target.videoId ||
    final.dlq[0]?.sourceKey !== target.sourceKey
  )
    fail('Run-owned DLQ message was not correlated exactly')
}

/** Retains received DLQ evidence while checking terminal stability independently. */
export async function runFfmpegExhaustion(
  adapter: ExhaustionAdapter,
  target: DuplicateTarget,
): Promise<void> {
  await adapter.prepare(target)
  await adapter.uploadInvalidMedia()
  const deadline = adapter.now() + adapter.exhaustionMs
  const received = new Map<string, DlqCorrelation>()
  let final: ExhaustionSnapshot
  while (true) {
    final = await adapter.observe()
    for (const message of final.dlq) received.set(message.messageId, message)
    final = { ...final, dlq: [...received.values()] }
    if (received.size > 1) fail('Multiple run-owned DLQ messages observed')
    if (await adapter.hasManifest(target)) fail('Failed job exposed a manifest')
    if (final.job.status === 'FAILED' && received.size === 1) break
    if (adapter.now() >= deadline)
      fail('FFmpeg exhaustion or DLQ isolation exceeded its bounded wait')
    await adapter.sleep(1000)
  }
  validateExhaustionResult(final, final, target, adapter.attempts)
  const stableUntil = adapter.now() + adapter.stabilityMs
  do {
    await adapter.sleep(Math.min(1000, Math.max(1, stableUntil - adapter.now())))
    const stable = await adapter.observe(false)
    validateExhaustionResult(final, { ...stable, dlq: final.dlq }, target, adapter.attempts)
    if (await adapter.hasManifest(target)) fail('Failed job exposed a manifest')
  } while (adapter.now() < stableUntil)
}

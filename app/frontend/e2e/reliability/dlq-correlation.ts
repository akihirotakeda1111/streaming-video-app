import { execFileSync } from 'node:child_process'

export interface RunMessageIdentity {
  messageId: string
  body: string
  receivedAt: string
  receiveCount?: number
}

export interface DlqCorrelation {
  messageId: string
  receivedAt: string
  receiveCount?: number
  jobId?: string
  videoId?: string
  sourceKey?: string
}

export interface DlqTarget {
  jobId: string
  videoId: string
  sourceKey: string
  sourceBucket: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const messageId = /^[A-Za-z0-9-]{1,128}$/
const key = /^videos\/[0-9a-f-]{36}\/jobs\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]{1,512}$/

/**
 * Correlates only a message owned by this run. The body and receipt handle are
 * deliberately not returned, so this is safe to attach as evidence. Receiving
 * temporarily changes visibility; callers must use this only in a gated,
 * disposable run and must never replay or delete messages here.
 */
export function correlateRunOwnedDlq(
  messages: readonly RunMessageIdentity[],
  target: DlqTarget,
): DlqCorrelation[] {
  if (
    !uuid.test(target.jobId) ||
    !uuid.test(target.videoId) ||
    !key.test(target.sourceKey) ||
    !target.sourceKey.startsWith(`videos/${target.videoId}/jobs/${target.jobId}/`) ||
    typeof target.sourceBucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.sourceBucket)
  )
    throw new Error('Noncanonical DLQ correlation target')
  const result: DlqCorrelation[] = []
  for (const message of messages) {
    if (
      !messageId.test(message.messageId) ||
      !Number.isFinite(Date.parse(message.receivedAt)) ||
      typeof message.body !== 'string' ||
      message.body.length > 256 * 1024
    )
      throw new Error('Malformed bounded DLQ observation')
    let body: any
    try {
      body = JSON.parse(message.body)
    } catch {
      continue
    }
    if (!Array.isArray(body?.Records)) continue
    const matching = body.Records.filter((record: any) => {
      if (
        record?.eventSource !== 'aws:s3' ||
        !/^ObjectCreated:/.test(record.eventName || '') ||
        typeof record.s3?.object?.key !== 'string'
      )
        return false
      let decoded: string
      try {
        decoded = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))
      } catch {
        return false
      }
      return decoded === target.sourceKey && record.s3.bucket?.name === target.sourceBucket
    })
    if (!matching.length) continue
    if (body.Records.length !== 1) throw new Error('DLQ message is only partially correlated')
    const row: DlqCorrelation = {
      messageId: message.messageId,
      receivedAt: new Date(message.receivedAt).toISOString(),
    }
    if (message.receiveCount !== undefined) {
      if (!Number.isSafeInteger(message.receiveCount) || message.receiveCount < 1)
        throw new Error('Malformed DLQ receive count')
      row.receiveCount = message.receiveCount
    }
    row.jobId = target.jobId
    row.videoId = target.videoId
    row.sourceKey = target.sourceKey
    result.push(row)
  }
  if (result.length > 100) throw new Error('DLQ observation exceeded the bounded run limit')
  return result
}

export type DlqTransport = (tool: string, args: string[]) => string

/** Bounded AWS CLI observation. It never deletes, purges, or replays messages. */
export function receiveRunOwnedDlq(
  queueUrl: string,
  target: DlqTarget,
  options: { region: string; timeoutMs: number; maxMessages?: number; execute?: DlqTransport },
): DlqCorrelation[] {
  if (
    !/^https:\/\/sqs\.[a-z]{2}-[a-z]+-\d+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]+(?:\.fifo)?$/.test(
      queueUrl,
    )
  )
    throw new Error('DLQ URL is malformed')
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(options.region)) throw new Error('DLQ region is malformed')
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 900000
  )
    throw new Error('DLQ observation timeout is outside the supported bound')
  const limit = options.maxMessages ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw new Error('DLQ observation batch is outside the supported bound')
  const execute =
    options.execute ??
    ((tool, args) =>
      execFileSync(tool, args, {
        encoding: 'utf8',
        timeout: Math.min(options.timeoutMs, 10000),
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }))
  let parsed: any
  try {
    parsed = JSON.parse(
      execute('aws', [
        'sqs',
        'receive-message',
        '--queue-url',
        queueUrl,
        '--max-number-of-messages',
        String(limit),
        '--visibility-timeout',
        '30',
        '--wait-time-seconds',
        '0',
        '--message-attribute-names',
        'All',
        '--attribute-names',
        'ApproximateReceiveCount',
        '--region',
        options.region,
        '--output',
        'json',
      ]),
    )
  } catch {
    throw new Error('bounded DLQ observation failed')
  }
  if (!Array.isArray(parsed?.Messages)) return []
  return correlateRunOwnedDlq(
    parsed.Messages.map((m: any) => ({
      messageId: m.MessageId,
      body: m.Body,
      receivedAt: new Date().toISOString(),
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount),
    })),
    target,
  )
}

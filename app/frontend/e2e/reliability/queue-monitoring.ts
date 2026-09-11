import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { observeUntil, type PollTimeoutEvidence } from './evidence.js'

type Execute = (file: string, args: readonly string[], options: Record<string, unknown>) => string

export interface QueueMetricObservation {
  queue: 'source' | 'dlq'
  backlog?: number
  ageSeconds?: number
  observedAt: string
  metricStatus: 'observed' | 'metric-delay'
}

export interface AlarmObservation {
  identifier: string
  state: string
  reason: string
  observedAt: string
}

export interface QueueMonitoringReport {
  scenario: 'queue-monitoring'
  status: 'passed' | 'outstanding'
  runId: string
  observedAt: string
  queueObservations: readonly QueueMetricObservation[]
  alarmObservations: readonly AlarmObservation[]
  metricObservation: PollTimeoutEvidence<readonly QueueMetricObservation[]> | { status: 'observed' }
  correlatedEvidence: readonly { scenario: string; runId?: string; status?: string; evidenceFile: string; evidenceTimestamp?: string; evidenceComplete: boolean }[]
  outstanding: readonly string[]
  readOnlyOperations: readonly string[]
}

const queueName = (arn: string): string => {
  const name = arn.split(':').at(-1)
  if (!name || !/^[A-Za-z0-9_-]+(?:\.fifo)?$/.test(name)) throw new Error('observed queue identity is malformed')
  return name
}

const queueUrl = (arn: string, region: string): string => {
  const parts = arn.split(':')
  const account = parts.at(4)
  const name = queueName(arn)
  if (!account || !/^\d{12}$/.test(account)) throw new Error('observed queue account is malformed')
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`
}

const parseJson = (value: string): any => {
  try { return JSON.parse(value) } catch { throw new Error('read-only reliability observation returned malformed data') }
}

const command = (execute: Execute, region: string, args: readonly string[]): any => {
  try {
    return parseJson(execute('aws', [...args, '--region', region, '--output', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }))
  } catch { throw new Error('read-only queue or alarm observation failed') }
}

function metricQuery(queue: string, metricName: string, id: string) {
  return {
    Id: id,
    MetricStat: { Metric: { Namespace: 'AWS/SQS', MetricName: metricName, Dimensions: [{ Name: 'QueueName', Value: queue }] }, Period: 60, Stat: 'Maximum' },
    ReturnData: true,
  }
}

export async function observeQueueMonitoring(options: {
  region: string
  sourceQueueArn: string
  deadLetterQueueArn: string
  alarmIdentifiers: readonly string[]
  evidenceDir: string
  runId: string
  timeoutMs: number
  execute?: Execute
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<QueueMonitoringReport> {
  const execute = options.execute ?? ((file, args, settings) => execFileSync(file, args, settings as any).toString())
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(options.region)) throw new Error('observation region is malformed')
  if (!/^e2e-[0-9a-f-]+$/.test(options.runId)) throw new Error('runId must be a generated E2E run ID')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 900_000) throw new Error('monitoring timeout is outside the supported bound')
  const source = queueName(options.sourceQueueArn)
  const dlq = queueName(options.deadLetterQueueArn)
  if (source === dlq) throw new Error('source queue and DLQ must differ')
  const observedAt = () => new Date((options.now ?? Date.now)()).toISOString()

  const readSnapshot = async (): Promise<readonly QueueMetricObservation[]> => {
    const values = await Promise.all([
      [source, 'source'] as const,
      [dlq, 'dlq'] as const,
    ].map(async ([queue, kind]) => {
      const attributes = command(execute, options.region, ['sqs', 'get-queue-attributes', '--queue-url', queueUrl(kind === 'source' ? options.sourceQueueArn : options.deadLetterQueueArn, options.region), '--attribute-names', 'ApproximateNumberOfMessagesVisible', 'ApproximateAgeOfOldestMessage']).Attributes || {}
      const backlog = Number(attributes.ApproximateNumberOfMessagesVisible)
      const age = Number(attributes.ApproximateAgeOfOldestMessage)
      const metrics = command(execute, options.region, ['cloudwatch', 'get-metric-data', '--metric-data-queries', JSON.stringify([
        metricQuery(queue, 'ApproximateNumberOfMessagesVisible', `${kind}backlog`),
        metricQuery(queue, 'ApproximateAgeOfOldestMessage', `${kind}age`),
      ]), '--start-time', new Date((options.now ?? Date.now)() - 300000).toISOString(), '--end-time', observedAt()]).MetricDataResults || []
      const value = (id: string, fallback: number) => {
        const result = metrics.find((item: any) => item.Id === id)
        const values = result?.Values
        return Array.isArray(values) && Number.isFinite(Number(values[0])) ? Number(values[0]) : fallback
      }
      const metricReady = metrics.length === 2 && metrics.every((item: any) => Array.isArray(item.Values) && item.Values.length > 0)
      return { queue: kind, ...(Number.isFinite(backlog) ? { backlog: value(`${kind}backlog`, backlog) } : {}), ...(Number.isFinite(age) ? { ageSeconds: value(`${kind}age`, age) } : {}), observedAt: observedAt(), metricStatus: metricReady ? 'observed' : 'metric-delay' } as QueueMetricObservation
    }))
    return values
  }

  const metric = await (async () => {
    try {
      return { status: 'observed' as const, value: await observeUntil(readSnapshot, value => value.every(item => item.metricStatus === 'observed'), { timeoutMs: options.timeoutMs, now: options.now, sleep: options.sleep }) }
    } catch (error) {
      if (error && typeof error === 'object' && 'evidence' in error) return { status: 'timeout' as const, evidence: (error as { evidence: PollTimeoutEvidence<readonly QueueMetricObservation[]> }).evidence }
      throw error
    }
  })()
  const queueObservations = metric.status === 'observed' ? metric.value : metric.evidence.lastObservation || await readSnapshot()
  const alarms = command(execute, options.region, ['cloudwatch', 'describe-alarms', '--alarm-names', ...options.alarmIdentifiers]).MetricAlarms
  if (!Array.isArray(alarms)) throw new Error('alarm observation response is malformed')
  const alarmObservations = options.alarmIdentifiers.map(identifier => {
    const alarm = alarms.find((item: any) => item.AlarmName === identifier)
    return { identifier, state: typeof alarm?.StateValue === 'string' ? alarm.StateValue : 'INSUFFICIENT_DATA', reason: typeof alarm?.StateReason === 'string' ? alarm.StateReason : 'alarm was not returned by the read-only inspection', observedAt: observedAt() }
  })

  const correlatedEvidence: Array<QueueMonitoringReport['correlatedEvidence'][number]> = []
  for (const file of ['ffmpeg-exhaustion-evidence.json', 'poison-isolation-evidence.json']) {
    try {
      const evidence = parseJson(await readFile(join(options.evidenceDir, file), 'utf8'))
      const scenario = file.replace('-evidence.json', '')
      const evidenceComplete = scenario === 'ffmpeg-exhaustion'
        ? Boolean(evidence.target && Array.isArray(evidence.snapshots) && evidence.snapshots.length > 0)
        : Boolean(evidence.target && Array.isArray(evidence.result?.poison) && Array.isArray(evidence.result?.observations))
      correlatedEvidence.push({ scenario, runId: typeof evidence.runId === 'string' ? evidence.runId : undefined, status: typeof evidence.status === 'string' ? evidence.status : undefined, evidenceFile: file, evidenceTimestamp: Array.isArray(evidence.timestamps) ? evidence.timestamps.at(-1) : undefined, evidenceComplete })
    } catch { /* absence is reported as outstanding below */ }
  }
  const missing = ['ffmpeg-exhaustion', 'poison-isolation'].filter(scenario => !correlatedEvidence.some(item => item.scenario === scenario && item.status === 'passed' && item.evidenceComplete))
  return {
    scenario: 'queue-monitoring', status: missing.length || metric.status === 'timeout' ? 'outstanding' : 'passed', runId: options.runId,
    observedAt: observedAt(), queueObservations, alarmObservations,
    metricObservation: metric.status === 'observed' ? { status: 'observed' } : metric.evidence,
    correlatedEvidence, outstanding: [...missing.map(item => `${item} evidence is outstanding`), ...(metric.status === 'timeout' ? ['queue metrics remained delayed within the bounded observation'] : [])],
    readOnlyOperations: ['sqs:get-queue-attributes', 'cloudwatch:get-metric-data', 'cloudwatch:describe-alarms'],
  }
}

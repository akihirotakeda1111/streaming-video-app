import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { observeUntil, ObservationTimeout, type PollTimeoutEvidence } from './evidence.js'
import { validateAlarmIdentifiers } from './alarm-identifiers.mjs'
import { correlateMonitoringEvidence, utcTime } from './queue-monitoring-evidence.js'

type Execute = (
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeout: number },
) => string | Promise<string>

const executeAws: Execute = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error('read-only queue or alarm observation failed'))
        else resolve(stdout)
      },
    )
  })

export interface QueueMetricObservation {
  queue: 'source' | 'dlq'
  backlog?: number
  ageSeconds?: number
  attributeBacklog?: number
  backlogTimestamp?: string
  ageTimestamp?: string
  observedAt: string
  metricStatus: 'observed' | 'metric-delay'
}

export interface AlarmObservation {
  identifier: string
  state?: string
  reason?: string
  observationStatus: 'observed' | 'missing' | 'invalid' | 'not-observed'
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
  correlatedEvidence: readonly {
    scenario: string
    runId?: string
    status?: string
    evidenceFile: string
    evidenceTimestamp?: string
    evidenceComplete: boolean
  }[]
  outstanding: readonly string[]
  readOnlyOperations: readonly string[]
}

const queueName = (arn: string): string => {
  const name = arn.split(':').at(-1)
  if (!name || !/^[A-Za-z0-9_-]+(?:\.fifo)?$/.test(name))
    throw new Error('observed queue identity is malformed')
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
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('read-only reliability observation returned malformed data')
  }
}

const command = async (
  execute: Execute,
  region: string,
  args: readonly string[],
  signal: AbortSignal,
  remainingMs: number,
): Promise<any> => {
  signal.throwIfAborted()
  if (remainingMs <= 0) throw new Error('observation deadline reached')
  try {
    const result = await execute('aws', [...args, '--region', region, '--output', 'json'], {
      signal,
      timeout: Math.min(10_000, remainingMs),
    })
    signal.throwIfAborted()
    return parseJson(result)
  } catch {
    throw new Error('read-only queue or alarm observation failed')
  }
}

function metricQuery(queue: string, metricName: string, id: string) {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/SQS',
        MetricName: metricName,
        Dimensions: [{ Name: 'QueueName', Value: queue }],
      },
      Period: 60,
      Stat: 'Maximum',
    },
    ReturnData: true,
  }
}

/** timeoutMs bounds all AWS observations, including alarms; no AWS work starts after it expires. */
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
  const execute = options.execute ?? executeAws
  validateAlarmIdentifiers(options.alarmIdentifiers)
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(options.region))
    throw new Error('observation region is malformed')
  if (!/^e2e-[0-9a-f-]+$/.test(options.runId))
    throw new Error('runId must be a generated E2E run ID')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 900_000)
    throw new Error('monitoring timeout is outside the supported bound')
  const source = queueName(options.sourceQueueArn)
  const dlq = queueName(options.deadLetterQueueArn)
  if (source === dlq) throw new Error('source queue and DLQ must differ')
  const now = options.now ?? Date.now
  const observedAt = () => new Date(now()).toISOString()
  const deadline = now() + options.timeoutMs
  let alarmObservations: AlarmObservation[] = options.alarmIdentifiers.map((identifier) => ({
    identifier,
    observationStatus: 'not-observed',
    observedAt: observedAt(),
  }))

  const readSnapshot = async (signal: AbortSignal): Promise<readonly QueueMetricObservation[]> => {
    const read = (args: readonly string[]) =>
      command(execute, options.region, args, signal, deadline - now())
    const alarms = (
      await read(['cloudwatch', 'describe-alarms', '--alarm-names', ...options.alarmIdentifiers])
    ).MetricAlarms
    if (!Array.isArray(alarms)) throw new Error('alarm observation response is malformed')
    alarmObservations = options.alarmIdentifiers.map((identifier) => {
      const matches = alarms.filter((item: any) => item?.AlarmName === identifier)
      const alarm = matches[0]
      const valid =
        matches.length === 1 &&
        ['OK', 'ALARM', 'INSUFFICIENT_DATA'].includes(alarm.StateValue) &&
        typeof alarm.StateReason === 'string'
      return {
        identifier,
        ...(valid ? { state: alarm.StateValue, reason: alarm.StateReason } : {}),
        observationStatus: valid ? 'observed' : matches.length ? 'invalid' : 'missing',
        observedAt: observedAt(),
      }
    })
    const values = await Promise.all(
      [[source, 'source'] as const, [dlq, 'dlq'] as const].map(async ([queue, kind]) => {
        const attributes =
          (
            await read([
              'sqs',
              'get-queue-attributes',
              '--queue-url',
              queueUrl(
                kind === 'source' ? options.sourceQueueArn : options.deadLetterQueueArn,
                options.region,
              ),
              '--attribute-names',
              'ApproximateNumberOfMessages',
            ])
          ).Attributes || {}
        const attributeBacklog =
          typeof attributes.ApproximateNumberOfMessages === 'string' &&
          /^\d+$/.test(attributes.ApproximateNumberOfMessages)
            ? Number(attributes.ApproximateNumberOfMessages)
            : undefined
        const end = now()
        const start = end - 300000
        const metrics = (
          await read([
            'cloudwatch',
            'get-metric-data',
            '--metric-data-queries',
            JSON.stringify([
              metricQuery(queue, 'ApproximateNumberOfMessagesVisible', `${kind}backlog`),
              metricQuery(queue, 'ApproximateAgeOfOldestMessage', `${kind}age`),
            ]),
            '--start-time',
            new Date(start).toISOString(),
            '--end-time',
            new Date(end).toISOString(),
          ])
        ).MetricDataResults
        const point = (id: string): { value: number; timestamp: string } | undefined => {
          if (!Array.isArray(metrics)) return undefined
          const matches = metrics.filter((item: any) => item?.Id === id)
          const result = matches[0]
          if (
            matches.length !== 1 ||
            result.StatusCode !== 'Complete' ||
            !Array.isArray(result.Values) ||
            !result.Values.length ||
            !Array.isArray(result.Timestamps) ||
            result.Values.length !== result.Timestamps.length
          )
            return undefined
          const points = result.Values.map((value: unknown, index: number) => ({
            value,
            time: utcTime(result.Timestamps[index]),
          }))
          if (
            !points.every(
              (p: any) =>
                typeof p.value === 'number' &&
                Number.isFinite(p.value) &&
                p.value >= 0 &&
                p.time !== undefined &&
                p.time <= end,
            )
          )
            return undefined
          const recent = points.filter((point: any) => point.time >= start)
          if (!recent.length) return undefined
          const latest = recent.reduce((a: any, b: any) => (a.time > b.time ? a : b))
          return { value: latest.value, timestamp: new Date(latest.time).toISOString() }
        }
        const backlog = point(`${kind}backlog`),
          age = point(`${kind}age`)
        return {
          queue: kind,
          ...(Number.isSafeInteger(attributeBacklog) ? { attributeBacklog } : {}),
          ...(backlog ? { backlog: backlog.value, backlogTimestamp: backlog.timestamp } : {}),
          ...(age ? { ageSeconds: age.value, ageTimestamp: age.timestamp } : {}),
          observedAt: observedAt(),
          metricStatus: backlog && age ? 'observed' : 'metric-delay',
        } as QueueMetricObservation
      }),
    )
    return values
  }

  const metric = await (async () => {
    try {
      return {
        status: 'observed' as const,
        value: await observeUntil(
          readSnapshot,
          (value) => value.every((item) => item.metricStatus === 'observed'),
          { timeoutMs: options.timeoutMs, now: options.now, sleep: options.sleep },
        ),
      }
    } catch (error) {
      if (error instanceof ObservationTimeout)
        return {
          status: 'timeout' as const,
          evidence: error.evidence as PollTimeoutEvidence<readonly QueueMetricObservation[]>,
        }
      throw error
    }
  })()
  const queueObservations =
    metric.status === 'observed' ? metric.value : metric.evidence.lastObservation || []

  const correlatedEvidence: Array<QueueMonitoringReport['correlatedEvidence'][number]> = []
  for (const file of ['ffmpeg-exhaustion-evidence.json', 'poison-isolation-evidence.json']) {
    try {
      const evidence = parseJson(await readFile(join(options.evidenceDir, file), 'utf8'))
      const scenario = file.replace('-evidence.json', '')
      const correlation = correlateMonitoringEvidence(evidence, scenario, {
        ...options,
        now: now(),
      })
      correlatedEvidence.push({
        scenario,
        runId: typeof evidence.runId === 'string' ? evidence.runId : undefined,
        status: typeof evidence.status === 'string' ? evidence.status : undefined,
        evidenceFile: file,
        ...correlation,
      })
    } catch {
      /* absence is reported as outstanding below */
    }
  }
  const missing = ['ffmpeg-exhaustion', 'poison-isolation'].filter(
    (scenario) =>
      !correlatedEvidence.some(
        (item) => item.scenario === scenario && item.status === 'passed' && item.evidenceComplete,
      ),
  )
  const outstanding = [
    ...missing.map((item) => `${item} evidence is outstanding`),
    ...alarmObservations
      .filter((item) => item.observationStatus !== 'observed')
      .map((item) => `${item.identifier} alarm observation is ${item.observationStatus}`),
    ...(metric.status === 'timeout' ? ['queue/alarm observation exceeded its bounded wait'] : []),
  ]
  return {
    scenario: 'queue-monitoring',
    status: outstanding.length ? 'outstanding' : 'passed',
    runId: options.runId,
    observedAt: observedAt(),
    queueObservations,
    alarmObservations,
    metricObservation: metric.status === 'observed' ? { status: 'observed' } : metric.evidence,
    correlatedEvidence,
    outstanding,
    readOnlyOperations: [
      'sqs:get-queue-attributes',
      'cloudwatch:get-metric-data',
      'cloudwatch:describe-alarms',
    ],
  }
}

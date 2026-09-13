import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { observeUntil, ObservationTimeout, type PollTimeoutEvidence } from './evidence.js'
import { validateAlarmIdentifiers } from './alarm-identifiers.mjs'
import { correlateMonitoringEvidence } from './queue-monitoring-evidence.js'
import { diagnoseMetric, type MetricDiagnostic } from './metric-diagnostics.js'

class ObservationRequestError extends Error {
  constructor(readonly errorCode: string) {
    super('read-only queue or alarm observation failed')
  }
}

function requestError(error: any, stderr = ''): ObservationRequestError {
  const awsCode =
    /\((AccessDenied|AccessDeniedException|UnauthorizedOperation|ExpiredToken|ExpiredTokenException|InvalidClientTokenId|Throttling|ThrottlingException|InvalidParameterValue|ResourceNotFound|ResourceNotFoundException)\)/.exec(
      stderr,
    )?.[1]
  return new ObservationRequestError(
    awsCode ??
      (error?.code === 'ENOENT' ? 'cli-not-found' : error?.killed ? 'cli-timeout' : 'cli-failed'),
  )
}

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
      (error, stdout, stderr) => {
        if (error) reject(requestError(error, stderr))
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
  metricRequest: {
    region: string
    queueName: string
    namespace: string
    startTime: string
    endTime: string
    periodSeconds: number
    statistic: string
  }
  metricDiagnostics: MetricDiagnostic[]
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
  metricObservation:
    PollTimeoutEvidence<readonly QueueMetricObservation[]> | { status: 'observed' | 'error' }
  correlatedEvidence: readonly {
    scenario: string
    runId?: string
    status?: string
    evidenceFile: string
    requestedRunId?: string
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
    try {
      return JSON.parse(result)
    } catch {
      throw new ObservationRequestError('invalid-json')
    }
  } catch (error) {
    signal.throwIfAborted()
    throw error instanceof ObservationRequestError ? error : requestError(error)
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
  ffmpegEvidenceRun?: string
  poisonEvidenceRun?: string
  execute?: Execute
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<QueueMonitoringReport> {
  const execute = options.execute ?? executeAws
  validateAlarmIdentifiers(options.alarmIdentifiers)
  for (const run of [options.ffmpegEvidenceRun, options.poisonEvidenceRun]) {
    if (
      run !== undefined &&
      !/^e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run)
    ) {
      throw new Error('evidence reference must be an e2e-UUIDv4 run directory name')
    }
  }
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
        const metricRequest = {
          region: options.region,
          queueName: queue,
          namespace: 'AWS/SQS',
          startTime: new Date(start).toISOString(),
          endTime: new Date(end).toISOString(),
          periodSeconds: 60,
          statistic: 'Maximum',
        }
        const queries = [
          metricQuery(queue, 'ApproximateNumberOfMessagesVisible', kind + 'backlog'),
          metricQuery(queue, 'ApproximateAgeOfOldestMessage', kind + 'age'),
        ]
        let metricDiagnostics: MetricDiagnostic[]
        try {
          const response = await read([
            'cloudwatch',
            'get-metric-data',
            '--metric-data-queries',
            JSON.stringify(queries),
            '--start-time',
            metricRequest.startTime,
            '--end-time',
            metricRequest.endTime,
          ])
          metricDiagnostics = queries.map((query) =>
            diagnoseMetric(response, query.Id, query.MetricStat.Metric.MetricName, start, end),
          )
        } catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof ObservationRequestError)) throw error
          metricDiagnostics = queries.map((query) => ({
            id: query.Id,
            metricName: query.MetricStat.Metric.MetricName,
            reason: 'request-error',
            errorCode: error.errorCode,
          }))
        }
        const backlog = metricDiagnostics[0]?.point,
          age = metricDiagnostics[1]?.point
        return {
          queue: kind,
          ...(Number.isSafeInteger(attributeBacklog) ? { attributeBacklog } : {}),
          ...(backlog ? { backlog: backlog.value, backlogTimestamp: backlog.timestamp } : {}),
          ...(age ? { ageSeconds: age.value, ageTimestamp: age.timestamp } : {}),
          observedAt: observedAt(),
          metricStatus: backlog && age ? 'observed' : 'metric-delay',
          metricRequest,
          metricDiagnostics,
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
          (value) =>
            value.every((item) => item.metricStatus === 'observed') ||
            value.some((item) =>
              item.metricDiagnostics.some((diagnostic) =>
                ['request-error', 'service-error'].includes(diagnostic.reason),
              ),
            ),
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
    const scenario = file.replace('-evidence.json', '')
    const requestedRunId =
      scenario === 'ffmpeg-exhaustion' ? options.ffmpegEvidenceRun : options.poisonEvidenceRun
    try {
      let directory = options.evidenceDir
      if (requestedRunId !== undefined) {
        const root = await realpath(dirname(options.evidenceDir))
        directory = join(root, requestedRunId)
        // Reject symlink/junction escapes, including redirects to another run.
        if (
          (await realpath(directory)) !== directory ||
          (await realpath(join(directory, file))) !== join(directory, file)
        ) {
          throw new Error('evidence reference leaves its selected run directory')
        }
      }
      const evidence = parseJson(await readFile(join(directory, file), 'utf8'))
      const correlation = correlateMonitoringEvidence(evidence, scenario, {
        ...options,
        runId: requestedRunId ?? options.runId,
        now: now(),
      })
      correlatedEvidence.push({
        scenario,
        runId: typeof evidence.runId === 'string' ? evidence.runId : undefined,
        status: typeof evidence.status === 'string' ? evidence.status : undefined,
        evidenceFile: file,
        requestedRunId,
        ...correlation,
      })
    } catch {
      correlatedEvidence.push({
        scenario,
        evidenceFile: file,
        requestedRunId,
        evidenceComplete: false,
      })
    }
  }
  const missing = ['ffmpeg-exhaustion', 'poison-isolation'].filter(
    (scenario) =>
      !correlatedEvidence.some(
        (item) => item.scenario === scenario && item.status === 'passed' && item.evidenceComplete,
      ),
  )
  const outstanding = [
    ...queueObservations.flatMap((item) =>
      item.metricDiagnostics
        .filter((diagnostic) => diagnostic.reason !== 'observed')
        .map(
          (diagnostic) =>
            item.queue +
            ':' +
            diagnostic.id +
            ': ' +
            diagnostic.reason +
            (diagnostic.errorCode ? ' (' + diagnostic.errorCode + ')' : ''),
        ),
    ),
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
    metricObservation:
      metric.status === 'observed'
        ? {
            status: queueObservations.every((item) => item.metricStatus === 'observed')
              ? 'observed'
              : 'error',
          }
        : metric.evidence,
    correlatedEvidence,
    outstanding,
    readOnlyOperations: [
      'sqs:get-queue-attributes',
      'cloudwatch:get-metric-data',
      'cloudwatch:describe-alarms',
    ],
  }
}

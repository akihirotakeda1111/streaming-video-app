import { execFile } from 'node:child_process'
import {
  activitiesFromHits,
  childIntervalsFromHistory,
  isEcsTaskArn,
  jobIdFromLogMessage,
  taskArnFromLogStream,
  withEcsTimings,
  type ChildInterval,
  type HistoryEvent,
  type LogHit,
  type ServiceSample,
} from './checkpoints.js'

interface AwsFailure extends Error {
  detail?: string
  notFound?: boolean
}

export async function awsJson(args: string[], region: string): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('aws', [...args, '--region', region, '--output', 'json'], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        AWS_PAGER: '',
        AWS_CLI_AUTO_PROMPT: 'off',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
    }, (error, out, err) => {
      if (error) {
        const detail = `${String(err ?? '')} ${error.message}`.replace(/\s+/g, ' ').slice(0, 400)
        const wrapped = new Error(`aws ${args.slice(0, 2).join(' ')} failed`) as AwsFailure
        wrapped.detail = detail
        wrapped.notFound = /ExecutionDoesNotExist|ResourceNotFound|StateMachineDoesNotExist/i.test(detail)
        reject(wrapped)
        return
      }
      resolve(String(out))
    })
  })
  return JSON.parse(stdout) as unknown
}

export function executionArn(stateMachineArn: string, executionName: string): string | undefined {
  const marker = ':stateMachine:'
  const index = stateMachineArn.lastIndexOf(marker)
  if (index < 0) return undefined
  const prefix = stateMachineArn.slice(0, index)
  const name = stateMachineArn.slice(index + marker.length)
  if (!prefix.startsWith('arn:aws:states:') || !name || name.includes(':') || !executionName) return undefined
  return `${prefix}:execution:${name}:${executionName}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export async function sampleParentService(region: string, cluster: string, service: string): Promise<ServiceSample> {
  const described = asRecord(await awsJson([
    'ecs', 'describe-services', '--cluster', cluster, '--services', service,
  ], region))
  const failures = asArray(described?.failures)
  if (failures.length > 0) throw new Error('parent service observation failed')
  const serviceRecord = asRecord(asArray(described?.services)[0])
  const runningCount = serviceRecord?.runningCount
  const desiredCount = serviceRecord?.desiredCount
  if (typeof runningCount !== 'number' || typeof desiredCount !== 'number') {
    throw new Error('parent service observation did not include task counts')
  }
  const listed = asRecord(await awsJson([
    'ecs', 'list-tasks', '--cluster', cluster, '--service-name', service, '--desired-status', 'RUNNING',
  ], region))
  const taskArns = asArray(listed?.taskArns).filter((arn): arn is string => typeof arn === 'string' && isEcsTaskArn(arn))
  return { observedAt: new Date().toISOString(), runningCount, desiredCount, taskArns }
}

async function logGroupForService(region: string, cluster: string, service: string): Promise<string> {
  const described = asRecord(await awsJson([
    'ecs', 'describe-services', '--cluster', cluster, '--services', service,
  ], region))
  const taskDefinition = asRecord(asArray(described?.services)[0])?.taskDefinition
  if (typeof taskDefinition !== 'string' || !taskDefinition) throw new Error('parent task definition is unavailable')
  const definition = asRecord(await awsJson(['ecs', 'describe-task-definition', '--task-definition', taskDefinition], region))
  const containers = asArray(asRecord(definition?.taskDefinition)?.containerDefinitions)
  for (const container of containers) {
    const options = asRecord(asRecord(asRecord(container)?.logConfiguration)?.options)
    const group = options?.['awslogs-group']
    if (typeof group === 'string' && group.trim()) return group
  }
  throw new Error('parent worker log group is unavailable')
}

async function logHits(region: string, group: string, account: string, cluster: string, jobIds: ReadonlySet<string>, startMs: number): Promise<LogHit[]> {
  const hits: LogHit[] = []
  let token: string | undefined
  for (let page = 0; page < 10 && hits.length < 5000; page += 1) {
    const args = ['logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(startMs), '--filter-pattern', '"job_id"']
    if (token) args.push('--next-token', token)
    const body = asRecord(await awsJson(args, region))
    for (const event of asArray(body?.events)) {
      const record = asRecord(event)
      const message = record?.message
      const stream = record?.logStreamName
      const timestamp = record?.timestamp
      if (typeof message !== 'string' || typeof stream !== 'string' || typeof timestamp !== 'number') continue
      const jobId = jobIdFromLogMessage(message)
      if (!jobId || !jobIds.has(jobId)) continue
      const taskArn = taskArnFromLogStream(stream, region, account, cluster)
      if (!taskArn) continue
      hits.push({ taskArn, jobId, observedAt: new Date(timestamp).toISOString() })
    }
    const next = body?.nextToken
    if (typeof next !== 'string' || !next || next === token) break
    token = next
  }
  return hits
}

async function historyEvents(region: string, executionArnValue: string): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = []
  let token: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const args = ['stepfunctions', 'get-execution-history', '--execution-arn', executionArnValue, '--max-results', '1000']
    if (token) args.push('--next-token', token)
    const body = asRecord(await awsJson(args, region))
    events.push(...asArray(body?.events) as HistoryEvent[])
    const next = body?.nextToken
    if (typeof next !== 'string' || !next || next === token) break
    token = next
  }
  return events
}

async function ecsTimings(region: string, cluster: string, taskArns: readonly string[]) {
  if (taskArns.length === 0) return []
  const body = asRecord(await awsJson(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...taskArns], region))
  return asArray(body?.tasks).flatMap((task) => {
    const record = asRecord(task)
    const taskArn = record?.taskArn
    if (typeof taskArn !== 'string') return []
    return [{ taskArn, startedAt: record?.startedAt, stoppedAt: record?.stoppedAt }]
  })
}

async function childIntervalsForJob(region: string, cluster: string, stateMachineArn: string, jobId: string): Promise<ChildInterval[]> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const arn = executionArn(stateMachineArn, `job-${jobId}-a${attempt}`)
    if (!arn) return []
    try {
      await awsJson(['stepfunctions', 'describe-execution', '--execution-arn', arn], region)
    } catch (error) {
      if ((error as AwsFailure).notFound) continue
      throw error
    }
    const events = await historyEvents(region, arn)
    const intervals = childIntervalsFromHistory(events)
    const timings = await ecsTimings(region, cluster, [...new Set(intervals.map((interval) => interval.taskArn))])
    return withEcsTimings(intervals, timings).map((interval) => ({ ...interval, jobId }))
  }
  return []
}

export interface LiveObserver {
  samples: ServiceSample[]
  hits: LogHit[]
  childIntervals: ChildInterval[]
  errors: string[]
  stop: () => Promise<void>
}

export function startLiveObserver(options: {
  region: string
  account: string
  cluster: string
  service: string
  stateMachineArn: string
  jobIds: () => readonly string[]
  samples: ServiceSample[]
  deadlineMs: number
  intervalMs?: number
}): LiveObserver {
  const hits: LogHit[] = []
  const childIntervals: ChildInterval[] = []
  const childrenByJob = new Map<string, ChildInterval[]>()
  const errors: string[] = []
  const seenChildren = new Set<string>()
  let stopped = false
  let tail: Promise<void> = Promise.resolve()
  const waiters = new Set<() => void>()
  let group: string | undefined

  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    const wake = () => finish()
    waiters.add(wake)
    function finish() {
      clearTimeout(timer)
      waiters.delete(wake)
      resolve()
    }
  })

  const remember = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'scalability observation failed'
    if (errors.length < 50) errors.push(message)
  }

  const tick = async () => {
    try {
      options.samples.push(await sampleParentService(options.region, options.cluster, options.service))
    } catch (error) {
      remember(error)
    }
    const jobIds = new Set(options.jobIds())
    if (jobIds.size === 0) return
    try {
      group ??= await logGroupForService(options.region, options.cluster, options.service)
      const startMs = Date.parse(options.samples[0]?.observedAt ?? new Date().toISOString())
      const found = await logHits(options.region, group, options.account, options.cluster, jobIds, Number.isFinite(startMs) ? startMs : Date.now())
      hits.splice(0, hits.length, ...found.slice(0, 5000))
    } catch (error) {
      remember(error)
    }
    for (const jobId of jobIds) {
      if (seenChildren.has(jobId)) continue
      try {
        const intervals = await childIntervalsForJob(options.region, options.cluster, options.stateMachineArn, jobId)
        if (intervals.length === 0) continue
        childrenByJob.set(jobId, intervals)
        childIntervals.splice(0, childIntervals.length, ...[...childrenByJob.values()].flat())
        const renditions = new Set(intervals.map((interval) => interval.rendition))
        if (renditions.has('360p') && renditions.has('720p') && intervals.every((interval) => interval.ecsStoppedAt)) {
          seenChildren.add(jobId)
        }
      } catch (error) {
        remember(error)
      }
    }
  }

  const loop = async () => {
    while (!stopped && Date.now() < options.deadlineMs) {
      await tick()
      if (stopped || Date.now() >= options.deadlineMs) break
      const interval = options.intervalMs ?? 15_000
      await pause(Math.min(interval, options.deadlineMs - Date.now()))
    }
  }
  tail = loop()

  return {
    samples: options.samples,
    hits,
    childIntervals,
    errors,
    async stop() {
      stopped = true
      for (const wake of waiters) wake()
      await tail
    },
  }
}

export function parentActivities(hits: readonly LogHit[]) {
  return activitiesFromHits(hits)
}

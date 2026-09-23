export const CHECKPOINT_IDS = [
  'parentScaleOut',
  'parentJobConcurrency',
  'childExecutionOverlap',
  'allJobsCompleted',
  'scaleIn',
  'abrPlayback',
] as const

export type CheckpointId = (typeof CHECKPOINT_IDS)[number]
export type CheckpointStatus = 'PASS' | 'FAIL' | 'NOT RUN'

export interface Checkpoint {
  id: CheckpointId
  status: CheckpointStatus
  observedAt?: string
  reason?: string
  evidence?: unknown
}

export interface ServiceSample {
  observedAt: string
  runningCount: number
  desiredCount: number
  taskArns: string[]
}

export interface LogHit {
  taskArn: string
  jobId: string
  observedAt: string
}

export interface ParentActivity {
  taskArn: string
  jobId: string
  startedAt: string
  endedAt: string
}

export interface HistoryEvent {
  id?: number
  previousEventId?: number
  timestamp?: unknown
  type?: string
  taskScheduledEventDetails?: { resourceType?: string; parameters?: string }
  taskStartedEventDetails?: { resourceType?: string }
  taskSubmittedEventDetails?: { resourceType?: string; output?: string }
  taskSucceededEventDetails?: { resourceType?: string; output?: string }
  taskFailedEventDetails?: { resourceType?: string; cause?: string }
}

export interface ChildInterval {
  rendition: '360p' | '720p'
  taskArn: string
  stepFunctionsStart: string
  stepFunctionsEnd: string
  ecsStartedAt?: string
  ecsStoppedAt?: string
  jobId?: string
}

export interface EcsTaskTiming {
  taskArn: string
  startedAt?: unknown
  stoppedAt?: unknown
}

export interface JobRecord {
  videoId: string
  jobId: string
  status: string
  createdAt: string
  completedAt?: string
  elapsedSeconds?: number
  error?: string
}

export interface PlaybackSummary {
  usedVideoJs: boolean
  master: boolean
  playlist360: boolean
  playlist720: boolean
  segment360: boolean
  segment720: boolean
  decoded: boolean
  advanced: boolean
  switched: boolean
  error?: string
  details?: unknown
}

export interface ScalabilityEvaluationInput {
  attempted: boolean
  minimumCapacity: number
  batchSize: number
  jobs: readonly JobRecord[]
  samples: readonly ServiceSample[]
  activities: readonly ParentActivity[]
  childIntervals: readonly ChildInterval[]
  playback?: PlaybackSummary
  playbackAttempted: boolean
  observationErrors: readonly string[]
}

export function parseAwsTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function isEcsTaskArn(value: string): boolean {
  return /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/[^/]+\/[^/]+$/.test(value)
}

export function intervalsOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start <= right.end && right.start <= left.end && left.end >= left.start && right.end >= right.start
}

export function taskArnFromLogStream(stream: string, region: string, account: string, cluster: string): string | undefined {
  const taskId = stream.split('/').at(-1) ?? ''
  if (!/^[0-9a-f]{32}$/.test(taskId)) return undefined
  if (!/^[a-z0-9-]+$/.test(region) || !/^\d{12}$/.test(account)) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(cluster)) return undefined
  return `arn:aws:ecs:${region}:${account}:task/${cluster}/${taskId}`
}

export function jobIdFromLogMessage(message: string): string | undefined {
  try {
    return jobIdFromValue(JSON.parse(message) as unknown)
  } catch {
    return undefined
  }
}

function jobIdFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.job_id === 'string' && record.job_id.trim()) return record.job_id
  if (record.fields && typeof record.fields === 'object') {
    const nested = (record.fields as Record<string, unknown>).job_id
    if (typeof nested === 'string' && nested.trim()) return nested
  }
  return undefined
}

export function activitiesFromHits(hits: readonly LogHit[]): ParentActivity[] {
  const grouped = new Map<string, { taskArn: string; jobId: string; start: number; end: number }>()
  for (const hit of hits) {
    const at = Date.parse(hit.observedAt)
    if (!Number.isFinite(at) || !isEcsTaskArn(hit.taskArn) || !hit.jobId) continue
    const key = `${hit.taskArn}\0${hit.jobId}`
    const existing = grouped.get(key)
    if (!existing) grouped.set(key, { taskArn: hit.taskArn, jobId: hit.jobId, start: at, end: at })
    else {
      existing.start = Math.min(existing.start, at)
      existing.end = Math.max(existing.end, at)
    }
  }
  return [...grouped.values()].map((item) => ({
    taskArn: item.taskArn,
    jobId: item.jobId,
    startedAt: new Date(item.start).toISOString(),
    endedAt: new Date(item.end).toISOString(),
  }))
}

export function parentConcurrency(activities: readonly ParentActivity[]): { pass: boolean; evidence?: ParentActivity[]; reason: string } {
  for (const left of activities) {
    for (const right of activities) {
      if (left.taskArn === right.taskArn || left.jobId === right.jobId) continue
      const overlaps = intervalsOverlap(
        { start: Date.parse(left.startedAt), end: Date.parse(left.endedAt) },
        { start: Date.parse(right.startedAt), end: Date.parse(right.endedAt) },
      )
      if (overlaps) return { pass: true, evidence: [left, right], reason: 'distinct parent tasks overlapped on distinct jobs' }
    }
  }
  if (activities.length === 0) return { pass: false, reason: 'no parent task was correlated with a submitted job' }
  return { pass: false, reason: 'distinct parent workers did not process distinct jobs concurrently' }
}

function walkChain(event: HistoryEvent, byId: ReadonlyMap<number, HistoryEvent>): HistoryEvent[] {
  const chain: HistoryEvent[] = []
  let current: HistoryEvent | undefined = event
  const seen = new Set<number>()
  while (current) {
    chain.push(current)
    const previous = current.previousEventId
    if (previous === undefined || seen.has(previous)) break
    seen.add(previous)
    current = byId.get(previous)
  }
  return chain
}

function renditionFromValue(value: unknown): '360p' | '720p' | undefined {
  if (typeof value === 'string') {
    try {
      return renditionFromValue(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = renditionFromValue(item)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.rendition === '360p' || record.rendition === '720p') return record.rendition
  if (record.Name === 'CHILD_PAYLOAD_JSON') return renditionFromValue(record.Value)
  for (const [key, item] of Object.entries(record)) {
    if (key === 'renditions') continue
    const found = renditionFromValue(item)
    if (found) return found
  }
  return undefined
}

function extractTaskArn(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (isEcsTaskArn(value)) return value
    try {
      return extractTaskArn(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTaskArn(item)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['task_arn', 'TaskArn', 'taskArn']) {
    if (typeof record[key] === 'string' && isEcsTaskArn(record[key])) return record[key]
  }
  for (const item of Object.values(record)) {
    const found = extractTaskArn(item)
    if (found) return found
  }
  return undefined
}

function eventOutput(event: HistoryEvent): string | undefined {
  return event.taskSucceededEventDetails?.output
    ?? event.taskSubmittedEventDetails?.output
    ?? event.taskFailedEventDetails?.cause
}

function eventResource(event: HistoryEvent): string | undefined {
  return event.taskSucceededEventDetails?.resourceType
    ?? event.taskSubmittedEventDetails?.resourceType
    ?? event.taskFailedEventDetails?.resourceType
    ?? event.taskScheduledEventDetails?.resourceType
    ?? event.taskStartedEventDetails?.resourceType
}

export function childIntervalsFromHistory(events: readonly HistoryEvent[]): ChildInterval[] {
  const byId = new Map<number, HistoryEvent>()
  for (const event of events) {
    if (typeof event.id === 'number') byId.set(event.id, event)
  }
  const found = new Map<string, ChildInterval>()
  for (const event of events) {
    if ((eventResource(event) ?? '').toLowerCase() !== 'ecs') continue
    if (event.type !== 'TaskSucceeded' && event.type !== 'TaskSubmitted' && event.type !== 'TaskFailed') continue
    const taskArn = extractTaskArn(eventOutput(event))
    if (!taskArn) continue
    const chain = walkChain(event, byId)
    const rendition = chain.map((item) => renditionFromValue(eventOutput(item) ?? item.taskScheduledEventDetails?.parameters)).find(Boolean)
    if (rendition !== '360p' && rendition !== '720p') continue
    const startEvent = chain.find((item) => item.type === 'TaskStarted')
      ?? chain.find((item) => item.type === 'TaskScheduled')
      ?? event
    const start = parseAwsTime(startEvent.timestamp)
    const end = parseAwsTime(event.timestamp)
    if (start === undefined || end === undefined || end < start) continue
    found.set(`${rendition}:${taskArn}`, {
      rendition,
      taskArn,
      stepFunctionsStart: new Date(start).toISOString(),
      stepFunctionsEnd: new Date(end).toISOString(),
    })
  }
  return [...found.values()]
}

export function withEcsTimings(intervals: readonly ChildInterval[], tasks: readonly EcsTaskTiming[]): ChildInterval[] {
  const byArn = new Map(tasks.map((task) => [task.taskArn, task]))
  return intervals.map((interval) => {
    const task = byArn.get(interval.taskArn)
    const started = task ? parseAwsTime(task.startedAt) : undefined
    const stopped = task ? parseAwsTime(task.stoppedAt) : undefined
    return {
      ...interval,
      ...(started !== undefined ? { ecsStartedAt: new Date(started).toISOString() } : {}),
      ...(stopped !== undefined ? { ecsStoppedAt: new Date(stopped).toISOString() } : {}),
    }
  })
}

export function childOverlap(intervals: readonly ChildInterval[]): { pass: boolean; evidence?: ChildInterval[]; reason: string } {
  const groups = new Map<string, ChildInterval[]>()
  for (const interval of intervals) {
    const key = interval.jobId ?? ''
    groups.set(key, [...(groups.get(key) ?? []), interval])
  }
  let reason = 'distinct 360p and 720p child task ARNs were not both observed'
  for (const group of groups.values()) {
    const result = childOverlapWithinJob(group)
    if (result.pass) return result
    reason = result.reason
  }
  return { pass: false, reason }
}

function childOverlapWithinJob(intervals: readonly ChildInterval[]): { pass: boolean; evidence?: ChildInterval[]; reason: string } {
  const low = intervals.filter((interval) => interval.rendition === '360p')
  const high = intervals.filter((interval) => interval.rendition === '720p')
  let sawDistinctPair = false
  let missingEcsTiming = false
  for (const left of low) {
    for (const right of high) {
      if (left.taskArn === right.taskArn) continue
      sawDistinctPair = true
      if (!left.ecsStartedAt || !left.ecsStoppedAt || !right.ecsStartedAt || !right.ecsStoppedAt) {
        missingEcsTiming = true
        continue
      }
      const stepFunctions = intervalsOverlap(
        { start: Date.parse(left.stepFunctionsStart), end: Date.parse(left.stepFunctionsEnd) },
        { start: Date.parse(right.stepFunctionsStart), end: Date.parse(right.stepFunctionsEnd) },
      )
      const ecs = intervalsOverlap(
        { start: Date.parse(left.ecsStartedAt), end: Date.parse(left.ecsStoppedAt) },
        { start: Date.parse(right.ecsStartedAt), end: Date.parse(right.ecsStoppedAt) },
      )
      if (stepFunctions && ecs) {
        return { pass: true, evidence: [left, right], reason: '360p and 720p child task intervals overlap' }
      }
    }
  }
  if (!sawDistinctPair) return { pass: false, reason: 'distinct 360p and 720p child task ARNs were not both observed' }
  if (missingEcsTiming) return { pass: false, reason: 'ECS timestamps did not establish child execution overlap' }
  return { pass: false, reason: '360p and 720p child execution intervals do not overlap' }
}

function checkpoint(id: CheckpointId, status: CheckpointStatus, reason?: string, evidence?: unknown, observedAt?: string): Checkpoint {
  return {
    id,
    status,
    ...(observedAt ? { observedAt } : {}),
    ...(reason ? { reason } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  }
}

export function overallStatus(checkpoints: Record<CheckpointId, Checkpoint>): 'passed' | 'failed' {
  return CHECKPOINT_IDS.every((id) => checkpoints[id]?.status === 'PASS') ? 'passed' : 'failed'
}

export function evaluateScalability(input: ScalabilityEvaluationInput): Record<CheckpointId, Checkpoint> {
  const observedAt = new Date().toISOString()
  if (!input.attempted) {
    return Object.fromEntries(CHECKPOINT_IDS.map((id) => [id, checkpoint(id, 'NOT RUN', 'observation did not run')])) as Record<CheckpointId, Checkpoint>
  }

  const ordered = [...input.samples].filter((sample) => Number.isFinite(Date.parse(sample.observedAt)))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
  const scaled = ordered.find((sample) => sample.runningCount >= 2)
  const beforeScale = ordered.find((sample) => sample.runningCount === 1 && (!scaled || Date.parse(sample.observedAt) <= Date.parse(scaled.observedAt)))
  const parentScaleOut = beforeScale && scaled
    ? checkpoint('parentScaleOut', 'PASS', 'parent service scaled from 1 to at least 2 running tasks', {
      from: beforeScale,
      to: scaled,
    }, scaled.observedAt)
    : checkpoint('parentScaleOut', 'FAIL', scaled
      ? 'did not observe the parent service at one running task before scale-out'
      : 'parent service running task count never reached 2', { samples: ordered.length }, observedAt)

  const concurrency = parentConcurrency(input.activities)
  const parentJobConcurrency = checkpoint(
    'parentJobConcurrency',
    concurrency.pass ? 'PASS' : 'FAIL',
    concurrency.reason,
    concurrency.evidence ?? input.activities.slice(0, 20),
    observedAt,
  )

  const overlap = childOverlap(input.childIntervals)
  const childExecutionOverlap = checkpoint(
    'childExecutionOverlap',
    overlap.pass ? 'PASS' : 'FAIL',
    overlap.reason,
    overlap.evidence ?? input.childIntervals.slice(0, 20),
    observedAt,
  )

  const incomplete = input.jobs.filter((job) => job.status !== 'COMPLETED')
  const allJobsCompleted = input.jobs.length === input.batchSize && input.batchSize > 0 && incomplete.length === 0
    ? checkpoint('allJobsCompleted', 'PASS', 'every submitted job reached COMPLETED', {
      jobIds: input.jobs.map((job) => job.jobId),
    }, observedAt)
    : checkpoint('allJobsCompleted', input.jobs.length === 0 ? 'NOT RUN' : 'FAIL', input.jobs.length === 0
      ? 'no jobs were submitted'
      : 'one or more submitted jobs did not reach COMPLETED', {
      incompleteJobIds: incomplete.map((job) => job.jobId),
    }, observedAt)

  const completedAt = allJobsCompleted.status === 'PASS'
    ? Math.max(...input.jobs.map((job) => Date.parse(job.completedAt ?? job.createdAt)))
    : undefined
  const scaledAt = scaled ? Date.parse(scaled.observedAt) : undefined
  const scaleInSample = completedAt === undefined || scaledAt === undefined
    ? undefined
    : ordered.find((sample) => Date.parse(sample.observedAt) >= completedAt
      && Date.parse(sample.observedAt) >= scaledAt
      && sample.runningCount === input.minimumCapacity
      && sample.desiredCount === input.minimumCapacity)
  const scaleIn = completedAt === undefined
    ? checkpoint('scaleIn', 'NOT RUN', 'scale-in is observed only after every job completes')
    : !scaled
      ? checkpoint('scaleIn', 'FAIL', 'scale-in requires an observed scale-out before the return to minimum', undefined, observedAt)
      : scaleInSample
        ? checkpoint('scaleIn', 'PASS', 'parent service returned to its configured minimum after scale-out', scaleInSample, scaleInSample.observedAt)
        : checkpoint('scaleIn', 'FAIL', 'parent service did not return to its configured minimum after completion', undefined, observedAt)

  const playback = !input.playbackAttempted
    ? checkpoint('abrPlayback', 'NOT RUN', 'playback was not attempted')
    : input.playback && playbackPasses(input.playback)
      ? checkpoint('abrPlayback', 'PASS', 'video.js playback decoded, advanced, and switched renditions', input.playback.details, observedAt)
      : checkpoint('abrPlayback', 'FAIL', input.playback?.error || 'ABR playback did not meet the video.js checkpoint', input.playback?.details, observedAt)

  const checkpoints = {
    parentScaleOut,
    parentJobConcurrency,
    childExecutionOverlap,
    allJobsCompleted,
    scaleIn,
    abrPlayback: playback,
  }
  if (input.observationErrors.length > 0) {
    for (const id of CHECKPOINT_IDS) {
      const item = checkpoints[id]
      if (item.status === 'FAIL' && item.evidence && typeof item.evidence === 'object' && !Array.isArray(item.evidence)) {
        item.evidence = { ...(item.evidence as Record<string, unknown>), observationErrors: input.observationErrors.slice(0, 20) }
      }
    }
  }
  return checkpoints
}

function playbackPasses(playback: PlaybackSummary): boolean {
  return playback.usedVideoJs
    && playback.master
    && playback.playlist360
    && playback.playlist720
    && playback.segment360
    && playback.segment720
    && playback.decoded
    && playback.advanced
    && playback.switched
    && !playback.error
}

export function checkpointSummary(checkpoints: Record<CheckpointId, Checkpoint>): string {
  return CHECKPOINT_IDS.map((id) => `${id}=${checkpoints[id]?.status ?? 'NOT RUN'}`).join(', ')
}

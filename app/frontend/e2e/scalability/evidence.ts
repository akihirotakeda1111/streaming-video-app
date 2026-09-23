import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CHECKPOINT_IDS,
  checkpointSummary,
  evaluateScalability,
  overallStatus,
  type Checkpoint,
  type CheckpointId,
  type JobRecord,
  type ParentActivity,
  type ScalabilityEvaluationInput,
  type ServiceSample,
} from './checkpoints.js'

const FIXTURE_KEYS = new Set(['fixture_path', 'fixturePath'])

export function sanitizeEvidence<T>(value: T, forbiddenPaths: readonly string[]): T {
  const forbidden = forbiddenPaths.filter((path) => path.trim().length > 0)
  return walk(value) as T

  function walk(input: unknown): unknown {
    if (typeof input === 'string') return redact(input)
    if (Array.isArray(input)) return input.map((item) => walk(item))
    if (!input || typeof input !== 'object') return input
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (FIXTURE_KEYS.has(key)) continue
      if (key === 'fixture' && typeof item === 'string' && looksAbsolute(item)) continue
      result[key] = walk(item)
    }
    return result
  }

  function redact(input: string): string {
    let output = input
    for (const path of forbidden) output = output.split(path).join('[redacted-fixture]')
    return output
  }
}

function looksAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')
}

export interface FixtureIdentity {
  name: string
  durationSeconds: number
  sizeBytes?: number
  sha256?: string
  width?: number
  height?: number
}

export interface SubmissionObservation {
  windowSeconds: number
  elapsedSeconds: number
  withinWindow: boolean
}

export interface WorkloadDocument {
  scenario: 'scalability'
  status: 'passed' | 'failed'
  startedAt: string
  observedAt: string
  batchSize: number
  fixture?: FixtureIdentity
  jobs: JobRecord[]
  incompleteJobIds: string[]
  checkpoints: Record<CheckpointId, Checkpoint>
  summary: string
  samples: ServiceSample[]
  parentActivities: ParentActivity[]
  childIntervals: unknown[]
  playback?: unknown
  observationErrors: string[]
  finalized: boolean
  submission?: SubmissionObservation
  error?: string
}

export function buildWorkloadDocument(
  input: ScalabilityEvaluationInput & {
    startedAt: string
    fixture?: FixtureIdentity
    playbackDetails?: unknown
    error?: string
    finalized?: boolean
    submission?: SubmissionObservation
    forbiddenPaths?: readonly string[]
  },
): WorkloadDocument {
  const checkpoints = evaluateScalability(input)
  const incompleteJobIds = input.jobs.filter((job) => job.status !== 'COMPLETED').map((job) => job.jobId)
  const finalized = input.finalized === true
  const acceptance = overallStatus(checkpoints)
  const submissionOk = input.submission?.withinWindow !== false
  const document: WorkloadDocument = {
    scenario: 'scalability',
    finalized,
    status: finalized && submissionOk ? acceptance : 'failed',
    startedAt: input.startedAt,
    observedAt: new Date().toISOString(),
    batchSize: input.batchSize,
    ...(input.fixture ? { fixture: input.fixture } : {}),
    jobs: [...input.jobs],
    incompleteJobIds,
    checkpoints,
    summary: checkpointSummary(checkpoints),
    samples: [...input.samples],
    parentActivities: [...input.activities],
    childIntervals: [...input.childIntervals],
    ...(input.playbackDetails !== undefined ? { playback: input.playbackDetails } : {}),
    observationErrors: [...input.observationErrors],
    ...(input.submission ? { submission: input.submission } : {}),
    ...(input.error ? { error: input.error } : {}),
  }
  return sanitizeEvidence(document, input.forbiddenPaths ?? [])
}

export function notRunDocument(input: {
  startedAt: string
  batchSize: number
  error: string
  forbiddenPaths?: readonly string[]
}): WorkloadDocument {
  return buildWorkloadDocument({
    attempted: false,
    minimumCapacity: 1,
    batchSize: input.batchSize,
    jobs: [],
    samples: [],
    activities: [],
    childIntervals: [],
    playbackAttempted: false,
    observationErrors: [],
    startedAt: input.startedAt,
    error: input.error,
    forbiddenPaths: input.forbiddenPaths,
  })
}

export async function writeWorkload(directory: string, document: WorkloadDocument): Promise<void> {
  const target = join(directory, 'workload.json')
  const temporary = join(directory, `.workload-${process.pid}.json`)
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`)
  await rm(target, { force: true })
  await rename(temporary, target)
}

export function assertCheckpointsPresent(document: WorkloadDocument): void {
  for (const id of CHECKPOINT_IDS) {
    if (!document.checkpoints[id]) throw new Error(`missing checkpoint ${id}`)
  }
}

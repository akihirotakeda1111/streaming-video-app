import process from 'node:process'

export const e2eProjects = ['chromium', 'firefox', 'webkit'] as const
export type E2EProject = (typeof e2eProjects)[number]

export const reliabilityProject = 'reliability' as const

export interface E2ETimeouts {
  navigation: number
  upload: number
  processing: number
  lease: number
  visibility: number
  dlq: number
  playback: number
}

export interface E2EConfig {
  frontendUrl: string
  apiUrl: string
  project: E2EProject
  timeouts: E2ETimeouts
}

export interface ReliabilityConfig {
  frontendUrl: string
  apiUrl: string
  sourceQueue: string
  deadLetterQueue: string
  sourceBucket: string
  outputBucket: string
  alarmIdentifiers: readonly string[]
  workerObservation: string
  databaseObservation: string
  workerProcessControl: string
  databaseProcessControl: string
  timeouts: E2ETimeouts
}

function requiredUrl(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for E2E tests`)

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }

  return url.toString().replace(/\/$/, '')
}

function timeout(name: string, fallback: number, maximum = 900_000): number {
  const value = process.env[name]?.trim()
  if (!value) return fallback

  const milliseconds = Number(value)
  if (!Number.isInteger(milliseconds) || milliseconds <= 0 || milliseconds > maximum) {
    throw new Error(`${name} must be a positive integer in milliseconds`)
  }
  return milliseconds
}

function requiredValue(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for reliability E2E tests`)
  return value
}

function requiredIdentifiers(name: string): readonly string[] {
  const values = requiredValue(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) throw new Error(`${name} must contain at least one identifier`)
  return Object.freeze(values)
}

function reliabilityTimeouts(): E2ETimeouts {
  return Object.freeze({
    navigation: timeout('E2E_NAVIGATION_TIMEOUT_MS', 30_000),
    upload: timeout('E2E_UPLOAD_TIMEOUT_MS', 120_000),
    processing: timeout('E2E_PROCESSING_TIMEOUT_MS', 300_000),
    lease: timeout('E2E_LEASE_TIMEOUT_MS', 180_000),
    visibility: timeout('E2E_VISIBILITY_TIMEOUT_MS', 180_000),
    dlq: timeout('E2E_DLQ_TIMEOUT_MS', 300_000),
    playback: timeout('E2E_PLAYBACK_TIMEOUT_MS', 120_000),
  })
}

/** Returns safe values for Playwright discovery; it never authorizes a live run. */
export function reliabilityDiscoveryConfig(): ReliabilityConfig {
  return Object.freeze({
    frontendUrl: process.env.E2E_FRONTEND_URL?.trim() || 'http://127.0.0.1:5173',
    apiUrl: process.env.E2E_API_URL?.trim() || 'http://127.0.0.1:8000',
    sourceQueue: 'discovery-source-queue',
    deadLetterQueue: 'discovery-dead-letter-queue',
    sourceBucket: 'discovery-source-bucket',
    outputBucket: 'discovery-output-bucket',
    alarmIdentifiers: Object.freeze(['discovery-alarm']),
    workerObservation: 'discovery-worker-observation',
    databaseObservation: 'discovery-database-observation',
    workerProcessControl: 'discovery-worker-process-control',
    databaseProcessControl: 'discovery-database-process-control',
    timeouts: reliabilityTimeouts(),
  })
}

/** Validates live inputs and disposable opt-ins, even during discovery. */
export function loadReliabilityConfig(): ReliabilityConfig {
  if (process.env.E2E_ENVIRONMENT !== 'disposable') {
    throw new Error('E2E_ENVIRONMENT=disposable is required for reliability E2E tests')
  }
  if (process.env.E2E_RELIABILITY_DISPOSABLE !== 'true') {
    throw new Error('E2E_RELIABILITY_DISPOSABLE=true is required for reliability E2E tests')
  }
  return Object.freeze({
    frontendUrl: requiredUrl('E2E_FRONTEND_URL'),
    apiUrl: requiredUrl('E2E_API_URL'),
    sourceQueue: requiredValue('E2E_SOURCE_QUEUE'),
    deadLetterQueue: requiredValue('E2E_DLQ'),
    sourceBucket: requiredValue('E2E_SOURCE_BUCKET'),
    outputBucket: requiredValue('E2E_OUTPUT_BUCKET'),
    alarmIdentifiers: requiredIdentifiers('E2E_ALARM_IDENTIFIERS'),
    workerObservation: requiredValue('E2E_WORKER_OBSERVATION'),
    databaseObservation: requiredValue('E2E_DATABASE_OBSERVATION'),
    workerProcessControl: requiredValue('E2E_WORKER_PROCESS_CONTROL'),
    databaseProcessControl: requiredValue('E2E_DATABASE_PROCESS_CONTROL'),
    timeouts: reliabilityTimeouts(),
  })
}

/** Requires live authorization; discovery placeholders cannot satisfy this check. */
export function assertReliabilityAuthorization(): ReliabilityConfig {
  return loadReliabilityConfig()
}

function project(): E2EProject {
  const value = process.env.E2E_PROJECT?.trim() || 'chromium'
  if (!e2eProjects.includes(value as E2EProject)) {
    throw new Error(`E2E_PROJECT must be one of: ${e2eProjects.join(', ')}`)
  }
  return value as E2EProject
}

if (process.env.E2E_ENVIRONMENT !== 'disposable') {
  throw new Error('E2E_ENVIRONMENT=disposable is required to run E2E tests')
}

export const e2eConfig: E2EConfig = Object.freeze({
  frontendUrl: requiredUrl('E2E_FRONTEND_URL'),
  apiUrl: requiredUrl('E2E_API_URL'),
  project: project(),
  timeouts: Object.freeze({
    navigation: timeout('E2E_NAVIGATION_TIMEOUT_MS', 30_000),
    upload: timeout('E2E_UPLOAD_TIMEOUT_MS', 120_000),
    processing: timeout('E2E_PROCESSING_TIMEOUT_MS', 300_000),
    lease: timeout('E2E_LEASE_TIMEOUT_MS', 180_000),
    visibility: timeout('E2E_VISIBILITY_TIMEOUT_MS', 180_000),
    dlq: timeout('E2E_DLQ_TIMEOUT_MS', 300_000),
    playback: timeout('E2E_PLAYBACK_TIMEOUT_MS', 120_000),
  }),
})

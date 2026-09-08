// @ts-check
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const URL_NAMES = ['E2E_FRONTEND_URL', 'E2E_API_URL']
export const IDENTITY_NAMES = [
  'E2E_SOURCE_QUEUE', 'E2E_DLQ', 'E2E_SOURCE_BUCKET', 'E2E_OUTPUT_BUCKET',
  'E2E_WORKER_OBSERVATION', 'E2E_DATABASE_OBSERVATION',
  'E2E_WORKER_PROCESS_CONTROL', 'E2E_DATABASE_PROCESS_CONTROL', 'E2E_SOURCE_DLQ',
]
export const TIMING_NAMES = [
  'E2E_NAVIGATION_TIMEOUT_MS', 'E2E_UPLOAD_TIMEOUT_MS', 'E2E_PROCESSING_TIMEOUT_MS',
  'E2E_LEASE_TIMEOUT_MS', 'E2E_VISIBILITY_TIMEOUT_MS', 'E2E_DLQ_TIMEOUT_MS',
  'E2E_PLAYBACK_TIMEOUT_MS',
]
export const SCOPE_NAMES = ['E2E_WORKER_CONTROL_SCOPE', 'E2E_DATABASE_CONTROL_SCOPE']

/** @param {string} name @param {string} value */
function identity(name, value) {
  let resourceUrl
  if (value.includes('://')) {
    try { resourceUrl = new URL(value) } catch { resourceUrl = undefined }
    if (!resourceUrl || resourceUrl.protocol !== 'https:' || resourceUrl.username || resourceUrl.password || resourceUrl.search || resourceUrl.hash) {
      throw new Error(`${name} must be a non-secret resource identifier`)
    }
  }
  if (value.length > 512 || /\s|[?&=*]|password|passwd|secret|token|credential|receipt/i.test(value)) {
    throw new Error(`${name} must be a non-secret resource identifier`)
  }
}

/**
 * Pure configuration validation shared by the runner and direct Playwright runs.
 * Absence is allowed offline; malformed supplied values never authorize a run.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} live
 */
export function validateSettings(env, live) {
  /** @param {string} name */
  const value = (name) => {
    const result = env[name]?.trim()
    if (!result && live) throw new Error(`${name} is required for reliability E2E tests`)
    return result || undefined
  }
  for (const [name, expected] of /** @type {[string, string][]} */ ([
    ['E2E_ENVIRONMENT', 'disposable'], ['E2E_RELIABILITY_DISPOSABLE', 'true'],
  ])) {
    const supplied = env[name]?.trim()
    if ((live || supplied) && supplied !== expected) throw new Error(`${name}=${expected} is required`)
  }
  for (const name of URL_NAMES) {
    const supplied = value(name)
    if (!supplied) continue
    let url
    try { url = new URL(supplied) } catch { throw new Error(`${name} must be a valid URL`) }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use http or https`)
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(`${name} must not contain credentials, a query, or a fragment`)
    }
  }
  for (const name of IDENTITY_NAMES) {
    const supplied = value(name)
    if (supplied) identity(name, supplied)
  }
  for (const name of TIMING_NAMES) {
    const supplied = value(name)
    if (supplied && (!/^\d+$/.test(supplied) || Number(supplied) < 1 || Number(supplied) > 900_000)) {
      throw new Error(`${name} must be a positive integer in milliseconds (maximum 900000)`)
    }
  }
  const attempts = value('E2E_MAX_ATTEMPTS')
  if (attempts && (!/^\d+$/.test(attempts) || Number(attempts) < 1 || Number(attempts) > 10)) {
    throw new Error('E2E_MAX_ATTEMPTS must be between 1 and 10')
  }
  const alarms = value('E2E_ALARM_IDENTIFIERS')
  if (alarms) {
    const items = alarms.split(',').map((item) => item.trim()).filter(Boolean)
    if (!items.length) throw new Error('E2E_ALARM_IDENTIFIERS must contain at least one identifier')
    for (const item of items) identity('E2E_ALARM_IDENTIFIERS', item)
  }
  if (env.E2E_SOURCE_DLQ?.trim() && env.E2E_DLQ?.trim() && env.E2E_SOURCE_DLQ.trim() !== env.E2E_DLQ.trim()) {
    throw new Error('E2E_SOURCE_DLQ must match E2E_DLQ')
  }
  const relationship = value('E2E_SOURCE_DLQ_RELATIONSHIP')
  if (relationship && !['configured', 'verified'].includes(relationship)) {
    throw new Error('E2E_SOURCE_DLQ_RELATIONSHIP must be configured or verified')
  }
  if (live && relationship !== 'verified') throw new Error('E2E_SOURCE_DLQ_RELATIONSHIP=verified is required')
  for (const name of SCOPE_NAMES) {
    const supplied = value(name)
    if (!supplied) continue
    identity(name, supplied)
    if (['all', 'host', 'shared', 'production'].includes(supplied.toLowerCase())) {
      throw new Error(`${name} must identify only the disposable test-owned boundary`)
    }
  }
  const evidence = value('E2E_EVIDENCE_DIR')
  if (evidence && (!path.isAbsolute(evidence) || evidence.split(/[\\/]/).includes('..'))) {
    throw new Error('E2E_EVIDENCE_DIR must be an absolute run-owned path')
  }
}

/** Reports completeness without observing resources or creating run directories.
 * @param {Record<string, string | undefined>} env
 */
export function checkSettings(env) {
  validateSettings(env, false)
  try {
    validateSettings(env, true)
    return { configured: true }
  } catch {
    return { configured: false }
  }
}

/** @param {string[]} args @param {Record<string, string | undefined>} env @returns {any} */
function awsJson(args, env) {
  try {
    const output = execFileSync('aws', [...args, '--output', 'json'], {
      env: { ...process.env, ...env, AWS_EC2_METADATA_DISABLED: 'true' },
      encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.trim() ? JSON.parse(output) : {}
  } catch {
    throw new Error('read-only AWS adapter unavailable or permission denied')
  }
}

/** @param {string} value @param {Record<string, string | undefined>} env */
function queueUrl(value, env) {
  if (/^https:\/\/sqs\.[^/]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_.-]+$/.test(value)) return value
  const result = awsJson(['sqs', 'get-queue-url', '--queue-name', value], env)
  if (typeof result?.QueueUrl !== 'string') throw new Error('queue identity could not be resolved')
  return result.QueueUrl
}

/** @param {string} value @param {string} kind */
function processBoundary(value, kind) {
  const match = /^process:([A-Za-z0-9_.-]+)$/.exec(value)
  if (!match) throw new Error(`${kind} observation must use the supported process:name adapter`)
  try {
    const processes = execFileSync('ps', ['-eo', 'comm='], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] })
    if (!processes.split('\n').some((name) => name.trim() === match[1])) {
      throw new Error(`${kind} process is not running`)
    }
    return { adapter: 'process', identity: match[1], observable: true, controllable: true }
  } catch (error) {
    if (error instanceof Error && error.message.includes('process is not running')) throw error
    throw new Error(`${kind} process observation/control is unavailable`)
  }
}

/**
 * Bounded read-only verification. The adapter performs no queue, object,
 * database, worker, or scenario mutation. An adapter can be supplied by tests.
 * @param {{ env?: Record<string, string | undefined>, adapter?: (env: Record<string, string | undefined>) => object }} options
 */
export function verifyLiveBoundary({ env = process.env, adapter } = {}) {
  validateSettings(env, true)
  if (adapter) return adapter(env)
  const region = env.AWS_REGION?.trim()
  const account = env.E2E_AWS_ACCOUNT_ID?.trim()
  if (!region || !/^\d{12}$/.test(account || '')) {
    throw new Error('AWS_REGION and E2E_AWS_ACCOUNT_ID are required for live preflight')
  }
  /** @param {string} name */
  const required = (name) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is required for live preflight`)
    return value
  }
  const caller = awsJson(['sts', 'get-caller-identity'], env)
  if (caller?.Account !== account) throw new Error('AWS account does not match the disposable target')
  const sourceUrl = queueUrl(required('E2E_SOURCE_QUEUE'), env)
  const dlqUrl = queueUrl(required('E2E_DLQ'), env)
  const source = awsJson(['sqs', 'get-queue-attributes', '--queue-url', sourceUrl, '--attribute-names', 'All'], env)?.Attributes
  const dlq = awsJson(['sqs', 'get-queue-attributes', '--queue-url', dlqUrl, '--attribute-names', 'All'], env)?.Attributes
  if (!source || !dlq || source.RedrivePolicy === undefined) throw new Error('source queue redrive policy is unavailable')
  let redrive
  try { redrive = JSON.parse(source.RedrivePolicy) } catch { throw new Error('source queue redrive policy is malformed') }
  if (redrive.deadLetterTargetArn !== dlq.QueueArn) throw new Error('source queue does not redrive to the configured DLQ')
  for (const arn of [source.QueueArn, dlq.QueueArn, redrive.deadLetterTargetArn]) {
    if (typeof arn !== 'string' || !arn.startsWith(`arn:aws:sqs:${region}:${account}:`)) throw new Error('queue identity is outside the disposable account or region')
  }
  if (Number(redrive.maxReceiveCount) !== Number(env.E2E_MAX_ATTEMPTS)) throw new Error('source queue max receive count does not match E2E_MAX_ATTEMPTS')
  if (Number(source.VisibilityTimeout) < Number(env.E2E_VISIBILITY_TIMEOUT_MS)) throw new Error('source queue visibility timeout is below the configured contract bound')
  for (const bucket of [required('E2E_SOURCE_BUCKET'), required('E2E_OUTPUT_BUCKET')]) {
    awsJson(['s3api', 'head-bucket', '--bucket', bucket], env)
    const location = awsJson(['s3api', 'get-bucket-location', '--bucket', bucket], env)?.LocationConstraint
    const actualRegion = location || 'us-east-1'
    if (actualRegion !== region) throw new Error('bucket region does not match the disposable target')
  }
  const alarmIdentifiers = required('E2E_ALARM_IDENTIFIERS').split(',').map((item) => item.trim()).filter(Boolean)
  for (const alarm of alarmIdentifiers) {
    const found = awsJson(['cloudwatch', 'describe-alarms', '--alarm-names', alarm], env)
    /** @type {Array<{AlarmName?: string}> | undefined} */
    const metricAlarms = found?.MetricAlarms
    if (!Array.isArray(metricAlarms) || !metricAlarms.some((item) => item.AlarmName === alarm)) {
      throw new Error('configured alarm identity was not observed')
    }
  }
  const worker = processBoundary(required('E2E_WORKER_OBSERVATION'), 'worker')
  const database = processBoundary(required('E2E_DATABASE_OBSERVATION'), 'database')
  if (required('E2E_WORKER_PROCESS_CONTROL') !== `process:${worker.identity}` || required('E2E_DATABASE_PROCESS_CONTROL') !== `process:${database.identity}`) {
    throw new Error('process-control identity does not match the observed disposable process')
  }
  return { status: 'verified', account, region, sourceQueue: source.QueueArn, deadLetterQueue: dlq.QueueArn, worker, database, alarms: alarmIdentifiers, verifiedAt: new Date().toISOString() }
}

export function assertLiveBoundary() {
  return verifyLiveBoundary()
}

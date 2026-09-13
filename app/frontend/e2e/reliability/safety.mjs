// @ts-check
import path from 'node:path'
import { validateAlarmIdentifiers } from './alarm-identifiers.mjs'
import { observeLiveBoundary, validateTargetSettings } from './live.mjs'

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
    validateAlarmIdentifiers(items)
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
  validateTargetSettings(env, live)
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

/** @param {Parameters<typeof observeLiveBoundary>[0]} [options] */
export function verifyLiveBoundary(options = {}) {
  validateSettings(options.env || process.env, true)
  return observeLiveBoundary(options)
}

export function assertLiveBoundary() {
  return verifyLiveBoundary()
}

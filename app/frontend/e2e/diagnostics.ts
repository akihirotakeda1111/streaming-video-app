import { readFile } from 'node:fs/promises'
import type { TestInfo } from '@playwright/test'

const REDACTED = '[REDACTED]'
const PRESERVED_KEYS = new Set(['origin', 'path', 'status', 'videoId', 'jobId'])
const CREDENTIAL_KEY = /authorization|token|password|secret|credential|api[_-]?key|cookie/i
const URL_KEY = /url/i
const SECRET_FIELDS =
  /("?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|x-amz-[a-z-]+)"?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,"'}]+))/gi
const AUTH_HEADERS = /((?:Proxy-)?Authorization)\s*:\s*[^\r\n]*/gi
const COOKIE_HEADERS = /((?:Set-)?Cookie)\s*:\s*[^\r\n]*/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

/** Keeps only URL origin and path; presigned query strings never enter artifacts. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    const stripped = value.replace(/[?#][\s\S]*/, '')
    if (stripped !== value) {
      try {
        const url = new URL(stripped)
        return `${url.origin}${url.pathname}`
      } catch {
        return REDACTED
      }
    }
    return REDACTED
  }
}

function stripQueryAndFragment(value: string): string {
  const index = value.search(/[?#]/)
  return index === -1 ? value : value.slice(0, index)
}

/** Redacts URL query strings and common credential-shaped values while retaining IDs. */
export function redactText(value: string): string {
  let redacted = value.replace(/https?:\/\/[^\s"']+/gi, (url) => redactUrl(url))
  redacted = redacted.replace(AUTH_HEADERS, `$1: ${REDACTED}`)
  redacted = redacted.replace(COOKIE_HEADERS, `$1: ${REDACTED}`)
  redacted = redacted.replace(BEARER, `Bearer ${REDACTED}`)
  return redacted.replace(
    SECRET_FIELDS,
    (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`
      return `${prefix}${REDACTED}`
    },
  )
}

export interface SafeDiagnostic {
  origin?: string
  path?: string
  status?: number
  videoId?: string
  jobId?: string
  message?: string
  [key: string]: unknown
}

function sanitizeUnknown(value: unknown): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(sanitizeUnknown)
  if (typeof value === 'object' && value !== null) return sanitizeRecord(value as Record<string, unknown>)
  return value
}

function sanitizeRecord(input: Record<string, unknown>): SafeDiagnostic {
  const output: SafeDiagnostic = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue

    if (PRESERVED_KEYS.has(key)) {
      output[key] =
        (key === 'origin' || key === 'path') && typeof value === 'string' ? stripQueryAndFragment(value) : value
      continue
    }

    if (CREDENTIAL_KEY.test(key)) {
      output[key] = REDACTED
      continue
    }

    if (typeof value === 'string') {
      output[key] = URL_KEY.test(key) ? redactUrl(value) : redactText(value)
      continue
    }

    output[key] = sanitizeUnknown(value)
  }
  return output
}

/** Produces a JSON-safe diagnostic record with URLs and credential-like fields redacted. */
export function safeDiagnostic(input: SafeDiagnostic): SafeDiagnostic {
  return sanitizeRecord(input)
}

export async function attachSafeDiagnostic(testInfo: TestInfo, name: string, diagnostic: SafeDiagnostic): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(safeDiagnostic(diagnostic), null, 2)}\n`),
    contentType: 'application/json',
  })
}

export async function attachSafeText(testInfo: TestInfo, name: string, text: string): Promise<void> {
  await testInfo.attach(name, { body: Buffer.from(redactText(text)), contentType: 'text/plain' })
}

export async function attachSafeFile(testInfo: TestInfo, name: string, path: string): Promise<void> {
  await attachSafeText(testInfo, name, await readFile(path, 'utf8'))
}

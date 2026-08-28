import { readFile } from 'node:fs/promises'
import type { TestInfo } from '@playwright/test'

const REDACTED = '[REDACTED]'
const SECRET_FIELDS = /("?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|x-amz-[a-z-]+)"?\s*[:=]\s*["']?)([^\s,"'}]+)/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

/** Keeps only URL origin and path; presigned query strings never enter artifacts. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return redactText(value)
  }
}

/** Redacts URL query strings and common credential-shaped values while retaining IDs. */
export function redactText(value: string): string {
  let redacted = value.replace(/https?:\/\/[^\s"']+/gi, (url) => redactUrl(url))
  redacted = redacted.replace(BEARER, `Bearer ${REDACTED}`)
  return redacted.replace(SECRET_FIELDS, `$1${REDACTED}`)
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

/** Produces a JSON-safe diagnostic record with URLs and credential-like fields redacted. */
export function safeDiagnostic(input: SafeDiagnostic): SafeDiagnostic {
  const output: SafeDiagnostic = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (/url|authorization|token|password|secret|credential|api[_-]?key/i.test(key)) {
      output[key] = typeof value === 'string' ? redactUrl(value) : REDACTED
    } else if (typeof value === 'string') {
      output[key] = redactText(value)
    } else {
      output[key] = value
    }
  }
  return output
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

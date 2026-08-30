import process from 'node:process'

export const e2eProjects = ['chromium', 'firefox', 'webkit'] as const
export type E2EProject = (typeof e2eProjects)[number]

export interface E2ETimeouts {
  navigation: number
  upload: number
  processing: number
  playback: number
}

export interface E2EConfig {
  frontendUrl: string
  apiUrl: string
  project: E2EProject
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

function timeout(name: string, fallback: number): number {
  const value = process.env[name]?.trim()
  if (!value) return fallback

  const milliseconds = Number(value)
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`${name} must be a positive integer in milliseconds`)
  }
  return milliseconds
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
    playback: timeout('E2E_PLAYBACK_TIMEOUT_MS', 120_000),
  }),
})

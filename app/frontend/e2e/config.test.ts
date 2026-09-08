import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const liveInputs = {
  E2E_FRONTEND_URL: 'http://127.0.0.1:5173',
  E2E_API_URL: 'http://127.0.0.1:8000',
  E2E_SOURCE_QUEUE: 'test-source-queue',
  E2E_DLQ: 'test-dlq',
  E2E_SOURCE_BUCKET: 'test-source-bucket',
  E2E_OUTPUT_BUCKET: 'test-output-bucket',
  E2E_ALARM_IDENTIFIERS: 'test-alarm-1, test-alarm-2',
  E2E_WORKER_OBSERVATION: 'test-worker-observation',
  E2E_DATABASE_OBSERVATION: 'test-database-observation',
  E2E_WORKER_PROCESS_CONTROL: 'test-worker-process-control',
  E2E_DATABASE_PROCESS_CONTROL: 'test-database-process-control',
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('E2E_')) vi.stubEnv(name, undefined)
  }
  vi.stubEnv('E2E_ENVIRONMENT', 'disposable')
  vi.stubEnv('E2E_PROJECT', 'chromium')
  for (const [name, value] of Object.entries(liveInputs)) vi.stubEnv(name, value)
  vi.resetModules()
})

afterEach(() => vi.unstubAllEnvs())

describe('reliability E2E runtime configuration', () => {
  it('provides offline discovery defaults without authorizing execution', async () => {
    const { reliabilityDiscoveryConfig, assertReliabilityAuthorization } = await import('./config.js')
    for (const name of Object.keys(liveInputs)) vi.stubEnv(name, undefined)
    vi.stubEnv('E2E_DISCOVERY', 'true')
    const config = reliabilityDiscoveryConfig()
    expect(config.sourceQueue).toBe('discovery-source-queue')
    expect(config.frontendUrl).toBe('http://127.0.0.1:5173')
    expect(() => assertReliabilityAuthorization()).toThrow('E2E_RELIABILITY_DISPOSABLE=true')
  })

  it.each([undefined, 'true'])('requires both opt-ins with discovery=%s', async (discovery) => {
    const { assertReliabilityAuthorization } = await import('./config.js')
    vi.stubEnv('E2E_DISCOVERY', discovery)
    expect(() => assertReliabilityAuthorization()).toThrow('E2E_RELIABILITY_DISPOSABLE=true')
    vi.stubEnv('E2E_RELIABILITY_DISPOSABLE', 'true')
    vi.stubEnv('E2E_ENVIRONMENT', 'shared')
    expect(() => assertReliabilityAuthorization()).toThrow('E2E_ENVIRONMENT=disposable')
  })

  it.each(Object.keys(liveInputs))('rejects missing %s even during discovery', async (name) => {
    const { assertReliabilityAuthorization } = await import('./config.js')
    vi.stubEnv('E2E_RELIABILITY_DISPOSABLE', 'true')
    vi.stubEnv('E2E_DISCOVERY', 'true')
    vi.stubEnv(name, ' ')
    expect(() => assertReliabilityAuthorization()).toThrow(`${name} is required`)
  })

  it.each(['E2E_FRONTEND_URL', 'E2E_API_URL'])('redacts invalid %s values', async (name) => {
    const { loadReliabilityConfig } = await import('./config.js')
    vi.stubEnv('E2E_RELIABILITY_DISPOSABLE', 'true')
    vi.stubEnv(name, 'secret-invalid-url')
    expect(() => loadReliabilityConfig()).toThrow(new Error(`${name} must be a valid URL`))
    vi.stubEnv(name, 'ftp://user:secret@localhost')
    expect(() => loadReliabilityConfig()).toThrow(new Error(`${name} must use http or https`))
  })

  it('rejects an empty alarm identifier list', async () => {
    const { loadReliabilityConfig } = await import('./config.js')
    vi.stubEnv('E2E_RELIABILITY_DISPOSABLE', 'true')
    vi.stubEnv('E2E_ALARM_IDENTIFIERS', ' , , ')
    expect(() => loadReliabilityConfig()).toThrow('E2E_ALARM_IDENTIFIERS must contain at least one identifier')
  })

  it.each(['0', '-1', '1.5', '900001', 'invalid'])('rejects invalid timeout %s', async (value) => {
    const { loadReliabilityConfig } = await import('./config.js')
    vi.stubEnv('E2E_RELIABILITY_DISPOSABLE', 'true')
    vi.stubEnv('E2E_LEASE_TIMEOUT_MS', value)
    expect(() => loadReliabilityConfig()).toThrow('E2E_LEASE_TIMEOUT_MS must be a positive integer')
  })

  it.each([undefined, 'true'])('accepts authorized live inputs with discovery=%s', async (discovery) => {
    const { assertReliabilityAuthorization } = await import('./config.js')
    vi.stubEnv('E2E_DISCOVERY', discovery)
    vi.stubEnv('E2E_RELIABILITY_DISPOSABLE', 'true')
    vi.stubEnv('E2E_LEASE_TIMEOUT_MS', '900000')
    const config = assertReliabilityAuthorization()
    expect(config.sourceQueue).toBe(liveInputs.E2E_SOURCE_QUEUE)
    expect(config.alarmIdentifiers).toEqual(['test-alarm-1', 'test-alarm-2'])
    expect(config.timeouts.lease).toBe(900000)
  })
})

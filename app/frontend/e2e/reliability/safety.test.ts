import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { checkSettings, IDENTITY_NAMES, SCOPE_NAMES, TIMING_NAMES, URL_NAMES, validateSettings, verifyLiveBoundary } from './safety.mjs'

function completeSettings(): Record<string, string> {
  return {
    ...Object.fromEntries(IDENTITY_NAMES.map((name) => [name, 'test-owned'])),
    ...Object.fromEntries(URL_NAMES.map((name) => [name, 'http://127.0.0.1:8000'])),
    ...Object.fromEntries(TIMING_NAMES.map((name) => [name, '30000'])),
    ...Object.fromEntries(SCOPE_NAMES.map((name) => [name, 'test-owned'])),
    E2E_ENVIRONMENT: 'disposable', E2E_RELIABILITY_DISPOSABLE: 'true',
    E2E_SOURCE_DLQ_RELATIONSHIP: 'verified', E2E_MAX_ATTEMPTS: '3',
    E2E_ALARM_IDENTIFIERS: 'test-alarm', E2E_EVIDENCE_DIR: resolve('unused-test-evidence'),
    AWS_REGION: 'us-east-1', E2E_AWS_ACCOUNT_ID: '123456789012', E2E_DOCKER_HOST: 'unix:///var/run/docker.sock',
  }
}

describe('shared reliability safety policy', () => {
  it('distinguishes complete settings from actual live authorization', () => {
    expect(checkSettings({})).toEqual({ configured: false })
    expect(checkSettings(completeSettings())).toEqual({ configured: true })
    expect(() => verifyLiveBoundary({ env: completeSettings() })).toThrow('full Docker container ID')
  })

  it.each(Object.keys(completeSettings()))('requires %s live while allowing absence offline', (name) => {
    const env = completeSettings()
    delete env[name]
    expect(checkSettings(env)).toEqual({ configured: false })
    expect(() => validateSettings(env, true)).toThrow(name)
  })

  it.each(SCOPE_NAMES.flatMap((name) => ['all', 'host', 'shared', 'production', 'ALL', '*'].map((value) => [name, value])))('rejects unsafe %s=%s offline', (name, value) => {
    const env = { ...completeSettings(), [name!]: value! }
    expect(() => checkSettings(env)).toThrow(name)
    expect(() => validateSettings(env, true)).toThrow(name)
  })

  it.each(['0', '-1', '900001', '1.5', '1e3', '0x10', 'invalid'])('rejects malformed timing %s in both modes', (value) => {
    const env = { ...completeSettings(), E2E_LEASE_TIMEOUT_MS: value }
    expect(() => checkSettings(env)).toThrow('E2E_LEASE_TIMEOUT_MS')
    expect(() => validateSettings(env, true)).toThrow('E2E_LEASE_TIMEOUT_MS')
  })

  it('does not treat a configured relationship as verified', () => {
    const env: Record<string, string> = { ...completeSettings(), E2E_SOURCE_DLQ_RELATIONSHIP: 'configured' }
    expect(checkSettings(env)).toEqual({ configured: false })
    expect(() => validateSettings(env, true)).toThrow('verified')
    env.E2E_SOURCE_DLQ = 'another-dlq'
    expect(() => checkSettings(env)).toThrow('must match')
  })

  it.each([
    ['E2E_API_URL', 'https://user:private-value@example.test/?credential=private-value'],
    ['E2E_SOURCE_QUEUE', 'secret-private-value'],
    ['E2E_ALARM_IDENTIFIERS', ' , , '],
    ['E2E_EVIDENCE_DIR', '../private-value'],
    ['E2E_MAX_ATTEMPTS', '11'],
    ['E2E_AWS_ACCOUNT_ID', 'private-value'],
    ['AWS_REGION', 'private-value'],
    ['E2E_DOCKER_HOST', 'https://private-value'],
  ])('rejects and redacts malformed %s', (name, value) => {
    const env = { ...completeSettings(), [name!]: value! }
    for (const live of [false, true]) {
      expect(() => validateSettings(env, live)).toThrow(name)
      try { validateSettings(env, live) } catch (error) { expect(String(error)).not.toContain('private-value') }
    }
  })

  it('exercises the Python entry point with local-only fake boundaries', () => {
    const python = process.env.PYTHON || 'python'
    const result = spawnSync(python, ['-B', fileURLToPath(new URL('./runner_checks.py', import.meta.url))], {
      input: JSON.stringify(completeSettings()), encoding: 'utf8', timeout: 30_000,
    })
    expect(result.error, 'Python must be installed, or PYTHON must name its executable').toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }, 35_000)
})

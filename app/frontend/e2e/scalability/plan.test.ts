import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const script = join(repoRoot, 'app/scripts/run_scalability_e2e.py')
const scriptsDir = join(repoRoot, 'app/scripts')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function handoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: '123456789012',
    region: 'us-east-1',
    environment: 'scalability-e2e-test',
    api_url: 'https://api.example.com/api/v1',
    frontend_url: 'http://127.0.0.1:5173',
    playback_base_url: 'https://d111111abcdef8.cloudfront.net',
    cluster: 'cluster',
    worker_service: 'worker',
    parent_service: 'worker',
    step_functions_arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:orchestration',
    api_image_digest: `sha256:${'a'.repeat(64)}`,
    worker_image_digest: `sha256:${'b'.repeat(64)}`,
    distributed_mode: true,
    parent_min_capacity: 1,
    fixture_path: '/var/lib/operator/secret-scalability-fixture.mp4',
    fixture_duration_seconds: 30,
    api_service: 'api',
    input_bucket: 'sv-scale-e2e-test-input',
    worker_max_concurrency: 1,
    worker_min_capacity: 1,
    worker_max_capacity: 4,
    backlog_per_worker_target: 3,
    processing_seconds: 300,
    scale_out_cooldown_seconds: 180,
    scale_in_cooldown_seconds: 600,
    runtime_budget_seconds: 100_000,
    ...overrides,
  }
}

function check(config?: Record<string, unknown>): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env }
  if (config) {
    const directory = mkdtempSync(join(tmpdir(), 'scalability-plan-'))
    directories.push(directory)
    const path = join(directory, 'handoff.json')
    writeFileSync(path, JSON.stringify(config))
    env.SCALABILITY_E2E_CONFIG = path
  } else {
    env.SCALABILITY_E2E_CONFIG = ''
  }
  const result = spawnSync('python', [script, '--check'], { cwd: repoRoot, env, encoding: 'utf8' })
  return { status: result.status ?? 2, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('scalability offline plan', () => {
  it('checks configuration without AWS when no handoff is configured', () => {
    const result = check()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no AWS calls')
  })

  it('keeps visible backlog above the target after in-flight messages and omits the fixture path', () => {
    const fractional = check(handoff({ backlog_per_worker_target: 1.1 }))
    expect(fractional.status, fractional.stderr).toBe(0)
    const fractionalReport = JSON.parse(fractional.stdout) as {
      batchSize: number
      inFlightMessages: number
      sustainedBacklogPerWorker: number
      submissionMode: string
      rationale: string
    }
    expect(fractionalReport.batchSize).toBe(3)
    expect(fractionalReport.inFlightMessages).toBe(1)
    expect(fractionalReport.sustainedBacklogPerWorker).toBe(2)
    expect(fractionalReport.submissionMode).toBe('parallel')
    expect(fractionalReport.rationale).toContain('in-flight')
    expect(fractionalReport.rationale).toContain('parallel')
    expect(`${fractional.stdout}\n${fractional.stderr}`).not.toContain('secret-scalability-fixture')

    const steady = check(handoff())
    expect(steady.status, steady.stderr).toBe(0)
    const steadyReport = JSON.parse(steady.stdout) as {
      batchSize: number
      inFlightMessages: number
      sustainedBacklogPerWorker: number
    }
    expect(steadyReport).toMatchObject({ batchSize: 5, inFlightMessages: 1, sustainedBacklogPerWorker: 4 })

    const wider = check(handoff({ worker_max_concurrency: 2 }))
    expect(wider.status, wider.stderr).toBe(0)
    const widerReport = JSON.parse(wider.stdout) as { batchSize: number; inFlightMessages: number; sustainedBacklogPerWorker: number }
    expect(widerReport).toMatchObject({ batchSize: 6, inFlightMessages: 2, sustainedBacklogPerWorker: 4 })
  })

  it('requires the API service, dedicated input bucket, and worker concurrency', () => {
    const { api_service: _api, ...withoutApi } = handoff()
    expect(check(withoutApi).stderr).toContain('api_service')
    const { input_bucket: _bucket, ...withoutBucket } = handoff()
    expect(check(withoutBucket).stderr).toContain('input_bucket')
    const { worker_max_concurrency: _concurrency, ...withoutConcurrency } = handoff()
    expect(check(withoutConcurrency).stderr).toContain('worker_max_concurrency')
    expect(check(handoff({ input_bucket: 'Wrong_Bucket' })).status).toBe(2)
  })

  it('rejects a budget that cannot cover evaluation, cooldown, and playback', () => {
    const passing = check(handoff())
    expect(passing.status, passing.stderr).toBe(0)
    const required = (JSON.parse(passing.stdout) as { requiredBudgetSeconds: number }).requiredBudgetSeconds
    expect(check(handoff({ runtime_budget_seconds: required })).status).toBe(0)
    const short = check(handoff({ runtime_budget_seconds: required - 1 }))
    expect(short.status).toBe(2)
    expect(short.stderr).toContain('runtime budget')
  })

  it('rejects processing that ends before the scale-out evaluation window', () => {
    const result = check(handoff({ processing_seconds: 30 }))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('scale-out evaluation')
  })

  it('requires https for the API and CloudFront and allows loopback http for the frontend', () => {
    expect(check(handoff({ api_url: 'http://127.0.0.1:8000' })).status).toBe(2)
    expect(check(handoff({ playback_base_url: 'http://d111111abcdef8.cloudfront.net' })).status).toBe(2)
    expect(check(handoff({ frontend_url: 'http://192.168.0.10:5173' })).status).toBe(2)
    expect(check(handoff({ frontend_url: 'http://localhost:5173' })).status).toBe(0)
    expect(check(handoff({ frontend_url: 'http://[::1]:5173' })).status).toBe(0)
    expect(check(handoff({ frontend_url: 'https://app.example.com' })).status).toBe(0)
  })
})

describe('API health URL', () => {
  it('keeps a configured /api/v1 prefix', () => {
    const result = spawnSync('python', ['-c', `
import sys
sys.path.insert(0, sys.argv[1])
import run_scalability_e2e as runner
print(runner._api_health_url("https://api.example.com/api/v1"))
print(runner._api_health_url("https://api.example.com"))
print(runner._api_health_url("https://api.example.com/api/v1/"))
`, scriptsDir], { encoding: 'utf8' })
    expect(result.status, result.stderr ?? '').toBe(0)
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      'https://api.example.com/api/v1/health',
      'https://api.example.com/api/v1/health',
      'https://api.example.com/api/v1/health',
    ])
  })
})

describe('fixture evidence identity', () => {
  it('records name, duration, size, and hash without the absolute path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scalability-fixture-'))
    directories.push(directory)
    const fixture = join(directory, 'clip.mp4')
    writeFileSync(fixture, 'hello')
    const result = spawnSync('python', ['-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import run_scalability_e2e as runner
print(json.dumps(runner.fixture_record(Path(sys.argv[2]), 12.5)))
`, scriptsDir, fixture], { encoding: 'utf8' })
    expect(result.status, result.stderr ?? '').toBe(0)
    const record = JSON.parse(result.stdout) as { name: string; durationSeconds: number; sizeBytes: number; sha256: string }
    expect(record).toEqual({
      name: 'clip.mp4',
      durationSeconds: 12.5,
      sizeBytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
    expect(result.stdout).not.toContain(directory)
  })
})

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
    submission_window_seconds: 60,
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
      submissionWindowSeconds: number
      requiredBudgetSeconds: number
    }
    expect(steadyReport).toMatchObject({
      batchSize: 5,
      inFlightMessages: 1,
      sustainedBacklogPerWorker: 4,
      submissionWindowSeconds: 60,
      requiredBudgetSeconds: 2940,
    })

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

  it('rejects processing that ends before the submission window and scale-out evaluation', () => {
    const early = check(handoff({ processing_seconds: 30 }))
    expect(early.status).toBe(2)
    expect(early.stderr).toContain('scale-out evaluation')
    const overrun = check(handoff({ submission_window_seconds: 130 }))
    expect(overrun.status).toBe(2)
    expect(overrun.stderr).toContain('submission window')
    const { submission_window_seconds: _window, ...withoutWindow } = handoff()
    expect(check(withoutWindow).stderr).toContain('submission_window_seconds')
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

describe('scaling alarm observations', () => {
  function python(source: string): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('python', ['-c', source, scriptsDir], { encoding: 'utf8' })
    return { status: result.status ?? 2, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  it('reads metric-math periods from MetricStat and keeps scale-in below the target', () => {
    const result = python(`
import json, sys
sys.path.insert(0, sys.argv[1])
import run_scalability_e2e as runner
alarm = {
  "EvaluationPeriods": 3,
  "Metrics": [
    {"Id": "visible_backlog", "MetricStat": {"Period": 60, "Stat": "Sum"}},
    {"Id": "running_tasks", "MetricStat": {"Period": 60, "Stat": "Average"}},
    {"Id": "backlog_per_worker", "Expression": "visible_backlog / running_tasks"},
  ],
}
window = runner._alarm_window(alarm)
policy = {"Alarms": [
  {"AlarmName": "scale-out", "AlarmARN": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:scale-out"},
  {"AlarmARN": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:scale-in"},
]}
names = runner._policy_alarm_names(policy)
high, low = runner._scale_alarms([
  {"AlarmName": "scale-out", "ComparisonOperator": "GreaterThanThreshold", "Threshold": 3},
  {"AlarmName": "scale-in", "ComparisonOperator": "LessThanThreshold", "Threshold": 2.7},
], 3)
equal_high, equal_low = runner._scale_alarms([
  {"ComparisonOperator": "GreaterThanThreshold", "Threshold": 3},
  {"ComparisonOperator": "LessThanOrEqualToThreshold", "Threshold": 3},
], 3)
print(json.dumps({
  "window": window,
  "names": names,
  "low": low["Threshold"],
  "equalLow": equal_low["Threshold"],
  "high": high["ComparisonOperator"],
}))
try:
  runner._alarm_window({"EvaluationPeriods": 3, "Metrics": [
    {"MetricStat": {"Period": 60}},
    {"MetricStat": {"Period": 120}},
  ]})
except ValueError as error:
  print(error)
try:
  runner._scale_alarms([
    {"ComparisonOperator": "GreaterThanThreshold", "Threshold": 3},
    {"ComparisonOperator": "LessThanThreshold", "Threshold": 3.1},
  ], 3)
except ValueError as error:
  print(error)
`)
    expect(result.status, result.stderr).toBe(0)
    const [reportLine, disagree, above] = result.stdout.trim().split(/\r?\n/)
    expect(JSON.parse(reportLine ?? '{}')).toEqual({
      window: 180,
      names: ['scale-out', 'scale-in'],
      low: 2.7,
      equalLow: 3,
      high: 'GreaterThanThreshold',
    })
    expect(disagree).toContain('metric periods disagree')
    expect(above).toContain('scale-in alarm threshold')
  })
})

describe('fixture media probe', () => {
  it('requires a video stream of at least 1280x720 and uses the measured duration', () => {
    const result = spawnSync('python', ['-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
import run_scalability_e2e as runner
hd = runner.media_from_probe({
  "streams": [{"codec_type": "video", "width": 1920, "height": 1080, "duration": "12.25"}],
  "format": {"duration": "99"},
})
portrait = runner.media_from_probe({
  "streams": [{"codec_type": "video", "width": 1080, "height": 1920, "tags": {"rotate": "-90"}}],
  "format": {"duration": "30.5"},
})
print(json.dumps({"hd": hd, "portrait": portrait}))
try:
  runner.media_from_probe({"streams": [{"codec_type": "video", "width": 640, "height": 360, "duration": "10"}]})
except ValueError as error:
  print(error)
try:
  runner.media_from_probe({"streams": [{"codec_type": "video", "disposition": {"attached_pic": 1}, "width": 1920, "height": 1080}]})
except ValueError as error:
  print(error)
`, scriptsDir], { encoding: 'utf8' })
    expect(result.status, result.stderr ?? '').toBe(0)
    const [reportLine, below, missing] = result.stdout.trim().split(/\r?\n/)
    expect(JSON.parse(reportLine ?? '{}')).toEqual({
      hd: { width: 1920, height: 1080, durationSeconds: 12.25 },
      portrait: { width: 1920, height: 1080, durationSeconds: 30.5 },
    })
    expect(below).toContain('below 720p')
    expect(missing).toContain('no video stream')
  })
})

describe('fixture path normalization', () => {
  it('uses one absolute path and rejects relative or Windows paths on Linux', () => {
    const result = spawnSync('python', ['-c', `
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import run_scalability_e2e as runner
handle = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
handle.write(b"x")
handle.close()
try:
    resolved = runner._resolve_fixture_path(handle.name)
    home = runner._resolve_fixture_path("~/scalability-fixture-not-real.mp4")
    print("resolved-match", resolved == Path(handle.name).resolve() and resolved.is_absolute())
    print("home-match", home == (Path.home() / "scalability-fixture-not-real.mp4").resolve())
    print("same-string", str(resolved) == str(Path(handle.name).resolve()))
finally:
    os.remove(handle.name)
try:
    runner._resolve_fixture_path("clip.mp4")
except ValueError as error:
    print("relative", error)
try:
    runner._normalize_fixture_path(r"C:\\Users\\video.mp4", posix=True)
except ValueError as error:
    print("windows", error)
try:
    runner._normalize_fixture_path("C:/Users/video.mp4", posix=True)
except ValueError as error:
    print("windows-forward", error)
from pathlib import PurePosixPath
mnt = "/mnt/c/Users/video.mp4"
print("mnt-absolute", PurePosixPath(mnt).is_absolute() and runner.WINDOWS_FIXTURE_PATH.match(mnt) is None)
`, scriptsDir], { encoding: 'utf8' })
    expect(result.status, result.stderr ?? '').toBe(0)
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toBe('resolved-match True')
    expect(lines[1]).toBe('home-match True')
    expect(lines[2]).toBe('same-string True')
    expect(lines[3]).toContain('fixture_path must be an absolute path')
    expect(lines[4]).toContain('Linux absolute path')
    expect(lines[5]).toContain('Linux absolute path')
    expect(lines[6]).toBe('mnt-absolute True')
    expect(result.stdout).not.toContain('secret-scalability-fixture')
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

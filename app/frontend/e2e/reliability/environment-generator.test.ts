import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverEnvironment,
  renderPowerShell,
  main,
} from '../../../scripts/generate_reliability_env.mjs'
import { validateSettings } from './safety.mjs'
import { DockerFfmpegExhaustionAdapter } from './ffmpeg-exhaustion-adapter.js'

function fixture() {
  const account = '123456789012',
    region = 'us-east-1'
  const prefix = `https://sqs.${region}.amazonaws.com/${account}/`
  const arn = `arn:aws:sqs:${region}:${account}:`
  const settings: Record<string, string> = {
    AWS_REGION: region,
    VIDEO_ENCODING_QUEUE_URL: prefix + 'source',
    VIDEO_INPUT_BUCKET: 'input',
    VIDEO_OUTPUT_BUCKET: 'output',
    WORKER_HEARTBEAT_INTERVAL_SECONDS: '30',
    WORKER_VISIBILITY_EXTENSION_SECONDS: '120',
    WORKER_LEASE_DURATION_SECONDS: '300',
    WORKER_RETRY_DELAY_SECONDS: '900',
    WORKER_MAXIMUM_ATTEMPTS: '3',
    AWS_SECRET_ACCESS_KEY: 'private-credential',
    DATABASE_URL: 'postgres://private-db',
  }
  const alarms = [
    ['age', 'source', 'ApproximateAgeOfOldestMessage'],
    ['backlog', 'source', 'ApproximateNumberOfMessagesVisible'],
    ['dead', 'dlq', 'ApproximateNumberOfMessagesVisible'],
  ].map(([AlarmName, Value, MetricName]) => ({
    AlarmName,
    Namespace: 'AWS/SQS',
    MetricName,
    Dimensions: [{ Name: 'QueueName', Value }],
  }))
  const state = { labeled: true, visibility: '180', target: arn + 'dlq' }
  const calls: string[][] = []
  const execute = vi.fn((tool: string, args: string[], options: { timeout: number }) => {
    calls.push([tool, ...args])
    expect(options.timeout).toBeLessThanOrEqual(10000)
    let result: unknown
    if (tool === 'docker') {
      expect(args.slice(2, 4)).toEqual(['container', 'inspect'])
      const role = args[4] === 'worker' ? 'worker' : 'database'
      result = [
        {
          Id: (role === 'worker' ? 'a' : 'b').repeat(64),
          State: { Running: true },
          Config: {
            Labels: {
              'com.streaming-video.e2e.disposable': String(state.labeled),
              'com.streaming-video.e2e.scope': 'test-owned',
              'com.streaming-video.e2e.role': role,
            },
            Env: Object.entries(settings).map(([k, v]) => `${k}=${v}`),
          },
        },
      ]
    } else if (tool === 'aws') {
      switch (args[1]) {
        case 'get-caller-identity':
          result = { Account: account }
          break
        case 'get-queue-url':
          result = { QueueUrl: prefix + 'dlq' }
          break
        case 'get-queue-attributes':
          result = {
            Attributes:
              args[3] === prefix + 'source'
                ? {
                    QueueArn: arn + 'source',
                    VisibilityTimeout: state.visibility,
                    RedrivePolicy: JSON.stringify({
                      deadLetterTargetArn: state.target,
                      maxReceiveCount: 3,
                    }),
                  }
                : { QueueArn: arn + 'dlq' },
          }
          break
        case 'describe-alarms':
          result = {
            MetricAlarms: args.includes('--alarm-names')
              ? alarms.filter((a) => args.includes(a.AlarmName!))
              : alarms,
          }
          break
        default:
          throw new Error('unexpected operation')
      }
    } else throw new Error('unexpected tool')
    return JSON.stringify(result)
  })
  const options = {
    worker: 'worker',
    database: 'database',
    account,
    dockerHost: 'unix:///var/run/docker.sock',
  }
  return {
    options,
    execute: execute as unknown as typeof execFileSync,
    calls,
    settings,
    alarms,
    state,
  }
}
afterEach(() => vi.restoreAllMocks())

describe('read-only environment command generator', () => {
  it('derives exhaustion budgets from the actual short Worker and queue settings', () => {
    const f = fixture()
    Object.assign(f.settings, {
      WORKER_HEARTBEAT_INTERVAL_SECONDS: '5',
      WORKER_VISIBILITY_EXTENSION_SECONDS: '30',
      WORKER_LEASE_DURATION_SECONDS: '30',
      WORKER_RETRY_DELAY_SECONDS: '10',
      WORKER_MAXIMUM_ATTEMPTS: '3',
    })
    f.state.visibility = '30'
    const env = discoverEnvironment({ ...f.options, exclusive: true }, f.execute)
    expect(() => validateSettings(env, true)).not.toThrow()
    expect(env.E2E_MAX_ATTEMPTS).toBe('3')
    expect(env.E2E_VISIBILITY_TIMEOUT_MS).toBe('60000')
    expect(env.E2E_LEASE_TIMEOUT_MS).toBe('60000')
    expect(env.E2E_DLQ_TIMEOUT_MS).toBe('40000')
    const adapter = new DockerFfmpegExhaustionAdapter(
      {
        workerSettings: { heartbeat: 5, visibility: 30, lease: 30, retry: 10, attempts: 3 },
      } as ConstructorParameters<typeof DockerFfmpegExhaustionAdapter>[0],
      { ...env, E2E_FFMPEG_INVALID_FIXTURE: join(tmpdir(), 'invalid.mp4') },
    )
    expect(adapter.exhaustionMs).toBe(420000)
    expect(adapter.stabilityMs).toBe(60000)
  })
  it('derives the full existing configuration, budgets and repeated identities without secrets', () => {
    const f = fixture()
    const env = discoverEnvironment(
      { ...f.options, exclusive: true, profile: 'test-profile' },
      f.execute,
    )
    expect(() => validateSettings(env, true)).not.toThrow()
    expect(env.E2E_VISIBILITY_TIMEOUT_MS).toBe('210000')
    expect(env.E2E_LEASE_TIMEOUT_MS).toBe('330000')
    expect(env.E2E_DLQ_TIMEOUT_MS).toBe('900000')
    expect(env.E2E_SOURCE_DLQ).toBe(env.E2E_DLQ)
    expect(env.E2E_WORKER_OBSERVATION).toBe(env.E2E_WORKER_PROCESS_CONTROL)
    expect(env.E2E_ALARM_IDENTIFIERS).toBe('age,backlog,dead')
    expect(env.VIDEO_INPUT_BUCKET).toBe(env.E2E_SOURCE_BUCKET)
    expect(env.VIDEO_OUTPUT_BUCKET).toBe(env.E2E_OUTPUT_BUCKET)
    expect(env.OUTPUT_S3_ENDPOINT).toBe('https://output.s3.us-east-1.amazonaws.com')
    expect(env.FRONTEND_ORIGIN).toBe(new URL(env.E2E_FRONTEND_URL!).origin)
    expect(env.VITE_API_BASE_URL).toBe(env.E2E_API_URL + '/api/v1')
    const output = renderPowerShell(env)
    expect(output).toContain("$env:AWS_PROFILE = 'test-profile'")
    expect(output).not.toContain('private-')
    expect(output).not.toContain('$env:DATABASE_URL')
    expect(output).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(f.calls.every((c) => ['docker', 'aws'].includes(c[0]!))).toBe(true)
    expect(f.calls.filter((c) => c[0] === 'aws').every((c) => c.includes('--profile'))).toBe(true)
  })
  it('leaves explicit confirmation and an unspecified fixture for manual completion', () => {
    const f = fixture()
    const env = discoverEnvironment(f.options, f.execute)
    expect(env.E2E_RELIABILITY_DISPOSABLE).toBe('')
    expect(env.E2E_DUPLICATE_EXCLUSIVE).toBe('')
    expect(env.E2E_DUPLICATE_FIXTURE).toBe('')
    expect(env.E2E_FFMPEG_INVALID_FIXTURE).toBe('')
    expect(env.E2E_CLOCK_SKEW_MS).toBe('')
    expect(env.E2E_PROJECT).toBe('chromium')
    expect(() => validateSettings(env, true)).toThrow('DISPOSABLE')
  })
  it('aligns Compose ports, API CORS and frontend API requests with custom test URLs', () => {
    const f = fixture()
    const env = discoverEnvironment({ ...f.options, frontendUrl: 'http://localhost:5517/', apiUrl: 'http://localhost:8800/' }, f.execute)
    expect(env.FRONTEND_PORT).toBe('5517')
    expect(env.API_PORT).toBe('8800')
    expect(env.FRONTEND_ORIGIN).toBe('http://localhost:5517')
    expect(env.VITE_API_BASE_URL).toBe('http://localhost:8800/api/v1')
    expect(renderPowerShell(env)).toContain("$env:OUTPUT_S3_ENDPOINT = 'https://output.s3.us-east-1.amazonaws.com'")
    expect(env).not.toHaveProperty('COMPOSE_DATABASE_URL')
    expect(env).not.toHaveProperty('API_AWS_SECRET_ACCESS_KEY')
  })
  it.each(['account', 'labels', 'redrive', 'attempts', 'budget', 'heartbeat', 'missing-alarm'])(
    'rejects inconsistent %s instead of inventing values',
    (mode) => {
      const f = fixture()
      if (mode === 'account') f.options.account = '999999999999'
      if (mode === 'labels') f.state.labeled = false
      if (mode === 'redrive') f.state.target = 'arn:aws:sqs:us-east-1:999999999999:other'
      if (mode === 'attempts') f.settings.WORKER_MAXIMUM_ATTEMPTS = '2'
      if (mode === 'budget') f.state.visibility = '901'
      if (mode === 'heartbeat') f.settings.WORKER_HEARTBEAT_INTERVAL_SECONDS = '100'
      if (mode === 'missing-alarm') f.alarms.pop()
      expect(() => discoverEnvironment(f.options, f.execute)).toThrow()
    },
  )
  it('requires a selection when multiple alarms match the same metric', () => {
    const f = fixture()
    f.alarms.push({ ...f.alarms[0]!, AlarmName: 'another-age' })
    expect(() => discoverEnvironment(f.options, f.execute)).toThrow('ambiguous')
    expect(
      discoverEnvironment({ ...f.options, alarms: 'age,backlog,dead' }, f.execute)
        .E2E_ALARM_IDENTIFIERS,
    ).toBe('age,backlog,dead')
  })
  it('quotes PowerShell literals and rejects multiline or secret setting names', () => {
    expect(renderPowerShell({ E2E_EVIDENCE_DIR: "C:/test's/$value`/evidence" })).toContain(
      "'C:/test''s/$value`/evidence'",
    )
    expect(() => renderPowerShell({ E2E_PASSWORD: 'private-value' })).toThrow()
    expect(() => renderPowerShell({ E2E_EVIDENCE_DIR: 'path\ncommand' })).toThrow()
  })
  it('prints no partial commands or raw errors on transport and argument failures', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const failing = (() => {
      throw new Error('private-value')
    }) as unknown as typeof execFileSync
    expect(main(['--worker', 'worker', '--database', 'database'], failing)).toBe(2)
    expect(main(['--unknown-private-value'], failing)).toBe(2)
    expect(out).not.toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toContain('private-value')
  })
  it('creates a UTF-8 PowerShell file without overwriting it', () => {
    const f = fixture()
    const root = mkdtempSync(join(tmpdir(), 'e2e-env-generator-'))
    const output = join(root, 'settings.ps1'),
      mp4 = join(root, 'fixture.mp4'), invalid = join(root, 'invalid.mp4')
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      writeFileSync(mp4, 'test fixture bytes')
      writeFileSync(invalid, 'invalid mp4 bytes')
      const args = [
        '--worker',
        'worker',
        '--database',
        'database',
        '--fixture',
        mp4,
        '--invalid-fixture', invalid,
        '--clock-skew-ms', '100',
        '--full',
        '--docker-host',
        f.options.dockerHost,
        '--exclusive',
        '--output',
        output,
      ]
      expect(main(args, f.execute)).toBe(0)
      const text = readFileSync(output, 'utf8')
      expect(text.startsWith('\ufeff')).toBe(true)
      expect(text).toContain("$env:E2E_RELIABILITY_DISPOSABLE = 'true'")
      expect(text).toContain(mp4)
      expect(text).toContain(invalid)
      expect(text).toContain("$env:E2E_CLOCK_SKEW_MS = '100'")
      expect(text).toContain("$env:E2E_PROJECT = 'chromium'")
      expect(main(args, f.execute)).toBe(2)
      expect(readFileSync(output, 'utf8')).toBe(text)
    } finally {
      unlinkSync(mp4)
      unlinkSync(invalid)
      try {
        unlinkSync(output)
      } finally {
        rmdirSync(root)
      }
    }
  })

  it('rejects incomplete full-suite inputs before discovery', () => {
    const f = fixture()
    const options = { ...f.options, full: true, exclusive: true, fixture: 'normal.mp4', invalidFixture: 'invalid.mp4', clockSkewMs: '100' }
    for (const name of ['exclusive', 'fixture', 'invalidFixture', 'clockSkewMs'] as const) {
      expect(() => discoverEnvironment({ ...options, [name]: undefined }, f.execute)).toThrow('--full requires')
    }
    expect(f.execute).not.toHaveBeenCalled()
  })

  it.each(['0', '5001', '-1', '1.5', 'NaN', 'private-value'])('rejects invalid clock bounds %s without leaking inputs', (clockSkewMs) => {
    const f = fixture()
    expect(() => discoverEnvironment({ ...f.options, clockSkewMs }, f.execute)).toThrow('Invalid clock skew bound')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rejects an unavailable invalid fixture instead of generating a partial setup', () => {
    const f = fixture()
    expect(() => discoverEnvironment({ ...f.options, invalidFixture: join(tmpdir(), 'missing-e2e-invalid-file.mp4') }, f.execute)).toThrow('E2E_FFMPEG_INVALID_FIXTURE file unavailable')
  })
})

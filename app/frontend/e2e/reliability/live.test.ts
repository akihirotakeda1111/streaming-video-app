import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { verifyLiveBoundary, IDENTITY_NAMES, URL_NAMES, TIMING_NAMES, SCOPE_NAMES } from './safety.mjs'
import { observeLiveBoundary } from './live.mjs'

it('rejects option-like alarms even when preflight is called directly', () => {
  const execute = vi.fn()
  expect(() => observeLiveBoundary({ env: { E2E_ALARM_IDENTIFIERS: 'age,--profile,other' }, execute })).toThrow('E2E_ALARM_IDENTIFIERS')
  expect(execute).not.toHaveBeenCalled()
})

function fixture() {
  const account = '123456789012'
  const region = 'us-east-1'
  const prefix = `https://sqs.${region}.amazonaws.com/${account}/`
  const arn = `arn:aws:sqs:${region}:${account}:`
  const workerId = 'a'.repeat(64)
  const databaseId = 'b'.repeat(64)
  const env: Record<string, string> = {
    ...Object.fromEntries(IDENTITY_NAMES.map(n => [n, 'test-owned'])),
    ...Object.fromEntries(URL_NAMES.map(n => [n, 'http://127.0.0.1:8000'])),
    ...Object.fromEntries(TIMING_NAMES.map(n => [n, '900000'])),
    ...Object.fromEntries(SCOPE_NAMES.map(n => [n, 'test-owned'])),
    E2E_ENVIRONMENT: 'disposable', E2E_RELIABILITY_DISPOSABLE: 'true',
    E2E_SOURCE_DLQ_RELATIONSHIP: 'verified', E2E_MAX_ATTEMPTS: '3',
    E2E_SOURCE_QUEUE: 'source', E2E_DLQ: 'dlq', E2E_SOURCE_DLQ: 'dlq',
    E2E_SOURCE_BUCKET: 'input', E2E_OUTPUT_BUCKET: 'output',
    E2E_ALARM_IDENTIFIERS: 'age,backlog,dead', E2E_EVIDENCE_DIR: resolve('unused-test-evidence'),
    AWS_REGION: region, E2E_AWS_ACCOUNT_ID: account, E2E_DOCKER_HOST: 'unix:///var/run/docker.sock',
    E2E_WORKER_OBSERVATION: `docker:${workerId}`, E2E_WORKER_PROCESS_CONTROL: `docker:${workerId}`,
    E2E_DATABASE_OBSERVATION: `docker:${databaseId}`, E2E_DATABASE_PROCESS_CONTROL: `docker:${databaseId}`,
    E2E_VISIBILITY_TIMEOUT_MS: '180000', E2E_LEASE_TIMEOUT_MS: '300000',
  }
  const source = { QueueArn: arn + 'source', VisibilityTimeout: '180', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn + 'dlq', maxReceiveCount: 3 }) }
  const alarms = [
    { AlarmName: 'age', Namespace: 'AWS/SQS', MetricName: 'ApproximateAgeOfOldestMessage', Dimensions: [{ Name: 'QueueName', Value: 'source' }] },
    { AlarmName: 'backlog', Namespace: 'AWS/SQS', MetricName: 'ApproximateNumberOfMessagesVisible', Dimensions: [{ Name: 'QueueName', Value: 'source' }] },
    { AlarmName: 'dead', Namespace: 'AWS/SQS', MetricName: 'ApproximateNumberOfMessagesVisible', Dimensions: [{ Name: 'QueueName', Value: 'dlq' }] },
  ]
  const settings: Record<string,string> = { AWS_REGION: region, VIDEO_ENCODING_QUEUE_URL: prefix + 'source', VIDEO_INPUT_BUCKET: 'input', VIDEO_OUTPUT_BUCKET: 'output', DATABASE_URL: 'postgres://user:private-value@postgres:5432/test', WORKER_HEARTBEAT_INTERVAL_SECONDS: '30', WORKER_VISIBILITY_EXTENSION_SECONDS: '120', WORKER_LEASE_DURATION_SECONDS: '300', WORKER_RETRY_DELAY_SECONDS: '900', WORKER_MAXIMUM_ATTEMPTS: '3' }
  const container = (id: string, role: string) => ({ Id: id, Path: role === 'worker' ? '/usr/local/bin/video-worker' : 'docker-entrypoint.sh', Args: role === 'worker' ? [] : ['postgres'], State: { Running: true, Paused: false, Restarting: false, Pid: 100, StartedAt: '2026-09-08T00:00:00Z' }, Config: { Labels: { 'com.streaming-video.e2e.disposable': 'true', 'com.streaming-video.e2e.scope': 'test-owned', 'com.streaming-video.e2e.role': role }, Entrypoint: ['/usr/local/bin/video-worker'] }, HostConfig: { AutoRemove: false, Privileged: false, PidMode: '' }, NetworkSettings: { Networks: { test: { NetworkID: 'network-id', IPAddress: role === 'worker' ? '172.18.0.2' : '172.18.0.3', Aliases: role === 'worker' ? ['worker'] : ['postgres'] } } } })
  const worker = { ...container(workerId, 'worker'), Mounts: [] as {Type: string, Name: string}[] }
  const database = { ...container(databaseId, 'database'), Mounts: [{Type: 'volume', Name: 'test-db-data'}], State: { ...container(databaseId, 'database').State, Health: { Status: 'healthy' } } }
  const info = { ID: 'engine-id', OSType: 'linux', Plugins: { Authorization: [] as string[] } }
  const calls: string[][] = []
  const execute = vi.fn((tool: string, args: string[], options: {timeout: number}) => {
    calls.push([tool, ...args])
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout).toBeLessThanOrEqual(10000)
    let value: unknown
    if (tool === 'aws') {
      expect(args).toContain('--region')
      switch (args[1]) {
        case 'get-caller-identity': value = { Account: account }; break
        case 'get-queue-url': value = { QueueUrl: prefix + args[3] }; break
        case 'get-queue-attributes': value = { Attributes: args[3] === prefix + 'source' ? source : { QueueArn: arn + 'dlq' } }; break
        case 'head-bucket': case 'get-bucket-location':
          expect(args).toContain('--expected-bucket-owner')
          expect(args).toContain(account)
          value = args[1] === 'head-bucket' ? {} : { LocationConstraint: null }; break
        case 'describe-alarms': value = { MetricAlarms: alarms }; break
        default: throw new Error('unexpected operation')
      }
    } else if (tool === 'docker') {
      expect(args.slice(0, 2)).toEqual(['--host', env.E2E_DOCKER_HOST])
      if (args[2] === 'info') value = info
      else if (args[2] === 'volume') value = [{ Name: 'test-db-data', Driver: 'local', Options: null, Labels: {'com.streaming-video.e2e.disposable': 'true', 'com.streaming-video.e2e.scope': 'test-owned'} }]
      else if (args[3] === 'ls') value = databaseId
      else {
        expect(args.slice(2, 4)).toEqual(['container', 'inspect'])
        value = args[4] === workerId ? [{ ...worker, Config: { ...worker.Config, Env: Object.entries(settings).map(([k,v]) => `${k}=${v}`) } }] : [database]
      }
    } else throw new Error('unexpected tool')
    return JSON.stringify(value)
  })
  const run = () => verifyLiveBoundary({ env, execute: execute as unknown as typeof execFileSync })
  return { env, source, settings, worker, database, info, alarms, execute, calls, run }
}

afterEach(() => { vi.doUnmock('node:child_process'); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules() })

describe('live read-only verification policy', () => {
  it('verifies real policy using only fake read-only command responses', () => {
    const f = fixture()
    const evidence = f.run()
    expect(evidence.status).toBe('verified')
    expect(evidence.worker.identity).toBe('a'.repeat(64))
    expect(evidence.workerSettings).toEqual({ heartbeat: 30, visibility: 120, lease: 300, retry: 900, attempts: 3 })
    expect(JSON.stringify(evidence)).not.toContain('private-value')
    expect(f.calls.length).toBeGreaterThan(10)
  })
  it.each(['181', 'invalid', '', undefined])('rejects visibility exceeding the wait budget or malformed: %s', value => {
    const f = fixture(); f.source.VisibilityTimeout = value as string
    expect(f.run).toThrow(/visibility|Visibility/)
  })
  it.each([
    ['WORKER_MAXIMUM_ATTEMPTS', '10'], ['WORKER_HEARTBEAT_INTERVAL_SECONDS', '120'],
    ['WORKER_HEARTBEAT_INTERVAL_SECONDS', '100'], ['WORKER_VISIBILITY_EXTENSION_SECONDS', '181'],
    ['WORKER_LEASE_DURATION_SECONDS', '301'], ['WORKER_RETRY_DELAY_SECONDS', '43201'],
    ['VIDEO_ENCODING_QUEUE_URL', 'https://wrong.test/queue'], ['VIDEO_INPUT_BUCKET', 'wrong'],
    ['VIDEO_OUTPUT_BUCKET', 'wrong'], ['DATABASE_URL', 'postgres://private-value@unrelated:5432/db'],
    ['WORKER_MAXIMUM_ATTEMPTS', ''],
  ])('rejects mismatched effective worker setting %s', (name, value) => {
    const f = fixture(); f.settings[name!] = value!
    expect(f.run).toThrow()
    try { f.run() } catch (error) { expect(String(error)).not.toContain('private-value') }
  })
  it('rejects another redrive target and observed queue ARN', () => {
    const f = fixture(); f.source.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: 'wrong', maxReceiveCount: 3 })
    expect(f.run).toThrow('redrive')
    f.source.QueueArn = 'wrong'; expect(f.run).toThrow('ARN')
  })
  it.each(['Namespace', 'MetricName', 'queue'])('rejects an existing alarm with wrong %s', field => {
    const f = fixture()
    if (field === 'queue') f.alarms[0]!.Dimensions[0]!.Value = 'unrelated'
    else f.alarms[0]![field as 'Namespace' | 'MetricName'] = 'unrelated'
    expect(f.run).toThrow('alarm metric')
  })
  it.each(['com.streaming-video.e2e.disposable', 'com.streaming-video.e2e.scope', 'com.streaming-video.e2e.role'])('rejects unowned container: %s', key => {
    const f = fixture(); (f.worker.Config.Labels as Record<string,string>)[key] = 'wrong'
    expect(f.run).toThrow('ownership')
  })
  it('rejects process names, different control IDs, stopped containers and policy-restricted Engines', () => {
    const f = fixture(); f.env.E2E_WORKER_OBSERVATION = 'process:node'; expect(f.run).toThrow('full Docker')
    const g = fixture(); g.env.E2E_WORKER_PROCESS_CONTROL = g.env.E2E_DATABASE_PROCESS_CONTROL!; expect(g.run).toThrow('full Docker')
    const h = fixture(); h.worker.State.Running = false; expect(h.run).toThrow('stably running')
    const j = fixture(); j.info.Plugins.Authorization = ['restricted']; expect(j.run).toThrow('authorization plugins')
  })
  it('rejects unsafe restore, wrapper entrypoints, and disconnected database', () => {
    const f = fixture(); f.worker.HostConfig.AutoRemove = true; expect(f.run).toThrow('restore')
    const g = fixture(); g.worker.Path = '/bin/sh'; expect(g.run).toThrow('entrypoint')
    const h = fixture(); h.database.NetworkSettings.Networks.test.NetworkID = 'other'; expect(h.run).toThrow('database target')
    const j = fixture(); j.database.Mounts[0]!.Type = 'bind'; expect(j.run).toThrow('dedicated named')
    const k = fixture(); k.database.State.Health.Status = 'unhealthy'; expect(k.run).toThrow('healthcheck')
  })
  it.each(['permission denied private-value', 'ETIMEDOUT private-value', 'invalid JSON private-value'])('redacts transport failure %s', message => {
    const f = fixture(); f.execute.mockImplementationOnce(() => { throw new Error(message) })
    expect(f.run).toThrow(/^read-only aws observation failed/)
  })
  it('bounds the entire verification as well as individual observations', () => {
    const f = fixture(); let time = 0
    expect(() => verifyLiveBoundary({ env: f.env, execute: f.execute as unknown as typeof execFileSync, now: () => { time += 11000; return time } })).toThrow(/deadline|observation failed/)
  })
  it('rejects missing alarms, wrong bucket regions, foreign owners and changed containers', () => {
    for (const scenario of ['alarm', 'bucket', 'owner', 'restart', 'shared-volume']) {
      const f = fixture()
      const original = f.execute.getMockImplementation()!
      let inspections = 0
      f.execute.mockImplementation((tool, args, options) => {
        const output = original(tool, args, options)
        if (scenario === 'alarm' && args[1] === 'describe-alarms') return '{}'
        if (scenario === 'bucket' && args[1] === 'get-bucket-location') return JSON.stringify({ LocationConstraint: 'eu-west-1' })
        if (scenario === 'owner' && args[1] === 'head-bucket') throw new Error('403 private-value')
        if (scenario === 'shared-volume' && args[3] === 'ls') return '"other-container"'
        if (scenario === 'restart' && tool === 'docker' && args[3] === 'inspect' && ++inspections > 2) {
          const value = JSON.parse(output); value[0].State.StartedAt = 'changed'; return JSON.stringify(value)
        }
        return output
      })
      expect(f.run, scenario).toThrow()
    }
  })
  it('direct Playwright authorization runs the same policy and blocks mismatches before caller work', async () => {
    const f = fixture()
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    vi.resetModules()
    vi.doMock('node:child_process', () => ({ execFileSync: f.execute }))
    const { assertReliabilityAuthorization } = await import('../config.js')
    expect(assertReliabilityAuthorization().sourceQueue).toBe('source')
    f.settings.WORKER_MAXIMUM_ATTEMPTS = '10'
    const scenario = vi.fn()
    expect(() => { assertReliabilityAuthorization(); scenario() }).toThrow('attempts')
    expect(scenario).not.toHaveBeenCalled()
  })
})

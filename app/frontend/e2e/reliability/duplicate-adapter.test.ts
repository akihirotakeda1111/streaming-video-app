import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DockerDuplicateAdapter, duplicateEvents } from './duplicate-adapter.js'
import { duplicateTarget } from './duplicate-driver.js'
import { safeDiagnostic } from '../diagnostics.js'
vi.mock('node:fs', () => ({ statSync: () => ({ size: 4, isFile: () => true }) }))

function fixture() {
  const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
  const worker = 'a'.repeat(64),
    database = 'b'.repeat(64)
  const control = (identity: string) => ({
    adapter: 'docker',
    identity,
    startedAt: '2026-09-09T00:00:00Z',
    scope: 'test-owned',
    observable: true,
    controllable: true,
    controls: ['stop', 'start'],
    restore: 'start',
  })
  const boundary = {
    status: 'verified',
    account: '123456789012',
    region: 'us-east-1',
    sourceQueue: 'arn:aws:sqs:us-east-1:123456789012:source',
    deadLetterQueue: 'dlq',
    buckets: ['input', 'output'],
    dockerEngine: 'engine',
    worker: control(worker),
    database: control(database),
    workerSettings: { heartbeat: 1, visibility: 4, lease: 4, retry: 4, attempts: 3 },
    alarms: [],
    verifiedAt: 'now',
  }
  const env: NodeJS.ProcessEnv = {
    E2E_DUPLICATE_EXCLUSIVE: 'true',
    E2E_DUPLICATE_FIXTURE: resolve('fixture.mp4'),
    E2E_PROCESSING_TIMEOUT_MS: '1000',
    E2E_VISIBILITY_TIMEOUT_MS: '1000',
    E2E_NAVIGATION_TIMEOUT_MS: '1000',
    E2E_SOURCE_BUCKET: 'input',
    E2E_OUTPUT_BUCKET: 'output',
    E2E_AWS_ACCOUNT_ID: boundary.account,
    AWS_REGION: boundary.region,
    E2E_DOCKER_HOST: 'unix:///var/run/docker.sock',
  }
  const state = {
    owned: false,
    present: false,
    active: 0,
    startup: true,
    versioned: false,
    changed: false,
    pending: false,
    uncertainSend: false,
    failUpload: false,
    failInsert: false,
    sent: 0,
    objectKeys: [] as string[],
    invalidMetadata: false,
    raw: '',
  }
  const calls: { tool: string; args: string[]; input?: string }[] = []
  const container = (id: string) => ({
    Id: id,
    State: { Running: true, StartedAt: state.changed ? 'other' : boundary.worker.startedAt },
    Config: {
      Labels: {
        'com.streaming-video.e2e.scope': 'test-owned',
        'com.streaming-video.e2e.disposable': 'true',
      },
      Env: [
        'DATABASE_URL=postgres://user:private-password@postgres/db',
        'VIDEO_ENCODING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/source',
      ],
    },
  })
  const execute = (tool: string, args: string[], input?: string) => {
    calls.push({ tool, args, input })
    if (tool === 'docker') {
      if (args.includes('info')) return JSON.stringify({ ID: 'engine' })
      if (args.includes('inspect')) return JSON.stringify([container(args.at(-1)!)])
      if (args.includes('logs'))
        return args.includes('--tail')
          ? JSON.stringify({ fields: { duplicate_observation_schema: state.startup ? 1 : 0 } })
          : state.raw
      if (args.includes('psql')) {
        if (input?.includes('INSERT INTO')) {
          state.owned = state.present = true
          if (state.failInsert) throw new Error('transport lost')
          return ''
        }
        if (input?.includes("'active'")) return JSON.stringify({ active: state.active })
        if (input?.includes("'present'"))
          return JSON.stringify({ present: state.present, owned: state.owned })
        if (input?.includes('DELETE FROM')) {
          state.owned = false
          return ''
        }
        return JSON.stringify({
          status: state.pending ? 'PROCESSING' : 'COMPLETED',
          attempt: 1,
          workerId: state.pending ? 'owner' : null,
          leaseMs: state.pending ? 1000 : null,
          observedAtMs: 100,
          updatedAtMs: 20,
        })
      }
    }
    if (tool === 'aws') {
      if (args.includes('get-bucket-versioning'))
        return JSON.stringify(state.versioned ? { Status: 'Enabled' } : {})
      if (args.includes('get-bucket-notification-configuration'))
        return JSON.stringify({
          QueueConfigurations: [
            { QueueArn: boundary.sourceQueue, Events: ['s3:ObjectCreated:Put'] },
          ],
        })
      if (args.includes('put-object')) {
        if (state.failUpload) throw new Error('private-server-error')
        return '{}'
      }
      if (args.includes('send-message')) {
        if (state.uncertainSend) throw new Error('private-server-error')
        return JSON.stringify({ MessageId: `sent-${++state.sent}` })
      }
      if (args.includes('list-objects-v2'))
        return JSON.stringify({ Contents: state.objectKeys.map((Key) => ({ Key })) })
      if (args.includes('head-object'))
        return JSON.stringify({
          ContentLength: state.invalidMetadata ? 0 : 128,
          ContentType: args[args.indexOf('--key') + 1]!.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'video/mp2t',
        })
      if (args.includes('delete-object')) return '{}'
    }
    throw new Error('Unexpected external operation in fake transport')
  }
  const adapter = new DockerDuplicateAdapter(boundary, env, execute)
  let now = 0
  adapter.now = () => now
  adapter.sleep = async (ms) => {
    now += ms
  }
  const logs = (messageId = 'original', outcome = 'deleted') =>
    [
      JSON.stringify({
        timestamp: new Date(10).toISOString(),
        span: {
          name: 'worker_delivery',
          message_id: messageId,
          delivery_id: `${messageId}-1`,
        },
        fields: {
          job_id: target.jobId,
          video_id: target.videoId,
          worker_id: 'owner',
          outcome: 'already_completed',
        },
      }),
      JSON.stringify({
        timestamp: new Date(20).toISOString(),
        span: { name: 'worker_delivery', message_id: messageId, delivery_id: `${messageId}-1` },
        fields: { outcome },
      }),
    ].join('\n')
  return { adapter, target, state, env, calls, logs }
}

describe('delivery log correlation', () => {
  it('preserves server-time and lease evidence after sanitization', () => {
    const evidence = safeDiagnostic({
      observations: [
        { observedAtMs: 100, updatedAtMs: 80, leaseMs: 200, workerId: 'owner', attempt: 1 },
      ],
      receipt_handle: 'private-handle',
      database_url: 'postgres://user:private-password@host/db',
    })
    expect(evidence.observations).toEqual([
      { observedAtMs: 100, updatedAtMs: 80, leaseMs: 200, workerId: 'owner', attempt: 1 },
    ])
    expect(JSON.stringify(evidence)).not.toContain('private')
  })
  it('correlates deletion by delivery ID and excludes secrets and unrelated messages', () => {
    const f = fixture()
    const raw =
      f.logs() +
      '\n' +
      JSON.stringify({
        timestamp: new Date(21).toISOString(),
        span: { delivery_id: 'other', message_id: 'other' },
        fields: { outcome: 'deleted', receipt_handle: 'private-handle' },
      })
    const result = duplicateEvents(raw, f.target)
    expect(result.map((e) => e.outcome)).toEqual(['already_completed', 'deleted'])
    expect(result[1]!.messageId).toBe('original')
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('merges nested attempt and delivery spans and rejects uncorrelated/unsafe values', () => {
    const f = fixture()
    const row = {
      timestamp: new Date(10).toISOString(),
      spans: [
        {
          name: 'worker_delivery',
          delivery_id: 'delivery-1',
          message_id: 'message-1',
        },
        {
          name: 'worker_attempt',
          job_id: f.target.jobId,
          video_id: f.target.videoId,
          worker_id: 'owner',
          attempt: 1,
        },
      ],
      fields: {
        operation: 'segment_upload',
        outcome: 'success',
        object_key: f.target.prefix + 'hls/segment-00000.ts',
        receipt_handle: 'private-handle',
        database_url: 'private-db',
      },
    }
    const result = duplicateEvents(JSON.stringify(row), f.target)
    expect(result[0]).toMatchObject({ messageId: 'message-1', workerId: 'owner', attempt: 1 })
    expect(result[0]!.outcome).toBe('segment_published')
    expect(result[0]).not.toHaveProperty('objectKey')
    expect(JSON.stringify(result)).not.toContain('private')
    row.fields.operation = 'unrecognized_upload'
    expect(duplicateEvents(JSON.stringify(row), f.target)[0]!.outcome).toBe(
      'unsupported_media_operation',
    )
    row.spans[0]!.message_id = 'bad?secret'
    expect(() => duplicateEvents(JSON.stringify(row), f.target)).toThrow('malformed')
  })
  it('rejects the unknown sentinel used by Worker when message metadata is absent or unsafe', () => {
    const f = fixture()
    expect(() => duplicateEvents(f.logs('unknown'), f.target)).toThrow('malformed')
  })
})

describe('dedicated duplicate service adapter', () => {
  it.each(['matching', 'missing', 'extra', 'wrong-key', 'empty'])(
    'checks canonical expectations independently against %s S3 output',
    async (mode) => {
      const f = fixture()
      await f.adapter.prepare(f.target)
      const expected = [
        f.target.prefix + 'hls/segment-00000.ts',
        f.target.prefix + 'hls/index.m3u8',
      ]
      f.state.objectKeys = [...expected].reverse()
      if (mode === 'missing') f.state.objectKeys.pop()
      if (mode === 'extra') f.state.objectKeys.push(f.target.prefix + 'hls/segment-00001.ts')
      if (mode === 'wrong-key') f.state.objectKeys[1] = f.target.prefix + 'hls/segment-00001.ts'
      f.state.invalidMetadata = mode === 'empty'
      if (mode === 'matching')
        await expect(f.adapter.verifyOutput(expected)).resolves.toBeUndefined()
      else
        await expect(f.adapter.verifyOutput(expected)).rejects.toThrow(
          mode === 'empty' ? 'metadata' : 'Published keys',
        )
    },
  )
  it('creates canonical data and sends standard S3 notifications only to the source queue', async () => {
    const f = fixture()
    await f.adapter.prepare(f.target)
    await f.adapter.upload()
    expect(await f.adapter.sendDuplicate()).toBe('sent-1')
    const send = f.calls.find((c) => c.args.includes('send-message'))!
    const body = JSON.parse(send.args[send.args.indexOf('--message-body') + 1]!)
    expect(body.Records[0].s3.object.key).toBe(f.target.sourceKey)
    expect(body.Records[0].s3.bucket.name).toBe('input')
    expect(
      f.calls.some((c) =>
        c.args.some((a) =>
          ['receive-message', 'purge-queue', 'kill', 'start', 'apply'].includes(a),
        ),
      ),
    ).toBe(false)
  })
  it.each(['startup', 'versioned', 'active', 'changed', 'exclusive'])(
    'rejects unsupported %s before resource creation',
    async (field) => {
      const f = fixture()
      if (field === 'startup') f.state.startup = false
      if (field === 'versioned') f.state.versioned = true
      if (field === 'active') f.state.active = 1
      if (field === 'changed') f.state.changed = true
      if (field === 'exclusive') delete f.env.E2E_DUPLICATE_EXCLUSIVE
      await expect(f.adapter.prepare(f.target)).rejects.toThrow()
      expect(f.calls.some((c) => c.input?.includes('INSERT INTO'))).toBe(false)
    },
  )
  it('cleans up an ambiguous DB setup only after proving exact ownership', async () => {
    const f = fixture()
    f.state.failInsert = true
    await expect(f.adapter.prepare(f.target)).rejects.toThrow()
    await f.adapter.cleanup()
    expect(f.state.owned).toBe(false)
    expect(f.calls.find((c) => c.input?.includes('DELETE FROM'))!.input).toContain(f.target.runId)
  })
  it.each(['send', 'upload'])(
    'retains remote resources after uncertain %s outcome',
    async (mode) => {
      const f = fixture()
      await f.adapter.prepare(f.target)
      f.state.uncertainSend = mode === 'send'
      f.state.failUpload = mode === 'upload'
      await expect(
        mode === 'send' ? f.adapter.sendDuplicate() : f.adapter.upload(),
      ).rejects.toThrow('uncertain')
      await expect(f.adapter.cleanup()).rejects.toThrow('Uncertain')
      expect(
        f.calls.some((c) => c.args.includes('delete-object') || c.input?.includes('DELETE FROM')),
      ).toBe(false)
    },
  )
  it('retains pending run messages and unrelated objects instead of deleting them', async () => {
    const f = fixture()
    await f.adapter.prepare(f.target)
    await f.adapter.upload()
    await f.adapter.sendDuplicate()
    f.state.raw = f.logs()
    await expect(f.adapter.cleanup()).rejects.toThrow('pending')
    expect(f.state.owned).toBe(true)
    const g = fixture()
    await g.adapter.prepare(g.target)
    g.state.objectKeys = [g.target.sourceKey + '-unrelated']
    await expect(g.adapter.cleanup()).rejects.toThrow('Unexpected objects')
    expect(g.calls.some((c) => c.args.includes('delete-object'))).toBe(false)
  })
  it('cleans exact run resources only after every known message is acknowledged', async () => {
    const f = fixture()
    await f.adapter.prepare(f.target)
    await f.adapter.upload()
    await f.adapter.sendDuplicate()
    f.state.raw = f.logs() + '\n' + f.logs('sent-1')
    await f.adapter.cleanup()
    expect(f.state.owned).toBe(false)
    expect(
      f.calls.some((c) => c.args.includes('receive-message') || c.args.includes('delete-message')),
    ).toBe(false)
  })
  it('retains resources after the verified container changes', async () => {
    const f = fixture()
    await f.adapter.prepare(f.target)
    f.state.changed = true
    await expect(f.adapter.cleanup()).rejects.toThrow('changed')
    expect(f.calls.some((c) => c.input?.includes('DELETE FROM'))).toBe(false)
  })
})

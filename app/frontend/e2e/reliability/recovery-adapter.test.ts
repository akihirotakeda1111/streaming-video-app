import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('./safety.mjs', () => ({ verifyLiveBoundary: state.verify }))
import { DockerRecoveryAdapter, type Execute } from './recovery-adapter.js'
import { targetForRun } from './recovery-driver.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recovery-adapter-test-')); roots.push(root)
  const path = join(root, 'fixture.mp4'); writeFileSync(path, 'fixture')
  const target = targetForRun('e2e-11111111-1111-4111-8111-111111111111')
  const workerId = 'a'.repeat(64), databaseId = 'b'.repeat(64)
  const started = '2026-09-09T00:00:00Z'
  const boundary = { worker: { identity: workerId, startedAt: started, scope: 'test-owned' }, database: { identity: databaseId, startedAt: started },
    dockerEngine: 'engine', sourceQueue: 'arn:source', workerSettings: { heartbeat: 1, visibility: 3, lease: 3, retry: 1, attempts: 3 } }
  state.verify.mockReturnValue(boundary)
  const worker = { Id: workerId, State: { Running: true, Paused: false, Restarting: false, StartedAt: started }, Path: '/usr/local/bin/video-worker',
    HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false, Privileged: false, PidMode: '' },
    Config: { Labels: { 'com.streaming-video.e2e.disposable': 'true', 'com.streaming-video.e2e.scope': 'test-owned', 'com.streaming-video.e2e.role': 'worker' },
      Env: ['DATABASE_URL=postgres://user:secret@postgres/test', 'TMPDIR=/tmp/video-worker'] } }
  const env = { E2E_RECOVERY_EXCLUSIVE: 'true', E2E_RECOVERY_FIXTURE: path, E2E_PROCESSING_TIMEOUT_MS: '10000', E2E_LEASE_TIMEOUT_MS: '3000',
    E2E_VISIBILITY_TIMEOUT_MS: '3000', E2E_DOCKER_HOST: 'unix:///var/run/docker.sock', AWS_REGION: 'us-east-1', E2E_AWS_ACCOUNT_ID: '123456789012',
    E2E_SOURCE_BUCKET: 'input', E2E_OUTPUT_BUCKET: 'output' }
  const calls: { tool: string; args: string[]; input?: string }[] = []
  let unsafe = false, engine = 'engine'
  const execute: Execute = (tool, allArgs, input) => {
    calls.push({ tool, args: allArgs, input })
    const args = tool === 'docker' ? allArgs.slice(2) : allArgs
    let value: unknown = {}
    if (tool === 'aws') {
      if (args[1] === 'get-bucket-notification-configuration') value = { QueueConfigurations: [{ QueueArn: 'arn:source', Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'videos/' }, { Name: 'suffix', Value: '/source.mp4' }] } } }] }
      if (args[1] === 'list-objects-v2') value = { Contents: [{ Key: args[3] === 'input' ? target.sourceKey : unsafe ? 'unrelated/object' : target.prefix + 'hls/segment-00000.ts' }] }
      if (args[1] === 'head-object') value = { ContentLength: 1, ContentType: 'video/mp2t' }
    } else if (args[0] === 'info') value = { ID: engine, OSType: 'linux', Plugins: { Authorization: [] } }
    else if (args[0] === 'container' && args[1] === 'inspect') value = [args[2] === workerId ? worker : { Id: databaseId, State: { Running: true, StartedAt: started } }]
    else if (args[0] === 'container' && args[1] === 'kill') { worker.State.Running = false; return workerId }
    else if (args[0] === 'container' && args[1] === 'start') { worker.State.Running = true; worker.State.StartedAt = '2026-09-09T00:01:00Z'; return workerId }
    else if (args[0] === 'logs') value = args.includes('--tail') ? { fields: { observation_schema: 1 } } : {
      timestamp: started, fields: { video_id: target.videoId, job_id: target.jobId, worker_id: 'owner', attempt: 1, outcome: 'record_acknowledged' } }
    else if (args[0] === 'exec' && args.includes('psql')) {
      if (input?.includes("'active'")) value = { active: 0, now: Date.now() }
      else if (input?.includes("'owned'")) value = { owned: true, present: true }
      else if (input?.includes("'status'")) value = { status: 'COMPLETED', attempt: 1, worker_id: null, leaseMs: null, databaseNowMs: Date.now() }
      else return ''
    } else if (args[0] === 'exec' && args.includes('find')) return ''
    else throw new Error('unexpected adapter command')
    return JSON.stringify(value)
  }
  const adapter = new DockerRecoveryAdapter(boundary as ConstructorParameters<typeof DockerRecoveryAdapter>[0], env, execute)
  return { adapter, target, calls, worker, env, changeEngine: () => { engine = 'other' }, unsafeOutput: () => { unsafe = true } }
}
describe('scoped Docker and AWS recovery adapter', () => {
  it('uses full-ID kill/start and deletes only canonical owned resources', async () => {
    const f = fixture()
    await f.adapter.prepare(f.target); await f.adapter.upload(); await f.adapter.crash(); await f.adapter.restore(); await f.adapter.cleanup()
    const deletes = f.calls.filter(c => c.args.includes('delete-object'))
    expect(deletes).toHaveLength(2)
    expect(f.calls.filter(c => c.args.includes('kill'))[0]!.args).toContain('a'.repeat(64))
    expect(f.calls.some(c => c.args.includes('purge-queue') || c.args.includes('receive-message'))).toBe(false)
  })
  it('blocks changed engine before kill', async () => {
    const f = fixture(); await f.adapter.prepare(f.target); f.changeEngine()
    await expect(f.adapter.crash()).rejects.toThrow('boundary changed')
    expect(f.calls.some(c => c.args.includes('kill'))).toBe(false)
  })
  it('blocks unsupported auto restart before resource mutation', async () => {
    const f = fixture(); f.worker.HostConfig.RestartPolicy.Name = 'always'
    await expect(f.adapter.prepare(f.target)).rejects.toThrow('restart policy')
    expect(f.calls.some(c => c.input?.includes('INSERT'))).toBe(false)
  })
  it('never deletes an output outside the run prefix', async () => {
    const f = fixture(); await f.adapter.prepare(f.target); await f.adapter.upload(); f.unsafeOutput()
    await expect(f.adapter.cleanup()).rejects.toThrow('unexpected run output')
    expect(f.calls.some(c => c.args.includes('delete-object') && c.args.includes('unrelated/object'))).toBe(false)
  })
})

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { verifyLiveBoundary } from './safety.mjs'
import type { Event, Job, RecoveryAdapter, Target } from './recovery-driver.js'

type Boundary = ReturnType<typeof verifyLiveBoundary>
export type Execute = (tool: string, args: string[], input?: string) => string
const error = (message: string): never => { throw new Error(message) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const outcomes = new Set(['queue_received', 'acquired', 'acquisition_observed', 'source_downloaded', 'encode_started', 'encode_finished', 'lease_renewed', 'visibility_extended', 'segment_published', 'manifest_published', 'completed', 'record_acknowledged', 'retry_released', 'final_failed', 'ownership_lost', 'processing_error', 'infrastructure_failure', 'panicked'])
/** Allowlist fields before anything reaches an attachment. Raw Docker logs never leave memory. */
export function parseEvents(text: string, target: Target): Event[] {
  const result: Event[] = []
  for (const line of text.split('\n').filter(Boolean)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    const fields = { ...Object.assign({}, ...(event.spans || [])), ...event.span, ...event.fields }
    if (fields.video_id !== target.videoId || fields.job_id !== target.jobId || !outcomes.has(fields.outcome)) continue
    const at = Date.parse(event.timestamp)
    if (!Number.isFinite(at)) error('correlated log timestamp is invalid')
    const safe: Event = { at, outcome: fields.outcome }
    for (const name of ['worker_id', 'message_id'] as const) {
      if (fields[name] !== undefined) {
        if (typeof fields[name] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fields[name])) error('correlated log identity is invalid')
        safe[name] = fields[name]
      }
    }
    for (const name of ['attempt', 'visibility_seconds', 'lease_expires_at_ms'] as const) {
      if (fields[name] !== undefined) {
        if (!Number.isSafeInteger(fields[name]) || fields[name] <= 0) error('correlated log number is invalid')
        safe[name] = fields[name]
      }
    }
    for (const name of ['source_key', 'object_key'] as const) {
      if (fields[name] !== undefined) {
        if (typeof fields[name] !== 'string' || !fields[name].startsWith(target.prefix)
          || !/^[a-zA-Z0-9_./-]+$/.test(fields[name]) || fields[name].includes('..')) error('correlated object key is outside run scope')
        safe[name] = fields[name]
      }
    }
    result.push(safe)
  }
  if (result.length > 20000) error('correlated evidence exceeds bounded size')
  return result
}

/** AWS CLI and full-ID Docker controls; no shell, queue purge/receive/replay or deployment edits. */
export class DockerRecoveryAdapter implements RecoveryAdapter {
  readonly heartbeatMs: number
  readonly maximumAttempts: number
  readonly processingTimeoutMs: number
  readonly recoveryTimeoutMs: number
  private target?: Target
  private stoppedByRun = false
  private initialStarted: string
  private dbUser = ''
  private dbName = ''
  private uploaded = false
  private prepared = false
  private readonly fixture: string
  private readonly since: string
  private readonly execute: Execute
  constructor(private readonly boundary: Boundary, private readonly env: NodeJS.ProcessEnv = process.env, execute?: Execute) {
    this.heartbeatMs = boundary.workerSettings.heartbeat * 1000
    this.maximumAttempts = boundary.workerSettings.attempts
    this.processingTimeoutMs = Number(env.E2E_PROCESSING_TIMEOUT_MS)
    this.recoveryTimeoutMs = Math.max(Number(env.E2E_LEASE_TIMEOUT_MS), Number(env.E2E_VISIBILITY_TIMEOUT_MS)) + 15000
    this.initialStarted = boundary.worker.startedAt
    this.since = new Date().toISOString()
    this.fixture = env.E2E_RECOVERY_FIXTURE || ''
    this.execute = execute || ((tool, args, input) => {
      try {
        return execFileSync(tool, args, { encoding: 'utf8', input, timeout: 10000, maxBuffer: 16 * 1024 * 1024,
          windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env: { ...env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
        })
      } catch { return error(`recovery ${tool} operation failed (permission, timeout, or response)` ) }
    })
  }
  now = Date.now
  sleep = (ms: number) => setTimeout(ms)
  private docker(args: string[], input?: string): string { return this.execute('docker', ['--host', this.env.E2E_DOCKER_HOST!, ...args], input) }
  private aws(args: string[]): any {
    try { return JSON.parse(this.execute('aws', [...args, '--region', this.env.AWS_REGION!, '--output', 'json']) || '{}') }
    catch { return error('scoped AWS operation failed') }
  }
  private inspect(id: string): any {
    let data
    try { data = JSON.parse(this.docker(['container', 'inspect', id])) }
    catch { return error('container inspection failed') }
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.Id !== id) error('container identity mismatch')
    return data[0]
  }
  private checkIdentity(): any {
    let engine
    try { engine = JSON.parse(this.docker(['info', '--format', '{{json .}}'])) }
    catch { return error('Docker Engine observation failed') }
    if (engine.ID !== this.boundary.dockerEngine || engine.OSType !== 'linux'
      || (engine.Plugins?.Authorization?.length ?? 0) !== 0) error('Docker boundary changed')
    const c = this.inspect(this.boundary.worker.identity)
    if (c.Config?.Labels?.['com.streaming-video.e2e.disposable'] !== 'true'
      || c.Config?.Labels?.['com.streaming-video.e2e.scope'] !== this.boundary.worker.scope
      || c.Config?.Labels?.['com.streaming-video.e2e.role'] !== 'worker'
      || c.HostConfig?.RestartPolicy?.Name !== 'no' || c.HostConfig?.AutoRemove !== false
      || c.HostConfig?.Privileged !== false || c.HostConfig?.PidMode === 'host'
      || c.Path !== '/usr/local/bin/video-worker' || c.State?.Paused || c.State?.Restarting
      || c.State?.StartedAt !== this.initialStarted) error('worker control boundary changed or unsupported restart policy')
    return c
  }
  private sql(sql: string): any {
    const c = this.inspect(this.boundary.database.identity)
    if (!c.State?.Running || c.State.StartedAt !== this.boundary.database.startedAt) error('database boundary changed')
    const output = this.docker(['exec', '-i', this.boundary.database.identity, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-U', this.dbUser, '-d', this.dbName], `SET statement_timeout='8s';\n${sql}\n`)
    try { return output.trim() ? JSON.parse(output.trim()) : null } catch { return error('database observation is malformed') }
  }
  async prepare(target: Target): Promise<void> {
    if (!UUID.test(target.videoId) || !UUID.test(target.jobId) || target.sourceKey !== `videos/${target.videoId}/jobs/${target.jobId}/source.mp4`) error('noncanonical run target')
    if (this.env.E2E_RECOVERY_EXCLUSIVE !== 'true') error('E2E_RECOVERY_EXCLUSIVE=true is required for dedicated worker and resources')
    if (!isAbsolute(this.fixture) || !this.fixture.toLowerCase().endsWith('.mp4')) error('E2E_RECOVERY_FIXTURE must be an absolute MP4 path')
    const size = statSync(this.fixture).size
    if (!size || size > 1024 * 1024 * 1024) error('fixture must be between 1 byte and 1 GiB')
    const c = this.checkIdentity()
    if (!c.State.Running) error('worker is not running')
    const startup = this.docker(['logs', '--since', c.State.StartedAt, '--tail', '2000', c.Id])
    if (!startup.split('\n').some(line => { try { return JSON.parse(line).fields?.observation_schema === 1 } catch { return false } })) error('worker image lacks recovery observation schema 1; rebuild and restart before running')
    const settings = Object.fromEntries(c.Config.Env.map((entry: string) => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)] }))
    if (settings.TMPDIR !== '/tmp/video-worker') error('recovery cleanup requires the repository TMPDIR /tmp/video-worker')
    let db: URL
    try { db = new URL(settings.DATABASE_URL) } catch { return error('worker database identity unavailable') }
    this.dbUser = decodeURIComponent(db.username)
    this.dbName = decodeURIComponent(db.pathname.slice(1))
    if (!/^[a-zA-Z0-9_]+$/.test(this.dbUser) || !/^[a-zA-Z0-9_]+$/.test(this.dbName)) error('unsupported database name or role')
    // Revalidate full authorization immediately before creating resources.
    const fresh = verifyLiveBoundary({ env: this.env, execute: ((tool: string, args: string[]) => this.execute(tool, args)) as typeof execFileSync })
    if (fresh.worker.startedAt !== this.initialStarted || fresh.dockerEngine !== this.boundary.dockerEngine) error('live boundary changed')
    for (const bucket of [this.env.E2E_SOURCE_BUCKET!, this.env.E2E_OUTPUT_BUCKET!]) {
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) error('unsupported bucket identity')
      const version = this.aws(['s3api', 'get-bucket-versioning', '--bucket', bucket, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      if (version.Status) error('versioned buckets are unsupported by scoped cleanup')
    }
    const notifications = this.aws(['s3api', 'get-bucket-notification-configuration', '--bucket', this.env.E2E_SOURCE_BUCKET!, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
    const queues = notifications.QueueConfigurations || []
    const rules = queues[0]?.Filter?.Key?.FilterRules || []
    if (!Array.isArray(rules) || rules.some((rule: {Name: string, Value: string}) => typeof rule.Value !== 'string'
      || (rule.Name === 'prefix' ? !target.sourceKey.startsWith(rule.Value) : rule.Name === 'suffix' ? !target.sourceKey.endsWith(rule.Value) : true))) error('source key does not match S3 notification filters')
    if (queues.length !== 1 || queues[0].QueueArn !== this.boundary.sourceQueue
      || !queues[0].Events?.some((event: string) => ['s3:ObjectCreated:*', 's3:ObjectCreated:Put'].includes(event))
      || notifications.TopicConfigurations?.length || notifications.LambdaFunctionConfigurations?.length || notifications.EventBridgeConfiguration) error('requires one matching direct S3-to-source-queue notification')
    const ready = this.sql("SELECT json_build_object('active', (SELECT count(*) FROM jobs WHERE status IN ('UPLOADING','QUEUED','PROCESSING')), 'now', extract(epoch from clock_timestamp())*1000);")
    if (ready.active !== 0 || Math.abs(ready.now - this.now()) > 1000) error('database has active work or clock skew exceeds one second')
    this.target = target
    this.prepared = true // Register before mutation, including ambiguous transport failures.
    this.sql(`BEGIN; INSERT INTO videos(video_id,file_name,content_type,size_bytes,upload_bucket,upload_key,upload_expires_at)
      VALUES ('${target.videoId}','${target.runId}.mp4','video/mp4',${size},'${this.env.E2E_SOURCE_BUCKET}','${target.sourceKey}',now()+interval '1 hour');
      INSERT INTO jobs(id,video_id,status) VALUES ('${target.jobId}','${target.videoId}','UPLOADING'); COMMIT;`)
  }
  async upload(): Promise<void> {
    this.uploaded = true
    this.aws(['s3api', 'put-object', '--bucket', this.env.E2E_SOURCE_BUCKET!, '--key', this.target!.sourceKey,
      '--body', this.fixture, '--content-type', 'video/mp4', '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
  }
  async observe() {
    const t = this.target!
    const job: Job = this.sql(`SELECT json_build_object('status',status,'attempt',attempt,'worker_id',worker_id,
      'leaseMs',extract(epoch from lease_expires_at)*1000,'databaseNowMs',extract(epoch from clock_timestamp())*1000)
      FROM jobs WHERE id='${t.jobId}' AND video_id='${t.videoId}';`)
    if (!job || !Number.isFinite(job.databaseNowMs) || !Number.isSafeInteger(job.attempt)) error('run job observation unavailable')
    const events = parseEvents(this.docker(['logs', '--since', this.since, this.boundary.worker.identity]), t)
    return { job, events }
  }
  async crash(): Promise<void> {
    const c = this.checkIdentity()
    if (!c.State.Running) error('worker stopped before crash injection')
    this.stoppedByRun = true // Restore even if the kill response is lost.
    this.docker(['container', 'kill', '--signal', 'KILL', c.Id])
    if (this.inspect(c.Id).State.Running) error('worker did not stop within crash boundary')
  }
  async restore(): Promise<void> {
    if (!this.stoppedByRun) return
    const c = this.checkIdentity()
    if (!c.State.Running) this.docker(['container', 'start', c.Id])
    const restored = this.inspect(c.Id)
    if (!restored.State.Running || restored.State.Paused || restored.State.Restarting) error('worker restore could not be verified')
    this.initialStarted = restored.State.StartedAt
    this.stoppedByRun = false
  }
  async verifyOutput(keys: string[]): Promise<void> {
    const t = this.target!
    const deadline = this.now() + this.processingTimeoutMs
    if (keys.length > 512) error('recovery fixture exceeds bounded publication size')
    const listed = this.aws(['s3api', 'list-objects-v2', '--bucket', this.env.E2E_OUTPUT_BUCKET!, '--prefix', t.prefix + 'hls/', '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
    const actual = (listed.Contents || []).map((o: {Key: string}) => o.Key).sort()
    if (listed.IsTruncated || JSON.stringify(actual) !== JSON.stringify([...new Set(keys)].sort())) error('published object set differs from evidence')
    for (const key of actual) {
      if (this.now() >= deadline) error('publication verification deadline exceeded')
      const head = this.aws(['s3api', 'head-object', '--bucket', this.env.E2E_OUTPUT_BUCKET!, '--key', key, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      if (!(head.ContentLength > 0) || head.ContentType !== (key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')) error('published object metadata is invalid')
    }
  }
  async cleanup(): Promise<void> {
    if (!this.prepared || !this.target) return
    const deadline = this.now() + this.processingTimeoutMs
    const t = this.target
    const ownership = this.sql(`SELECT json_build_object('present', EXISTS(SELECT 1 FROM videos WHERE video_id='${t.videoId}'),
      'owned', EXISTS(SELECT 1 FROM videos WHERE video_id='${t.videoId}' AND upload_key='${t.sourceKey}' AND file_name='${t.runId}.mp4'));`)
    if (!ownership?.owned) {
      if (ownership?.present || this.uploaded) error('cleanup cannot prove run resource ownership')
      this.prepared = false
      return
    }
    if (this.uploaded) {
      const s = await this.observe()
      if (s.job.status !== 'COMPLETED' || !s.events.some(e => e.outcome === 'record_acknowledged')) error('run remains active; resources retained')
    }
    const worker = this.checkIdentity()
    if (!worker.State.Running) error('worker must be restored before scoped cleanup')
    const directories = this.docker(['exec', worker.Id, 'find', '/tmp/video-worker', '-mindepth', '1', '-maxdepth', '1',
      '-type', 'd', '-name', `job-${t.jobId}-*`, '-print']).split('\n').filter(Boolean)
    for (const directory of directories) {
      if (this.now() >= deadline) error('scoped cleanup deadline exceeded')
      if (!new RegExp(`^/tmp/video-worker/job-${t.jobId}-[a-zA-Z0-9]+$`).test(directory)
        || this.docker(['exec', worker.Id, 'readlink', '-f', '--', directory]).trim() !== directory) error('temporary directory escaped run scope')
      this.docker(['exec', worker.Id, 'rm', '-rf', '--', directory])
    }
    for (const [bucket, prefix] of [[this.env.E2E_SOURCE_BUCKET!, t.sourceKey], [this.env.E2E_OUTPUT_BUCKET!, t.prefix + 'hls/']]) {
      const objects = this.aws(['s3api', 'list-objects-v2', '--bucket', bucket!, '--prefix', prefix!, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      if (objects.IsTruncated) error('cleanup object limit exceeded')
      for (const o of objects.Contents || []) {
        if (this.now() >= deadline) error('scoped cleanup deadline exceeded')
        if (bucket === this.env.E2E_SOURCE_BUCKET ? o.Key !== t.sourceKey : !new RegExp('^' + t.prefix + 'hls/(index\\.m3u8|segment-[0-9]{5}\\.ts)$').test(o.Key)) error('unexpected run output retained')
        this.aws(['s3api', 'delete-object', '--bucket', bucket!, '--key', o.Key, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      }
    }
    this.sql(`DELETE FROM videos WHERE video_id='${t.videoId}' AND upload_key='${t.sourceKey}' AND file_name='${t.runId}.mp4';`)
    this.prepared = false
  }
}

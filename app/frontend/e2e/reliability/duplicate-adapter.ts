import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { verifyLiveBoundary } from './safety.mjs'
import { SafeTransportError, transportFailure } from './transport-diagnostics.js'
import {
  acknowledged,
  sideEffects,
  type DuplicateAdapter,
  type DuplicateEvent,
  type DuplicateJob,
  type DuplicateTarget,
} from './duplicate-driver.js'

type Boundary = ReturnType<typeof verifyLiveBoundary>
export type DuplicateTransport = (tool: string, args: string[], input?: string) => string
const fail = (message: string): never => {
  throw new Error(message)
}
const identity = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(v)
// Spec 25 emits operation + start/success; these labels are internal E2E names.
const mediaOutcomes: Record<string, Record<string, string>> = {
  download: { start: 'download_started', success: 'source_downloaded' },
  encode: { start: 'encode_started', success: 'encode_finished' },
  segment_upload: { start: 'segment_upload_started', success: 'segment_published' },
  manifest_upload: { start: 'manifest_upload_started', success: 'manifest_published' },
}
const outcomes = new Set([
  'acquired',
  'busy',
  'already_completed',
  'completed',
  'retained',
  'deleted',
  'download_started',
  'source_downloaded',
  'encode_started',
  'encode_finished',
  'segment_upload_started',
  'segment_published',
  'manifest_upload_started',
  'manifest_published',
  'queue_update_failed',
  'retry_released',
  'final_failed',
  'ownership_lost',
  'cancelled',
  'panicked',
  'processing_error',
  'infrastructure_failure',
  'unsupported_media_operation',
])

/** Associate message outcomes through delivery spans, never adjacent log lines or receipt handles. */
export function duplicateEvents(text: string, target: DuplicateTarget): DuplicateEvent[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n').filter(Boolean)) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const spans = [...(Array.isArray(row.spans) ? row.spans : []), row.span].filter(
      (span) => span && typeof span === 'object',
    )
    const delivery = spans.find((span) => span.name === 'worker_delivery')
    const attempt = spans.find((span) => span.name === 'worker_attempt')
    const fields = {
      ...attempt,
      ...row.fields,
      message_id: delivery?.message_id,
      delivery_id: delivery?.delivery_id,
    }
    // Spec 26 has its own correlated parser; these are not media operations.
    if (['lease_renewal', 'visibility_extension'].includes(fields.operation)) continue
    if (fields.operation !== undefined)
      fields.outcome =
        mediaOutcomes[fields.operation]?.[fields.outcome] ?? 'unsupported_media_operation'
    else if (sideEffects.has(fields.outcome)) fields.outcome = 'unsupported_media_operation'
    if (outcomes.has(fields.outcome)) rows.push({ ...fields, at: Date.parse(row.timestamp) })
  }
  const deliveries = new Set(
    rows
      .filter((r) => r.job_id === target.jobId && r.video_id === target.videoId)
      .map((r) => r.delivery_id),
  )
  const result: DuplicateEvent[] = []
  for (const r of rows.filter((r) => deliveries.has(r.delivery_id))) {
    if (
      !identity(r.delivery_id) ||
      !identity(r.message_id) ||
      r.message_id === 'unknown' ||
      !Number.isFinite(r.at)
    )
      fail('Correlated delivery evidence is missing or malformed')
    if (r.job_id !== undefined && (r.job_id !== target.jobId || r.video_id !== target.videoId))
      fail('Expected a single-record run message')
    const e: DuplicateEvent = {
      at: r.at as number,
      outcome: r.outcome as string,
      messageId: r.message_id as string,
      deliveryId: r.delivery_id as string,
    }
    if (r.worker_id !== undefined) {
      if (!identity(r.worker_id)) fail('Malformed observed worker identity')
      e.workerId = r.worker_id as string
    }
    if (r.attempt !== undefined) {
      if (!Number.isSafeInteger(r.attempt) || Number(r.attempt) < 1)
        fail('Malformed observed attempt')
      e.attempt = Number(r.attempt)
    }
    result.push(e)
  }
  if (result.length > 20000) fail('Run evidence exceeds bounded size')
  return result
}

/** Uses existing dedicated resources only. No provisioning, process changes or queue consumption. */
export class DockerDuplicateAdapter implements DuplicateAdapter {
  readonly processingMs: number
  readonly deliveryMs: number
  protected target?: DuplicateTarget
  private registered = false
  private uploaded = false
  private uncertain = false
  private messages: string[] = []
  private dbUser = ''
  private dbName = ''
  private sourceUrl = ''
  private since = new Date().toISOString()
  private execute: DuplicateTransport
  constructor(
    protected boundary: Boundary,
    protected env: NodeJS.ProcessEnv = process.env,
    execute?: DuplicateTransport,
  ) {
    this.processingMs = Number(env.E2E_PROCESSING_TIMEOUT_MS)
    this.deliveryMs = Number(env.E2E_VISIBILITY_TIMEOUT_MS) + Number(env.E2E_NAVIGATION_TIMEOUT_MS)
    if (
      ![this.processingMs, this.deliveryMs].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 1800000,
      )
    )
      fail('Invalid duplicate wait budgets')
    this.execute =
      execute ||
      ((tool, args, input) => {
        try {
          return execFileSync(tool, args, {
            encoding: 'utf8',
            input,
            windowsHide: true,
            timeout: args.includes('put-object') ? Number(env.E2E_UPLOAD_TIMEOUT_MS) : 10000,
            maxBuffer: 16 * 1024 * 1024,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            env: {
              ...env,
              AWS_EC2_METADATA_DISABLED: 'true',
              AWS_PAGER: '',
              AWS_CLI_AUTO_PROMPT: 'off',
            },
          })
        } catch (error) {
          throw transportFailure(error)
        }
      })
  }
  now = Date.now
  sleep = (ms: number) => setTimeout(ms)
  protected docker(args: string[], input?: string): string {
    return this.execute('docker', ['--host', this.env.E2E_DOCKER_HOST!, ...args], input)
  }
  private aws(args: string[]): any {
    let output: string
    try {
      output = this.execute('aws', [...args, '--region', this.env.AWS_REGION!, '--output', 'json'])
    } catch (error) {
      throw transportFailure(error)
    }
    try {
      return JSON.parse(output || '{}')
    } catch {
      throw new SafeTransportError('invalid_response')
    }
  }
  protected inspect(id: string): any {
    let rows
    try {
      rows = JSON.parse(this.docker(['container', 'inspect', id]))
    } catch {
      return fail('Container inspection failed')
    }
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== id)
      fail('Container identity changed')
    return rows[0]
  }
  protected workerStateMatches(c: any): boolean {
    return c.State?.Running && c.State.StartedAt === this.boundary.worker.startedAt
  }
  protected unchanged(): void {
    let engine
    try {
      engine = JSON.parse(this.docker(['info', '--format', '{{json .}}']))
    } catch {
      return fail('Docker Engine inspection failed')
    }
    if (engine.ID !== this.boundary.dockerEngine) fail('Docker Engine changed')
    for (const b of [this.boundary.worker, this.boundary.database]) {
      const c = this.inspect(b.identity)
      if (
        !(b === this.boundary.worker
          ? this.workerStateMatches(c)
          : c.State?.Running && c.State.StartedAt === b.startedAt) ||
        c.State.Paused ||
        c.State.Restarting ||
        c.Config?.Labels?.['com.streaming-video.e2e.scope'] !== b.scope ||
        c.Config?.Labels?.['com.streaming-video.e2e.disposable'] !== 'true'
      )
        fail('Verified container boundary changed')
    }
  }
  protected sql(sql: string): any {
    this.unchanged()
    const output = this.docker(
      [
        'exec',
        '-i',
        this.boundary.database.identity,
        'psql',
        '-X',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        this.dbUser,
        '-d',
        this.dbName,
      ],
      `SET statement_timeout='8s';\n${sql}\n`,
    )
    try {
      return output.trim() ? JSON.parse(output.trim()) : null
    } catch {
      return fail('Database response malformed')
    }
  }
  async prepare(target: DuplicateTarget): Promise<void> {
    if (this.env.E2E_DUPLICATE_EXCLUSIVE !== 'true')
      fail('E2E_DUPLICATE_EXCLUSIVE=true is required for dedicated resources')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    if (
      !uuid.test(target.videoId) ||
      !uuid.test(target.jobId) ||
      !/^e2e-[0-9a-f-]{36}$/.test(target.runId) ||
      target.prefix !== `videos/${target.videoId}/jobs/${target.jobId}/` ||
      target.sourceKey !== target.prefix + 'source.mp4'
    )
      fail('Noncanonical run target')
    const fixture = this.env.E2E_DUPLICATE_FIXTURE || ''
    if (!isAbsolute(fixture) || !fixture.toLowerCase().endsWith('.mp4'))
      fail('E2E_DUPLICATE_FIXTURE must be an absolute MP4 path')
    let size
    try {
      const stat = statSync(fixture)
      size = stat.isFile() ? stat.size : 0
    } catch {
      return fail('Duplicate fixture unavailable')
    }
    if (!size || size > 1024 ** 3) fail('Fixture must be nonempty and at most 1 GiB')
    this.unchanged()
    const worker = this.inspect(this.boundary.worker.identity)
    const startup = this.docker([
      'logs',
      '--since',
      worker.State.StartedAt,
      '--tail',
      '2000',
      worker.Id,
    ])
    if (
      !startup.split('\n').some((line) => {
        try {
          return JSON.parse(line).fields?.duplicate_observation_schema === 1
        } catch {
          return false
        }
      })
    )
      fail('Worker requires duplicate observation schema 1; rebuild before running')
    const settings = Object.fromEntries(
      worker.Config.Env.map((entry: string) => {
        const i = entry.indexOf('=')
        return [entry.slice(0, i), entry.slice(i + 1)]
      }),
    )
    let db
    try {
      db = new URL(settings.DATABASE_URL)
      this.dbUser = decodeURIComponent(db.username)
      this.dbName = decodeURIComponent(db.pathname.slice(1))
    } catch {
      return fail('Database identity unavailable')
    }
    if (![this.dbUser, this.dbName].every((v) => /^[a-zA-Z0-9_]+$/.test(v)))
      fail('Unsupported database name or role')
    this.sourceUrl = settings.VIDEO_ENCODING_QUEUE_URL
    if (this.sourceUrl.endsWith('.fifo'))
      fail('Duplicate validation requires an SQS Standard queue')
    for (const bucket of [this.env.E2E_SOURCE_BUCKET!, this.env.E2E_OUTPUT_BUCKET!]) {
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) fail('Invalid bucket identity')
      const version = this.aws([
        's3api',
        'get-bucket-versioning',
        '--bucket',
        bucket,
        '--expected-bucket-owner',
        this.env.E2E_AWS_ACCOUNT_ID!,
      ])
      if (version.Status) fail('Versioned buckets require a separate cleanup adapter')
    }
    const n = this.aws([
      's3api',
      'get-bucket-notification-configuration',
      '--bucket',
      this.env.E2E_SOURCE_BUCKET!,
      '--expected-bucket-owner',
      this.env.E2E_AWS_ACCOUNT_ID!,
    ])
    const q = n.QueueConfigurations
    if (
      !Array.isArray(q) ||
      q.length !== 1 ||
      q[0].QueueArn !== this.boundary.sourceQueue ||
      !q[0].Events?.some((e: string) =>
        ['s3:ObjectCreated:*', 's3:ObjectCreated:Put'].includes(e),
      ) ||
      n.TopicConfigurations?.length ||
      n.LambdaFunctionConfigurations?.length ||
      n.EventBridgeConfiguration
    )
      fail('Requires one direct S3 notification to the source queue')
    const rules = q[0].Filter?.Key?.FilterRules || []
    if (
      !Array.isArray(rules) ||
      rules.some(
        (r: { Name: string; Value: string }) =>
          !r ||
          typeof r.Name !== 'string' ||
          typeof r.Value !== 'string' ||
          (r.Name.toLowerCase() === 'prefix'
            ? !target.sourceKey.startsWith(r.Value)
            : r.Name.toLowerCase() === 'suffix'
              ? !target.sourceKey.endsWith(r.Value)
              : true),
      )
    )
      fail('Source key does not match notification filters')
    const ready = this.sql(
      "SELECT json_build_object('active',count(*)) FROM jobs WHERE status IN ('UPLOADING','QUEUED','PROCESSING');",
    )
    if (ready?.active !== 0) fail('Dedicated database contains active work')
    this.target = target
    this.registered = true // Includes an ambiguous transaction response; cleanup proves exact ownership.
    this.since = new Date().toISOString()
    this
      .sql(`BEGIN; INSERT INTO videos(video_id,file_name,content_type,size_bytes,upload_bucket,upload_key,upload_expires_at)
      VALUES ('${target.videoId}','${target.runId}.mp4','video/mp4',${size},'${this.env.E2E_SOURCE_BUCKET}','${target.sourceKey}',now()+interval '1 hour');
      INSERT INTO jobs(id,video_id,status) VALUES ('${target.jobId}','${target.videoId}','UPLOADING'); COMMIT;`)
  }
  async upload(): Promise<void> {
    this.unchanged()
    this.uploaded = true
    try {
      this.aws([
        's3api',
        'put-object',
        '--bucket',
        this.env.E2E_SOURCE_BUCKET!,
        '--key',
        this.target!.sourceKey,
        '--body',
        this.env.E2E_DUPLICATE_FIXTURE!,
        '--content-type',
        'video/mp4',
        '--expected-bucket-owner',
        this.env.E2E_AWS_ACCOUNT_ID!,
      ])
    } catch (error) {
      this.uncertain = true
      fail(`Upload outcome uncertain; retain run resources. ${transportFailure(error).message}`)
    }
  }
  async sendDuplicate(): Promise<string> {
    this.unchanged()
    const t = this.target!
    const body = JSON.stringify({
      Records: [
        {
          eventVersion: '2.1',
          eventSource: 'aws:s3',
          awsRegion: this.env.AWS_REGION,
          eventTime: new Date().toISOString(),
          eventName: 'ObjectCreated:Put',
          s3: {
            s3SchemaVersion: '1.0',
            configurationId: 'duplicate-e2e',
            bucket: { name: this.env.E2E_SOURCE_BUCKET },
            object: { key: t.sourceKey },
          },
        },
      ],
    })
    try {
      const result = this.aws([
        'sqs',
        'send-message',
        '--queue-url',
        this.sourceUrl,
        '--message-body',
        body,
      ])
      if (!identity(result.MessageId) || this.messages.includes(result.MessageId))
        fail('Invalid sent message identity')
      this.messages.push(result.MessageId)
      return result.MessageId
    } catch {
      this.uncertain = true
      return fail('Duplicate send outcome uncertain; retain run resources')
    }
  }
  protected readJob(): DuplicateJob {
    const t = this.target!
    const job: DuplicateJob = this
      .sql(`SELECT json_build_object('status',status,'attempt',attempt,'workerId',worker_id,
      'leaseMs',extract(epoch from lease_expires_at)*1000,'updatedAtMs',extract(epoch from updated_at)*1000,'observedAtMs',extract(epoch from clock_timestamp())*1000)
      FROM jobs WHERE id='${t.jobId}' AND video_id='${t.videoId}';`)
    if (
      !job ||
      !Number.isFinite(job.observedAtMs) ||
      !Number.isFinite(job.updatedAtMs) ||
      !Number.isSafeInteger(job.attempt)
    )
      fail('Job observation unavailable')
    return job
  }
  protected readLogs(): string {
    return this.docker(['logs', '--since', this.since, this.boundary.worker.identity])
  }
  async observe() {
    return { job: this.readJob(), events: duplicateEvents(this.readLogs(), this.target!) }
  }
  async verifyOutput(keys: string[]): Promise<void> {
    const actual = this.objects(this.env.E2E_OUTPUT_BUCKET!, this.target!.prefix + 'hls/')
    if (JSON.stringify(actual.sort()) !== JSON.stringify([...keys].sort()))
      fail('Published keys differ from the canonical layout and observed upload count')
    const deadline = this.now() + this.processingMs
    for (const key of actual) {
      if (this.now() >= deadline) fail('Object verification deadline exceeded')
      const head = this.aws([
        's3api',
        'head-object',
        '--bucket',
        this.env.E2E_OUTPUT_BUCKET!,
        '--key',
        key,
        '--expected-bucket-owner',
        this.env.E2E_AWS_ACCOUNT_ID!,
      ])
      if (
        !(head.ContentLength > 0) ||
        head.ContentType !==
          (key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
      )
        fail('Published metadata is invalid')
    }
  }
  private objects(bucket: string, prefix: string): string[] {
    const data = this.aws([
      's3api',
      'list-objects-v2',
      '--bucket',
      bucket,
      '--prefix',
      prefix,
      '--max-keys',
      '512',
      '--no-paginate',
      '--expected-bucket-owner',
      this.env.E2E_AWS_ACCOUNT_ID!,
    ])
    if (data.IsTruncated || !Array.isArray(data.Contents || []))
      fail('Object listing cannot be cleaned within bounds')
    return (data.Contents || []).map((o: { Key: string }) => o.Key)
  }
  async cleanup(): Promise<void> {
    if (!this.registered) return
    if (this.uncertain) fail('Uncertain remote mutation; manual inspection required')
    const t = this.target!
    if (this.uploaded) {
      const deadline = this.now() + this.processingMs + this.deliveryMs
      let drained = false
      while (this.now() < deadline) {
        const s = await this.observe()
        const ids = new Set([...this.messages, ...s.events.map((e) => e.messageId)])
        if (
          s.job.status === 'COMPLETED' &&
          s.job.workerId === null &&
          s.job.leaseMs === null &&
          ids.size &&
          [...ids].every((id) => acknowledged(s, id))
        ) {
          drained = true
          break
        }
        await this.sleep(250)
      }
      if (!drained) fail('Processing or run messages are still pending; retain resources')
    }
    const ownership = this
      .sql(`SELECT json_build_object('present',EXISTS(SELECT 1 FROM videos WHERE video_id='${t.videoId}'),
      'owned',EXISTS(SELECT 1 FROM videos WHERE video_id='${t.videoId}' AND file_name='${t.runId}.mp4' AND upload_key='${t.sourceKey}'));`)
    if (!ownership?.owned) {
      if (ownership?.present || this.uploaded) fail('Cannot prove exact run ownership')
      this.registered = false
      return
    }
    // List and validate the entire deletion set before deleting the first object.
    const input = this.objects(this.env.E2E_SOURCE_BUCKET!, t.sourceKey)
    const output = this.objects(this.env.E2E_OUTPUT_BUCKET!, t.prefix + 'hls/')
    if (
      input.some((k) => k !== t.sourceKey) ||
      output.some(
        (k) => !new RegExp('^' + t.prefix + 'hls/(index\\.m3u8|segment-[0-9]{5}\\.ts)$').test(k),
      )
    )
      fail('Unexpected objects retained for manual cleanup')
    const deadline = this.now() + this.processingMs
    for (const [bucket, keys] of [
      [this.env.E2E_SOURCE_BUCKET!, input],
      [this.env.E2E_OUTPUT_BUCKET!, output],
    ] as const) {
      for (const key of keys) {
        if (this.now() >= deadline) fail('Cleanup deadline exceeded')
        this.aws([
          's3api',
          'delete-object',
          '--bucket',
          bucket,
          '--key',
          key,
          '--expected-bucket-owner',
          this.env.E2E_AWS_ACCOUNT_ID!,
        ])
      }
    }
    this.sql(
      `DELETE FROM videos WHERE video_id='${t.videoId}' AND file_name='${t.runId}.mp4' AND upload_key='${t.sourceKey}';`,
    )
    this.registered = false
  }
}

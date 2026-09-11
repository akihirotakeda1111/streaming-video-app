import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { DockerDuplicateAdapter, duplicateEvents } from './duplicate-adapter.js'
import type { DuplicateSnapshot, DuplicateTarget } from './duplicate-driver.js'
import { receiveRunOwnedDlq } from './dlq-correlation.js'
import type { ExhaustionAdapter, ExhaustionSnapshot } from './ffmpeg-exhaustion-driver.js'
import type { verifyLiveBoundary } from './safety.mjs'

type Boundary = ReturnType<typeof verifyLiveBoundary>

/** Disposable-only adapter: invalid bytes are uploaded to the canonical source key. */
export class DockerFfmpegExhaustionAdapter extends DockerDuplicateAdapter implements ExhaustionAdapter {
  readonly attempts: number
  private readonly invalidFixture: string
  private startedAt = new Date().toISOString()
  private executeAws(args: string[]): any {
    try {
      const output = execFileSync('aws', [...args, '--region', this.env.AWS_REGION!, '--output', 'json'], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...this.env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
      })
      return JSON.parse(output || '{}')
    } catch { throw new Error('AWS observation failed') }
  }
  constructor(boundary: Boundary, env: NodeJS.ProcessEnv = process.env) {
    const invalidFixture = env.E2E_FFMPEG_INVALID_FIXTURE?.trim() || ''
    if (!isAbsolute(invalidFixture) || !invalidFixture.toLowerCase().endsWith('.mp4')) throw new Error('E2E_FFMPEG_INVALID_FIXTURE must be an absolute MP4 path')
    super(boundary, { ...env, E2E_DUPLICATE_EXCLUSIVE: 'true', E2E_DUPLICATE_FIXTURE: invalidFixture })
    this.attempts = boundary.workerSettings.attempts
    this.invalidFixture = invalidFixture
  }
  async prepare(target: DuplicateTarget): Promise<void> {
    await super.prepare(target)
    this.startedAt = new Date().toISOString()
  }
  async uploadInvalidMedia(): Promise<void> {
    this.unchanged()
    try {
      this.executeAws(['s3api', 'put-object', '--bucket', this.env.E2E_SOURCE_BUCKET!, '--key', this.target!.sourceKey, '--body', this.invalidFixture, '--content-type', 'video/mp4', '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
    } catch { throw new Error('Invalid media upload outcome uncertain; retain run resources') }
  }
  async observe(): Promise<ExhaustionSnapshot & DuplicateSnapshot> {
    const t = this.target!
    const job = this.sql(`SELECT json_build_object('status',status,'attempt',attempt,'failure',failure_message,'workerId',worker_id,'leaseMs',extract(epoch from lease_expires_at)*1000,'updatedAtMs',extract(epoch from updated_at)*1000,'observedAtMs',extract(epoch from clock_timestamp())*1000) FROM jobs WHERE id='${t.jobId}' AND video_id='${t.videoId}';`)
    if (!job || !Number.isSafeInteger(job.attempt) || typeof job.status !== 'string' || !Number.isFinite(job.observedAtMs) || !Number.isFinite(job.updatedAtMs)) throw new Error('Job observation unavailable')
    const messages = receiveRunOwnedDlq(this.env.E2E_DLQ!, t, { region: this.env.AWS_REGION!, timeoutMs: Number(this.env.E2E_DLQ_TIMEOUT_MS), maxMessages: 10 })
    return { job, events: duplicateEvents(this.docker(['logs', '--since', this.startedAt, '--tail', '2000', this.boundary.worker.identity]), t), dlq: messages }
  }
  async hasManifest(target: DuplicateTarget): Promise<boolean> {
    const result = this.executeAws(['s3api', 'list-objects-v2', '--bucket', this.env.E2E_OUTPUT_BUCKET!, '--prefix', target.prefix + 'hls/', '--max-keys', '512', '--no-paginate', '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
    return Boolean(result.IsTruncated || result.Contents?.some((item: { Key?: string }) => item.Key === target.prefix + 'hls/index.m3u8'))
  }
  async cleanup(): Promise<void> {
    const t = this.target!
    const job = this.sql(`SELECT status FROM jobs WHERE id='${t.jobId}' AND video_id='${t.videoId}';`)
    if (job?.status !== 'FAILED') throw new Error('Failed job is not safe to clean')
    try {
      this.executeAws(['s3api', 'delete-object', '--bucket', this.env.E2E_SOURCE_BUCKET!, '--key', t.sourceKey, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      const output = this.executeAws(['s3api', 'list-objects-v2', '--bucket', this.env.E2E_OUTPUT_BUCKET!, '--prefix', t.prefix, '--max-keys', '512', '--no-paginate', '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      for (const object of output.Contents || []) if (object.Key) this.executeAws(['s3api', 'delete-object', '--bucket', this.env.E2E_OUTPUT_BUCKET!, '--key', object.Key, '--expected-bucket-owner', this.env.E2E_AWS_ACCOUNT_ID!])
      this.sql(`DELETE FROM videos WHERE video_id='${t.videoId}' AND upload_key='${t.sourceKey}';`)
    } catch { throw new Error('Run-owned FFmpeg resources require manual cleanup') }
  }
}

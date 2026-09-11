import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DockerDuplicateAdapter, duplicateEvents } from './duplicate-adapter.js'
import type { DuplicateSnapshot, DuplicateTarget } from './duplicate-driver.js'
import { receiveRunOwnedDlq } from './dlq-correlation.js'
import type { ExhaustionAdapter, ExhaustionSnapshot } from './ffmpeg-exhaustion-driver.js'
import { exhaustionBudget } from './ffmpeg-exhaustion-driver.js'
import type { verifyLiveBoundary } from './safety.mjs'

type Boundary = ReturnType<typeof verifyLiveBoundary>

/** Disposable-only adapter: invalid bytes are uploaded to the canonical source key. */
export class DockerFfmpegExhaustionAdapter
  extends DockerDuplicateAdapter
  implements ExhaustionAdapter
{
  readonly attempts: number
  readonly exhaustionMs: number
  readonly stabilityMs: number
  override now = () => performance.now()
  private startedAt = new Date().toISOString()
  protected executeAws(args: string[]): any {
    try {
      const output = execFileSync(
        'aws',
        [...args, '--region', this.env.AWS_REGION!, '--output', 'json'],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: {
            ...this.env,
            AWS_EC2_METADATA_DISABLED: 'true',
            AWS_PAGER: '',
            AWS_CLI_AUTO_PROMPT: 'off',
          },
        },
      )
      return JSON.parse(output || '{}')
    } catch {
      throw new Error('AWS observation failed')
    }
  }
  constructor(boundary: Boundary, env: NodeJS.ProcessEnv = process.env) {
    const invalidFixture = env.E2E_FFMPEG_INVALID_FIXTURE?.trim() || ''
    if (!isAbsolute(invalidFixture) || !invalidFixture.toLowerCase().endsWith('.mp4'))
      throw new Error('E2E_FFMPEG_INVALID_FIXTURE must be an absolute MP4 path')
    super(boundary, {
      ...env,
      E2E_DUPLICATE_EXCLUSIVE: 'true',
      E2E_DUPLICATE_FIXTURE: invalidFixture,
    })
    this.attempts = boundary.workerSettings.attempts
    this.stabilityMs = Number(env.E2E_VISIBILITY_TIMEOUT_MS)
    this.exhaustionMs = exhaustionBudget(
      this.attempts,
      this.processingMs,
      boundary.workerSettings.retry * 1000,
      Number(env.E2E_VISIBILITY_TIMEOUT_MS),
      Number(env.E2E_DLQ_TIMEOUT_MS),
    )
  }
  async prepare(target: DuplicateTarget): Promise<void> {
    // Exercise the gated DLQ permission before creating any run-owned resources.
    this.receiveDlq(target)
    await super.prepare(target)
    this.startedAt = new Date().toISOString()
  }
  async uploadInvalidMedia(): Promise<void> {
    // The constructor supplies the invalid fixture to the common upload transport.
    await super.upload()
  }
  private receiveDlq(target: DuplicateTarget) {
    return receiveRunOwnedDlq(
      this.env.E2E_DLQ!,
      { ...target, sourceBucket: this.env.E2E_SOURCE_BUCKET! },
      {
        region: this.env.AWS_REGION!,
        timeoutMs: Number(this.env.E2E_DLQ_TIMEOUT_MS),
        maxMessages: 10,
        execute: (_tool, args) => JSON.stringify(this.executeAws(args.slice(0, -4))),
      },
    )
  }
  async observe(receiveDlq = true): Promise<ExhaustionSnapshot & DuplicateSnapshot> {
    const t = this.target!
    const job = this.sql(
      `SELECT json_build_object('status',status,'attempt',attempt,'failure',failure_message,'workerId',worker_id,'leaseMs',extract(epoch from lease_expires_at)*1000,'updatedAtMs',extract(epoch from updated_at)*1000,'observedAtMs',extract(epoch from clock_timestamp())*1000) FROM jobs WHERE id='${t.jobId}' AND video_id='${t.videoId}';`,
    )
    if (
      !job ||
      !Number.isSafeInteger(job.attempt) ||
      typeof job.status !== 'string' ||
      !Number.isFinite(job.observedAtMs) ||
      !Number.isFinite(job.updatedAtMs)
    )
      throw new Error('Job observation unavailable')
    const messages = receiveDlq ? this.receiveDlq(t) : []
    return {
      job,
      events: duplicateEvents(
        this.docker([
          'logs',
          '--since',
          this.startedAt,
          '--tail',
          '2000',
          this.boundary.worker.identity,
        ]),
        t,
      ),
      dlq: messages,
    }
  }
  async hasManifest(target: DuplicateTarget): Promise<boolean> {
    const result = this.executeAws([
      's3api',
      'list-objects-v2',
      '--bucket',
      this.env.E2E_OUTPUT_BUCKET!,
      '--prefix',
      target.prefix + 'hls/',
      '--max-keys',
      '512',
      '--no-paginate',
      '--expected-bucket-owner',
      this.env.E2E_AWS_ACCOUNT_ID!,
    ])
    return Boolean(
      result.IsTruncated ||
      result.Contents?.some(
        (item: { Key?: string }) => item.Key === target.prefix + 'hls/index.m3u8',
      ),
    )
  }
  async cleanup(): Promise<void> {
    const t = this.target!
    const job = this.sql(
      `SELECT json_build_object('status',j.status,'owned',v.file_name='${t.runId}.mp4' AND v.upload_key='${t.sourceKey}') FROM jobs j JOIN videos v ON v.video_id=j.video_id WHERE j.id='${t.jobId}' AND j.video_id='${t.videoId}';`,
    )
    if (job?.status !== 'FAILED' || job.owned !== true)
      throw new Error('Failed job is not safe to clean')
    try {
      const output = this.executeAws([
        's3api',
        'list-objects-v2',
        '--bucket',
        this.env.E2E_OUTPUT_BUCKET!,
        '--prefix',
        t.prefix + 'hls/',
        '--max-keys',
        '512',
        '--no-paginate',
        '--expected-bucket-owner',
        this.env.E2E_AWS_ACCOUNT_ID!,
      ])
      if (
        output.IsTruncated ||
        !Array.isArray(output.Contents || []) ||
        (output.Contents || []).some(
          (o: { Key?: string }) =>
            !o.Key ||
            !new RegExp('^' + t.prefix + 'hls/(index\\.m3u8|segment-[0-9]{5}\\.ts)$').test(o.Key),
        )
      )
        throw new Error('Unsafe cleanup listing')
      this.executeAws([
        's3api',
        'delete-object',
        '--bucket',
        this.env.E2E_SOURCE_BUCKET!,
        '--key',
        t.sourceKey,
        '--expected-bucket-owner',
        this.env.E2E_AWS_ACCOUNT_ID!,
      ])
      const deadline = this.now() + this.processingMs
      for (const object of output.Contents || []) {
        if (this.now() >= deadline) throw new Error('Cleanup deadline exceeded')
        this.executeAws([
          's3api',
          'delete-object',
          '--bucket',
          this.env.E2E_OUTPUT_BUCKET!,
          '--key',
          object.Key,
          '--expected-bucket-owner',
          this.env.E2E_AWS_ACCOUNT_ID!,
        ])
      }
      this.sql(
        `DELETE FROM videos WHERE video_id='${t.videoId}' AND file_name='${t.runId}.mp4' AND upload_key='${t.sourceKey}';`,
      )
    } catch {
      throw new Error('Run-owned FFmpeg resources require manual cleanup')
    }
  }
}

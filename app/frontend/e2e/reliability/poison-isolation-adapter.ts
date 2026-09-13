import { DockerDuplicateAdapter } from './duplicate-adapter.js'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PoisonIdentity } from './poison-isolation-driver.js'
import type { DuplicateSnapshot, DuplicateTarget } from './duplicate-driver.js'
import {
  receiveRunOwnedPoisonDlq,
  type PoisonDlqCorrelation,
  type PoisonDlqTarget,
} from './dlq-correlation.js'

export class DockerPoisonIsolationAdapter extends DockerDuplicateAdapter {
  readonly dlqMs: number
  private readonly poison: PoisonDlqTarget[] = []
  private readonly poisonIds = new Set<string>()
  private readonly identities: PoisonIdentity[] = []
  now = () => performance.now()

  constructor(boundary: ConstructorParameters<typeof DockerDuplicateAdapter>[0], env = process.env) {
    super(boundary, env)
    const observationMs = Number(env.E2E_DLQ_TIMEOUT_MS)
    const visibilityMs = Number(env.E2E_VISIBILITY_TIMEOUT_MS)
    const attempts = boundary.workerSettings.attempts
    if (![observationMs, visibilityMs].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 900000)
      || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
      throw new Error('Invalid poison DLQ wait budget')
    // Poison does not schedule Worker retries. Cover every source visibility
    // cycle using the validated upper bound, then allow DLQ observation time.
    // The shared preflight checks that attempts equals source maxReceiveCount.
    this.dlqMs = attempts * visibilityMs + observationMs
  }

  async prepare(target: DuplicateTarget): Promise<void> {
    await super.prepare(target)
    // This receive changes visibility; it is intentionally gated by the shared disposable preflight.
    this.observePoisonDlq()
  }

  sendPoison(): void {
    const malformed = '{"Records":['
    const malformedId = this.sendPoisonMessage(malformed, 'malformed')
    this.poison.push({ messageId: malformedId, body: malformed, kind: 'malformed' })
    const videoId = randomUUID()
    const jobId = randomUUID()
    const body = JSON.stringify({
      Records: [{
        eventVersion: '2.1', eventSource: 'aws:s3', awsRegion: this.env.AWS_REGION,
        eventTime: new Date().toISOString(), eventName: 'ObjectCreated:Put',
        s3: { s3SchemaVersion: '1.0', configurationId: 'poison-e2e', bucket: { name: this.env.E2E_SOURCE_BUCKET }, object: { key: `videos/${videoId}/jobs/${jobId}/source.mp4` } },
      }],
    })
    const unknownId = this.sendPoisonMessage(body, 'unknown-job', { videoId, jobId })
    this.poison.push({ messageId: unknownId, body, kind: 'unknown-job', canonicalIds: { videoId, jobId } })
    for (const item of this.poison) this.poisonIds.add(item.messageId)
  }

  private sendPoisonMessage(body: string, kind: PoisonIdentity['kind'], canonicalIds?: PoisonIdentity['canonicalIds']): string {
    const identity: PoisonIdentity = { kind, bodySha256: createHash('sha256').update(body).digest('hex'), sentAt: new Date().toISOString(), ...(canonicalIds ? { canonicalIds } : {}) }
    this.identities.push(identity)
    identity.messageId = this.sendQueueMessage(body)
    return identity.messageId
  }

  poisonIdentities(): PoisonIdentity[] {
    return this.identities.map((identity) => ({ ...identity }))
  }

  async observeWithPoison(): Promise<DuplicateSnapshot & { poison: PoisonDlqCorrelation[] }> {
    return { ...(await super.observe()), poison: this.observePoisonDlq() }
  }

  observePoisonDlq(): PoisonDlqCorrelation[] {
    return receiveRunOwnedPoisonDlq(this.env.E2E_DLQ!, this.poison, {
      region: this.env.AWS_REGION!,
      timeoutMs: Number(this.env.E2E_DLQ_TIMEOUT_MS),
      execute: (_tool, args) => JSON.stringify(this.aws(args.slice(0, -4))),
    })
  }

  unknownJobCount(): number {
    const ids = this.poison.filter((item) => item.canonicalIds).map((item) => item.canonicalIds!)
    if (ids.length !== 1) throw new Error('Unknown poison identity unavailable')
    const row = this.sql(`SELECT json_build_object('count', count(*)) FROM jobs WHERE id='${ids[0].jobId}' OR video_id='${ids[0].videoId}';`)
    if (!Number.isSafeInteger(row?.count) || row.count < 0) throw new Error('Unknown poison job observation unavailable')
    return row.count
  }

  protected cleanupEvents(snapshot: DuplicateSnapshot) {
    return snapshot.events.filter((event) => !this.poisonIds.has(event.messageId))
  }

  protected cleanupMessageIds(): string[] {
    return []
  }
}

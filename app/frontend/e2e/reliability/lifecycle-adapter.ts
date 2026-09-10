import {
  DockerDuplicateAdapter,
  duplicateEvents,
  type DuplicateTransport,
} from './duplicate-adapter.js'
import type { DuplicateTarget } from './duplicate-driver.js'
import { verifyLiveBoundary } from './safety.mjs'
import { lifecycleEvents } from './lifecycle-events.js'
import { assertDatabaseClock, fail } from './lifecycle.js'
import type { LifecycleAdapter, LifecycleSnapshot, Scenario } from './lifecycle-driver.js'

/** Only the exact preflight-verified worker can be stopped and restored. */
export class DockerLifecycleAdapter extends DockerDuplicateAdapter implements LifecycleAdapter {
  readonly clockSkewMs: number
  readonly heartbeatMs: number
  readonly leaseMs: number
  readonly visibilityMs: number
  readonly maximumVisibilityMs: number
  readonly attempts: number
  readonly recoveryMs: number
  private stopped = false
  private restoreRequired = false
  private startedAt: string
  constructor(
    boundary: ReturnType<typeof verifyLiveBoundary>,
    readonly scenario: Scenario,
    env: NodeJS.ProcessEnv = process.env,
    execute?: DuplicateTransport,
  ) {
    super(boundary, env, execute)
    this.clockSkewMs = Number(env.E2E_CLOCK_SKEW_MS)
    if (!Number.isSafeInteger(this.clockSkewMs) || this.clockSkewMs < 1 || this.clockSkewMs > 5000)
      fail('E2E_CLOCK_SKEW_MS must explicitly bound clock skew between 1 and 5000 ms')
    this.heartbeatMs = boundary.workerSettings.heartbeat * 1000
    this.leaseMs = boundary.workerSettings.lease * 1000
    this.visibilityMs = boundary.workerSettings.visibility * 1000
    this.maximumVisibilityMs = Number(env.E2E_VISIBILITY_TIMEOUT_MS)
    this.attempts = boundary.workerSettings.attempts
    this.recoveryMs =
      Number(env.E2E_LEASE_TIMEOUT_MS) +
      this.maximumVisibilityMs +
      this.deliveryMs +
      4 * this.clockSkewMs
    if (
      ![
        this.heartbeatMs,
        this.leaseMs,
        this.visibilityMs,
        this.maximumVisibilityMs,
        this.recoveryMs,
      ].every((n) => Number.isSafeInteger(n) && n > 0) ||
      this.maximumVisibilityMs < this.visibilityMs
    )
      fail('Invalid lifecycle timing settings')
    if (
      this.processingMs <= 3 * this.heartbeatMs ||
      this.clockSkewMs * 2 >= Math.min(this.leaseMs, this.visibilityMs)
    )
      fail('Lifecycle budgets cannot cover repeated renewals with clock skew')
    if (scenario === 'crash-recovery' && this.attempts < 2)
      fail('Crash recovery requires remaining attempt budget')
    this.startedAt = boundary.worker.startedAt
  }
  protected override workerStateMatches(c: any): boolean {
    return c.State?.StartedAt === this.startedAt && c.State?.Running === !this.stopped
  }
  override async prepare(target: DuplicateTarget): Promise<void> {
    this.unchanged()
    const worker = this.inspect(this.boundary.worker.identity)
    if (this.scenario === 'crash-recovery' && worker.HostConfig?.RestartPolicy?.Name !== 'no')
      fail('Crash recovery requires restart policy no on the retained worker')
    const startup = this.docker(['logs', '--since', this.startedAt, '--tail', '2000', worker.Id])
    if (
      !startup.split('\n').some((line) => {
        try {
          return JSON.parse(line).fields?.heartbeat_observation_schema === 1
        } catch {
          return false
        }
      })
    )
      fail('Worker requires heartbeat observation schema 1; rebuild before running')
    await super.prepare(target)
  }
  override async observe(): Promise<LifecycleSnapshot> {
    this.unchanged()
    const raw = this.readLogs()
    const localBeforeMs = this.now()
    const job = this.readJob()
    const localAfterMs = this.now()
    assertDatabaseClock(job.observedAtMs, localBeforeMs, localAfterMs, this.clockSkewMs)
    const events = duplicateEvents(raw, this.target!)
    const parsed = lifecycleEvents(
      raw,
      this.target!,
      events,
      this.boundary.workerSettings,
      this.clockSkewMs,
    )
    if (parsed.operations.some((op) => op.observedAtMs > localAfterMs + this.clockSkewMs))
      fail('Worker clock is outside the configured skew bound')
    return { job, events, ...parsed, localBeforeMs, localAfterMs }
  }
  async stop(): Promise<number> {
    if (this.scenario !== 'crash-recovery' || this.restoreRequired) fail('Unexpected worker stop')
    this.unchanged()
    const t = this.target!
    const other = this.sql(
      `SELECT json_build_object('active',count(*)) FROM jobs WHERE status IN ('UPLOADING','QUEUED','PROCESSING') AND id <> '${t.jobId}';`,
    )
    if (other?.active !== 0) fail('Other work appeared in the dedicated database')
    // Mark before dispatch: a timeout can still mean that the stop took effect.
    this.restoreRequired = true
    this.docker([
      'container',
      'stop',
      '--signal',
      'SIGKILL',
      '--timeout',
      '0',
      this.boundary.worker.identity,
    ])
    this.stopped = true
    this.unchanged()
    return this.now()
  }
  async restore(): Promise<void> {
    if (!this.restoreRequired) return
    const c = this.inspect(this.boundary.worker.identity)
    if (c.State?.StartedAt !== this.startedAt)
      fail('Worker restarted outside the controlled boundary')
    // Resolve an uncertain stop without permitting an unrelated restart.
    this.stopped = c.State.Running === false
    this.unchanged()
    if (this.stopped) {
      let failed = false
      try {
        this.docker(['container', 'start', this.boundary.worker.identity])
      } catch {
        failed = true
      }
      const started = this.inspect(this.boundary.worker.identity)
      if (
        !started.State?.Running ||
        !started.State.StartedAt ||
        started.State.StartedAt === this.startedAt
      )
        fail('Worker restoration failed; start the same retained container manually')
      this.startedAt = started.State.StartedAt
      this.stopped = false
      this.unchanged()
      this.restoreRequired = false
      if (failed) fail('Worker restored but start response was uncertain')
    }
    this.restoreRequired = false
  }
  override async cleanup(): Promise<void> {
    await this.restore()
    await super.cleanup()
  }
}

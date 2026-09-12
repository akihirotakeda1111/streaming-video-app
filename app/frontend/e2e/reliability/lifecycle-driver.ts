import {
  acknowledged,
  sideEffects,
  type DuplicateAdapter,
  type DuplicateEvent,
  type DuplicateJob,
  type DuplicateSnapshot,
  type DuplicateTarget,
} from './duplicate-driver.js'
import {
  DatabaseClockError,
  type ClockDiagnostic,
  assertCrashRecovery,
  assertHeartbeats,
  expiryBounds,
  fail,
  failureOutcomes,
  type HeartbeatObservation,
  type RecoveryObservation,
} from './lifecycle.js'
import type { RenewalOperation } from './lifecycle-events.js'

export type Scenario = 'crash-recovery' | 'long-heartbeat'
export interface LifecycleSnapshot extends DuplicateSnapshot {
  heartbeats: HeartbeatObservation[]
  operations: RenewalOperation[]
  localBeforeMs: number
  localAfterMs: number
}
export interface LifecycleAdapter extends Omit<DuplicateAdapter, 'observe' | 'sendDuplicate'> {
  observe(): Promise<LifecycleSnapshot>
  stop(): Promise<number>
  restore(): Promise<void>
  clockSkewMs: number
  heartbeatMs: number
  leaseMs: number
  visibilityMs: number
  maximumVisibilityMs: number
  recoveryMs: number
  attempts: number
}
export interface LifecycleReport {
  target: DuplicateTarget
  scenario: Scenario
  status: 'running' | 'passed' | 'unverified'
  cleanup: 'pending' | 'complete' | 'retained'
  restoration: 'not-needed' | 'pending' | 'complete' | 'failed'
  scenarioStarted: boolean
  observations: RecoveryObservation[]
  events: DuplicateEvent[]
  heartbeats: HeartbeatObservation[]
  operations: RenewalOperation[]
  stoppedAtMs?: number
  recoveryAfterMs?: number
  restartRequestedAtMs?: number
  bounds?: ReturnType<typeof expiryBounds>
  clockDiagnostic?: ClockDiagnostic
  reason?: string
}

/** Derive canonical outputs only from a complete, owner-correlated publication sequence. */
export function lifecycleOutput(
  s: DuplicateSnapshot,
  target: DuplicateTarget,
  owner: DuplicateEvent,
): string[] {
  const work = s.events.filter(
    (e) =>
      e.deliveryId === owner.deliveryId &&
      (sideEffects.has(e.outcome) || e.outcome === 'completed'),
  )
  if (
    work.some(
      (e) =>
        e.workerId !== owner.workerId ||
        e.attempt !== owner.attempt ||
        e.messageId !== owner.messageId,
    )
  )
    fail('Media work changed owner or message')
  for (const outcome of [
    'download_started',
    'source_downloaded',
    'encode_started',
    'encode_finished',
    'completed',
  ]) {
    if (work.filter((e) => e.outcome === outcome).length !== 1)
      fail('Canonical processing evidence is incomplete')
  }
  const expected = ['download_started', 'source_downloaded', 'encode_started', 'encode_finished']
  if (
    work.slice(0, 4).some((e, i) => e.outcome !== expected[i]) ||
    work.at(-1)?.outcome !== 'completed'
  )
    fail('Canonical processing order changed')
  if (work.some((e, i) => !Number.isFinite(e.at) || e.at < (i ? work[i - 1]!.at : owner.at)))
    fail('Publication timestamps are not ordered')
  const uploads = work.slice(4, -1)
  if (uploads.length < 4 || uploads.length % 2) fail('Publication evidence is incomplete')
  const keys: string[] = []
  for (let i = 0; i < uploads.length; i += 2) {
    const last = i === uploads.length - 2
    const name = last ? 'manifest' : 'segment'
    if (
      uploads[i]!.outcome !== `${name}_upload_started` ||
      uploads[i + 1]!.outcome !== `${name}_published`
    )
      fail('Manifest was not published last')
    keys.push(
      target.prefix +
        'hls/' +
        (last ? 'index.m3u8' : `segment-${String(i / 2).padStart(5, '0')}.ts`),
    )
  }
  if (!acknowledged(s, owner.messageId)) fail('Original message was not acknowledged')
  return keys
}

/** Run actual work through an injectable boundary; always restore before scoped cleanup. */
export async function runLifecycle(
  adapter: LifecycleAdapter,
  report: LifecycleReport,
): Promise<void> {
  const read = async () => {
    const s = await adapter.observe()
    report.events = s.events
    report.heartbeats = s.heartbeats
    report.operations = s.operations
    report.observations.push({
      at: s.localAfterMs,
      status: s.job.status,
      attempt: s.job.attempt,
      workerId: s.job.workerId,
      leaseExpiresAtMs: s.job.leaseMs,
      dbNowMs: s.job.observedAtMs,
      events: [],
    })
    if (report.observations.length > 4000) fail('Lifecycle evidence exceeds bounded size')
    if (s.job.status === 'FAILED' || s.events.some((e) => failureOutcomes.has(e.outcome)))
      fail('Lifecycle observed a processing or ownership failure')
    return s
  }
  const until = async (
    phase: string,
    budget: number,
    accept: (s: LifecycleSnapshot) => boolean,
  ) => {
    const deadline = adapter.now() + budget
    while (adapter.now() < deadline) {
      const s = await read()
      if (adapter.now() >= deadline) break
      if (accept(s)) return s
      await adapter.sleep(Math.min(250, deadline - adapter.now()))
    }
    return fail(`Lifecycle ${phase} timed out after ${budget} ms`)
  }
  let previousJob: DuplicateJob | undefined
  let dbRenewals = 0
  const trackInitialOwner = (s: LifecycleSnapshot) => {
    if (s.job.attempt > 1 || s.events.filter((e) => e.outcome === 'acquired').length > 1)
      fail('Ownership changed during initial processing')
    if (s.job.status === 'PROCESSING') {
      const owner = s.events.find((e) => e.outcome === 'acquired')
      // Log capture can precede acquisition; defer until both sides are visible.
      if (!owner) return
      if (
        !s.job.workerId ||
        s.job.workerId !== owner.workerId ||
        s.job.attempt !== 1 ||
        !s.job.leaseMs ||
        s.job.leaseMs <= s.job.observedAtMs
      )
        fail('Active database owner or lease is invalid')
      if (previousJob && s.job.workerId !== previousJob.workerId) fail('Database owner changed')
      if (previousJob?.leaseMs && s.job.leaseMs < previousJob.leaseMs)
        fail('Database lease regressed')
      if (previousJob?.leaseMs && s.job.leaseMs > previousJob.leaseMs) dbRenewals++
      previousJob = s.job
    }
  }
  try {
    if (report.scenario === 'crash-recovery' && adapter.attempts < 2)
      fail('Crash recovery requires remaining attempt budget')
    await adapter.prepare(report.target)
    report.scenarioStarted = true
    await adapter.upload()
    const requiredRenewals = report.scenario === 'crash-recovery' ? 1 : 2
    const active = await until('encode readiness', adapter.processingMs, (s) => {
      trackInitialOwner(s)
      if (s.job.status === 'COMPLETED' || s.events.some((e) => e.outcome === 'encode_finished'))
        fail(
          report.scenario === 'crash-recovery'
            ? 'Encode completed before crash readiness (one renewal)'
            : 'Encode too short to establish repeated renewals before completion',
        )
      const renewals = s.heartbeats.filter((e) => e.outcome === 'heartbeat_succeeded')
      const encode = s.events.find((e) => e.outcome === 'encode_started')
      if (
        s.job.status !== 'PROCESSING' ||
        !encode ||
        renewals.length < requiredRenewals ||
        dbRenewals < requiredRenewals
      )
        return false
      assertHeartbeats(renewals, requiredRenewals, adapter.clockSkewMs)
      if (
        renewals.filter(
          (e) =>
            e.startedAtMs >= encode.at &&
            (report.scenario === 'crash-recovery' || e.at - encode.at >= adapter.heartbeatMs),
        ).length < requiredRenewals
      )
        return false
      return true
    })
    const original = active.events.find((e) => e.outcome === 'acquired')!
    if (
      !original.workerId ||
      original.attempt !== 1 ||
      (active.job.attempt >= adapter.attempts && report.scenario === 'crash-recovery')
    )
      fail('Crash injection has no remaining attempt budget')
    if (report.scenario === 'crash-recovery') {
      report.restoration = 'pending'
      report.stoppedAtMs = await adapter.stop()
      const stopped = await read()
      if (
        stopped.job.status !== 'PROCESSING' ||
        stopped.job.attempt !== 1 ||
        stopped.job.workerId !== original.workerId ||
        !stopped.job.leaseMs ||
        stopped.events.some((e) => e.outcome === 'completed' || e.outcome === 'encode_finished')
      )
        fail('Crash did not interrupt the acquired encode before completion')
      const visibility = stopped.operations
        .filter(
          (e) => e.deliveryId === original.deliveryId && e.operation === 'visibility_extension',
        )
        .at(-1)
      if (!visibility) fail('Last visibility renewal evidence is missing')
      report.bounds = expiryBounds({
        databaseNowMs: stopped.job.observedAtMs,
        leaseExpiresAtMs: stopped.job.leaseMs,
        localBeforeMs: stopped.localBeforeMs,
        localAfterMs: stopped.localAfterMs,
        // A reversed response timestamp must not move the safe restart bound earlier.
        visibilityObservedAtMs: Math.max(visibility.startedAtMs, visibility.observedAtMs),
        visibilityDurationMs: visibility.durationMs,
        stoppedAtMs: report.stoppedAtMs,
        maximumVisibilityMs: adapter.maximumVisibilityMs,
        clockSkewMs: adapter.clockSkewMs,
      })
      report.recoveryAfterMs = report.bounds.recoveryAfterMs
      await until('lease and visibility expiry', adapter.recoveryMs, (s) => {
        if (
          s.job.status !== 'PROCESSING' ||
          s.job.attempt !== 1 ||
          s.job.workerId !== original.workerId ||
          s.job.leaseMs !== stopped.job.leaseMs ||
          s.events.some((e) => e.outcome === 'completed') ||
          s.events.filter((e) => e.outcome === 'acquired').length !== 1
        )
          fail('Stopped attempt changed ownership or completed')
        return (
          s.job.observedAtMs >= stopped.job.leaseMs! &&
          adapter.now() >= report.recoveryAfterMs! + 2 * adapter.clockSkewMs
        )
      })
      report.restartRequestedAtMs = adapter.now()
      await adapter.restore()
      report.restoration = 'complete'
    }
    const final = await until(
      'completion and acknowledgement',
      adapter.processingMs + adapter.deliveryMs,
      (s) => {
        if (report.scenario === 'long-heartbeat') trackInitialOwner(s)
        else if (s.job.attempt > 2) fail('Recovery exceeded one replacement attempt')
        return s.job.status === 'COMPLETED' && acknowledged(s, original.messageId)
      },
    )
    if (final.job.workerId !== null || final.job.leaseMs !== null)
      fail('Completion did not clear ownership')
    const acquisitions = final.events.filter((e) => e.outcome === 'acquired')
    if (report.scenario === 'crash-recovery') {
      report.observations.at(-1)!.events = final.events
      assertCrashRecovery(
        report.observations,
        original.workerId,
        original.deliveryId,
        report.recoveryAfterMs!,
        adapter.clockSkewMs,
      )
    } else {
      assertHeartbeats(final.heartbeats, 2, adapter.clockSkewMs)
      if (final.job.attempt !== 1 || acquisitions.length !== 1)
        fail('Long heartbeat changed attempt or owner')
    }
    const owner = acquisitions.at(-1)!
    if (
      final.events.some(
        (e) =>
          (sideEffects.has(e.outcome) || e.outcome === 'completed') &&
          !acquisitions.some(
            (a) =>
              a.deliveryId === e.deliveryId &&
              a.workerId === e.workerId &&
              a.attempt === e.attempt &&
              a.messageId === e.messageId,
          ),
      )
    )
      fail('Unowned media work was observed')
    await adapter.verifyOutput(lifecycleOutput(final, report.target, owner))
    report.status = 'passed'
  } catch (error) {
    report.status = 'unverified'
    if (error instanceof DatabaseClockError) report.clockDiagnostic = error.clockDiagnostic
    report.reason = error instanceof Error ? error.message : 'Lifecycle scenario failed'
  } finally {
    try {
      await adapter.restore()
      if (report.restoration === 'pending') report.restoration = 'complete'
    } catch {
      report.restoration = 'failed'
      report.status = 'unverified'
      report.reason = 'Worker restoration failed; start the same retained container manually'
    }
    try {
      if (report.restoration === 'failed') fail('Restoration required before cleanup')
      await adapter.cleanup()
      report.cleanup = 'complete'
    } catch {
      report.cleanup = 'retained'
      report.status = 'unverified'
      report.reason ??= 'Run resources retained for manual recovery'
    }
  }
  if (report.status !== 'passed') fail(report.reason || 'Lifecycle scenario unverified')
}

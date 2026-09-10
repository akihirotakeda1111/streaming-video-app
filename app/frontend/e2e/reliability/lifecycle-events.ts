import type { DuplicateEvent, DuplicateTarget } from './duplicate-driver.js'
import { fail, positive, type HeartbeatObservation } from './lifecycle.js'

export interface RenewalOperation {
  operation: 'lease_renewal' | 'visibility_extension'
  messageId: string
  deliveryId: string
  cycle: number
  startedAtMs: number
  observedAtMs: number
  durationMs: number
}

/** Pair Spec 26 operations by delivery and cycle, never by adjacent log lines. */
export function lifecycleEvents(
  raw: string,
  target: DuplicateTarget,
  media: DuplicateEvent[],
  settings: { lease: number; visibility: number },
  skew: number,
): { operations: RenewalOperation[]; heartbeats: HeartbeatObservation[] } {
  positive(skew, 'clockSkewMs')
  const owners = new Map(
    media.filter((e) => e.outcome === 'acquired').map((e) => [e.deliveryId, e]),
  )
  const operations: RenewalOperation[] = []
  const groups = new Map<string, { lease?: RenewalOperation; visibility?: RenewalOperation }>()
  for (const line of raw.split('\n').filter(Boolean)) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const spans = [...(Array.isArray(row.spans) ? row.spans : []), row.span].filter(
      (s) => s && typeof s === 'object',
    )
    const delivery = spans.find((s) => s.name === 'worker_delivery')
    const attempt = spans.find((s) => s.name === 'worker_attempt')
    const f = { ...delivery, ...attempt, ...row.fields }
    if (!['lease_renewal', 'visibility_extension'].includes(f.operation)) continue
    const owner = owners.get(f.delivery_id)
    if (!owner) {
      if (f.job_id === target.jobId || f.video_id === target.videoId)
        fail('Heartbeat has no correlated acquisition')
      continue
    }
    if (
      f.outcome !== 'success' ||
      f.message_id !== owner.messageId ||
      (f.job_id !== undefined && f.job_id !== target.jobId) ||
      (f.video_id !== undefined && f.video_id !== target.videoId)
    )
      fail('Correlated heartbeat operation failed or changed identity')
    if (
      f.operation === 'lease_renewal' &&
      (f.job_id !== target.jobId ||
        f.video_id !== target.videoId ||
        f.worker_id !== owner.workerId ||
        f.attempt !== owner.attempt)
    )
      fail('Heartbeat lease owner changed')
    const start = positive(f.request_started_at_unix_ms, 'heartbeat request time')
    const end = positive(f.response_observed_at_unix_ms, 'heartbeat response time')
    const timestamp = positive(Date.parse(row.timestamp), 'heartbeat log time')
    const duration = positive(f.duration_seconds, 'heartbeat duration') * 1000
    if (
      !Number.isSafeInteger(f.heartbeat_cycle) ||
      f.heartbeat_cycle < 1 ||
      !Number.isFinite(f.elapsed_ms) ||
      f.elapsed_ms < 0 ||
      end < start ||
      Math.abs(end - start - f.elapsed_ms) > skew ||
      timestamp < end - skew ||
      duration !== 1000 * (f.operation === 'lease_renewal' ? settings.lease : settings.visibility)
    )
      fail('Heartbeat timing evidence is invalid')
    const op: RenewalOperation = {
      operation: f.operation,
      messageId: f.message_id,
      deliveryId: f.delivery_id,
      cycle: f.heartbeat_cycle,
      startedAtMs: start,
      observedAtMs: end,
      durationMs: duration,
    }
    const key = `${op.deliveryId}:${op.cycle}`
    const group = groups.get(key) || {}
    const kind = op.operation === 'lease_renewal' ? 'lease' : 'visibility'
    if (group[kind]) fail('Duplicate heartbeat operation in one cycle')
    group[kind] = op
    groups.set(key, group)
    operations.push(op)
    if (operations.length > 20000) fail('Heartbeat evidence exceeds bounded size')
  }
  const heartbeats: HeartbeatObservation[] = []
  for (const group of groups.values()) {
    const op = group.lease || group.visibility!
    const owner = owners.get(op.deliveryId)!
    if (group.lease && group.visibility && group.visibility.startedAtMs < group.lease.observedAtMs)
      fail('Heartbeat visibility extension preceded lease renewal')
    heartbeats.push({
      outcome: group.lease && group.visibility ? 'heartbeat_succeeded' : 'heartbeat_incomplete',
      workerId: owner.workerId!,
      attempt: owner.attempt!,
      messageId: op.messageId,
      deliveryId: op.deliveryId,
      cycle: op.cycle,
      startedAtMs: op.startedAtMs,
      at: Math.max(group.lease?.observedAtMs || 0, group.visibility?.observedAtMs || 0),
      leaseExpiresAtMs: group.lease
        ? group.lease.startedAtMs + group.lease.durationMs - skew
        : null,
      visibilityExpiresAtMs: group.visibility
        ? group.visibility.startedAtMs + group.visibility.durationMs - skew
        : null,
      visibilityObservedAtMs: group.visibility?.observedAtMs || 0,
    })
  }
  return { operations, heartbeats }
}

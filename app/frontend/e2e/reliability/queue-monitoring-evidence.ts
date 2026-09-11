const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const messageId = /^[A-Za-z0-9-]{1,128}$/
const hash = /^[0-9a-f]{64}$/

/** Parse explicit ISO offsets as an absolute UTC instant; reject ambiguous local times. */
export const utcTime = (value: unknown): number | undefined => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    return undefined
  // Date.parse normalizes invalid calendar dates such as February 30; reject them.
  const calendar = Date.parse(value.slice(0, 19) + 'Z')
  if (
    !Number.isFinite(calendar) ||
    new Date(calendar).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** Validate the existing scenario artifacts; no searching, copying or rerunning other sessions. */
export function correlateMonitoringEvidence(
  evidence: any,
  scenario: string,
  context: {
    runId: string
    sourceQueueArn: string
    deadLetterQueueArn: string
    region: string
    now: number
  },
): { evidenceComplete: boolean; evidenceTimestamp?: string } {
  const incomplete = { evidenceComplete: false }
  const target = evidence?.target
  const boundary = evidence?.verification
  if (
    evidence?.scenario !== scenario ||
    evidence.status !== 'passed' ||
    evidence.runId !== context.runId ||
    evidence.scenarioStarted !== true ||
    evidence.liveResourcesVerified !== true ||
    boundary?.status !== 'verified' ||
    boundary.sourceQueue !== context.sourceQueueArn ||
    boundary.deadLetterQueue !== context.deadLetterQueueArn ||
    boundary.region !== context.region ||
    boundary.account !== context.sourceQueueArn.split(':')[4] ||
    !target ||
    target.runId !== evidence.runId ||
    !uuid.test(target.videoId) ||
    !uuid.test(target.jobId) ||
    target.prefix !== `videos/${target.videoId}/jobs/${target.jobId}/` ||
    target.sourceKey !== target.prefix + 'source.mp4'
  )
    return incomplete

  const verifiedAt = utcTime(boundary.verifiedAt)
  if (verifiedAt === undefined || verifiedAt > context.now) return incomplete
  const validTime = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= verifiedAt &&
    value <= context.now
  const validMessage = (value: any) =>
    value &&
    typeof value.messageId === 'string' &&
    messageId.test(value.messageId) &&
    validTime(utcTime(value.receivedAt))
  let times: number[]
  if (scenario === 'ffmpeg-exhaustion') {
    const snapshots = evidence.snapshots
    if (!Array.isArray(snapshots) || !snapshots.length) return incomplete
    times = snapshots.map((snapshot) => snapshot?.job?.observedAtMs)
    if (!times.every(validTime) || snapshots.some((snapshot) => !Array.isArray(snapshot?.dlq)))
      return incomplete
    const terminal = snapshots.at(-1)
    const attempts = boundary.workerSettings?.attempts
    if (
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      terminal.job.status !== 'FAILED' ||
      terminal.job.attempt !== attempts ||
      !Array.isArray(terminal.events) ||
      !terminal.events.some(
        (event: any) =>
          event?.outcome === 'final_failed' && event.attempt === attempts && validTime(event.at),
      )
    )
      return incomplete
    const messages = snapshots.flatMap((snapshot) => snapshot.dlq)
    if (
      !messages.length ||
      new Set(messages.map((message) => message?.messageId)).size !== 1 ||
      !messages.every(
        (message) =>
          validMessage(message) &&
          message.jobId === target.jobId &&
          message.videoId === target.videoId &&
          message.sourceKey === target.sourceKey,
      )
    )
      return incomplete
    times.push(...messages.map((message) => utcTime(message.receivedAt)!))
  } else if (scenario === 'poison-isolation') {
    const result = evidence.result
    if (
      !result ||
      !['runId', 'videoId', 'jobId', 'prefix', 'sourceKey'].every(
        (key) => result.target?.[key] === target[key],
      ) ||
      result.phase !== 'complete' ||
      result.cleanup !== 'complete' ||
      result.unknownJobCount !== 0 ||
      !Array.isArray(result.observations) ||
      !result.observations.length ||
      !Array.isArray(result.poison) ||
      result.poison.length !== 2 ||
      !Array.isArray(result.identities) ||
      result.identities.length !== 2
    )
      return incomplete
    times = result.observations.map((observation: any) => utcTime(observation?.observedAt))
    const final = result.observations.at(-1)
    if (
      !times.every(validTime) ||
      final.status !== 'COMPLETED' ||
      final.attempt !== 1 ||
      final.poisonCount !== 2 ||
      new Set(result.poison.map((message: any) => message?.messageId)).size !== 2 ||
      new Set(result.poison.map((message: any) => message?.kind)).size !== 2
    )
      return incomplete
    for (const message of result.poison) {
      const identities = result.identities.filter(
        (identity: any) => identity?.messageId === message?.messageId,
      )
      const identity = identities[0]
      if (
        !validMessage(message) ||
        !['malformed', 'unknown-job'].includes(message.kind) ||
        !hash.test(message.bodySha256) ||
        identities.length !== 1 ||
        identity.kind !== message.kind ||
        identity.bodySha256 !== message.bodySha256 ||
        !validTime(utcTime(identity.sentAt))
      )
        return incomplete
      if (
        message.kind === 'unknown-job' &&
        (!uuid.test(message.canonicalIds?.videoId) ||
          !uuid.test(message.canonicalIds?.jobId) ||
          message.canonicalIds.videoId !== identity.canonicalIds?.videoId ||
          message.canonicalIds.jobId !== identity.canonicalIds?.jobId ||
          message.canonicalIds.jobId === target.jobId)
      )
        return incomplete
      times.push(utcTime(message.receivedAt)!)
    }
  } else return incomplete
  return { evidenceComplete: true, evidenceTimestamp: new Date(Math.max(...times)).toISOString() }
}

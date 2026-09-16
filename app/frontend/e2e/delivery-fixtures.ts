import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export interface LegacyDeliveryJob {
  phase: 'phase1' | 'phase2'
  videoId: string
  jobId: string
  manifestKey: string
  manifestETag: string
}

export interface DeliveryTargets {
  verificationScope: 'pre-cutover-compatibility' | 'completed-job-replay'
  sourceRunId?: string
  capturedAt: string
  cutoverAt?: string
  jobs: (Omit<LegacyDeliveryJob, 'phase'> & { phase: string })[]
}

/** Accept only a successful, matching playback run with an original object fingerprint. */
export function parsePlaybackRunEvidence(text: string, runId: string, bucket: string): DeliveryTargets {
  const value = JSON.parse(text)
  const pipeline = value?.diagnostics?.['pipeline-status']
  const delivery = value?.diagnostics?.['browser-playback']?.delivery
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!value || value.scenario !== 'phase1-pipeline' || value.status !== 'passed' || value.runId !== runId
    || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > Date.now()
    || !uuid.test(value.videoId) || !uuid.test(value.jobId)
    || pipeline?.videoId !== value.videoId || pipeline?.jobId !== value.jobId || pipeline?.jobStatus !== 'COMPLETED'
    || !delivery || !bucket || delivery.outputBucket !== bucket
    || delivery.manifestKey !== `videos/${value.videoId}/jobs/${value.jobId}/hls/index.m3u8`
    || typeof delivery.manifestETag !== 'string' || !/^"[a-f0-9]+(?:-\d+)?"$/i.test(delivery.manifestETag)) {
    throw new Error('Playback evidence is incomplete, unsuccessful, or does not match the selected run and bucket')
  }
  return { verificationScope: 'completed-job-replay', sourceRunId: runId, capturedAt: value.observedAt,
    jobs: [{ phase: 'current', videoId: value.videoId, jobId: value.jobId,
      manifestKey: delivery.manifestKey, manifestETag: delivery.manifestETag }] }
}

export async function loadDeliveryTargets(env: NodeJS.ProcessEnv): Promise<DeliveryTargets> {
  const runId = env.E2E_PLAYBACK_EVIDENCE_RUN?.trim()
  const legacy = env.E2E_LEGACY_DELIVERY_FIXTURES?.trim()
  if (Boolean(runId) === Boolean(legacy)) throw new Error('Select exactly one playback evidence run or legacy inventory')
  if (legacy) return { ...parseLegacyDeliveryFixtures(await readFile(legacy, 'utf8')),
    verificationScope: 'pre-cutover-compatibility' }
  if (!/^e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId!)) {
    throw new Error('Invalid playback evidence run ID')
  }
  const destination = env.E2E_EVIDENCE_DIR
  if (!destination || !isAbsolute(destination) || runId === env.E2E_RUN_ID) throw new Error('A prior run under the evidence root is required')
  const root = await realpath(dirname(destination))
  const file = join(root, runId!, 'phase1-pipeline-evidence.json')
  if (await realpath(file) !== file) throw new Error('Playback evidence must not redirect outside its run directory')
  return parsePlaybackRunEvidence(await readFile(file, 'utf8'), runId!, env.E2E_OUTPUT_BUCKET?.trim() ?? '')
}
export interface LegacyDeliveryFixtures {
  capturedAt: string
  cutoverAt: string
  jobs: LegacyDeliveryJob[]
}

/** Inventory captured by the operator before the CloudFront cutover. */
export function parseLegacyDeliveryFixtures(text: string): LegacyDeliveryFixtures {
  const value = JSON.parse(text) as LegacyDeliveryFixtures
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!value || !Number.isFinite(Date.parse(value.capturedAt))
    || !Number.isFinite(Date.parse(value.cutoverAt))
    || Date.parse(value.capturedAt) >= Date.parse(value.cutoverAt)
    || Date.parse(value.cutoverAt) > Date.now()
    || !Array.isArray(value.jobs) || value.jobs.length < 2 || value.jobs.length > 10) {
    throw new Error('Legacy inventory requires pre-cutover capture and 2–10 jobs')
  }
  const ids = new Set<string>()
  for (const job of value.jobs) {
    if (!job || !['phase1', 'phase2'].includes(job.phase)
      || !uuid.test(job.videoId) || !uuid.test(job.jobId)
      || job.manifestKey !== `videos/${job.videoId}/jobs/${job.jobId}/hls/index.m3u8`
      || typeof job.manifestETag !== 'string' || !/^"[a-f0-9]+(?:-\d+)?"$/i.test(job.manifestETag)
      || ids.has(job.videoId)) throw new Error('Invalid or duplicate legacy job')
    ids.add(job.videoId)
  }
  if (!value.jobs.some(job => job.phase === 'phase1') || !value.jobs.some(job => job.phase === 'phase2')) {
    throw new Error('Both Phase 1 and Phase 2 jobs are required')
  }
  return value
}

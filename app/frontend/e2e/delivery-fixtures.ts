export interface LegacyDeliveryJob {
  phase: 'phase1' | 'phase2'
  videoId: string
  jobId: string
  manifestKey: string
  manifestETag: string
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

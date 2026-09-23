import { expect, test, type APIRequestContext } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { e2eConfig } from '../config.js'
import { type JobRecord, type ServiceSample } from './checkpoints.js'
import { buildWorkloadDocument, notRunDocument, sanitizeEvidence, writeWorkload, type FixtureIdentity, type WorkloadDocument } from './evidence.js'
import { parentActivities, sampleParentService, startLiveObserver, type LiveObserver } from './observe.js'
import { proveAbrPlayback, type PlaybackProof } from './playback.js'
import { apiUrl, presignedUploadBucket } from './urls.js'

function failedPlayback(error: string): PlaybackProof {
  return {
    usedVideoJs: false,
    master: false,
    playlist360: false,
    playlist720: false,
    segment360: false,
    segment720: false,
    decoded: false,
    advanced: false,
    switched: false,
    requests: [],
    error,
  }
}

interface Settings {
  fixturePath: string
  fixture: FixtureIdentity
  batchSize: number
  budgetMs: number
  playwrightTimeoutMs: number
  evidenceDir: string
  playbackBaseUrl: string
  region: string
  account: string
  cluster: string
  service: string
  stateMachineArn: string
  minimumCapacity: number
  inputBucket: string
  submissionWindowSeconds: number
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`scalability runner did not provide ${name}`)
  return value
}

function resourceName(value: string): string {
  const cluster = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:cluster\/([^/]+)$/.exec(value)
  const service = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:service\/[^/]+\/([^/]+)$/.exec(value)
  return cluster?.[1] ?? service?.[1] ?? value
}

function readSettings(): Settings {
  const batchSize = Number(required('SCALABILITY_BATCH_SIZE'))
  const budgetSeconds = Number(required('SCALABILITY_RUNTIME_BUDGET_SECONDS'))
  const playwrightTimeoutMs = Number(required('SCALABILITY_PLAYWRIGHT_TIMEOUT_MS'))
  const durationSeconds = Number(required('SCALABILITY_FIXTURE_DURATION_SECONDS'))
  const submissionWindowSeconds = Number(required('SCALABILITY_SUBMISSION_WINDOW_SECONDS'))
  const minimumCapacity = Number(process.env.SCALABILITY_MIN_CAPACITY ?? '1')
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('SCALABILITY_BATCH_SIZE must be a positive integer')
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error('SCALABILITY_RUNTIME_BUDGET_SECONDS must be positive')
  if (!Number.isInteger(playwrightTimeoutMs) || playwrightTimeoutMs <= 0) throw new Error('SCALABILITY_PLAYWRIGHT_TIMEOUT_MS must be a positive integer')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('SCALABILITY_FIXTURE_DURATION_SECONDS must be positive')
  if (!Number.isFinite(submissionWindowSeconds) || submissionWindowSeconds <= 0) throw new Error('SCALABILITY_SUBMISSION_WINDOW_SECONDS must be positive')
  if (!Number.isInteger(minimumCapacity) || minimumCapacity < 1) throw new Error('SCALABILITY_MIN_CAPACITY must be a positive integer')
  const sizeBytes = Number(process.env.SCALABILITY_FIXTURE_BYTES)
  const width = Number(process.env.SCALABILITY_FIXTURE_WIDTH)
  const height = Number(process.env.SCALABILITY_FIXTURE_HEIGHT)
  const sha256 = process.env.SCALABILITY_FIXTURE_SHA256?.trim()
  return {
    fixturePath: required('SCALABILITY_FIXTURE_PATH'),
    fixture: {
      name: required('SCALABILITY_FIXTURE_NAME'),
      durationSeconds,
      ...(Number.isInteger(sizeBytes) && sizeBytes > 0 ? { sizeBytes } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(Number.isInteger(width) && width > 0 ? { width } : {}),
      ...(Number.isInteger(height) && height > 0 ? { height } : {}),
    },
    batchSize,
    budgetMs: budgetSeconds * 1000,
    playwrightTimeoutMs,
    evidenceDir: required('SCALABILITY_EVIDENCE_DIR'),
    playbackBaseUrl: required('PLAYBACK_BASE_URL'),
    region: required('SCALABILITY_REGION'),
    account: required('SCALABILITY_ACCOUNT_ID'),
    cluster: resourceName(required('SCALABILITY_CLUSTER')),
    service: resourceName(required('SCALABILITY_PARENT_SERVICE')),
    stateMachineArn: required('SCALABILITY_STATE_MACHINE_ARN'),
    minimumCapacity,
    inputBucket: required('SCALABILITY_INPUT_BUCKET'),
    submissionWindowSeconds,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeMessage(error: unknown, forbidden: readonly string[]): string {
  const message = error instanceof Error ? error.message : 'scalability workload failed'
  return sanitizeEvidence(message, forbidden)
}

async function submit(request: APIRequestContext, bytes: Buffer, index: number, inputBucket: string): Promise<JobRecord> {
  const createdResponse = await request.post(apiUrl(e2eConfig.apiUrl, 'videos'), {
    data: { fileName: `scalability-${index}.mp4`, contentType: 'video/mp4', sizeBytes: bytes.length },
  })
  if (!createdResponse.ok()) throw new Error(`video create failed (${createdResponse.status()})`)
  const created = await createdResponse.json() as {
    videoId: string
    createdAt: string
    job: { jobId: string }
    upload: { url: string; headers: Record<string, string> }
  }
  if (!created.videoId || !created.job?.jobId) throw new Error('video create did not return a job id')
  const job: JobRecord = {
    videoId: created.videoId,
    jobId: created.job.jobId,
    status: 'UPLOADING',
    createdAt: created.createdAt || new Date().toISOString(),
  }
  try {
    const bucket = presignedUploadBucket(created.upload?.url ?? '')
    if (bucket !== inputBucket) {
      throw new Error(`presigned upload bucket ${bucket ?? 'unknown'} does not match the dedicated input bucket ${inputBucket}`)
    }
    const upload = await request.put(created.upload.url, { headers: created.upload.headers, data: bytes })
    if (!upload.ok()) throw new Error(`upload failed (${upload.status()})`)
    return job
  } catch (error) {
    job.status = 'SUBMISSION_FAILED'
    const message = error instanceof Error ? error.message : 'upload failed'
    job.error = /https?:\/\//i.test(message) || message.includes('X-Amz-') ? 'upload failed' : message
    return job
  }
}

async function refreshJob(request: APIRequestContext, job: JobRecord): Promise<void> {
  const response = await request.get(apiUrl(e2eConfig.apiUrl, `videos/${job.videoId}`))
  if (!response.ok()) {
    job.error = `status request failed (${response.status()})`
    return
  }
  const body = await response.json() as {
    updatedAt?: string
    job?: { jobId?: string; status?: string; failure?: { message?: string } }
  }
  const status = body.job?.status
  if (!status) return
  job.status = status
  if (body.job?.jobId) job.jobId = body.job.jobId
  if (status === 'COMPLETED' && !job.completedAt) {
    job.completedAt = body.updatedAt ?? new Date().toISOString()
    const elapsed = (Date.parse(job.completedAt) - Date.parse(job.createdAt)) / 1000
    if (Number.isFinite(elapsed) && elapsed >= 0) job.elapsedSeconds = elapsed
  }
  if (status === 'FAILED') job.error = body.job?.failure?.message ?? 'job failed'
}

function terminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'TIMED_OUT' || status === 'SUBMISSION_FAILED'
}

test.describe('@scalability', () => {
  test('measures parent scale-out, child overlap, ABR playback, completion, and scale-in', async ({ request, page }, testInfo) => {
    const startedAt = new Date().toISOString()
    let settings: Settings | undefined
    let document: WorkloadDocument | undefined
    let published = false
    try {
      settings = readSettings()
      test.setTimeout(settings.playwrightTimeoutMs)
      const active = settings
      const jobs: JobRecord[] = []
      const samples: ServiceSample[] = []
      const observationErrors: string[] = []
      let observer: LiveObserver | undefined
      let playback: PlaybackProof | undefined
      let playbackAttempted = false
      let failure: string | undefined
      let finalWriteError: string | undefined
      let submission: { windowSeconds: number; elapsedSeconds: number; withinWindow: boolean } | undefined
      const forbidden = [active.fixturePath]
      const snapshot = (finalized: boolean) => buildWorkloadDocument({
        attempted: true,
        minimumCapacity: active.minimumCapacity,
        batchSize: active.batchSize,
        jobs,
        samples,
        activities: observer ? parentActivities(observer.hits) : [],
        childIntervals: observer?.childIntervals ?? [],
        playback,
        playbackAttempted,
        observationErrors: [...observationErrors, ...(observer?.errors ?? [])],
        startedAt,
        fixture: active.fixture,
        playbackDetails: playback,
        ...(failure ? { error: failure } : {}),
        ...(submission ? { submission } : {}),
        finalized,
        forbiddenPaths: forbidden,
      })
      const publish = async (required: boolean) => {
        try {
          await writeWorkload(active.evidenceDir, snapshot(required))
          published = true
        } catch (error) {
          const message = safeMessage(error, forbidden)
          if (!required) {
            observationErrors.push(message)
            return
          }
          finalWriteError = message
          failure = message
          try {
            await writeWorkload(active.evidenceDir, { ...snapshot(true), status: 'failed', finalized: true, error: message })
            published = true
          } catch {
            // The required write stays failed in memory when the evidence directory cannot be updated.
          }
        }
      }
      try {
        try {
          samples.push(await sampleParentService(active.region, active.cluster, active.service))
        } catch (error) {
          failure = safeMessage(error, forbidden)
        }
        let bytes: Buffer | undefined
        try {
          bytes = await readFile(active.fixturePath)
        } catch (error) {
          failure = safeMessage(error, forbidden)
        }
        if (bytes) {
          const payload = bytes
          const submissionStarted = Date.now()
          const results = await Promise.allSettled(Array.from({ length: active.batchSize }, (_, index) => (
            submit(request, payload, index, active.inputBucket)
          )))
          const elapsedSeconds = (Date.now() - submissionStarted) / 1000
          const errors: string[] = []
          for (const result of results) {
            if (result.status === 'fulfilled') {
              jobs.push(result.value)
              if (result.value.status === 'SUBMISSION_FAILED') {
                errors.push(`${result.value.jobId}: ${result.value.error ?? 'submission failed'}`)
              }
            } else {
              errors.push(safeMessage(result.reason, forbidden))
            }
          }
          submission = {
            windowSeconds: active.submissionWindowSeconds,
            elapsedSeconds,
            withinWindow: elapsedSeconds <= active.submissionWindowSeconds,
          }
          if (!submission.withinWindow) {
            errors.push(`batch submission took ${elapsedSeconds}s, above the planned submission window of ${active.submissionWindowSeconds}s`)
          }
          if (errors.length > 0) failure = errors.join('; ')
        }
        await publish(false)
        if (jobs.length > 0) {
          observer = startLiveObserver({
            region: active.region,
            account: active.account,
            cluster: active.cluster,
            service: active.service,
            stateMachineArn: active.stateMachineArn,
            jobIds: () => jobs.map((job) => job.jobId),
            samples,
          })
          const deadline = Date.now() + active.budgetMs
          while (Date.now() < deadline) {
            for (const job of jobs) {
              if (terminal(job.status)) continue
              await refreshJob(request, job)
            }
            if (!playbackAttempted && jobs.some((job) => job.status === 'COMPLETED')) {
              playbackAttempted = true
              const completed = jobs.find((job) => job.status === 'COMPLETED')
              if (completed) {
                try {
                  const playbackResponse = await request.get(apiUrl(e2eConfig.apiUrl, `videos/${completed.videoId}/playback`))
                  if (!playbackResponse.ok()) throw new Error(`playback lookup failed (${playbackResponse.status()})`)
                  const body = await playbackResponse.json() as { manifestUrl?: string; jobId?: string }
                  if (body.jobId !== completed.jobId) throw new Error('playback response job id did not match the completed job')
                  if (!body.manifestUrl) throw new Error('playback response did not include a manifest URL')
                  playback = await proveAbrPlayback(page, e2eConfig.frontendUrl, body.manifestUrl, active.playbackBaseUrl, e2eConfig.timeouts.playback)
                } catch (error) {
                  playback = failedPlayback(safeMessage(error, forbidden))
                }
              }
            }
            await publish(false)
            const allTerminal = jobs.every((job) => terminal(job.status))
            const allCompleted = jobs.length === active.batchSize && jobs.every((job) => job.status === 'COMPLETED')
            const completedAt = allCompleted ? Math.max(...jobs.map((job) => Date.parse(job.completedAt ?? job.createdAt))) : undefined
            const scaledAt = samples.find((sample) => sample.runningCount >= 2)?.observedAt
            const scaledIn = completedAt !== undefined && scaledAt !== undefined && samples.some((sample) => (
              Date.parse(sample.observedAt) >= completedAt
              && Date.parse(sample.observedAt) >= Date.parse(scaledAt)
              && sample.runningCount === active.minimumCapacity
              && sample.desiredCount === active.minimumCapacity
            ))
            if (allTerminal && playbackAttempted && (!allCompleted || scaledIn)) break
            if (allTerminal && !jobs.some((job) => job.status === 'COMPLETED')) break
            await sleep(2_000)
          }
          for (const job of jobs) {
            if (terminal(job.status)) continue
            job.status = 'TIMED_OUT'
            job.error = 'did not complete before the run deadline'
          }
        }
      } catch (error) {
        failure = safeMessage(error, forbidden)
      } finally {
        if (observer) {
          try {
            await observer.stop()
          } catch (error) {
            observationErrors.push(safeMessage(error, forbidden))
          }
        }
        await publish(true)
      }
      document = finalWriteError
        ? { ...snapshot(true), status: 'failed', finalized: true, error: finalWriteError }
        : snapshot(true)
    } catch (error) {
      const forbidden = settings ? [settings.fixturePath] : []
      if (!published) {
        document = notRunDocument({
          startedAt,
          batchSize: settings?.batchSize ?? 0,
          error: safeMessage(error, forbidden),
          forbiddenPaths: forbidden,
        })
        if (settings) await writeWorkload(settings.evidenceDir, document)
      }
      if (!document) throw error
    }
    if (!document) throw new Error('scalability evidence was not recorded')
    await testInfo.attach('scalability-workload', { body: JSON.stringify(document), contentType: 'application/json' })
    expect(document.status, document.summary).toBe('passed')
  })
})

import { expect, test, type APIRequestContext } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { e2eConfig } from '../config.js'
import { type JobRecord, type ServiceSample } from './checkpoints.js'
import { buildWorkloadDocument, notRunDocument, sanitizeEvidence, writeWorkload, type FixtureIdentity, type WorkloadDocument } from './evidence.js'
import { parentActivities, sampleParentService, startLiveObserver, type LiveObserver } from './observe.js'
import { proveAbrPlayback, type PlaybackProof } from './playback.js'

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
import { apiUrl } from './urls.js'

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
  const minimumCapacity = Number(process.env.SCALABILITY_MIN_CAPACITY ?? '1')
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('SCALABILITY_BATCH_SIZE must be a positive integer')
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error('SCALABILITY_RUNTIME_BUDGET_SECONDS must be positive')
  if (!Number.isInteger(playwrightTimeoutMs) || playwrightTimeoutMs <= 0) throw new Error('SCALABILITY_PLAYWRIGHT_TIMEOUT_MS must be a positive integer')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('SCALABILITY_FIXTURE_DURATION_SECONDS must be positive')
  if (!Number.isInteger(minimumCapacity) || minimumCapacity < 1) throw new Error('SCALABILITY_MIN_CAPACITY must be a positive integer')
  const sizeBytes = Number(process.env.SCALABILITY_FIXTURE_BYTES)
  const sha256 = process.env.SCALABILITY_FIXTURE_SHA256?.trim()
  return {
    fixturePath: required('SCALABILITY_FIXTURE_PATH'),
    fixture: {
      name: required('SCALABILITY_FIXTURE_NAME'),
      durationSeconds,
      ...(Number.isInteger(sizeBytes) && sizeBytes > 0 ? { sizeBytes } : {}),
      ...(sha256 ? { sha256 } : {}),
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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeMessage(error: unknown, forbidden: readonly string[]): string {
  const message = error instanceof Error ? error.message : 'scalability workload failed'
  return sanitizeEvidence(message, forbidden)
}

async function submit(request: APIRequestContext, bytes: Buffer, index: number): Promise<JobRecord> {
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
  const upload = await request.put(created.upload.url, { headers: created.upload.headers, data: bytes })
  if (!upload.ok()) throw new Error(`upload failed (${upload.status()})`)
  return { videoId: created.videoId, jobId: created.job.jobId, status: 'UPLOADING', createdAt: created.createdAt }
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
  return status === 'COMPLETED' || status === 'FAILED' || status === 'TIMED_OUT'
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
      const forbidden = [active.fixturePath]
      const snapshot = () => buildWorkloadDocument({
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
        forbiddenPaths: forbidden,
      })
      const publish = async () => {
        try {
          await writeWorkload(active.evidenceDir, snapshot())
          published = true
        } catch (error) {
          observationErrors.push(safeMessage(error, forbidden))
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
          for (let index = 0; index < active.batchSize; index += 1) {
            try {
              jobs.push(await submit(request, bytes, index))
            } catch (error) {
              failure = safeMessage(error, forbidden)
              break
            }
          }
        }
        await publish()
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
            await publish()
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
        await publish()
      }
      document = snapshot()
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

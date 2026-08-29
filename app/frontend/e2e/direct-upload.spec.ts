import { test, expect, type Page, type Request } from '@playwright/test'
import { e2eConfig } from './config.js'
import { attachSafeDiagnostic, safeDiagnostic } from './diagnostics.js'
import { withMp4Fixture, type VideoFixture } from './fixtures.js'
import { urlEvidence } from './url-evidence.js'

interface NetworkEvidence {
  method: string
  origin: string
  path: string
  status?: number
  contentType?: string
  bodyBytes?: number
}

type JobStatus = 'UPLOADING' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

interface StatusObservation {
  status: JobStatus
  failure: unknown
  body: Record<string, unknown>
}

interface PlaybackObservation {
  videoId: string
  jobId: string
  protocol: string
  contentType: string
  manifestUrl: string
}

interface BrowserPlaybackEvidence {
  manifestOrigin: string
  segmentCount: number
  readyState: number
  initialTime: number
  currentTime: number
  advancement: number
}

interface MediaNetworkFailure {
  origin: string
  path: string
  status?: number
  error?: string
}

const JOB_STATUSES = new Set<JobStatus>([
  'UPLOADING',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function evidenceUrl(value: string): Pick<NetworkEvidence, 'origin' | 'path'> {
  return urlEvidence(value)
}

function createVideoTarget(): Pick<NetworkEvidence, 'origin' | 'path'> {
  const api = new URL(e2eConfig.apiUrl)
  const basePath = api.pathname.replace(/\/$/, '')
  const path = basePath.endsWith('/api/v1') ? `${basePath}/videos` : '/api/v1/videos'
  return { origin: api.origin, path }
}

function matchesTarget(
  value: Pick<NetworkEvidence, 'origin' | 'path'>,
  target: Pick<NetworkEvidence, 'origin' | 'path'>,
): boolean {
  return value.origin === target.origin && value.path === target.path
}

function responsesMatchingTarget(
  responses: NetworkEvidence[],
  target: Pick<NetworkEvidence, 'origin' | 'path'> | undefined,
): NetworkEvidence[] {
  if (!target) return []
  return responses.filter((response) => matchesTarget(response, target))
}

function isAbortFailure(failure: MediaNetworkFailure): boolean {
  return /ERR_ABORTED|NS_BINDING_ABORTED|AbortError|aborted|cancelled|canceled/i.test(
    failure.error ?? '',
  )
}

function failuresForMedia(
  failures: MediaNetworkFailure[],
  manifest: URL | undefined,
  pathPrefix: string | undefined,
): MediaNetworkFailure[] {
  if (!manifest || !pathPrefix) return []
  return failures.filter(
    (failure) =>
      failure.origin === manifest.origin &&
      failure.path.startsWith(pathPrefix) &&
      !isAbortFailure(failure),
  )
}

function mediaPathPrefix(
  videoId: string | undefined,
  jobId: string | undefined,
): string | undefined {
  return videoId && jobId ? `/videos/${videoId}/jobs/${jobId}/hls/` : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseEvidence(response: Awaited<ReturnType<Page['waitForResponse']>>): NetworkEvidence {
  return {
    method: response.request().method(),
    ...evidenceUrl(response.url()),
    status: response.status(),
  }
}

async function requestEvidence(request: Request): Promise<NetworkEvidence> {
  const buffer = request.postDataBuffer()
  const headers = await request.allHeaders()
  const length = headers['content-length']
  const bodyBytes = buffer
    ? buffer.byteLength
    : length && /^\d+$/.test(length)
      ? Number(length)
      : undefined
  return {
    method: request.method(),
    ...evidenceUrl(request.url()),
    contentType: headers['content-type'],
    bodyBytes,
  }
}

function uploadTargetFromCreateBody(body: unknown): Pick<NetworkEvidence, 'origin' | 'path'> {
  if (!isRecord(body) || !isRecord(body.upload) || typeof body.upload.url !== 'string') {
    throw new Error('create-video response did not include an upload URL')
  }
  return evidenceUrl(body.upload.url)
}

function idFromResult(text: string, label: 'Video' | 'Job'): string {
  const id = text.match(new RegExp(`${label} ID:\\s*([0-9a-f-]+)`, 'i'))?.[1]
  if (!id) throw new Error(`${label} ID was not rendered by the UI`)
  return id
}

function statusTarget(videoId: string): Pick<NetworkEvidence, 'origin' | 'path'> {
  const api = new URL(e2eConfig.apiUrl)
  const basePath = api.pathname.replace(/\/$/, '')
  const path = basePath.endsWith('/api/v1')
    ? `${basePath}/videos/${videoId}`
    : `/api/v1/videos/${videoId}`
  return { origin: api.origin, path }
}

function playbackTarget(videoId: string): Pick<NetworkEvidence, 'origin' | 'path'> {
  const api = new URL(e2eConfig.apiUrl)
  const basePath = api.pathname.replace(/\/$/, '')
  const path = basePath.endsWith('/api/v1')
    ? `${basePath}/videos/${videoId}/playback`
    : `/api/v1/videos/${videoId}/playback`
  return { origin: api.origin, path }
}

function parseStatusResponse(value: unknown): StatusObservation {
  if (!isRecord(value) || !isRecord(value.job) || typeof value.job.status !== 'string') {
    throw new Error('get-video response did not match the response contract')
  }
  const status = value.job.status as JobStatus
  if (!JOB_STATUSES.has(status)) throw new Error(`get-video response had unknown status: ${status}`)
  return { status, failure: value.job.failure, body: value }
}

function parsePlaybackResponse(value: unknown): PlaybackObservation {
  if (!isRecord(value)) throw new Error('playback response was not an object')
  for (const field of ['videoId', 'jobId', 'protocol', 'contentType', 'manifestUrl']) {
    if (typeof value[field] !== 'string') throw new Error(`playback response had invalid ${field}`)
  }
  return value as unknown as PlaybackObservation
}

async function inspectHlsObjects(
  page: Page,
  playback: PlaybackObservation,
  videoId: string,
  jobId: string,
  apiOrigin: string,
  frontendOrigin: string,
): Promise<number> {
  const manifest = new URL(playback.manifestUrl)
  const expectedPrefix = `/videos/${videoId}/jobs/${jobId}/hls/`
  expect(playback.protocol).toBe('HLS')
  expect(playback.contentType).toBe('application/vnd.apple.mpegurl')
  expect(manifest.protocol).toBe('https:')
  expect(manifest.hostname).not.toContain('cloudfront.net')
  expect(manifest.origin).not.toBe(apiOrigin)
  expect(manifest.origin).not.toBe(frontendOrigin)
  expect(manifest.search).toBe('')
  expect(manifest.hash).toBe('')
  expect(manifest.pathname).toBe(`${expectedPrefix}index.m3u8`)

  const result = await page.evaluate(async (manifestUrl) => {
    const response = await fetch(manifestUrl)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? null
    const text = await response.text()
    const references = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    const manifestOrigin = new URL(manifestUrl).origin
    type Segment = {
      reference: string
      valid: boolean
      origin: string | null
      path: string | null
      status: number | null
      contentType: string | null
    }
    const segments: Segment[] = references.map((reference): Segment => {
      let url: URL
      try {
        url = new URL(reference, manifestUrl)
      } catch {
        return {
          reference,
          valid: false,
          origin: null,
          path: null,
          status: null,
          contentType: null,
        }
      }
      return {
        reference,
        valid: true,
        origin: url.origin,
        path: url.pathname,
        status: null,
        contentType: null,
      }
    })
    for (const segment of segments) {
      if (!segment.valid || segment.origin !== manifestOrigin) continue
      const segmentResponse = await fetch(new URL(segment.reference, manifestUrl))
      segment.status = segmentResponse.status
      segment.contentType = segmentResponse.headers.get('content-type')?.split(';', 1)[0] ?? null
    }
    return { status: response.status, contentType, segments }
  }, playback.manifestUrl)

  expect(result.status).toBe(200)
  expect(result.contentType).toBe('application/vnd.apple.mpegurl')
  expect(result.segments.length).toBeGreaterThan(0)
  for (const segment of result.segments) {
    expect(segment.reference).toMatch(/^segment-\d{5}\.ts$/)
    expect(segment.valid).toBe(true)
    expect(segment.origin).toBe(manifest.origin)
    expect(segment.path).toBe(`${expectedPrefix}${segment.reference}`)
    expect(segment.status).toBe(200)
    expect(segment.contentType).toBe('video/mp2t')
  }
  return result.segments.length
}

async function proveBrowserPlayback(
  page: Page,
  manifestUrl: string,
  segmentCount: number,
): Promise<BrowserPlaybackEvidence> {
  const players = page.locator('video[aria-label="Uploaded video"]')
  await expect(players, 'exactly one video.js player must initialize').toHaveCount(1)
  const video = players.first()

  await expect
    .poll(
      () =>
        video.evaluate((element: HTMLVideoElement) => {
          const win = window as Window & {
            videojs?: { getPlayer: (el: HTMLElement) => { currentSrc: () => string } | undefined }
          }
          const player =
            (element as HTMLVideoElement & { player?: { currentSrc: () => string } }).player ??
            win.videojs?.getPlayer(element)
          return {
            hasVideoJsPlayer: Boolean(player),
            currentSrc: player?.currentSrc() ?? '',
            mediaError: element.error
              ? { code: element.error.code, message: element.error.message }
              : null,
          }
        }),
      {
        timeout: e2eConfig.timeouts.playback,
        message: 'player did not initialize with the playback manifest URL',
      },
    )
    .toMatchObject({ hasVideoJsPlayer: true, currentSrc: manifestUrl, mediaError: null })

  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
      timeout: e2eConfig.timeouts.playback,
      message: 'player did not load media metadata',
    })
    .toBeGreaterThanOrEqual(1)

  const initialTime = await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true
    await element.play()
    return element.currentTime
  })

  await expect
    .poll(
      async () => {
        const state = await video.evaluate((element: HTMLVideoElement) => ({
          currentTime: element.currentTime,
          readyState: element.readyState,
          paused: element.paused,
          ended: element.ended,
          mediaError: element.error
            ? { code: element.error.code, message: element.error.message }
            : null,
        }))
        if (state.mediaError)
          throw new Error(`fatal media error: ${JSON.stringify(state.mediaError)}`)
        if (state.ended && state.currentTime <= initialTime) {
          throw new Error('media ended without positive time advancement')
        }
        return state.currentTime
      },
      { timeout: e2eConfig.timeouts.playback, message: 'media currentTime did not advance' },
    )
    .toBeGreaterThan(initialTime + 0.05)

  const finalState = await video.evaluate((element: HTMLVideoElement) => ({
    currentTime: element.currentTime,
    readyState: element.readyState,
  }))
  return {
    manifestOrigin: new URL(manifestUrl).origin,
    segmentCount,
    readyState: finalState.readyState,
    initialTime,
    currentTime: finalState.currentTime,
    advancement: finalState.currentTime - initialTime,
  }
}

function expectRfc3339(value: unknown, field: string) {
  expect(typeof value, `${field} must be a string`).toBe('string')
  expect(RFC3339.test(String(value)), `${field} must be RFC 3339`).toBe(true)
  expect(Number.isNaN(Date.parse(String(value))), `${field} must be a valid instant`).toBe(false)
}

function validateCompletedResponse(
  observation: StatusObservation,
  videoId: string,
  jobId: string,
  fixture: VideoFixture,
) {
  const body = observation.body
  const job = body.job as Record<string, unknown>
  expect(body.videoId).toBe(videoId)
  expect(job.jobId).toBe(jobId)
  expect(UUID.test(String(body.videoId))).toBe(true)
  expect(UUID.test(String(job.jobId))).toBe(true)
  expect(body.fileName).toBe('fixture.mp4')
  expect(body.contentType).toBe(fixture.contentType)
  expect(body.sizeBytes).toBe(fixture.sizeBytes)
  expect(observation.status).toBe('COMPLETED')
  expect(observation.failure).toBeNull()
  expectRfc3339(body.createdAt, 'createdAt')
  expectRfc3339(body.updatedAt, 'updatedAt')
}

test.use({ trace: 'off' })

test.describe('@phase1-pipeline', () => {
  test('uploads one video and reaches COMPLETED through the asynchronous pipeline', async ({
    page,
  }, testInfo) => {
    const createTarget = createVideoTarget()
    const apiOrigin = new URL(e2eConfig.apiUrl).origin
    const frontendOrigin = new URL(e2eConfig.frontendUrl).origin
    const createResponses: NetworkEvidence[] = []
    const putResponses: NetworkEvidence[] = []
    const putRequests: Request[] = []
    let createResponse: Awaited<ReturnType<Page['waitForResponse']>> | undefined
    let uploadRequest: NetworkEvidence | undefined
    let uploadTarget: Pick<NetworkEvidence, 'origin' | 'path'> | undefined
    let videoId: string | undefined
    let jobId: string | undefined
    let latestStatus: JobStatus | undefined
    let latestStatusIndex = -1
    let playbackEvidence: BrowserPlaybackEvidence | undefined
    let playbackManifest: URL | undefined
    const observedStatuses: JobStatus[] = []
    const statusResponses: Promise<StatusObservation>[] = []
    const playbackResponses: Promise<PlaybackObservation>[] = []
    const mediaNetworkFailures: MediaNetworkFailure[] = []

    page.on('response', (response) => {
      const method = response.request().method()
      if (method === 'POST' && matchesTarget(evidenceUrl(response.url()), createTarget)) {
        createResponse = response
        createResponses.push(responseEvidence(response))
      }
      if (method === 'PUT') putResponses.push(responseEvidence(response))
      if (
        method === 'GET' &&
        videoId &&
        matchesTarget(evidenceUrl(response.url()), statusTarget(videoId)) &&
        response.status() === 200
      ) {
        const receivedIndex = statusResponses.length
        const statusResponse = response.json().then(parseStatusResponse)
        statusResponses.push(statusResponse)
        void statusResponse.then((observation) => {
          if (receivedIndex >= latestStatusIndex) {
            latestStatusIndex = receivedIndex
            latestStatus = observation.status
          }
          if (!observedStatuses.includes(observation.status))
            observedStatuses.push(observation.status)
        })
      }
      if (
        method === 'GET' &&
        videoId &&
        matchesTarget(evidenceUrl(response.url()), playbackTarget(videoId)) &&
        response.status() === 200
      ) {
        playbackResponses.push(response.json().then(parsePlaybackResponse))
      }
    })
    page.on('request', (request) => {
      if (request.method() !== 'PUT') return
      putRequests.push(request)
    })
    page.on('requestfailed', (request) => {
      const target = evidenceUrl(request.url())
      mediaNetworkFailures.push({ ...target, error: request.failure()?.errorText })
    })
    page.on('response', (response) => {
      if (response.status() < 400) return
      mediaNetworkFailures.push({ ...evidenceUrl(response.url()), status: response.status() })
    })

    try {
      await withMp4Fixture(async (fixture: VideoFixture) => {
        await page.goto('/')
        await expect(page.locator('h1')).toHaveText('You did it!')

        await test.step('select generated MP4 and submit once', async () => {
          await page.locator('#video-file').setInputFiles(fixture.path)
          await page.getByRole('button', { name: 'Upload video' }).click()
        })

        const result = page.locator('[aria-label="Video creation result"]')
        await expect(result).toBeVisible()
        const resultText = (await result.textContent()) ?? ''
        videoId = idFromResult(resultText, 'Video')
        jobId = idFromResult(resultText, 'Job')
        expect(createResponses).toHaveLength(1)

        if (!createResponse) throw new Error('create-video response was not observed')
        uploadTarget = uploadTargetFromCreateBody(await createResponse.json())
        expect(uploadTarget.origin).not.toBe(apiOrigin)
        expect(uploadTarget.origin).not.toBe(frontendOrigin)

        const target = uploadTarget
        await expect
          .poll(
            () => putRequests.find((request) => matchesTarget(evidenceUrl(request.url()), target)),
            { timeout: e2eConfig.timeouts.upload },
          )
          .toBeTruthy()

        const matchedRequest = putRequests.find((request) =>
          matchesTarget(evidenceUrl(request.url()), target),
        )
        if (!matchedRequest) throw new Error('upload request was not observed')
        uploadRequest = await requestEvidence(matchedRequest)
        expect(uploadRequest?.method).toBe('PUT')
        expect(uploadRequest?.contentType).toBe('video/mp4')
        expect(uploadRequest?.origin).not.toBe(apiOrigin)
        expect(uploadRequest?.origin).not.toBe(frontendOrigin)
        expect(uploadRequest?.bodyBytes).toBe(fixture.sizeBytes)

        await expect
          .poll(
            () =>
              putResponses.some(
                (response) =>
                  matchesTarget(response, target) &&
                  response.status !== undefined &&
                  response.status >= 200 &&
                  response.status < 300,
              ),
            { timeout: e2eConfig.timeouts.upload },
          )
          .toBe(true)

        await expect(page.locator('[data-workflow-state]')).toHaveAttribute(
          'data-workflow-state',
          /processing|ready/,
        )

        await expect
          .poll(
            async () => {
              const rendered = (
                (await page.locator('[data-job-status]').textContent()) ?? ''
              ).match(/Job status:\s*(\w+)/)?.[1]
              if (rendered === 'FAILED' || latestStatus === 'FAILED') {
                const observations = await Promise.all(statusResponses)
                const failed = observations.findLast((item) => item.status === 'FAILED')
                throw new Error(
                  `pipeline reached FAILED: ${JSON.stringify(
                    safeDiagnostic({ videoId, jobId, status: 'FAILED', failure: failed?.failure }),
                  )}`,
                )
              }
              return { api: latestStatus, ui: rendered }
            },
            {
              timeout: e2eConfig.timeouts.processing,
              message: `pipeline did not reach COMPLETED (videoId=${videoId}, jobId=${jobId}); last status is reported below`,
            },
          )
          .toEqual({ api: 'COMPLETED', ui: 'COMPLETED' })

        const observations = await Promise.all(statusResponses)
        const completed = observations.findLast((item) => item.status === 'COMPLETED')
        expect(completed, 'a successful COMPLETED API response was not observed').toBeDefined()
        validateCompletedResponse(completed!, videoId, jobId, fixture)

        await expect(page.locator('[data-workflow-state]')).toHaveAttribute(
          'data-workflow-state',
          'ready',
          { timeout: e2eConfig.timeouts.playback },
        )

        await expect
          .poll(
            async () => {
              const items = await Promise.all(playbackResponses)
              return items.find((item) => item.videoId === videoId && item.jobId === jobId)
            },
            {
              timeout: e2eConfig.timeouts.playback,
              message: `playback response was not observed (videoId=${videoId}, jobId=${jobId})`,
            },
          )
          .toBeTruthy()

        const playback = (await Promise.all(playbackResponses)).find(
          (item) => item.videoId === videoId && item.jobId === jobId,
        )
        if (!playback) throw new Error('a successful playback response was not observed')
        playbackManifest = new URL(playback.manifestUrl)
        const segmentCount = await inspectHlsObjects(
          page,
          playback,
          videoId,
          jobId,
          apiOrigin,
          frontendOrigin,
        )
        playbackEvidence = await proveBrowserPlayback(page, playback.manifestUrl, segmentCount)

        const mediaPrefix = `/videos/${videoId}/jobs/${jobId}/hls/`
        const fatalMediaFailures = failuresForMedia(
          mediaNetworkFailures,
          playbackManifest,
          mediaPrefix,
        )
        expect(fatalMediaFailures, 'manifest or segment network requests must not fail').toEqual([])
        await expect(
          page.locator('[role="alert"]'),
          'video.js must not report a fatal error',
        ).toHaveCount(0)
      })
    } finally {
      const matchedPuts = responsesMatchingTarget(putResponses, uploadTarget)
      await attachSafeDiagnostic(testInfo, 'direct-upload-network', {
        videoId,
        jobId,
        apiOrigin,
        frontendOrigin,
        upload: uploadRequest,
        responses: [...createResponses, ...matchedPuts].map((response) =>
          safeDiagnostic({
            origin: response.origin,
            path: response.path,
            status: response.status,
            method: response.method,
            contentType: response.contentType,
            bodyBytes: response.bodyBytes,
          }),
        ),
      })
      await attachSafeDiagnostic(testInfo, 'pipeline-status', {
        videoId,
        jobId,
        status: latestStatus,
        observedStatuses,
      })
      const mediaPrefix = mediaPathPrefix(videoId, jobId)
      await attachSafeDiagnostic(testInfo, 'browser-playback', {
        videoId,
        jobId,
        status: latestStatus,
        manifestOrigin: playbackManifest?.origin,
        segmentCount: playbackEvidence?.segmentCount,
        readyState: playbackEvidence?.readyState,
        initialTime: playbackEvidence?.initialTime,
        currentTime: playbackEvidence?.currentTime,
        advancement: playbackEvidence?.advancement,
        failures: failuresForMedia(mediaNetworkFailures, playbackManifest, mediaPrefix),
      })
    }
  })
})

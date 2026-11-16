import { test, expect } from '@playwright/test'
import { e2eConfig } from './config.js'
import { withMp4Fixture } from './fixtures.js'

interface VideoStatusResponse {
  videoId: string
  job: {
    jobId: string
    status: string
    failure?: { code?: string; message?: string } | null
  }
}

interface PlaybackResponse {
  videoId: string
  jobId: string
  protocol: string
  contentType: string
  manifestUrl: string
}

function resultId(text: string, label: 'Video' | 'Job'): string {
  const id = text.match(new RegExp(`${label} ID:\\s*([0-9a-f-]+)`, 'i'))?.[1]
  if (!id) throw new Error(`${label} ID was not rendered by the upload flow`)
  return id
}

function requiredLocalUrl(name: string): URL {
  const raw = process.env[name]?.trim()
  if (!raw) throw new Error(`${name} is required for Emulator E2E`)
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`${name} must be an HTTP loopback URL`)
  }
  return url
}

test.describe('@emulator-pipeline', () => {
  test('uploads, transcodes, and plays a video through AWS Emulator', async ({ page, request }) => {
    const s3Proxy = requiredLocalUrl('EMULATOR_S3_PROXY_URL')
    const playbackBase = requiredLocalUrl('PLAYBACK_BASE_URL')
    const apiBase = e2eConfig.apiUrl.replace(/\/$/, '')
    const putRequests: string[] = []
    const putContentTypes: string[] = []
    const putBodyBytes: number[] = []
    const putStatuses: number[] = []
    page.on('request', (browserRequest) => {
      if (browserRequest.method() === 'PUT') {
        putRequests.push(browserRequest.url())
        putContentTypes.push(browserRequest.headers()['content-type'] ?? '')
        putBodyBytes.push(browserRequest.postDataBuffer()?.byteLength ?? 0)
      }
    })
    page.on('response', (response) => {
      if (response.request().method() === 'PUT') putStatuses.push(response.status())
    })

    await withMp4Fixture(async (fixture) => {
      await page.goto('/')
      await expect(page.locator('h1')).toHaveText('You did it!')
      await page.locator('#video-file').setInputFiles(fixture.path)
      await page.getByRole('button', { name: 'Upload video' }).click()

      const creation = page.locator('[aria-label="Video creation result"]')
      await expect(creation).toBeVisible()
      const resultText = (await creation.textContent()) ?? ''
      const videoId = resultId(resultText, 'Video')
      const jobId = resultId(resultText, 'Job')

      await expect.poll(() => putRequests.length, {
        timeout: e2eConfig.timeouts.upload,
        message: 'browser did not issue the presigned S3 upload',
      }).toBe(1)
      const uploadUrl = new URL(putRequests[0]!)
      expect(uploadUrl.origin).toBe(s3Proxy.origin)
      expect(uploadUrl.pathname).toContain(`/videos/${videoId}/jobs/${jobId}/source.mp4`)
      expect(putContentTypes).toEqual(['video/mp4'])
      expect(putBodyBytes).toEqual([fixture.sizeBytes])
      await expect.poll(() => putStatuses.length, {
        timeout: e2eConfig.timeouts.upload,
        message: 'presigned S3 upload did not complete',
      }).toBe(1)
      expect(putStatuses[0]).toBeGreaterThanOrEqual(200)
      expect(putStatuses[0]).toBeLessThan(300)

      await expect.poll(async () => {
        const response = await request.get(`${apiBase}/api/v1/videos/${videoId}`)
        expect(response.ok()).toBe(true)
        const body = await response.json() as VideoStatusResponse
        expect(body.videoId).toBe(videoId)
        expect(body.job?.jobId).toBe(jobId)
        if (body.job?.status === 'FAILED') {
          throw new Error(`video processing failed: ${body.job.failure?.code ?? 'unknown'}`)
        }
        return body.job?.status
      }, {
        timeout: e2eConfig.timeouts.processing,
        message: `video ${videoId} did not complete processing`,
      }).toBe('COMPLETED')

      await expect(page.locator('[data-job-status]')).toHaveText('Job status: COMPLETED')
      await expect(page.locator('[data-workflow-state]')).toHaveAttribute(
        'data-workflow-state', 'ready', { timeout: e2eConfig.timeouts.playback },
      )

      const response = await request.get(`${apiBase}/api/v1/videos/${videoId}/playback`)
      expect(response.ok()).toBe(true)
      const playback = await response.json() as PlaybackResponse
      expect(playback.videoId).toBe(videoId)
      expect(playback.jobId).toBe(jobId)
      expect(playback.protocol).toBe('HLS')
      expect(playback.contentType).toBe('application/vnd.apple.mpegurl')

      const manifestUrl = new URL(playback.manifestUrl)
      expect(manifestUrl.origin).toBe(playbackBase.origin)
      expect(manifestUrl.pathname).toBe(`/videos/${videoId}/jobs/${jobId}/hls/index.m3u8`)
      expect(manifestUrl.search).toBe('')
      expect(manifestUrl.hash).toBe('')

      const manifest = await page.evaluate(async (url) => {
        const response = await fetch(url)
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]
        const text = await response.text()
        const references = text.split(/\r?\n/).map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'))
        const segments = await Promise.all(references.map(async (reference) => {
          const segmentUrl = new URL(reference, url)
          const segment = await fetch(segmentUrl)
          return {
            reference,
            origin: segmentUrl.origin,
            status: segment.status,
            contentType: segment.headers.get('content-type')?.split(';', 1)[0],
          }
        }))
        return { status: response.status, contentType, segments }
      }, manifestUrl.href)

      expect(manifest.status).toBe(200)
      expect(manifest.contentType).toBe('application/vnd.apple.mpegurl')
      expect(manifest.segments.length).toBeGreaterThan(0)
      for (const segment of manifest.segments) {
        expect(segment.reference).toMatch(/^segment-\d{5}\.ts$/)
        expect(segment.origin).toBe(playbackBase.origin)
        expect(segment.status).toBe(200)
        expect(segment.contentType).toBe('video/mp2t')
      }

      const video = page.locator('video[aria-label="Uploaded video"]')
      await expect(video).toHaveCount(1)
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
        timeout: e2eConfig.timeouts.playback,
        message: 'video.js did not load media metadata from the emulator proxy',
      }).toBeGreaterThanOrEqual(1)
      const initialTime = await video.evaluate(async (element: HTMLVideoElement) => {
        element.muted = true
        await element.play()
        return element.currentTime
      })
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), {
        timeout: e2eConfig.timeouts.playback,
        message: 'video playback time did not advance',
      }).toBeGreaterThan(initialTime + 0.05)
    })
  })
})

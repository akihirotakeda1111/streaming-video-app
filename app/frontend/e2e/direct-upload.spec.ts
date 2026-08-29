import { test, expect, type Page, type Request } from '@playwright/test'
import { e2eConfig } from './config.js'
import { attachSafeDiagnostic, safeDiagnostic, redactUrl } from './diagnostics.js'
import { withMp4Fixture, type VideoFixture } from './fixtures.js'

interface NetworkEvidence {
  method: string
  origin: string
  path: string
  status?: number
  contentType?: string
  bodyBytes?: number
}

function evidenceUrl(value: string): Pick<NetworkEvidence, 'origin' | 'path'> {
  const url = new URL(redactUrl(value))
  return { origin: url.origin, path: url.pathname }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseEvidence(response: Awaited<ReturnType<Page['waitForResponse']>>): NetworkEvidence {
  return { method: response.request().method(), ...evidenceUrl(response.url()), status: response.status() }
}

function requestBodyBytes(request: Request): number | undefined {
  const buffer = request.postDataBuffer()
  if (buffer) return buffer.byteLength
  const length = request.headers()['content-length']
  if (length && /^\d+$/.test(length)) return Number(length)
  return undefined
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

test.describe('@phase1-pipeline', () => {
  test.use({ trace: 'off' })

  test('creates one video and uploads its source directly to S3', async ({ page }, testInfo) => {
    const createTarget = createVideoTarget()
    const apiOrigin = new URL(e2eConfig.apiUrl).origin
    const frontendOrigin = new URL(e2eConfig.frontendUrl).origin
    const createResponses: NetworkEvidence[] = []
    const putResponses: NetworkEvidence[] = []
    const putRequests: NetworkEvidence[] = []
    let createResponse: Awaited<ReturnType<Page['waitForResponse']>> | undefined
    let uploadRequest: NetworkEvidence | undefined
    let uploadTarget: Pick<NetworkEvidence, 'origin' | 'path'> | undefined
    let videoId: string | undefined
    let jobId: string | undefined

    page.on('response', (response) => {
      const method = response.request().method()
      if (method === 'POST' && matchesTarget(evidenceUrl(response.url()), createTarget)) {
        createResponse = response
        createResponses.push(responseEvidence(response))
      }
      if (method === 'PUT') putResponses.push(responseEvidence(response))
    })
    page.on('request', (request) => {
      if (request.method() !== 'PUT') return
      putRequests.push({
        method: 'PUT',
        ...evidenceUrl(request.url()),
        contentType: request.headers()['content-type'],
        bodyBytes: requestBodyBytes(request),
      })
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
            () => putRequests.find((request) => matchesTarget(request, target)),
            { timeout: e2eConfig.timeouts.upload },
          )
          .toBeTruthy()

        uploadRequest = putRequests.find((request) => matchesTarget(request, target))
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

        await expect(page.locator('[data-workflow-state]')).toHaveAttribute('data-workflow-state', /processing|ready/)
      })
    } finally {
      const target = uploadTarget
      const matchedPuts = target ? putResponses.filter((response) => matchesTarget(response, target)) : []
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
    }
  })
})

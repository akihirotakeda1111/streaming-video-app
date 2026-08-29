import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { e2eConfig } from './config.js'
import { attachSafeDiagnostic, safeDiagnostic, redactUrl } from './diagnostics.js'
import { withMp4Fixture, type VideoFixture } from './fixtures.js'

interface NetworkEvidence {
  method: string
  origin: string
  path: string
  status?: number
  contentType?: string
}

function evidenceUrl(value: string): Pick<NetworkEvidence, 'origin' | 'path'> {
  const url = new URL(redactUrl(value))
  return { origin: url.origin, path: url.pathname }
}

function responseEvidence(response: Awaited<ReturnType<Page['waitForResponse']>>): NetworkEvidence {
  return { method: response.request().method(), ...evidenceUrl(response.url()), status: response.status() }
}

function idFromResult(text: string, label: 'Video' | 'Job'): string {
  const id = text.match(new RegExp(`${label} ID:\\s*([0-9a-f-]+)`, 'i'))?.[1]
  if (!id) throw new Error(`${label} ID was not rendered by the UI`)
  return id
}

test.describe('@phase1-pipeline', () => {
  test('creates one video and uploads its source directly to S3', async ({ page }, testInfo) => {
    const responses: NetworkEvidence[] = []
    let uploadRequest: NetworkEvidence | undefined
    let videoId: string | undefined
    let jobId: string | undefined

    page.on('response', (response) => {
      const request = response.request()
      if (request.method() === 'POST' || request.method() === 'PUT') responses.push(responseEvidence(response))
    })
    page.on('request', (request) => {
      if (request.method() === 'PUT') {
        uploadRequest = { method: 'PUT', ...evidenceUrl(request.url()), contentType: request.headers()['content-type'] }
      }
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
        expect(responses.filter((response) => response.method === 'POST')).toHaveLength(1)

        await expect.poll(() => uploadRequest, { timeout: e2eConfig.timeouts.upload }).toBeTruthy()
        expect(uploadRequest?.method).toBe('PUT')
        expect(uploadRequest?.contentType).toBe('video/mp4')
        expect(uploadRequest?.origin).not.toBe(new URL(e2eConfig.apiUrl).origin)
        expect(uploadRequest?.origin).not.toBe(new URL(e2eConfig.frontendUrl).origin)
        await expect
          .poll(
            () => responses.some((response) => response.method === 'PUT' && response.status && response.status >= 200 && response.status < 300),
            { timeout: e2eConfig.timeouts.upload },
          )
          .toBe(true)

        await expect(page.locator('[data-workflow-state]')).toHaveAttribute('data-workflow-state', /processing|ready/)
      })
    } finally {
      await attachSafeDiagnostic(testInfo, 'direct-upload-network', {
        videoId,
        jobId,
        apiOrigin: new URL(e2eConfig.apiUrl).origin,
        frontendOrigin: new URL(e2eConfig.frontendUrl).origin,
        upload: uploadRequest,
        responses: responses.map((response) => safeDiagnostic(response)),
      })
    }
  })
})

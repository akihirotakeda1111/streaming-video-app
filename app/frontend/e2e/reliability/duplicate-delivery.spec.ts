import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { assertReliabilityAuthorization } from '../config.js'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { withMp4Fixture } from '../fixtures.js'

const DUPLICATE_TAG = '@duplicate-delivery'
const STATUS = new Set(['UPLOADING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'])

function idFromResult(text: string, label: string): string {
  const match = text.match(new RegExp(`${label}\\s*[:#]?\\s*([0-9a-f-]{36})`, 'i'))
  if (!match) throw new Error(`upload result did not contain a ${label}`)
  return match[1]
}

async function status(request: APIRequestContext, apiUrl: string, videoId: string) {
  const response = await request.get(`${apiUrl}/api/v1/videos/${videoId}`)
  if (!response.ok()) throw new Error('job status observation failed')
  const body = await response.json() as Record<string, any>
  const value = body.job?.status ?? body.status
  if (typeof value !== 'string' || !STATUS.has(value)) throw new Error('job status observation was malformed')
  return { status: value, body }
}

function injectDuplicate(queue: string, event: string): void {
  const queueUrl = queue.startsWith('https://')
    ? queue
    : JSON.parse(execFileSync('aws', ['sqs', 'get-queue-url', '--queue-name', queue, '--output', 'json'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    })).QueueUrl
  if (typeof queueUrl !== 'string') throw new Error('source queue URL was not observable')
  execFileSync('aws', ['sqs', 'send-message', '--queue-url', queueUrl, '--message-body', event, '--output', 'json'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

test.describe(DUPLICATE_TAG, () => {
  test('keeps one owner across active-lease and completed duplicate delivery', async ({ page, request }, testInfo) => {
    // This is deliberately inside the scenario: direct Playwright selection must gate
    // all side effects, independently of the Python runner.
    const config = assertReliabilityAuthorization()
    const evidence: Record<string, unknown> = {
      scenario: 'duplicate-delivery',
      runId: process.env.E2E_RUN_ID,
      timestamps: [new Date().toISOString()],
      observations: [],
    }

    try {
      await withMp4Fixture(async (fixture) => {
        await page.goto('/')
        await page.locator('#video-file').setInputFiles(fixture.path)
        const createResponse = page.waitForResponse((response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/videos'),
        )
        await page.getByRole('button', { name: 'Upload video' }).click()
        const createBody = await (await createResponse).json() as Record<string, any>
        const result = page.locator('[aria-label="Video creation result"]')
        await expect(result).toBeVisible()
        const text = (await result.textContent()) ?? ''
        const videoId = idFromResult(text, 'Video')
        const jobId = idFromResult(text, 'Job')
        evidence.videoId = videoId
        evidence.jobId = jobId

        await expect.poll(async () => (await status(request, config.apiUrl, videoId)).status, {
          timeout: config.timeouts.lease,
        }).toBe('PROCESSING')

        // The documented SQS boundary accepts the standard S3 event shape. The
        // worker must correlate this with the already active canonical job.
        const sourceKey = createBody.upload?.key ??
          (typeof createBody.upload?.url === 'string' ? new URL(createBody.upload.url).pathname.replace(/^\/+/, '') : undefined)
        if (typeof sourceKey !== 'string' || !sourceKey) throw new Error('canonical source key was not observable')
        const event = JSON.stringify({ Records: [{ eventVersion: '2.1', eventSource: 'aws:s3', eventName: 'ObjectCreated:Put', s3: { bucket: { name: config.sourceBucket }, object: { key: encodeURIComponent(sourceKey).replace(/%20/g, '+') } } }] })
        injectDuplicate(config.sourceQueue, event)
        evidence.activeLease = { observed: true, at: new Date().toISOString() }

        await expect.poll(async () => (await status(request, config.apiUrl, videoId)).status, {
          timeout: config.timeouts.processing,
        }).toBe('COMPLETED')
        const completed = await status(request, config.apiUrl, videoId)
        expect(completed.body.job?.status ?? completed.body.status).toBe('COMPLETED')
        evidence.completed = { observed: true, at: new Date().toISOString() }

        injectDuplicate(config.sourceQueue, event)
        await expect.poll(async () => (await status(request, config.apiUrl, videoId)).status, {
          timeout: config.timeouts.dlq,
        }).toBe('COMPLETED')
      })
    } finally {
      await attachSafeDiagnostic(testInfo, 'duplicate-delivery-evidence', safeDiagnostic(evidence))
    }
  })
})

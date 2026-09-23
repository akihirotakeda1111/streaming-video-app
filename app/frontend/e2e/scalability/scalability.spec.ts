import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { e2eConfig } from '../config.js'

type Job = { videoId: string; jobId: string; status: string; createdAt: string }

function api(path: string): string {
  const base = new URL(e2eConfig.apiUrl)
  const prefix = base.pathname.replace(/\/$/, '').endsWith('/api/v1') ? '' : '/api/v1'
  return new URL(`${prefix}/${path.replace(/^\//, '')}`, base).toString()
}

async function submit(request: APIRequestContext, bytes: Buffer, index: number): Promise<Job> {
  const createdResponse = await request.post(api('videos'), {
    data: { fileName: `scalability-${index}.mp4`, contentType: 'video/mp4', sizeBytes: bytes.length },
  })
  expect(createdResponse.ok()).toBeTruthy()
  const created = await createdResponse.json() as { videoId: string; job: { jobId: string }; upload: { url: string; headers: Record<string, string> }; createdAt: string }
  const upload = await request.put(created.upload.url, { headers: created.upload.headers, data: bytes })
  expect(upload.ok()).toBeTruthy()
  return { videoId: created.videoId, jobId: created.job.jobId, status: 'UPLOADING', createdAt: created.createdAt }
}

async function waitForCompletion(request: APIRequestContext, job: Job, deadline: number): Promise<Job> {
  let status = job.status
  while (Date.now() < deadline) {
    const response = await request.get(api(`videos/${job.videoId}`))
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { job: { jobId: string; status: string; failure?: unknown } }
    status = body.job.status
    if (status === 'COMPLETED') return { ...job, jobId: body.job.jobId, status }
    if (status === 'FAILED') throw new Error(`job ${job.videoId} failed`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`job ${job.videoId} did not complete before the run deadline`)
}

async function playbackEvidence(page: Page, job: Job): Promise<Record<string, unknown>> {
  const playbackResponse = await page.request.get(api(`videos/${job.videoId}/playback`))
  expect(playbackResponse.ok()).toBeTruthy()
  const playback = await playbackResponse.json() as { manifestUrl: string; contentType: string; jobId: string }
  expect(playback.jobId).toBe(job.jobId)
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(process.env.PLAYBACK_BASE_URL ?? '')) requests.push(new URL(request.url()).pathname)
  })
  await page.goto(e2eConfig.frontendUrl)
  await page.evaluate((source) => {
    const video = document.createElement('video')
    video.controls = true
    video.src = source
    document.body.appendChild(video)
    void video.play().catch(() => undefined)
  }, playback.manifestUrl)
  await page.waitForTimeout(3000)
  const media = await page.locator('video').evaluate((element) => {
    const video = element as HTMLVideoElement
    return { readyState: video.readyState, currentTime: video.currentTime, duration: video.duration }
  })
  expect(media.readyState).toBeGreaterThan(0)
  expect(media.currentTime).toBeGreaterThan(0)
  expect(requests.some((path) => path.endsWith('.m3u8'))).toBeTruthy()
  expect(requests.some((path) => /\.(ts|m4s|mp4)$/.test(path))).toBeTruthy()
  return { manifestUrl: new URL(playback.manifestUrl).origin + new URL(playback.manifestUrl).pathname, requests, media }
}

test.describe('@scalability', () => {
  test('runs one fixed distributed batch through publication and playback', async ({ request, page }, testInfo) => {
    const fixturePath = process.env.SCALABILITY_FIXTURE_PATH
    const batchSize = Number(process.env.SCALABILITY_BATCH_SIZE)
    const budget = Number(process.env.SCALABILITY_RUNTIME_BUDGET_SECONDS ?? 1800)
    if (!fixturePath || !Number.isInteger(batchSize) || batchSize < 1 || !Number.isFinite(budget)) {
      throw new Error('scalability runner did not provide fixed workload settings')
    }
    const bytes = await readFile(fixturePath)
    const startedAt = new Date().toISOString()
    const jobs = await Promise.all(Array.from({ length: batchSize }, (_, index) => submit(request, bytes, index)))
    const completed = await Promise.all(jobs.map((job) => waitForCompletion(request, job, Date.now() + budget * 1000)))
    const playback = await playbackEvidence(page, completed[0]!)
    const evidence = { scenario: 'scalability', status: 'passed', startedAt, observedAt: new Date().toISOString(),
      batchSize, jobs: completed, playback, note: 'Scaling and child-overlap observations are supplied by the runner environment contract.' }
    const destination = process.env.SCALABILITY_EVIDENCE_DIR
    if (!destination) throw new Error('SCALABILITY_EVIDENCE_DIR is required')
    await writeFile(`${destination}/workload.json`, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
    await testInfo.attach('scalability-workload', { body: JSON.stringify(evidence), contentType: 'application/json' })
  })
})

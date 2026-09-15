import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test, expect, type Response } from '@playwright/test'
import { normalizePlaybackBaseURL } from '../../scripts/generate_reliability_env.mjs'
import { e2eConfig } from './config.js'
import { parseLegacyDeliveryFixtures } from './delivery-fixtures.js'
import { persistPlaybackEvidence } from './playback-evidence.js'

function objectETag(key: string): string {
  const bucket = process.env.E2E_OUTPUT_BUCKET?.trim()
  const region = process.env.AWS_REGION?.trim()
  if (!bucket || !region) throw new Error('dedicated E2E output inspection is not configured')
  const raw = execFileSync('aws', [
    's3api', 'head-object', '--bucket', bucket, '--key', key,
    '--region', region, '--output', 'json',
  ], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
  })
  return (JSON.parse(raw) as { ETag: string }).ETag
}

test.describe('@delivery-regression', () => {
  test('plays pre-cutover Phase 1 and Phase 2 jobs using their real playback API', async ({ page, request }) => {
    const inventoryPath = process.env.E2E_LEGACY_DELIVERY_FIXTURES?.trim()
    if (!inventoryPath) throw new Error('E2E_LEGACY_DELIVERY_FIXTURES must name a pre-cutover inventory JSON file')
    const inventory = parseLegacyDeliveryFixtures(await readFile(inventoryPath, 'utf8'))
    const origin = normalizePlaybackBaseURL(process.env.PLAYBACK_BASE_URL ?? '')
    const frontendOrigin = new URL(e2eConfig.frontendUrl).origin
    const api = e2eConfig.apiUrl.replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1'
    const checked: { videoId: string; jobId: string; phase: string; path: string; advancement: number }[] = []
    let passed = false
    try {
      for (const job of inventory.jobs) {
        expect(objectETag(job.manifestKey)).toBe(job.manifestETag)
        const statusResponse = await request.get(`${api}/videos/${job.videoId}`)
        expect(statusResponse.status()).toBe(200)
        const status = await statusResponse.json()
        expect(status.videoId).toBe(job.videoId)
        expect(status.job.jobId).toBe(job.jobId)
        expect(status.job.status).toBe('COMPLETED')
        expect(Date.parse(status.updatedAt)).toBeLessThanOrEqual(Date.parse(inventory.capturedAt))

        await page.goto(e2eConfig.frontendUrl)
        // No existing-job route exists in the app. Mount its installed video.js
        // on the real frontend origin; all API and media requests remain live.
        await page.addScriptTag({ path: createRequire(import.meta.url).resolve('video.js/dist/video.min.js') })
        const playback = await page.evaluate(async url => {
          const response = await fetch(url)
          if (!response.ok) throw new Error('Legacy playback API failed')
          return response.json()
        }, `${api}/videos/${job.videoId}/playback`)
        expect(playback).toMatchObject({ videoId: job.videoId, jobId: job.jobId,
          protocol: 'HLS', contentType: 'application/vnd.apple.mpegurl', manifestUrl: `${origin}/${job.manifestKey}` })

        const media: { origin: string; path: string; status: number }[] = []
        const observe = (response: Response) => {
          const url = new URL(response.url())
          if (/\.(m3u8|ts)$/.test(url.pathname)) media.push({ origin: url.origin, path: url.pathname, status: response.status() })
        }
        page.on('response', observe)
        try {
          await page.evaluate(manifestUrl => {
            const video = document.createElement('video')
            video.id = 'legacy-delivery-player'
            video.muted = true
            document.body.append(video)
            const win = window as unknown as { videojs: (element: HTMLVideoElement, options: unknown) => unknown }
            win.videojs(video, { autoplay: true, muted: true, sources: [{ src: manifestUrl, type: 'application/vnd.apple.mpegurl' }] })
          }, playback.manifestUrl)
          const video = page.locator('video#legacy-delivery-player_html5_api')
          await expect(video).toHaveCount(1)
          const initial = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
          await expect.poll(() => video.evaluate((element: HTMLVideoElement) => {
            if (element.error) throw new Error('Legacy browser media error')
            return element.currentTime
          }), { timeout: e2eConfig.timeouts.playback }).toBeGreaterThan(initial + 0.05)
          const current = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
          expect(media.some(item => item.path.endsWith('.m3u8') && item.status === 200)).toBe(true)
          expect(media.some(item => item.path.endsWith('.ts') && item.status === 200)).toBe(true)
          expect(media.every(item => item.origin === origin && item.status >= 200 && item.status < 300)).toBe(true)
          const manifest = await request.get(playback.manifestUrl, { headers: { Origin: frontendOrigin } })
          expect(manifest.status()).toBe(200)
          expect(manifest.headers()['content-type']?.split(';', 1)[0]).toBe('application/vnd.apple.mpegurl')
          expect(manifest.headers()['access-control-allow-origin']).toBe(frontendOrigin)
          for (const reference of (await manifest.text()).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))) {
            expect(reference).toMatch(/^segment-\d{5}\.ts$/)
            const segment = await request.get(new URL(reference, playback.manifestUrl).href)
            expect(segment.status()).toBe(200)
            expect(segment.headers()['content-type']?.split(';', 1)[0]).toBe('video/mp2t')
          }
          expect(objectETag(job.manifestKey)).toBe(job.manifestETag)
          checked.push({ videoId: job.videoId, jobId: job.jobId, phase: job.phase,
            path: `/${job.manifestKey}`, advancement: current - initial })
        } finally {
          page.off('response', observe)
        }
      }
      passed = true
    } finally {
      await persistPlaybackEvidence({ 'cloudfront-completed-replay': { checked,
        capturedAt: inventory.capturedAt, cutoverAt: inventory.cutoverAt } }, passed, process.env, 'delivery-regression')
    }
  })
})

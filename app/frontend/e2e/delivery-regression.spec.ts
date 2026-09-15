import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { normalizePlaybackBaseURL } from '../../scripts/generate_reliability_env.mjs'
import { e2eConfig } from './config.js'
import { persistPlaybackEvidence } from './playback-evidence.js'

interface ListedObjects { Contents?: { Key?: string }[]; IsTruncated?: boolean }

function completedManifestKeys(): string[] {
  const bucket = process.env.E2E_OUTPUT_BUCKET?.trim()
  const region = process.env.AWS_REGION?.trim()
  if (!bucket || !region) throw new Error('dedicated E2E output inspection is not configured')
  const raw = execFileSync('aws', [
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'videos/',
    '--region', region, '--output', 'json',
  ], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
  })
  const listed = JSON.parse(raw || '{}') as ListedObjects
  if (listed.IsTruncated) throw new Error('output inspection must be complete and bounded')
  return (listed.Contents ?? []).map(({ Key }) => Key)
    .filter((key): key is string => Boolean(key?.match(/^videos\/[^/]+\/jobs\/[^/]+\/hls\/index\.m3u8$/)))
}

test.describe('@delivery-regression', () => {
  test('replays completed HLS objects through CloudFront without moving them', async ({ request }) => {
    const origin = normalizePlaybackBaseURL(process.env.PLAYBACK_BASE_URL ?? '')
    const frontendOrigin = new URL(e2eConfig.frontendUrl).origin
    const keysBefore = completedManifestKeys()
    expect(keysBefore.length, 'at least one previously completed manifest is required').toBeGreaterThan(0)

    const checked: { path: string; status: number; segmentStatus: number }[] = []
    for (const key of keysBefore.slice(-3)) {
      const manifest = await request.get(`${origin}/${key}`, { headers: { Origin: frontendOrigin } })
      expect(manifest.status()).toBe(200)
      expect(manifest.headers()['content-type']?.split(';', 1)[0]).toBe('application/vnd.apple.mpegurl')
      expect(manifest.headers()['access-control-allow-origin']).toBe(frontendOrigin)
      const reference = (await manifest.text()).split(/\r?\n/)
        .map((line) => line.trim()).find((line) => line && !line.startsWith('#'))
      expect(reference).toMatch(/^segment-\d{5}\.ts$/)
      const segment = await request.get(new URL(reference!, manifest.url()).href, {
        headers: { Origin: frontendOrigin },
      })
      expect(segment.status()).toBe(200)
      expect(segment.headers()['content-type']?.split(';', 1)[0]).toBe('video/mp2t')
      checked.push({ path: `/${key}`, status: manifest.status(), segmentStatus: segment.status() })
    }

    expect(completedManifestKeys()).toEqual(keysBefore)
    await persistPlaybackEvidence({ 'cloudfront-completed-replay': { checked } }, true, process.env, 'delivery-regression')
  })
})

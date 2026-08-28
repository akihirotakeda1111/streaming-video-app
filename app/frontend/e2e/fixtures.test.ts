import { access } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { generateMp4Fixture } from './fixtures'
import { redactText, redactUrl, safeDiagnostic } from './diagnostics'

describe('E2E fixtures and diagnostics', () => {
  it('generates and cleans up a video/mp4 fixture', async () => {
    const fixture = await generateMp4Fixture()
    expect(fixture.contentType).toBe('video/mp4')
    expect(fixture.sizeBytes).toBeGreaterThan(0)
    await access(fixture.path)
    await fixture.cleanup()
    await expect(access(fixture.path)).rejects.toThrow()
  })

  it('redacts presigned URLs and credential-like values but keeps IDs', () => {
    const text = redactText('videoId=video-123 url=https://s3.example/video.mp4?X-Amz-Signature=abc&token=secret Authorization: Bearer abc')
    expect(text).toContain('video-123')
    expect(text).not.toContain('X-Amz-Signature')
    expect(text).not.toContain('secret')
    expect(text).toContain('[REDACTED]')
    expect(redactUrl('https://api.example/videos/123?token=secret')).toBe('https://api.example/videos/123')
    expect(safeDiagnostic({ origin: 'https://api.example', path: '/videos/123', status: 201, jobId: 'job-1' })).toEqual(
      expect.objectContaining({ origin: 'https://api.example', path: '/videos/123', status: 201, jobId: 'job-1' }),
    )
  })
})

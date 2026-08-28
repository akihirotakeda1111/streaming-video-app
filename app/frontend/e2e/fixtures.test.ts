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

  it('redacts recognized credential fields unconditionally', () => {
    expect(safeDiagnostic({ accessToken: 'supersecret', password: 'hunter2' })).toEqual({
      accessToken: '[REDACTED]',
      password: '[REDACTED]',
    })
  })

  it('redacts malformed URL-like text without recursing', () => {
    expect(() => redactText('https://%')).not.toThrow()
    expect(() => redactUrl('https://?token=secret')).not.toThrow()
    expect(redactText('failed https://?token=secret')).toBe('failed [REDACTED]')
    expect(redactUrl('https://%')).toBe('[REDACTED]')
  })

  it('redacts quoted secrets including spaces', () => {
    const text = redactText('password="first second" secret=\'a b\'')
    expect(text).toBe('password="[REDACTED]" secret=\'[REDACTED]\'')
    expect(text).not.toContain('first')
    expect(text).not.toContain('second')
  })

  it('redacts nested credential values before serialization', () => {
    const diagnostic = safeDiagnostic({
      request: { headers: { authorization: 'Bearer abc' } },
      uploadUrl: 'https://s3.example/video.mp4?X-Amz-Signature=abc',
    })
    expect(diagnostic).toEqual({
      request: { headers: { authorization: '[REDACTED]' } },
      uploadUrl: 'https://s3.example/video.mp4',
    })
  })

  it('redacts complete cookie header values', () => {
    expect(
      safeDiagnostic({
        request: { headers: { cookie: 'session=abc', 'set-cookie': 'session=abc' } },
      }),
    ).toEqual({
      request: { headers: { cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' } },
    })
    expect(redactText('Cookie: session=abc')).toBe('Cookie: [REDACTED]')
    expect(redactText('Set-Cookie: session=abc')).toBe('Set-Cookie: [REDACTED]')
  })

  it('redacts complete non-Bearer authorization values', () => {
    expect(redactText('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: [REDACTED]')
    expect(redactText('Proxy-Authorization: Basic dXNlcjpwYXNz')).toBe('Proxy-Authorization: [REDACTED]')
  })

  it('strips query strings from preserved origin and path', () => {
    expect(safeDiagnostic({ origin: 'https://api.example?token=secret', path: '/videos/123?token=secret' })).toEqual({
      origin: 'https://api.example',
      path: '/videos/123',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { remainingPlaybackTimeout } from './playback.js'
import { apiUrl, classifyPlaybackPath, isPlaybackMediaRequest, presignedUploadBucket, renditionToken, summarizePlayback } from './urls.js'

describe('scalability API URLs', () => {
  it('keeps a configured /api/v1 prefix', () => {
    expect(apiUrl('https://api.example.com/api/v1', 'videos')).toBe('https://api.example.com/api/v1/videos')
    expect(apiUrl('https://api.example.com/api/v1/', '/videos/abc/playback')).toBe('https://api.example.com/api/v1/videos/abc/playback')
  })

  it('adds /api/v1 when the base has no API prefix', () => {
    expect(apiUrl('https://api.example.com', 'videos')).toBe('https://api.example.com/api/v1/videos')
    expect(apiUrl('https://api.example.com/', 'videos/abc')).toBe('https://api.example.com/api/v1/videos/abc')
  })
})

describe('presigned upload buckets', () => {
  it('reads virtual-hosted and path-style buckets and rejects other hosts', () => {
    expect(presignedUploadBucket('https://sv-scale-e2e-test.s3.us-east-1.amazonaws.com/videos/v/jobs/j/source.mp4?X-Amz-Signature=secret')).toBe('sv-scale-e2e-test')
    expect(presignedUploadBucket('https://s3.us-east-1.amazonaws.com/sv-scale-e2e-test/videos/v/jobs/j/source.mp4?X-Amz-Signature=secret')).toBe('sv-scale-e2e-test')
    expect(presignedUploadBucket('https://sv-scale-e2e-test.s3.amazonaws.com/key')).toBe('sv-scale-e2e-test')
    expect(presignedUploadBucket('https://my.bucket.s3.dualstack.us-east-1.amazonaws.com/key')).toBe('my.bucket')
    expect(presignedUploadBucket('https://evil.example.com/sv-scale-e2e-test/key')).toBeUndefined()
  })
})

describe('runtime budget playback cap', () => {
  it('limits playback to the time remaining before the absolute deadline', () => {
    expect(remainingPlaybackTimeout(120_000, 10_000, 4_000)).toBe(6_000)
    expect(remainingPlaybackTimeout(5_000, 10_000, 4_000)).toBe(5_000)
    expect(remainingPlaybackTimeout(120_000, 10_000, 10_000)).toBe(0)
    expect(remainingPlaybackTimeout(120_000, 10_000, 11_000)).toBe(0)
  })
})

describe('rendition identity', () => {
  it('uses playlist and representation paths instead of encoded height', () => {
    expect(renditionToken({ id: 'https://cdn.example.com/videos/j/hls/360p/index.m3u8', height: 640 })).toBe('360p')
    expect(renditionToken({ playlist: { uri: '720p/index.m3u8' }, height: 1280 })).toBe('720p')
    expect(renditionToken({ height: 360, id: '0' })).toBeUndefined()
    expect(renditionToken({ attributes: { NAME: '360p' }, height: 480 })).toBe('360p')
  })
})

describe('CloudFront playback requests', () => {
  const base = 'https://cdn.example.com'

  it('requires the playback origin and a media path prefix', () => {
    expect(isPlaybackMediaRequest('https://cdn.example.com/videos/job/index.m3u8', base)).toBe(true)
    expect(isPlaybackMediaRequest('https://cdn.example.com/videos/job/360p/segment-00001.ts', base)).toBe(true)
    expect(isPlaybackMediaRequest('https://cdn.example.com.evil.test/videos/job/index.m3u8', base)).toBe(false)
    expect(isPlaybackMediaRequest('https://cdn.example.com/videos-evil/index.m3u8', base)).toBe(false)
    expect(isPlaybackMediaRequest('https://cdn.example.com/favicon.ico', base)).toBe(false)
    expect(isPlaybackMediaRequest('https://other.example.com/videos/job/index.m3u8', base)).toBe(false)
  })

  it('uses a configured path prefix instead of every same-origin path', () => {
    const prefixed = 'https://cdn.example.com/videos'
    expect(isPlaybackMediaRequest('https://cdn.example.com/videos/job/720p/index.m3u8', prefixed)).toBe(true)
    expect(isPlaybackMediaRequest('https://cdn.example.com/other/index.m3u8', prefixed)).toBe(false)
  })

  it('classifies master, rendition playlists, and segments', () => {
    const manifest = '/videos/job/hls/index.m3u8'
    const summary = summarizePlayback([
      manifest,
      '/videos/job/hls/360p/index.m3u8',
      '/videos/job/hls/720p/index.m3u8',
      '/videos/job/hls/360p/segment-00001.ts',
      '/videos/job/hls/720p/segment-00001.m4s',
    ], manifest)
    expect(summary).toEqual({
      master: true,
      playlist360: true,
      playlist720: true,
      segment360: true,
      segment720: true,
    })
    expect(classifyPlaybackPath('/videos/job/hls/360p/index.m3u8', manifest).master).toBe(false)
  })
})

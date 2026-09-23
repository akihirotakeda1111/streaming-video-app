import { describe, expect, it } from 'vitest'
import { apiUrl, classifyPlaybackPath, isPlaybackMediaRequest, summarizePlayback } from './urls.js'

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

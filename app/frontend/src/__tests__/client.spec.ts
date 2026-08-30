import { describe, expect, it, vi } from 'vitest'

import { ContractError, NetworkError, createVideoApiClient, type Fetcher } from '../api/client'
import type { CreateVideoRequest } from '../api/contracts'

const videoId = '018f47a2-45c2-7a84-b84f-5f6dd7b5910a'
const jobId = '018f47a2-4699-7892-9fc0-fbe46d3bbd67'

const createRequest: CreateVideoRequest = { fileName: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 10 }

const createResponse = {
  videoId,
  job: { jobId, status: 'UPLOADING', failure: null },
  upload: {
    method: 'PUT',
    url: 'https://upload.example/source.mp4',
    headers: { 'Content-Type': 'video/mp4' },
    expiresAt: '2026-08-25T03:15:00Z',
    object: { bucket: 'input-bucket', key: `videos/${videoId}/jobs/${jobId}/source.mp4` },
  },
  createdAt: '2026-08-25T03:00:00Z',
}

const videoResponse = {
  videoId,
  fileName: 'movie.mp4',
  contentType: 'video/mp4',
  sizeBytes: 10,
  job: { jobId, status: 'COMPLETED', failure: null },
  createdAt: '2026-08-25T03:00:00Z',
  updatedAt: '2026-08-25T03:01:00Z',
}

const playbackResponse = {
  videoId,
  jobId,
  protocol: 'HLS',
  manifestUrl: 'https://cdn.example/index.m3u8',
  contentType: 'application/vnd.apple.mpegurl',
}

function mockFetcher() {
  return vi.fn<Fetcher>()
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('video API client', () => {
  it('constructs configured URLs and parses successful responses', async () => {
    const fetcher = mockFetcher().mockResolvedValue(response(createResponse, 201))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)

    const result = await client.createVideo(createRequest)

    expect(result).toEqual(createResponse)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.example/api/v1/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createRequest),
    })
  })

  it('gets a video with GET and parses the response', async () => {
    const fetcher = mockFetcher().mockResolvedValue(response(videoResponse))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)

    await expect(client.getVideo(videoId)).resolves.toEqual(videoResponse)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://api.example/api/v1/videos/${videoId}`, {
      method: 'GET',
    })
  })

  it('gets playback with GET and parses the response', async () => {
    const fetcher = mockFetcher().mockResolvedValue(response(playbackResponse))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)

    await expect(client.getPlayback(videoId)).resolves.toEqual(playbackResponse)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `https://api.example/api/v1/videos/${videoId}/playback`,
      { method: 'GET' },
    )
  })

  it('turns contract errors into ApiError', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      mockFetcher().mockResolvedValue(response({ code: 'VIDEO_NOT_READY', message: 'Still processing.' }, 409)),
    )

    await expect(client.getPlayback(videoId)).rejects.toEqual(
      expect.objectContaining({ name: 'ApiError', status: 409, code: 'VIDEO_NOT_READY' }),
    )
  })

  it('rejects malformed successful payloads', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      mockFetcher().mockResolvedValue(
        response({ ...createResponse, job: { ...createResponse.job, status: 'UNKNOWN' } }, 201),
      ),
    )

    await expect(client.createVideo(createRequest)).rejects.toBeInstanceOf(ContractError)
  })

  it('preserves ApiError status for non-JSON HTTP failures', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      mockFetcher().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 })),
    )

    await expect(client.getVideo(videoId)).rejects.toEqual(
      expect.objectContaining({ name: 'ApiError', status: 502 }),
    )
  })

  it('turns fetch failures into NetworkError', async () => {
    const fetcher = mockFetcher().mockRejectedValue(new TypeError('Failed to fetch'))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)

    await expect(client.createVideo(createRequest)).rejects.toEqual(
      expect.objectContaining({ name: 'NetworkError', message: 'Failed to fetch' }),
    )
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('turns body-read failures into NetworkError', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      mockFetcher().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError('Failed to fetch')),
      } as Response),
    )

    await expect(client.getVideo(videoId)).rejects.toBeInstanceOf(NetworkError)
  })

  it('rejects date-only timestamps', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      mockFetcher().mockResolvedValue(response({ ...createResponse, createdAt: '2026-08-25' }, 201)),
    )

    await expect(client.createVideo(createRequest)).rejects.toBeInstanceOf(ContractError)
  })

  it('uploads the file with the injected fetcher and returned request', async () => {
    const file = new File(['video'], 'movie.mp4', { type: 'video/mp4' })
    const fetcher = mockFetcher()
      .mockResolvedValueOnce(response(createResponse, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)
    const created = await client.createVideo(createRequest)

    await client.uploadFile(file, created)

    expect(fetcher).toHaveBeenNthCalledWith(2, created.upload.url, {
      method: created.upload.method,
      headers: created.upload.headers,
      body: file,
    })
  })

  it('turns unsuccessful uploads into ApiError without calling the API origin', async () => {
    const file = new File(['video'], 'movie.mp4', { type: 'video/mp4' })
    const fetcher = mockFetcher()
      .mockResolvedValueOnce(response(createResponse, 201))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)
    const created = await client.createVideo(createRequest)

    await expect(client.uploadFile(file, created)).rejects.toEqual(
      expect.objectContaining({ name: 'ApiError', status: 403 }),
    )
    expect(fetcher.mock.calls[1]?.[0]).toBe(created.upload.url)
  })

  it('rejects timezone-less timestamps', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      mockFetcher().mockResolvedValue(
        response({ ...createResponse, upload: { ...createResponse.upload, expiresAt: '2026-08-25T03:15:00' } }, 201),
      ),
    )

    await expect(client.createVideo(createRequest)).rejects.toBeInstanceOf(ContractError)
  })
})

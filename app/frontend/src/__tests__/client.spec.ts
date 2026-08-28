import { describe, expect, it, vi } from 'vitest'

import { ContractError, NetworkError, createVideoApiClient } from '../api/client'

const videoId = '018f47a2-45c2-7a84-b84f-5f6dd7b5910a'
const jobId = '018f47a2-4699-7892-9fc0-fbe46d3bbd67'

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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('video API client', () => {
  it('constructs configured URLs and parses successful responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(createResponse, 201))
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example/api/v1' }, fetcher)

    const result = await client.createVideo({ fileName: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 10 })

    expect(result.videoId).toBe(videoId)
    expect(fetcher).toHaveBeenCalledWith('https://api.example/api/v1/videos', expect.objectContaining({ method: 'POST' }))
  })

  it('turns contract errors into ApiError', async () => {
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example' }, vi.fn().mockResolvedValue(
      response({ code: 'VIDEO_NOT_READY', message: 'Still processing.' }, 409),
    ))

    await expect(client.getPlayback(videoId)).rejects.toEqual(
      expect.objectContaining({ name: 'ApiError', status: 409, code: 'VIDEO_NOT_READY' }),
    )
  })

  it('rejects malformed successful payloads', async () => {
    const client = createVideoApiClient({ apiBaseUrl: 'https://api.example' }, vi.fn().mockResolvedValue(
      response({ ...createResponse, job: { ...createResponse.job, status: 'UNKNOWN' } }, 201),
    ))

    await expect(client.createVideo({ fileName: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 10 })).rejects.toBeInstanceOf(ContractError)
  })

  it('preserves ApiError status for non-JSON HTTP failures', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 })),
    )

    await expect(client.getVideo(videoId)).rejects.toEqual(
      expect.objectContaining({ name: 'ApiError', status: 502 }),
    )
  })

  it('turns body-read failures into NetworkError', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      vi.fn().mockResolvedValue({
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
      vi.fn().mockResolvedValue(response({ ...createResponse, createdAt: '2026-08-25' }, 201)),
    )

    await expect(
      client.createVideo({ fileName: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(ContractError)
  })

  it('rejects timezone-less timestamps', async () => {
    const client = createVideoApiClient(
      { apiBaseUrl: 'https://api.example' },
      vi.fn().mockResolvedValue(
        response({ ...createResponse, upload: { ...createResponse.upload, expiresAt: '2026-08-25T03:15:00' } }, 201),
      ),
    )

    await expect(
      client.createVideo({ fileName: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(ContractError)
  })
})

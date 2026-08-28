import { runtimeConfig, type RuntimeConfig } from '../config/runtime'
import {
  VIDEO_STATUSES,
  type CreateVideoRequest,
  type CreateVideoResponse,
  type ErrorResponse,
  type Job,
  type PlaybackResponse,
  type VideoResponse,
} from './contracts'

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'api' | 'contract',
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

export class ApiError extends ApiClientError {
  constructor(message: string, status: number, code?: string) {
    super(message, 'api', status, code)
    this.name = 'ApiError'
  }
}

export class ContractError extends ApiClientError {
  constructor(message: string) {
    super(message, 'contract')
    this.name = 'ContractError'
  }
}

export class NetworkError extends ApiClientError {
  constructor(message: string) {
    super(message, 'network')
    this.name = 'NetworkError'
  }
}

export interface VideoApiClient {
  createVideo(request: CreateVideoRequest): Promise<CreateVideoResponse>
  uploadFile(file: File, response: CreateVideoResponse): Promise<void>
  getVideo(videoId: string): Promise<VideoResponse>
  getVideoStatus(videoId: string): Promise<VideoResponse>
  getPlayback(videoId: string): Promise<PlaybackResponse>
}

export async function uploadFileToPresignedRequest(
  file: File,
  response: CreateVideoResponse,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): Promise<void> {
  let result: Response
  try {
    result = await fetcher(response.upload.url, {
      method: response.upload.method,
      headers: response.upload.headers,
      body: file,
    })
  } catch (error) {
    throw asNetworkError(error)
  }
  if (!result.ok) {
    throw new ApiError(`Upload failed with status ${result.status}`, result.status)
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sourceKeyPattern =
  /^videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/source\.mp4$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ContractError(`Invalid ${field}`)
  return value
}

function uuid(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!uuidPattern.test(result)) throw new ContractError(`Invalid ${field}`)
  return result
}

const rfc3339DateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function dateTime(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!rfc3339DateTimePattern.test(result) || Number.isNaN(Date.parse(result))) {
    throw new ContractError(`Invalid ${field}`)
  }
  return result
}

function uri(value: unknown, field: string): string {
  const result = requiredString(value, field)
  try {
    new URL(result)
  } catch {
    throw new ContractError(`Invalid ${field}`)
  }
  return result
}

function parseJob(value: unknown): Job {
  if (!isRecord(value)) throw new ContractError('Invalid job')
  const status = value.status
  if (typeof status !== 'string' || !VIDEO_STATUSES.includes(status as (typeof VIDEO_STATUSES)[number])) {
    throw new ContractError('Invalid job.status')
  }
  const failure = value.failure
  if (failure !== undefined && failure !== null) {
    if (!isRecord(failure)) throw new ContractError('Invalid job.failure')
    if (status !== 'FAILED') throw new ContractError('Invalid job.failure')
    return {
      jobId: uuid(value.jobId, 'job.jobId'),
      status: status as (typeof VIDEO_STATUSES)[number],
      failure: {
        code: requiredString(failure.code, 'job.failure.code'),
        message: requiredString(failure.message, 'job.failure.message'),
      },
    }
  }
  if (status === 'FAILED') throw new ContractError('Invalid job.failure')
  return { jobId: uuid(value.jobId, 'job.jobId'), status: status as (typeof VIDEO_STATUSES)[number], failure: failure ?? null }
}

function parseCreateVideoResponse(value: unknown): CreateVideoResponse {
  if (!isRecord(value) || !isRecord(value.upload)) throw new ContractError('Invalid create-video response')
  const upload = value.upload
  if (upload.method !== 'PUT' || !isRecord(upload.object) || !isRecord(upload.headers)) {
    throw new ContractError('Invalid upload')
  }
  const objectKey = requiredString(upload.object.key, 'upload.object.key')
  const headers = Object.fromEntries(
    Object.entries(upload.headers).map(([key, item]) => [key, requiredString(item, `upload.headers.${key}`)]),
  )
  if (headers['Content-Type'] !== 'video/mp4') throw new ContractError('Invalid upload.headers.Content-Type')
  if (!sourceKeyPattern.test(objectKey)) {
    throw new ContractError('Invalid upload.object.key')
  }
  return {
    videoId: uuid(value.videoId, 'videoId'),
    job: parseJob(value.job),
    upload: {
      method: 'PUT',
      url: uri(upload.url, 'upload.url'),
      headers,
      expiresAt: dateTime(upload.expiresAt, 'upload.expiresAt'),
      object: { bucket: requiredString(upload.object.bucket, 'upload.object.bucket'), key: objectKey },
    },
    createdAt: dateTime(value.createdAt, 'createdAt'),
  }
}

function parseVideoResponse(value: unknown): VideoResponse {
  if (!isRecord(value)) throw new ContractError('Invalid video response')
  const sizeBytes = value.sizeBytes
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw new ContractError('Invalid sizeBytes')
  }
  return {
    videoId: uuid(value.videoId, 'videoId'),
    fileName: requiredString(value.fileName, 'fileName'),
    contentType: value.contentType === 'video/mp4' ? value.contentType : invalidContentType(),
    sizeBytes,
    job: parseJob(value.job),
    createdAt: dateTime(value.createdAt, 'createdAt'),
    updatedAt: dateTime(value.updatedAt, 'updatedAt'),
  }
}

function invalidContentType(): never {
  throw new ContractError('Invalid contentType')
}

function parsePlaybackResponse(value: unknown): PlaybackResponse {
  if (!isRecord(value) || value.protocol !== 'HLS' || value.contentType !== 'application/vnd.apple.mpegurl') {
    throw new ContractError('Invalid playback response')
  }
  return {
    videoId: uuid(value.videoId, 'videoId'),
    jobId: uuid(value.jobId, 'jobId'),
    protocol: 'HLS',
    manifestUrl: uri(value.manifestUrl, 'manifestUrl'),
    contentType: 'application/vnd.apple.mpegurl',
  }
}

function asNetworkError(error: unknown): NetworkError {
  return new NetworkError(error instanceof Error ? error.message : 'Network request failed')
}

async function readBody(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw asNetworkError(error)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    if (!response.ok) {
      throw new ApiError(`Request failed with status ${response.status}`, response.status)
    }
    throw new ContractError('Response body is not valid JSON')
  }
}

function parseError(value: unknown): ErrorResponse | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || !value.code || typeof value.message !== 'string' || !value.message) {
    return undefined
  }
  return { code: value.code, message: value.message }
}

export function createVideoApiClient(
  config: RuntimeConfig = runtimeConfig,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): VideoApiClient {
  const baseUrl = config.apiBaseUrl.trim()
  if (!baseUrl) throw new Error('VITE_API_BASE_URL is required')
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const endpoint = (path: string) => new URL(path.replace(/^\//, ''), base).toString()

  async function request<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
    let response: Response
    try {
      response = await fetcher(endpoint(path), init)
    } catch (error) {
      throw asNetworkError(error)
    }
    const body = await readBody(response)
    if (!response.ok) {
      const error = parseError(body)
      throw new ApiError(error?.message ?? `Request failed with status ${response.status}`, response.status, error?.code)
    }
    return parse(body)
  }

  return {
    createVideo: (requestBody) => request('/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }, parseCreateVideoResponse),
    uploadFile: (file, response) => uploadFileToPresignedRequest(file, response, fetcher),
    getVideo: (videoId) => request(`/videos/${encodeURIComponent(videoId)}`, { method: 'GET' }, parseVideoResponse),
    getVideoStatus: (videoId) => request(`/videos/${encodeURIComponent(videoId)}`, { method: 'GET' }, parseVideoResponse),
    getPlayback: (videoId) => request(`/videos/${encodeURIComponent(videoId)}/playback`, { method: 'GET' }, parsePlaybackResponse),
  }
}

export const createApiClient = createVideoApiClient

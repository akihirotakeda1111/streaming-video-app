export const VIDEO_STATUSES = ['UPLOADING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const

export type VideoStatus = (typeof VIDEO_STATUSES)[number]
export type JobStatus = VideoStatus

export interface CreateVideoRequest {
  fileName: string
  contentType: 'video/mp4'
  sizeBytes: number
}

export interface JobFailure {
  code: string
  message: string
}

export interface Job {
  jobId: string
  status: VideoStatus
  failure?: JobFailure | null
}

export interface StorageObject {
  bucket: string
  key: string
}

export interface PresignedUpload {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: string
  object: StorageObject
}

export interface CreateVideoResponse {
  videoId: string
  job: Job
  upload: PresignedUpload
  createdAt: string
}

export interface VideoResponse {
  videoId: string
  fileName: string
  contentType: 'video/mp4'
  sizeBytes: number
  job: Job
  createdAt: string
  updatedAt: string
}

export interface PlaybackResponse {
  videoId: string
  jobId: string
  protocol: 'HLS'
  manifestUrl: string
  contentType: 'application/vnd.apple.mpegurl'
}

export interface ErrorResponse {
  code: string
  message: string
}

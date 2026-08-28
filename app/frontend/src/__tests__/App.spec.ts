import { describe, it, expect, vi, afterEach } from 'vitest'

import { flushPromises, mount } from '@vue/test-utils'

import App from '../App.vue'
import type { WorkflowActions } from '../App.vue'
import { ApiError } from '../api/client'
import type { CreateVideoRequest, CreateVideoResponse, PlaybackResponse, VideoResponse } from '../api/contracts'

type PlayerMock = {
  dispose: ReturnType<typeof vi.fn<() => void>>
  error: ReturnType<typeof vi.fn<() => { message: string } | null>>
  on: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>
}

const videojsMock = vi.hoisted(() => {
  const createPlayer = (): PlayerMock => ({
    dispose: vi.fn<() => void>(),
    error: vi.fn<() => { message: string } | null>(() => null),
    on: vi.fn<(event: string, handler: () => void) => void>(),
  })
  return vi.fn<(element: HTMLVideoElement, options?: unknown) => PlayerMock>(createPlayer)
})
vi.mock('video.js', () => ({ default: videojsMock }))

const videoId = '018f47a2-45c2-7a84-b84f-5f6dd7b5910a'
const jobId = '018f47a2-4699-7892-9fc0-fbe46d3bbd67'

function mp4(name = 'movie.mp4', contents = 'video'): File {
  return new File([contents], name, { type: 'video/mp4' })
}

async function chooseFiles(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = wrapper.get('#video-file')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: files as unknown as FileList,
  })
  await input.trigger('change')
}

function createdResponse(): CreateVideoResponse {
  return {
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
}

function videoResponse(status: VideoResponse['job']['status']): VideoResponse {
  return {
    videoId,
    fileName: 'movie.mp4',
    contentType: 'video/mp4',
    sizeBytes: 5,
    job: { jobId, status, failure: status === 'FAILED' ? { code: 'ENCODING_FAILED', message: 'encode failed' } : null },
    createdAt: '2026-08-25T03:00:00Z',
    updatedAt: '2026-08-25T03:01:00Z',
  }
}

function playbackResponse(): PlaybackResponse {
  return {
    videoId,
    jobId,
    protocol: 'HLS',
    manifestUrl: 'https://cdn.example/index.m3u8',
    contentType: 'application/vnd.apple.mpegurl',
  }
}

function mockCreateVideo(implementation?: (request: CreateVideoRequest) => Promise<CreateVideoResponse>) {
  return vi.fn<(request: CreateVideoRequest) => Promise<CreateVideoResponse>>(implementation)
}

function mockUploadFile(implementation?: (file: File, response: CreateVideoResponse) => Promise<void>) {
  return vi.fn<(file: File, response: CreateVideoResponse) => Promise<void>>(implementation)
}

function mockGetVideoStatus(implementation?: (videoId: string) => Promise<VideoResponse>) {
  return vi.fn<(videoId: string) => Promise<VideoResponse>>(implementation)
}

function mockGetPlayback() {
  return vi.fn<(videoId: string) => Promise<PlaybackResponse>>()
}

function actions(overrides: Partial<WorkflowActions> = {}): WorkflowActions {
  return {
    createVideo: mockCreateVideo().mockResolvedValue(createdResponse()),
    uploadFile: mockUploadFile().mockResolvedValue(undefined),
    getVideoStatus: mockGetVideoStatus().mockResolvedValue(videoResponse('COMPLETED')),
    getPlayback: mockGetPlayback().mockResolvedValue(playbackResponse()),
    ...overrides,
  }
}

function createPlayerMock(): PlayerMock {
  const player: PlayerMock = {
    dispose: vi.fn<() => void>(),
    error: vi.fn<() => { message: string } | null>(() => null),
    on: vi.fn<(event: string, handler: () => void) => void>(),
  }
  videojsMock.mockReturnValue(player)
  return player
}

async function reachReady(wrapper: ReturnType<typeof mount>) {
  await chooseFiles(wrapper, [mp4()])
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  await vi.advanceTimersByTimeAsync(1000)
  await flushPromises()
}

describe('App workflow shell', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    videojsMock.mockClear()
  })

  it('mounts the upload shell', () => {
    const wrapper = mount(App)
    expect(wrapper.get('[data-workflow-state="idle"]').text()).toContain('Ready to upload')
  })

  it('rejects invalid files without network activity', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const workflowActions = actions()
    const wrapper = mount(App, { props: { workflowActions } })

    await chooseFiles(wrapper, [new File(['clip'], 'clip.webm', { type: 'video/webm' })])

    expect(wrapper.get('[role="alert"]').text()).toContain('MP4')
    expect(wrapper.find('[data-workflow-state="error"]').exists()).toBe(true)
    expect(workflowActions.createVideo).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not call live API defaults on submit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(App)
    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[data-workflow-state="error"]').text()).toContain('createVideo is not wired')
  })

  it('uploads the selected file to the create response and delays the first status poll', async () => {
    const file = mp4('clip.mp4', 'abcdef')
    const created = createdResponse()
    const workflowActions = actions({
      createVideo: mockCreateVideo().mockResolvedValue(created),
    })
    const wrapper = mount(App, { props: { workflowActions } })

    await chooseFiles(wrapper, [file])
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(workflowActions.createVideo).toHaveBeenCalledExactlyOnceWith({
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: file.size,
    })
    expect(workflowActions.uploadFile).toHaveBeenCalledExactlyOnceWith(file, created)
    expect(workflowActions.getVideoStatus).not.toHaveBeenCalled()
    expect(workflowActions.getPlayback).not.toHaveBeenCalled()
    expect(wrapper.get('[data-workflow-state="processing"]').text()).toContain('Processing')
    expect(wrapper.get('[aria-label="Video creation result"]').text()).toContain(videoId)
    expect(wrapper.get('[aria-label="Video creation result"]').text()).toContain(jobId)
    expect(wrapper.get('[aria-label="Video creation result"]').text()).toContain('PUT https://upload.example/source.mp4')
    expect((wrapper.vm as { createdVideo: CreateVideoResponse | null }).createdVideo).toEqual(created)
  })

  it('shows an actionable error and does not upload when create fails', async () => {
    const workflowActions = actions({
      createVideo: mockCreateVideo().mockRejectedValue(new ApiError('Video too large.', 413, 'PAYLOAD_TOO_LARGE')),
    })
    const wrapper = mount(App, { props: { workflowActions } })

    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-workflow-state="error"]').text()).toContain('Video too large.')
    expect(workflowActions.uploadFile).not.toHaveBeenCalled()
    expect(workflowActions.getVideoStatus).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-label="Video creation result"]').exists()).toBe(false)
  })

  it('prevents duplicate submissions while active', async () => {
    let finishCreate!: (value: CreateVideoResponse) => void
    const workflowActions = actions({
      createVideo: mockCreateVideo(
        () =>
          new Promise<CreateVideoResponse>((resolve) => {
            finishCreate = resolve
          }),
      ),
    })
    const wrapper = mount(App, { props: { workflowActions } })
    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('form').trigger('submit')

    expect(workflowActions.createVideo).toHaveBeenCalledOnce()
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-workflow-state="creating"]').exists()).toBe(true)

    finishCreate(createdResponse())
    await flushPromises()

    expect(workflowActions.uploadFile).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-workflow-state="processing"]').exists()).toBe(true)
  })

  it('prevents duplicate submissions while uploading', async () => {
    let finishUpload!: () => void
    const workflowActions = actions({
      uploadFile: mockUploadFile(
        () =>
          new Promise<void>((resolve) => {
            finishUpload = resolve
          }),
      ),
    })
    const wrapper = mount(App, { props: { workflowActions } })
    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('form').trigger('submit')

    expect(workflowActions.createVideo).toHaveBeenCalledOnce()
    expect(workflowActions.uploadFile).toHaveBeenCalledOnce()
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-workflow-state="uploading"]').exists()).toBe(true)

    finishUpload()
    await flushPromises()
  })

  it('shows an actionable error and does not poll when upload fails', async () => {
    const workflowActions = actions({
      uploadFile: mockUploadFile().mockRejectedValue(new ApiError('Upload failed with status 403', 403)),
    })
    const wrapper = mount(App, { props: { workflowActions } })

    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-workflow-state="error"]').text()).toContain('Upload failed with status 403')
    expect(workflowActions.getVideoStatus).not.toHaveBeenCalled()
    expect(workflowActions.getPlayback).not.toHaveBeenCalled()
  })

  it('does not start upload after disposal during create', async () => {
    let finishCreate!: (value: CreateVideoResponse) => void
    const workflowActions = actions({
      createVideo: mockCreateVideo(
        () =>
          new Promise<CreateVideoResponse>((resolve) => {
            finishCreate = resolve
          }),
      ),
    })
    const wrapper = mount(App, { props: { workflowActions } })
    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    ;(wrapper.vm as { dispose: () => void }).dispose()
    finishCreate(createdResponse())
    await flushPromises()

    expect(workflowActions.uploadFile).not.toHaveBeenCalled()
    expect((wrapper.vm as { createdVideo: CreateVideoResponse | null }).createdVideo).toBeNull()
    expect(wrapper.find('[data-workflow-state="creating"]').exists()).toBe(true)
  })

  it('polls contract statuses and requests playback only after COMPLETED', async () => {
    const workflowActions = actions({
      getVideoStatus: mockGetVideoStatus()
        .mockResolvedValueOnce(videoResponse('PROCESSING'))
        .mockResolvedValueOnce(videoResponse('QUEUED'))
        .mockResolvedValueOnce(videoResponse('COMPLETED')),
    })
    vi.useFakeTimers()
    const wrapper = mount(App, { props: { workflowActions, pollIntervalMs: 1000 } })

    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-job-status]').text()).toContain('UPLOADING')
    expect(workflowActions.getVideoStatus).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(wrapper.get('[data-job-status]').text()).toContain('PROCESSING')

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(wrapper.get('[data-job-status]').text()).toContain('QUEUED')

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(wrapper.get('[data-job-status]').text()).toContain('COMPLETED')
    expect(wrapper.find('[data-workflow-state="ready"]').exists()).toBe(true)
    expect(workflowActions.getPlayback).toHaveBeenCalledExactlyOnceWith(videoId)
    expect(videojsMock).toHaveBeenCalledWith(
      expect.any(HTMLVideoElement),
      expect.objectContaining({
        controls: true,
        sources: [{ src: 'https://cdn.example/index.m3u8', type: 'application/vnd.apple.mpegurl' }],
      }),
    )
    expect(wrapper.find('[aria-label="Uploaded video"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(workflowActions.getVideoStatus).toHaveBeenCalledTimes(3)
    expect(workflowActions.getVideoStatus).toHaveBeenCalledWith(videoId)
  })

  it('renders FAILED details and never requests playback', async () => {
    const workflowActions = actions({
      getVideoStatus: mockGetVideoStatus().mockResolvedValue(videoResponse('FAILED')),
    })
    vi.useFakeTimers()
    const wrapper = mount(App, { props: { workflowActions, pollIntervalMs: 1000 } })

    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    expect(wrapper.get('[data-workflow-state="error"]').text()).toContain('ENCODING_FAILED: encode failed')
    expect(wrapper.get('[data-job-status]').text()).toContain('FAILED')
    expect(workflowActions.getPlayback).not.toHaveBeenCalled()
  })

  it('ignores in-flight status after disposal', async () => {
    let finishStatus!: (value: VideoResponse) => void
    const workflowActions = actions({
      getVideoStatus: mockGetVideoStatus(
        () =>
          new Promise<VideoResponse>((resolve) => {
            finishStatus = resolve
          }),
      ),
    })
    vi.useFakeTimers()
    const wrapper = mount(App, { props: { workflowActions, pollIntervalMs: 1000 } })
    await chooseFiles(wrapper, [mp4()])
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    ;(wrapper.vm as { dispose: () => void }).dispose()
    finishStatus(videoResponse('COMPLETED'))
    await flushPromises()

    expect(workflowActions.getPlayback).not.toHaveBeenCalled()
    expect(wrapper.get('[data-job-status]').text()).toContain('UPLOADING')
    expect(wrapper.find('[data-workflow-state="processing"]').exists()).toBe(true)
  })

  it('shows a visible alert when the player emits an error', async () => {
    const player = createPlayerMock()
    player.error.mockReturnValue({ message: 'The media could not be loaded.' })
    vi.useFakeTimers()
    const wrapper = mount(App, { props: { workflowActions: actions(), pollIntervalMs: 1000 } })

    await reachReady(wrapper)

    const errorHandler = player.on.mock.calls.find(([event]) => event === 'error')?.[1]
    expect(errorHandler).toEqual(expect.any(Function))
    ;(errorHandler as () => void)()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('The media could not be loaded.')
    expect(wrapper.find('[data-workflow-state="error"]').exists()).toBe(true)
  })

  it('disposes the player when the selected video is replaced', async () => {
    const player = createPlayerMock()
    vi.useFakeTimers()
    const wrapper = mount(App, { props: { workflowActions: actions(), pollIntervalMs: 1000 } })

    await reachReady(wrapper)
    expect(videojsMock).toHaveBeenCalledOnce()

    await chooseFiles(wrapper, [mp4('other.mp4')])

    expect(player.dispose).toHaveBeenCalledOnce()
  })

  it('disposes the player on unmount', async () => {
    const player = createPlayerMock()
    vi.useFakeTimers()
    const wrapper = mount(App, { props: { workflowActions: actions(), pollIntervalMs: 1000 } })

    await reachReady(wrapper)
    wrapper.unmount()

    expect(player.dispose).toHaveBeenCalledOnce()
  })
})

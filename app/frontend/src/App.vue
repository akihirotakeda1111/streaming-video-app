<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import type { VideoApiClient } from './api/client'
import type { CreateVideoResponse, PlaybackResponse, VideoResponse } from './api/contracts'

export type WorkflowState = 'idle' | 'creating' | 'created' | 'uploading' | 'processing' | 'ready' | 'error'

export interface WorkflowActions {
  createVideo: VideoApiClient['createVideo']
  uploadFile: (file: File, response: CreateVideoResponse) => Promise<void>
  getVideoStatus: VideoApiClient['getVideoStatus']
  getPlayback: VideoApiClient['getPlayback']
}

const props = withDefaults(
  defineProps<{
    workflowActions?: Partial<WorkflowActions>
    pollIntervalMs?: number
  }>(),
  { pollIntervalMs: 1000 },
)

const state = ref<WorkflowState>('idle')
const selectedFile = ref<File | null>(null)
const createdVideo = ref<CreateVideoResponse | null>(null)
const errorMessage = ref('')
const playback = ref<PlaybackResponse | null>(null)
const input = ref<HTMLInputElement | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

function unwired(name: keyof WorkflowActions): () => Promise<never> {
  return async () => {
    throw new Error(`${name} is not wired`)
  }
}

const defaultActions: WorkflowActions = {
  createVideo: unwired('createVideo'),
  uploadFile: unwired('uploadFile'),
  getVideoStatus: unwired('getVideoStatus'),
  getPlayback: unwired('getPlayback'),
}

const actions = computed(() => ({ ...defaultActions, ...props.workflowActions }))
const continuesWorkflow = computed(() =>
  Boolean(props.workflowActions?.uploadFile && props.workflowActions?.getVideoStatus && props.workflowActions?.getPlayback),
)
const active = computed(() => state.value === 'creating')
const stateLabel = computed(() =>
  ({ idle: 'Ready to upload', creating: 'Creating video', created: 'Video created', uploading: 'Uploading', processing: 'Processing', ready: 'Ready to play', error: 'Upload error' })[
    state.value
  ],
)

function setError(message: string) {
  errorMessage.value = message
  state.value = 'error'
}

function selectFile(event: Event) {
  const files = (event.target as HTMLInputElement).files
  selectedFile.value = files?.length === 1 ? (files[0] ?? null) : null
  createdVideo.value = null
  playback.value = null
  errorMessage.value = ''
  if (!selectedFile.value) {
    if (files?.length) setError('Please select one MP4 video file.')
    else state.value = 'idle'
    return
  }
  if (selectedFile.value.type !== 'video/mp4' || selectedFile.value.size === 0) {
    selectedFile.value = null
    setError('Please choose one non-empty MP4 video file.')
    return
  }
  state.value = 'idle'
}

function clearTimer() {
  if (pollTimer !== undefined) clearTimeout(pollTimer)
  pollTimer = undefined
}

async function checkStatus(videoId: string) {
  if (disposed) return
  const result: VideoResponse = await actions.value.getVideoStatus(videoId)
  if (disposed) return
  if (result.job.status === 'FAILED') throw new Error(result.job.failure?.message ?? 'Video processing failed.')
  if (result.job.status === 'COMPLETED') {
    const nextPlayback = await actions.value.getPlayback(videoId)
    if (disposed) return
    playback.value = nextPlayback
    state.value = 'ready'
    return
  }
  if (disposed) return
  pollTimer = setTimeout(() => {
    void checkStatus(videoId).catch((error: unknown) => {
      if (!disposed) setError(errorMessageFor(error))
    })
  }, props.pollIntervalMs)
}

async function submit() {
  if (active.value) return
  if (!selectedFile.value) {
    setError('Choose an MP4 video before uploading.')
    return
  }
  const file = selectedFile.value
  if (file.type !== 'video/mp4' || file.size === 0) {
    setError('Only non-empty MP4 video files are supported.')
    return
  }
  clearTimer()
  errorMessage.value = ''
  playback.value = null
  createdVideo.value = null
  try {
    state.value = 'creating'
    const created = await actions.value.createVideo({ fileName: file.name, contentType: 'video/mp4', sizeBytes: file.size })
    if (disposed) return
    createdVideo.value = created
    if (continuesWorkflow.value) {
      state.value = 'uploading'
      await actions.value.uploadFile(file, created)
      if (disposed) return
      state.value = 'processing'
      await checkStatus(created.videoId)
      return
    }
    state.value = 'created'
  } catch (error: unknown) {
    if (!disposed) setError(errorMessageFor(error))
  }
}

function errorMessageFor(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.'
}

function dispose() {
  disposed = true
  clearTimer()
}

onBeforeUnmount(dispose)
defineExpose({ createdVideo, dispose, state })
</script>

<template>
  <main class="upload-shell" :data-workflow-state="state">
    <h1>You did it!</h1>
    <p class="intro">Upload an MP4 video and watch it when processing is complete.</p>

    <form class="upload-card" @submit.prevent="submit">
      <label for="video-file">Video file</label>
      <input id="video-file" ref="input" type="file" accept="video/mp4" :disabled="active" @change="selectFile" />
      <p v-if="selectedFile" class="file-name">Selected: {{ selectedFile.name }}</p>
      <p class="hint">MP4 files only. Select one video.</p>
      <button type="submit" :disabled="active">{{ active ? 'Working…' : 'Upload video' }}</button>
      <p class="status" role="status" aria-live="polite">{{ stateLabel }}</p>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <section v-if="createdVideo" class="create-result" aria-label="Video creation result">
        <p>Video ID: {{ createdVideo.videoId }}</p>
        <p>Job ID: {{ createdVideo.job.jobId }}</p>
        <p>Upload ready: {{ createdVideo.upload.method }} {{ createdVideo.upload.url }}</p>
      </section>
      <video v-if="playback" class="player" controls :src="playback.manifestUrl" aria-label="Uploaded video"></video>
    </form>
  </main>
</template>

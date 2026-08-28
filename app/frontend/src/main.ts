import { createApp } from 'vue'
import { createPinia } from 'pinia'

import { createVideoApiClient } from './api/client'
import type { CreateVideoRequest } from './api/contracts'
import App from './App.vue'
import router from './router'
import './assets/main.css'

const apiClient = createVideoApiClient()
const app = createApp(App, {
  workflowActions: {
    createVideo: (request: CreateVideoRequest) => apiClient.createVideo(request),
    uploadFile: (file, response) => apiClient.uploadFile(file, response),
    getVideoStatus: (videoId) => apiClient.getVideoStatus(videoId),
    getPlayback: (videoId) => apiClient.getPlayback(videoId),
  },
})

app.use(createPinia())
app.use(router)

app.mount('#app')

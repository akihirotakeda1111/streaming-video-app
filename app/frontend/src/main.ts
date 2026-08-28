import { createApp } from 'vue'
import { createPinia } from 'pinia'

import { createVideoApiClient } from './api/client'
import App from './App.vue'
import router from './router'
import './assets/main.css'
import 'video.js/dist/video-js.css'

const apiClient = createVideoApiClient()
const app = createApp(App, {
  workflowActions: {
    createVideo: apiClient.createVideo.bind(apiClient),
    uploadFile: apiClient.uploadFile.bind(apiClient),
    getVideoStatus: apiClient.getVideoStatus.bind(apiClient),
    getPlayback: apiClient.getPlayback.bind(apiClient),
  },
})

app.use(createPinia())
app.use(router)

app.mount('#app')

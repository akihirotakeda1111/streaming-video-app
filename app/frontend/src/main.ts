import { createApp } from 'vue'
import { createPinia } from 'pinia'

import { createVideoApiClient } from './api/client'
import type { CreateVideoRequest } from './api/contracts'
import App from './App.vue'
import router from './router'
import './assets/main.css'

const app = createApp(App, {
  workflowActions: {
    createVideo: (request: CreateVideoRequest) => createVideoApiClient().createVideo(request),
  },
})

app.use(createPinia())
app.use(router)

app.mount('#app')

export interface RuntimeConfig {
  apiBaseUrl: string
}

export const runtimeConfig: RuntimeConfig = Object.freeze({
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL?.trim() ?? '',
})

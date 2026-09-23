import { createRequire } from 'node:module'
import { expect, type Page, type Request } from '@playwright/test'
import type { PlaybackSummary } from './checkpoints.js'
import { isPlaybackMediaRequest, summarizePlayback } from './urls.js'

export interface PlaybackProof extends PlaybackSummary {
  manifestUrl?: string
  readyState?: number
  initialTime?: number
  currentTime?: number
  requests: string[]
}

export async function proveAbrPlayback(
  page: Page,
  frontendUrl: string,
  manifestUrl: string,
  playbackBaseUrl: string,
  timeoutMs: number,
): Promise<PlaybackProof> {
  const started = Date.now()
  const remaining = () => Math.max(1_000, timeoutMs - (Date.now() - started))
  const manifest = new URL(manifestUrl)
  const manifestPath = manifest.pathname
  const requests: { path: string; at: number }[] = []
  const proof: PlaybackProof = {
    usedVideoJs: false,
    master: false,
    playlist360: false,
    playlist720: false,
    segment360: false,
    segment720: false,
    decoded: false,
    advanced: false,
    switched: false,
    requests: [],
    manifestUrl: `${manifest.origin}${manifestPath}`,
  }
  const refresh = () => {
    proof.requests = requests.map((request) => request.path)
    const summary = summarizePlayback(proof.requests, manifestPath)
    proof.master = summary.master
    proof.playlist360 = summary.playlist360
    proof.playlist720 = summary.playlist720
    proof.segment360 = summary.segment360
    proof.segment720 = summary.segment720
  }
  const onRequest = (request: Request) => {
    if (!isPlaybackMediaRequest(request.url(), playbackBaseUrl)) return
    requests.push({ path: new URL(request.url()).pathname, at: Date.now() })
    refresh()
  }
  page.on('request', onRequest)
  try {
    await page.goto(frontendUrl)
    await page.addScriptTag({ path: createRequire(import.meta.url).resolve('video.js/dist/video.min.js') })
    await page.evaluate((source) => {
      const libraries = window as unknown as {
        videojs?: (element: HTMLVideoElement, options: unknown) => {
          loop?: (enabled: boolean) => void
          play?: () => Promise<void> | undefined
          qualityLevels?: () => { length: number }
        }
      }
      if (typeof libraries.videojs !== 'function') throw new Error('video.js player was not available')
      const video = document.createElement('video')
      video.id = 'scalability-player'
      video.muted = true
      video.playsInline = true
      document.body.append(video)
      const player = libraries.videojs(video, {
        autoplay: true,
        muted: true,
        loop: true,
        controls: true,
        html5: { vhs: { overrideNative: true } },
        sources: [{ src: source, type: 'application/vnd.apple.mpegurl' }],
      })
      player.loop?.(true)
      const pending = player.play?.()
      if (pending && typeof (pending as Promise<void>).catch === 'function') {
        void (pending as Promise<void>).catch(() => undefined)
      }
      ;(window as unknown as { __scalabilityPlayer?: typeof player }).__scalabilityPlayer = player
    }, manifestUrl)
    proof.usedVideoJs = true
    const video = page.locator('video#scalability-player_html5_api')
    await expect(video).toHaveCount(1, { timeout: remaining() })
    const initialTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement, startedAt: number) => {
      if (element.error) throw new Error(`media decode failed: ${element.error.message}`)
      return element.readyState >= 2 && element.currentTime > startedAt + 0.05
    }, initialTime), {
      timeout: remaining(),
      message: 'readyState and currentTime did not show decoded playback',
    }).toBe(true)
    const media = await video.evaluate((element: HTMLVideoElement) => ({
      readyState: element.readyState,
      currentTime: element.currentTime,
    }))
    proof.readyState = media.readyState
    proof.initialTime = initialTime
    proof.currentTime = media.currentTime
    proof.decoded = media.readyState >= 2
    proof.advanced = media.currentTime > initialTime + 0.05
    await expect.poll(() => page.evaluate(() => {
      const player = (window as unknown as { __scalabilityPlayer?: { qualityLevels?: () => { length: number } } }).__scalabilityPlayer
      if (!player || typeof player.qualityLevels !== 'function') return 0
      return player.qualityLevels().length
    }), {
      timeout: remaining(),
      message: 'video.js did not expose both renditions',
    }).toBeGreaterThanOrEqual(2)
    await selectAndWait(page, requests, 360, remaining)
    await selectAndWait(page, requests, 720, remaining)
    proof.switched = true
    refresh()
    return proof
  } catch (error) {
    proof.error = error instanceof Error ? error.message : 'ABR playback failed'
    refresh()
    return proof
  } finally {
    page.off('request', onRequest)
  }
}

async function selectAndWait(
  page: Page,
  requests: { path: string; at: number }[],
  height: 360 | 720,
  remaining: () => number,
): Promise<void> {
  const from = requests.length
  const selected = await page.evaluate((target) => {
    const player = (window as unknown as {
      __scalabilityPlayer?: {
        qualityLevels?: () => { length: number; [index: number]: { height: number; enabled: boolean } }
        tech?: (options: { IWillNotUseThisInPlugins: true }) => {
          vhs?: { representations?: () => { height: number; enabled: (value: boolean) => void }[] }
        }
      }
    }).__scalabilityPlayer
    if (!player) return { count: 0, matched: 0 }
    if (typeof player.qualityLevels === 'function') {
      const levels = player.qualityLevels()
      let matched = 0
      for (let index = 0; index < levels.length; index += 1) {
        const level = levels[index]
        if (!level) continue
        const enable = level.height === target
        level.enabled = enable
        if (enable) matched += 1
      }
      return { count: levels.length, matched }
    }
    const representations = player.tech?.({ IWillNotUseThisInPlugins: true }).vhs?.representations?.() ?? []
    let matched = 0
    for (const representation of representations) {
      const enable = representation.height === target
      representation.enabled(enable)
      if (enable) matched += 1
    }
    return { count: representations.length, matched }
  }, height)
  if (selected.matched < 1) throw new Error(`video.js could not select ${height}p`)
  const token = height === 360 ? '360p' : '720p'
  await expect.poll(() => requests.slice(from).some((request) => (
    request.path.split('/').includes(token) && /\.(m3u8|ts|m4s|mp4)$/i.test(request.path)
  )), {
    timeout: remaining(),
    message: `video.js did not request the ${token} rendition after the switch`,
  }).toBe(true)
}

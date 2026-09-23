import { createRequire } from 'node:module'
import { expect, type Page, type Request } from '@playwright/test'
import type { PlaybackSummary } from './checkpoints.js'
import { isPlaybackMediaRequest, isRenditionMediaSegment, summarizePlayback } from './urls.js'

type RenditionToken = '360p' | '720p'

export interface PlaybackProof extends PlaybackSummary {
  manifestUrl?: string
  readyState?: number
  initialTime?: number
  currentTime?: number
  requests: string[]
}

/** Cap playback at the configured timeout and the time left until the run deadline. */
export function remainingPlaybackTimeout(playbackTimeoutMs: number, deadlineMs: number, nowMs: number): number {
  if (!Number.isFinite(playbackTimeoutMs) || playbackTimeoutMs <= 0) return 0
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return 0
  return Math.min(playbackTimeoutMs, Math.max(0, deadlineMs - nowMs))
}

export async function proveAbrPlayback(
  page: Page,
  frontendUrl: string,
  manifestUrl: string,
  playbackBaseUrl: string,
  timeoutMs: number,
): Promise<PlaybackProof> {
  const started = Date.now()
  const remaining = () => {
    const left = timeoutMs - (Date.now() - started)
    if (left <= 0) throw new Error('playback exceeded the runtime budget')
    return left
  }
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
    if (timeoutMs <= 0) throw new Error('playback exceeded the runtime budget')
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)
    await page.goto(frontendUrl, { timeout: remaining() })
    page.setDefaultTimeout(remaining())
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
    await expect.poll(async () => (await inspectRenditions(page, '')).tokens, {
      timeout: remaining(),
      message: 'video.js did not expose 360p and 720p playlist renditions',
    }).toEqual(expect.arrayContaining(['360p', '720p']))
    await selectAndWait(page, requests, '360p', remaining)
    await selectAndWait(page, requests, '720p', remaining)
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
  token: RenditionToken,
  remaining: () => number,
): Promise<void> {
  const from = requests.length
  const selected = await inspectRenditions(page, token)
  if (selected.matched < 1) throw new Error(`video.js could not select the ${token} rendition`)
  await expect.poll(() => requests.slice(from).some((request) => isRenditionMediaSegment(request.path, token)), {
    timeout: remaining(),
    message: `video.js did not request a ${token} media segment after the switch`,
  }).toBe(true)
}

async function inspectRenditions(page: Page, target: RenditionToken | ''): Promise<{ tokens: string[]; matched: number }> {
  return page.evaluate((selected) => {
    function tokenFrom(value: unknown): '360p' | '720p' | undefined {
      const queue: unknown[] = [value]
      const seen = new Set<unknown>()
      while (queue.length > 0) {
        const current = queue.shift()
        if (current == null || (typeof current === 'object' && seen.has(current))) continue
        if (typeof current === 'string') {
          let pathname = current
          try {
            pathname = new URL(current, 'https://playback.invalid').pathname
          } catch {
            pathname = current
          }
          const segments = pathname.split(/[/?#]/).filter(Boolean)
          if (segments.includes('360p')) return '360p'
          if (segments.includes('720p')) return '720p'
          continue
        }
        if (typeof current !== 'object') continue
        seen.add(current)
        const record = current as Record<string, unknown>
        for (const key of ['id', 'uri', 'resolvedUri', 'playlist', 'URI', 'attributes', 'name', 'label', 'NAME']) {
          if (Object.prototype.hasOwnProperty.call(record, key)) queue.push(record[key])
        }
      }
      return undefined
    }
    const player = (window as unknown as {
      __scalabilityPlayer?: {
        qualityLevels?: () => { length: number; [index: number]: { enabled: boolean } }
        tech?: (options: { IWillNotUseThisInPlugins: true }) => {
          vhs?: { representations?: () => { enabled?: (value: boolean) => void }[] }
        }
      }
    }).__scalabilityPlayer
    const representations = player?.tech?.({ IWillNotUseThisInPlugins: true }).vhs?.representations?.() ?? []
    const levels = player && typeof player.qualityLevels === 'function' ? player.qualityLevels() : undefined
    const tokens = new Set<string>()
    for (const representation of representations) {
      const token = tokenFrom(representation)
      if (token) tokens.add(token)
    }
    if (levels) {
      for (let index = 0; index < levels.length; index += 1) {
        const token = tokenFrom(levels[index])
        if (token) tokens.add(token)
      }
    }
    if (!selected) return { tokens: [...tokens], matched: 0 }
    const enableGroup = <T>(items: T[], setEnabled: (item: T, enabled: boolean) => void): number => {
      const decisions = items.map((item) => tokenFrom(item) === selected)
      if (!decisions.some(Boolean)) return 0
      items.forEach((item, index) => setEnabled(item, decisions[index] === true))
      return decisions.filter(Boolean).length
    }
    const matched = enableGroup(representations, (representation, enabled) => {
      if (typeof representation.enabled === 'function') representation.enabled(enabled)
    }) + enableGroup(levels ? Array.from({ length: levels.length }, (_, index) => levels[index]).filter((level) => level != null) : [], (level, enabled) => {
      level.enabled = enabled
    })
    return { tokens: [...tokens], matched }
  }, target)
}

const VIRTUAL_HOSTED_BUCKET = [
  /^(.+)\.s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com$/i,
  /^(.+)\.s3-accelerate\.dualstack\.amazonaws\.com$/i,
  /^(.+)\.s3-accelerate\.amazonaws\.com$/i,
  /^(.+)\.s3\.[a-z0-9-]+\.amazonaws\.com$/i,
  /^(.+)\.s3\.amazonaws\.com$/i,
]

/**
 * Return the bucket addressed by an S3 presigned PUT URL.
 * Virtual-hosted and path-style AWS endpoints are recognized. Any other host
 * is rejected so the upload is not sent to an unknown environment.
 */
export function presignedUploadBucket(uploadUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(uploadUrl)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  for (const pattern of VIRTUAL_HOSTED_BUCKET) {
    const match = pattern.exec(host)
    const bucket = match?.[1]?.toLowerCase()
    if (bucket) return bucket
  }
  const pathStyle = host === 's3.amazonaws.com'
    || /^s3\.[a-z0-9-]+\.amazonaws\.com$/i.test(host)
    || /^s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com$/i.test(host)
  if (!pathStyle) return undefined
  const bucket = url.pathname.split('/').filter(Boolean)[0]
  if (!bucket) return undefined
  try {
    return decodeURIComponent(bucket).toLowerCase()
  } catch {
    return undefined
  }
}

/** Identify a 360p or 720p rendition from a playlist URI or representation id. */
export function renditionToken(value: unknown): '360p' | '720p' | undefined {
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

/** Build an API URL without dropping a configured `/api/v1` base path. */
export function apiUrl(apiBase: string, path: string): string {
  const base = new URL(apiBase)
  const pathname = base.pathname.replace(/\/+$/, '')
  const prefix = pathname.endsWith('/api/v1') ? pathname : `${pathname}/api/v1`
  const suffix = path.replace(/^\/+/, '')
  const joined = `${prefix}/${suffix}`.replace(/\/{2,}/g, '/')
  return new URL(joined, `${base.origin}/`).toString()
}

/**
 * Accept a request only when its origin is the playback origin and its path is
 * under the configured media prefix. A full-URL prefix check is not used.
 */
export function isPlaybackMediaRequest(requestUrl: string, playbackBaseUrl: string): boolean {
  let request: URL
  let base: URL
  try {
    request = new URL(requestUrl)
    base = new URL(playbackBaseUrl)
  } catch {
    return false
  }
  if (request.origin !== base.origin) return false
  const parts = request.pathname.split('/').filter(Boolean)
  const prefix = base.pathname.replace(/\/+$/, '')
  if (!prefix) return parts[0] === 'videos'
  const prefixParts = prefix.split('/').filter(Boolean)
  if (parts.length < prefixParts.length) return false
  return prefixParts.every((part, index) => parts[index] === part)
}

export interface PlaybackPathClasses {
  master: boolean
  playlist360: boolean
  playlist720: boolean
  segment360: boolean
  segment720: boolean
}

const SEGMENT = /\.(ts|m4s|mp4)$/i

/** A rendition switch counts only after a media segment for that rendition is requested. */
export function isRenditionMediaSegment(pathname: string, rendition: '360p' | '720p'): boolean {
  const path = pathname.split(/[?#]/, 1)[0] ?? pathname
  return path.split('/').includes(rendition) && SEGMENT.test(path)
}

export function classifyPlaybackPath(pathname: string, manifestPath: string): PlaybackPathClasses {
  const manifest = manifestPath.split(/[?#]/, 1)[0] ?? manifestPath
  const segments = pathname.split('/')
  const rendition = segments.includes('360p') ? '360p' : segments.includes('720p') ? '720p' : undefined
  const playlist = pathname.endsWith('.m3u8')
  const segment = SEGMENT.test(pathname)
  return {
    master: pathname === manifest,
    playlist360: rendition === '360p' && playlist && pathname !== manifest,
    playlist720: rendition === '720p' && playlist && pathname !== manifest,
    segment360: rendition === '360p' && segment,
    segment720: rendition === '720p' && segment,
  }
}

export function summarizePlayback(paths: readonly string[], manifestPath: string): PlaybackPathClasses {
  const summary: PlaybackPathClasses = {
    master: false,
    playlist360: false,
    playlist720: false,
    segment360: false,
    segment720: false,
  }
  for (const path of paths) {
    const classes = classifyPlaybackPath(path, manifestPath)
    summary.master ||= classes.master
    summary.playlist360 ||= classes.playlist360
    summary.playlist720 ||= classes.playlist720
    summary.segment360 ||= classes.segment360
    summary.segment720 ||= classes.segment720
  }
  return summary
}

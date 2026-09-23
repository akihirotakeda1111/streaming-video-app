import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export const RECOVERY_BOUND_MS = 10_000
export const OBSERVATION_GAP_MS = 5_000

export interface PublicationEvidence {
  lastAbsentAt: number
  firstPresentAt: number
  lastNegativeAt: number
  firstSuccessAt: number
  recoveryUpperBoundMs: number
  recoveryBoundMs: number
  clock: string
}
export interface PublicationSample {
  observedAt: number
  cloudFrontStatus: number
  lastAbsentAt?: number
  firstPresentAt?: number
  lastNegativeAt?: number
  recoveryBoundMs: number
}

/** Missing-object 404 is the only absence signal. IAM/transport failures abort. */
export async function privateManifestExists(key: string): Promise<boolean> {
  const bucket = process.env.E2E_OUTPUT_BUCKET?.trim()
  const region = process.env.AWS_REGION?.trim()
  if (!bucket || !region) throw new Error('Dedicated output inspection is required')
  try {
    await execute('aws', ['s3api', 'head-object', '--bucket', bucket, '--key', key,
      '--region', region, '--output', 'json'], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
    })
    return true
  } catch (error) {
    const result = error as { stderr?: string; killed?: boolean }
    if (!result.killed && /\(404\).*HeadObject/.test(result.stderr ?? '')) return false
    throw new Error('Private manifest observation failed (permission, timeout, or transport)')
  }
}

/** Poll continuously from before PUT. S3 publication is independent of CDN errors.
 * Use the LAST absence request's START as a conservative publication lower bound;
 * never restart that deadline on later CDN 403/404 responses.
 */
export async function observePublication(options: {
  exists: () => Promise<boolean>
  status: () => Promise<number>
  signal: AbortSignal
  timeoutMs: number
  initialObservation?: { absentAt: number; negativeAt: number }
  onObservation?: (sample: PublicationSample) => void
  now?: () => number
  pause?: () => Promise<void>
}): Promise<PublicationEvidence> {
  const now = options.now ?? (() => performance.now())
  const pause = options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 250)))
  const deadline = now() + options.timeoutMs
  let lastAbsentAt: number | undefined = options.initialObservation?.absentAt
  let lastNegativeAt: number | undefined = options.initialObservation?.negativeAt
  let firstPresentAt: number | undefined
  while (!options.signal.aborted && now() < deadline) {
    if (firstPresentAt === undefined) {
      const started = now()
      if (await options.exists()) {
        firstPresentAt = now()
        if (lastAbsentAt === undefined || lastNegativeAt === undefined
          || firstPresentAt - lastAbsentAt > OBSERVATION_GAP_MS
          || firstPresentAt - lastNegativeAt > OBSERVATION_GAP_MS) {
          throw new Error('Publication was not bracketed by recent S3 absence and CloudFront negative observations')
        }
      } else {
        lastAbsentAt = started
      }
    }
    const status = await options.status()
    const observedAt = now()
    if (status !== 200 && status !== 403 && status !== 404) throw new Error('Unexpected CloudFront publication status')
    if (status === 403 || status === 404) lastNegativeAt = observedAt
    options.onObservation?.({ observedAt, cloudFrontStatus: status, lastAbsentAt,
      firstPresentAt, lastNegativeAt, recoveryBoundMs: RECOVERY_BOUND_MS })
    if (firstPresentAt !== undefined) {
      if (observedAt - lastAbsentAt! > RECOVERY_BOUND_MS) throw new Error('CloudFront recovery exceeded the publication bound')
      if (status === 200) return { lastAbsentAt: lastAbsentAt!, firstPresentAt,
        lastNegativeAt: lastNegativeAt!, firstSuccessAt: observedAt,
        recoveryUpperBoundMs: observedAt - lastAbsentAt!, recoveryBoundMs: RECOVERY_BOUND_MS,
        clock: 'monotonic milliseconds in observer process' }
    }
    await pause()
  }
  throw new Error('Publication observation stopped or exceeded the processing budget')
}

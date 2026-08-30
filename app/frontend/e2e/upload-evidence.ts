import { urlEvidence, type UrlEvidence } from './url-evidence.js'

export type { UrlEvidence }

export function matchesTarget(value: UrlEvidence, target: UrlEvidence): boolean {
  return value.origin === target.origin && value.path === target.path
}

export function putDestinations(urls: string[]): UrlEvidence[] {
  return urls.map(urlEvidence)
}

/** Video bytes must leave the browser in exactly one PUT, and only to the API-provided URL. */
export function isSolePutToTarget(destinations: UrlEvidence[], target: UrlEvidence): boolean {
  return destinations.length === 1 && matchesTarget(destinations[0], target)
}

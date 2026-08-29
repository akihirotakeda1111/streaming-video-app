export interface UrlEvidence {
  origin: string
  path: string
}

/** Parses the original browser URL and omits its query and fragment from evidence. */
export function urlEvidence(value: string): UrlEvidence {
  const url = new URL(value)
  return { origin: url.origin, path: url.pathname }
}

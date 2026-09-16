function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported delivery policy shape')
  return value as Record<string, unknown>
}
function strings(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string')) throw new Error('Unsupported delivery policy value')
  return values as string[]
}
function only(value: unknown, expected: string): boolean {
  const values = strings(value)
  return values.length === 1 && values[0] === expected
}

/** Validate the repository's supported bucket grant, not arbitrary IAM semantics.
 * Extra Allow forms fail closed; dedicated test IAM remains identity-based.
 * Deny statements cannot broaden access and need not be interpreted here.
 */
export function validateDeliveryBucketPolicy(value: unknown, bucket: string, distributionArn: string): void {
  const policy = record(value)
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement]
  let grants = 0
  for (const value of statements) {
    const statement = record(value)
    if (statement.Effect === 'Deny') continue
    if (statement.Effect !== 'Allow' || statement.NotPrincipal || statement.NotAction || statement.NotResource) {
      throw new Error('Unsupported delivery grant')
    }
    const principal = record(statement.Principal)
    const condition = record(statement.Condition)
    const equals = record(condition.StringEquals)
    if (Object.keys(principal).length !== 1 || !only(principal.Service, 'cloudfront.amazonaws.com')
      || !only(statement.Action, 's3:GetObject')
      || !only(statement.Resource, `arn:aws:s3:::${bucket}/videos/*/jobs/*/hls/*`)
      || Object.keys(condition).length !== 1 || Object.keys(equals).length !== 1
      || !only(equals['AWS:SourceArn'], distributionArn)) throw new Error('CloudFront read grant is not restricted to the expected distribution and HLS prefix')
    grants += 1
  }
  if (!grants) throw new Error('Missing CloudFront HLS GetObject Allow grant')
}

export function validateDeliveryErrorCaching(value: unknown): void {
  const errors = record(value)
  const items = Array.isArray(errors.Items) ? errors.Items.map(record) : []
  for (const code of [403, 404]) {
    const matches = items.filter(item => item.ErrorCode === code)
    if (matches.length !== 1 || matches[0]!.ErrorCachingMinTTL !== 0
      || matches[0]!.ResponseCode !== undefined || matches[0]!.ResponsePagePath !== undefined) {
      throw new Error('403/404 require zero error TTL without status or page rewriting')
    }
  }
}

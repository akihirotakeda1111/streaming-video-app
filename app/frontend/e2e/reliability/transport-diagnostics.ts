/** Only fixed categories and advice leave this boundary; never retain the raw error. */
const advice = {
  access_denied:
    'Check the host AWS identity and its permission for this operation, plus bucket policies and expected owner.',
  credentials_missing:
    'Configure AWS CLI credentials in the test runner environment; Worker credentials are separate.',
  credentials_expired: 'Refresh the host AWS session and its session token.',
  credentials_invalid: 'Check the host access key, secret key and session token combination.',
  signature_mismatch: 'Check the host credentials, region and system clock.',
  timeout: 'Check connectivity and the operation timeout; upload may have completed remotely.',
  network: 'Check DNS, endpoint reachability and proxy settings in the test runner environment.',
  tls: 'Check the AWS CLI certificate trust and proxy configuration.',
  file_read: 'Check that the fixture is still present and readable by the test runner.',
  bucket_missing: 'Check the configured source bucket and account.',
  region_mismatch: 'Check the bucket region against AWS_REGION.',
  cli_missing: 'Check that the required CLI is installed on the test runner PATH.',
  process_permission: 'Check permission to execute the CLI on the test runner.',
  response_too_large: 'CLI output exceeded the bounded capture limit.',
  invalid_response: 'The CLI returned a response that could not be parsed as JSON.',
  unknown:
    'The failure could not be classified; verify host CLI authentication, fixture access and connectivity.',
} as const
type FailureCode = keyof typeof advice

export class SafeTransportError extends Error {
  constructor(readonly category: FailureCode) {
    super(`[${category}] ${advice[category]}`)
    this.name = 'SafeTransportError'
  }
}

export function transportFailure(error: unknown): SafeTransportError {
  if (error instanceof SafeTransportError) return error
  const e = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown
    stderr?: unknown
    message?: unknown
  }
  if (e.code === 'ETIMEDOUT') return new SafeTransportError('timeout')
  if (e.code === 'ENOENT') return new SafeTransportError('cli_missing')
  if (e.code === 'EACCES' || e.code === 'EPERM') return new SafeTransportError('process_permission')
  if (e.code === 'ENOBUFS' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return new SafeTransportError('response_too_large')
  // Inspect privately and bound parsing. Never put stderr/message/cause on the returned error.
  const raw = (
    typeof e.stderr === 'string'
      ? e.stderr
      : Buffer.isBuffer(e.stderr)
        ? e.stderr.toString('utf8')
        : typeof e.message === 'string'
          ? e.message
          : ''
  ).slice(0, 32768)
  const rules: [RegExp, FailureCode][] = [
    [/\b(AccessDenied|AccessDeniedException|AllAccessDisabled)\b/i, 'access_denied'],
    [/\b(ExpiredToken|ExpiredTokenException|RequestExpired)\b/i, 'credentials_expired'],
    [
      /Unable to locate credentials|NoCredentialsError|profile .* could not be found/i,
      'credentials_missing',
    ],
    [
      /\b(InvalidAccessKeyId|InvalidClientTokenId|UnrecognizedClientException|InvalidToken)\b|security token included in the request is invalid/i,
      'credentials_invalid',
    ],
    [
      /\b(SignatureDoesNotMatch|RequestTimeTooSkewed|InvalidSignatureException)\b/i,
      'signature_mismatch',
    ],
    [/SSL validation failed|CERTIFICATE_VERIFY_FAILED|certificate verify failed/i, 'tls'],
    [/\bRequestTimeout\b|timed? out|timeout on endpoint/i, 'timeout'],
    [
      /Could not connect to the endpoint|Could not resolve|Name or service not known|Failed to connect to proxy|Connection (?:reset|refused|closed)/i,
      'network',
    ],
    [
      /Error parsing parameter ['"]?--body|Unable to load paramfile|No such file or directory|Permission denied.*(?:file|\.mp4)/i,
      'file_read',
    ],
    [/\bNoSuchBucket\b/i, 'bucket_missing'],
    [
      /\b(PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraintException)\b/i,
      'region_mismatch',
    ],
  ]
  return new SafeTransportError(rules.find(([pattern]) => pattern.test(raw))?.[1] || 'unknown')
}

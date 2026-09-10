import { describe, expect, it } from 'vitest'
import { SafeTransportError, transportFailure } from './transport-diagnostics.js'
import { safeDiagnostic } from '../diagnostics.js'

describe('safe transport diagnostics', () => {
  it.each([
    ['An error occurred (AccessDenied) when calling the PutObject operation', 'access_denied'],
    [
      'An error occurred (ExpiredToken) when calling the PutObject operation',
      'credentials_expired',
    ],
    ['Unable to locate credentials', 'credentials_missing'],
    ['The config profile (test) could not be found', 'credentials_missing'],
    ['An error occurred (InvalidAccessKeyId)', 'credentials_invalid'],
    ['An error occurred (SignatureDoesNotMatch)', 'signature_mismatch'],
    ['SSL validation failed: CERTIFICATE_VERIFY_FAILED', 'tls'],
    ['Read timeout on endpoint URL', 'timeout'],
    ['Could not connect to the endpoint URL', 'network'],
    ["Error parsing parameter '--body': Blob values must be a path to a file.", 'file_read'],
    ['An error occurred (NoSuchBucket)', 'bucket_missing'],
    ['An error occurred (PermanentRedirect)', 'region_mismatch'],
    ['Unrecognized failure', 'unknown'],
  ])('classifies %s without retaining raw details', (stderr, category) => {
    const failure = transportFailure({
      stderr: Buffer.from(stderr + '\nprivate-value https://host/?token=private-value'),
      message: 'command includes private-value',
      stdout: 'private-value',
      status: 1,
    })
    expect(failure.category).toBe(category)
    expect(failure).not.toHaveProperty('stderr')
    expect(failure).not.toHaveProperty('cause')
    const evidence = JSON.stringify(safeDiagnostic({ reason: failure.message }))
    expect(evidence).toContain(`[${category}]`)
    expect(evidence).not.toContain('private-value')
    expect(failure.stack).not.toContain('private-value')
  })
  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ENOENT', 'cli_missing'],
    ['EACCES', 'process_permission'],
    ['EPERM', 'process_permission'],
    ['ENOBUFS', 'response_too_large'],
  ])('classifies process code %s', (code, category) => {
    expect(transportFailure({ code, message: 'private-value' }).category).toBe(category)
  })
  it('preserves a sanitized failure through nested transport boundaries', () => {
    const failure = new SafeTransportError('invalid_response')
    expect(transportFailure(failure)).toBe(failure)
    expect(transportFailure(null).category).toBe('unknown')
  })
})

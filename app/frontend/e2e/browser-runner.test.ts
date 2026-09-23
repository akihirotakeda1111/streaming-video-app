import { describe, expect, it, vi } from 'vitest'
import { runBrowserE2E } from '../../scripts/run_browser_e2e.mjs'

const settings = { AWS_REGION: 'us-east-1', E2E_OUTPUT_BUCKET: 'output',
  E2E_AWS_ACCOUNT_ID: '123456789012', PLAYBACK_BASE_URL: 'https://example.cloudfront.net/',
  OUTPUT_S3_ENDPOINT: 'https://output.s3.us-east-1.amazonaws.com/' }

describe('default browser E2E entry point', () => {
  it('gates uploads and removes inherited replay/discovery selections', () => {
    const execute = vi.fn().mockReturnValue({ status: 0 })
    expect(runBrowserE2E([], { ...settings, E2E_DISCOVERY: 'true', E2E_INCLUDE_DELIVERY_REPLAY: 'true',
      E2E_INCLUDE_RELIABILITY: 'true', E2E_RUN_ID: 'old', E2E_LEGACY_DELIVERY_FIXTURES: 'old' }, execute)).toBe(0)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0]![1].slice(2)).toEqual(['--grep', '@preflight', '--retries', '0'])
    expect(execute.mock.calls[1]![1].slice(2)).toEqual(['--grep-invert', '@preflight'])
    const env = execute.mock.calls[1]![2].env
    for (const key of ['E2E_DISCOVERY', 'E2E_INCLUDE_DELIVERY_REPLAY', 'E2E_INCLUDE_RELIABILITY', 'E2E_RUN_ID', 'E2E_LEGACY_DELIVERY_FIXTURES']) {
      expect(env[key]).toBeUndefined()
    }
    expect(env.PLAYBACK_BASE_URL).toBe('https://example.cloudfront.net')
    expect(env.OUTPUT_S3_ENDPOINT).toBe('https://output.s3.us-east-1.amazonaws.com')
  })
  it('stops before uploads when the preflight fails or cannot start', () => {
    for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('missing') }]) {
      const execute = vi.fn().mockReturnValue(result)
      expect(runBrowserE2E([], settings, execute)).not.toBe(0)
      expect(execute).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects missing settings before dispatch', () => {
    for (const key of Object.keys(settings)) {
      const execute = vi.fn()
      expect(() => runBrowserE2E([], { ...settings, [key]: '' }, execute)).toThrow(key)
      expect(execute).not.toHaveBeenCalled()
    }
  })
  it('keeps discovery offline and explicit reliability selectors available', () => {
    const execute = vi.fn().mockReturnValue({ status: 0 })
    expect(runBrowserE2E(['--list'], {}, execute)).toBe(0)
    expect(execute.mock.calls[0]![2].env.E2E_DISCOVERY).toBe('true')
    execute.mockClear()
    expect(runBrowserE2E(['--project', 'reliability'], {}, execute)).toBe(0)
    expect(execute.mock.calls[0]![2].env.E2E_INCLUDE_RELIABILITY).toBe('true')
  })
  it('rejects a different S3 target or CloudFront URL before dispatch', () => {
    for (const endpoint of ['https://other.s3.us-east-1.amazonaws.com', settings.PLAYBACK_BASE_URL,
      'https://output.s3.us-east-1.amazonaws.com/path']) {
      const execute = vi.fn()
      expect(() => runBrowserE2E([], { ...settings, OUTPUT_S3_ENDPOINT: endpoint }, execute)).toThrow('OUTPUT_S3_ENDPOINT')
      expect(execute).not.toHaveBeenCalled()
    }
  })
})

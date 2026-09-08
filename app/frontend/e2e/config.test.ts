import process from 'node:process'
import { describe, expect, it } from 'vitest'

process.env.E2E_ENVIRONMENT = 'disposable'
process.env.E2E_FRONTEND_URL = 'http://127.0.0.1:5173'
process.env.E2E_API_URL = 'http://127.0.0.1:8000'
process.env.E2E_PROJECT = 'chromium'

const { loadReliabilityConfig } = await import('./config.js')

describe('reliability E2E runtime configuration', () => {
  it('uses non-authorizing defaults for offline discovery', () => {
    process.env.E2E_DISCOVERY = 'true'
    const config = loadReliabilityConfig()
    expect(config.sourceQueue).toBe('discovery-source-queue')
    expect(config.frontendUrl).toBe('http://127.0.0.1:5173')
    delete process.env.E2E_DISCOVERY
  })

  it('requires the disposable opt-in before live identifiers', () => {
    expect(() => loadReliabilityConfig()).toThrow('E2E_RELIABILITY_DISPOSABLE=true')
  })

  it('reports missing inputs by name without exposing values', () => {
    process.env.E2E_RELIABILITY_DISPOSABLE = 'true'
    try {
      loadReliabilityConfig()
      throw new Error('expected missing configuration')
    } catch (error) {
      expect(error).toEqual(expect.any(Error))
      expect((error as Error).message).toBe('E2E_SOURCE_QUEUE is required for reliability E2E tests')
      expect((error as Error).message).not.toContain('127.0.0.1')
    }
    delete process.env.E2E_RELIABILITY_DISPOSABLE
  })
})

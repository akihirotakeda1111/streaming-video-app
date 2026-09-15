import { describe, expect, it } from 'vitest'
import { parseLegacyDeliveryFixtures } from './delivery-fixtures.js'

const inventory = () => ({ capturedAt: '2025-01-01T00:00:00Z', cutoverAt: '2025-02-01T00:00:00Z',
  jobs: ['phase1', 'phase2'].map((phase, index) => {
    const videoId = `${index + 1}1111111-1111-4111-8111-111111111111`
    const jobId = '33333333-3333-4333-8333-333333333333'
    return { phase, videoId, jobId, manifestKey: `videos/${videoId}/jobs/${jobId}/hls/index.m3u8`, manifestETag: '"abcd"' }
  }) })

describe('pre-cutover delivery inventory', () => {
  it('accepts explicit Phase 1 and Phase 2 legacy keys', () => {
    expect(parseLegacyDeliveryFixtures(JSON.stringify(inventory())).jobs).toHaveLength(2)
  })
  it('rejects inventory captured after the cutover', () => {
    expect(() => parseLegacyDeliveryFixtures(JSON.stringify({ ...inventory(), capturedAt: '2025-03-01T00:00:00Z' }))).toThrow()
  })
  it('rejects missing phase coverage, moved keys, missing fingerprints, and duplicate jobs', () => {
    for (const change of [
      (value: ReturnType<typeof inventory>) => { value.jobs[1]!.phase = 'phase1' },
      (value: ReturnType<typeof inventory>) => { value.jobs[0]!.manifestKey = 'moved/index.m3u8' },
      (value: ReturnType<typeof inventory>) => { value.jobs[0]!.manifestETag = '' },
      (value: ReturnType<typeof inventory>) => { value.jobs[1] = value.jobs[0]! },
    ]) {
      const value = inventory()
      change(value)
      expect(() => parseLegacyDeliveryFixtures(JSON.stringify(value))).toThrow()
    }
  })
})

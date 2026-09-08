import { describe, expect, it } from 'vitest'
import { createEvidence, ObservationTimeout, observeUntil, RunResources, safeEvidence } from './evidence.js'

describe('reliability evidence helpers', () => {
  it('creates a run ID and records required evidence fields', () => {
    const evidence = createEvidence(new RunResources().runId, { videoId: 'video-1', jobId: 'job-1', workerId: 'worker-1', attempt: 2 })
    expect(evidence).toMatchObject({ videoId: 'video-1', jobId: 'job-1', workerId: 'worker-1', attempt: 2 })
    expect(evidence.timestamps).toHaveLength(1)
  })

  it('redacts credentials, receipt handles, database URLs, and URL queries', () => {
    const output = JSON.stringify(safeEvidence({
      message: 'https://example.test/a?X-Amz-Signature=secret postgres://user:pass@db.test/app',
      receiptHandle: 'receipt-secret',
    }))
    expect(output).not.toContain('secret')
    expect(output).not.toContain('receipt-secret')
    expect(output).not.toContain('postgres://')
  })

  it('bounds polling and includes the final observation in timeout evidence', async () => {
    let clock = 0
    await expect(observeUntil(async () => 'waiting', () => false, {
      timeoutMs: 10,
      intervalMs: 5,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
    })).rejects.toMatchObject({ evidence: { timeoutMs: 10, lastObservation: 'waiting' } })
    expect(() => new ObservationTimeout({ timeoutMs: 1, startedAt: '', endedAt: '' })).toBeTruthy()
  })

  it('cleans only registered resources after partial setup', async () => {
    const resources = new RunResources()
    const cleaned: string[] = []
    resources.register({ kind: 'fixture', id: 'run/video-1', cleanup: () => { cleaned.push('fixture') } })
    resources.register({ kind: 'database-record', id: 'run/job-1', cleanup: () => { cleaned.push('job') } })
    expect(resources.has('fixture', 'run/video-1')).toBe(true)
    await resources.cleanup()
    expect(cleaned).toEqual(['job', 'fixture'])
    expect(resources.has('fixture', 'run/video-1')).toBe(false)
    expect(() => resources.register({ kind: 'bucket-object', id: 'run/*', cleanup: () => {} })).toThrow()
  })
})

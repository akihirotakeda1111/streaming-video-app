import { describe, expect, it } from 'vitest'
import { observePublication, RECOVERY_BOUND_MS } from './publication-probe.js'

function simulate(publication: number, recovery: number, interval = 250) {
  let clock = 0
  return observePublication({ exists: async () => clock >= publication,
    status: async () => clock >= recovery ? 200 : 403,
    signal: new AbortController().signal, timeoutMs: 200_000,
    now: () => clock, pause: async () => { clock += interval } })
}
describe('publication recovery bound', () => {
  it('excludes long encoding but measures the S3-to-CloudFront recovery window', async () => {
    const result = await simulate(120_000, 121_000)
    expect(result.firstPresentAt).toBe(120_000)
    expect(result.lastAbsentAt).toBe(119_750)
    expect(result.recoveryUpperBoundMs).toBe(1250)
  })
  it('fails prolonged negatives even after minutes of processing, without resetting the deadline', async () => {
    await expect(simulate(120_000, 180_000)).rejects.toThrow('recovery exceeded')
  })
  it('does not accept a late success or a publication missed between sparse observations', async () => {
    await expect(simulate(1000, 1000 + RECOVERY_BOUND_MS)).rejects.toThrow('recovery exceeded')
    await expect(simulate(1000, 1000, 6000)).rejects.toThrow('bracketed')
    await expect(simulate(0, 0)).rejects.toThrow('bracketed')
  })
  it('fails when publication never happens or the observer is cancelled', async () => {
    await expect(simulate(300_000, 300_000)).rejects.toThrow('budget')
    await expect(observePublication({ exists: async () => false, status: async () => 403,
      signal: AbortSignal.abort(), timeoutMs: 1000 })).rejects.toThrow('stopped')
  })
  it('does not turn IAM or unexpected HTTP errors into absence evidence', async () => {
    await expect(observePublication({ exists: async () => { throw new Error('IAM failure') },
      status: async () => 403, signal: new AbortController().signal, timeoutMs: 1000 })).rejects.toThrow('IAM')
    await expect(observePublication({ exists: async () => false,
      status: async () => 500, signal: new AbortController().signal, timeoutMs: 1000 })).rejects.toThrow('Unexpected')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { runRecovery, targetForRun, validateCompletion, type Event, type RecoveryAdapter, type RecoveryReport, type Snapshot } from './recovery-driver.js'
import { parseEvents } from './recovery-adapter.js'
const target = targetForRun('e2e-11111111-1111-4111-8111-111111111111')
function event(outcome: string, at: number, attempt = 1, extra = {}): Event {
  return { outcome, at, attempt, worker_id: attempt === 1 ? 'old' : 'new', ...extra }
}
const received = (at: number): Event => ({ outcome: 'queue_received', at, message_id: 'original', visibility_seconds: 2 })
function processing(attempt = 1, offset = 0): Event[] {
  return [event('acquisition_observed', 1000 + offset, attempt), event('source_downloaded', 1100 + offset, attempt, { source_key: target.sourceKey }),
    event('encode_started', 1200 + offset, attempt), event('lease_renewed', 2200 + offset, attempt),
    event('visibility_extended', 2250 + offset, attempt, { visibility_seconds: 2 }), event('lease_renewed', 3300 + offset, attempt),
    event('visibility_extended', 3350 + offset, attempt, { visibility_seconds: 2 })]
}
function finish(attempt = 1, offset = 0): Event[] {
  return [event('encode_finished', 7000 + offset, attempt),
    event('segment_published', 7100 + offset, attempt, { object_key: target.prefix + 'hls/segment-00000.ts' }),
    event('manifest_published', 7200 + offset, attempt, { object_key: target.prefix + 'hls/index.m3u8' }),
    event('completed', 7300 + offset, attempt), event('record_acknowledged', 7400 + offset, attempt)]
}
function completed(attempt = 1): Snapshot {
  return { job: { status: 'COMPLETED', attempt, worker_id: null, leaseMs: null, databaseNowMs: 16000 },
    events: attempt === 1 ? [received(900), ...processing(), ...finish()]
      : [received(900), ...processing(), received(7900), ...processing(2, 7000), ...finish(2, 7000)] }
}
function fixture(crash: boolean, change: (s: Snapshot) => Snapshot = s => s) {
  let clock = 4000, stopped = false, restarted = false
  const adapter: RecoveryAdapter = {
    heartbeatMs: 1000, maximumAttempts: 3, processingTimeoutMs: 10000, recoveryTimeoutMs: 10000,
    prepare: vi.fn(), upload: vi.fn(), verifyOutput: vi.fn(), cleanup: vi.fn(),
    now: () => clock, sleep: async ms => { clock += ms },
    crash: vi.fn(async () => { stopped = true }),
    restore: vi.fn(async () => { if (stopped) { restarted = true; stopped = false } }),
    observe: vi.fn(async () => {
      if (crash && !restarted) return { events: [received(900), ...processing()],
        job: { status: 'PROCESSING', attempt: 1, worker_id: 'old', leaseMs: 6000, databaseNowMs: clock } }
      clock = 16000
      return change(completed(crash ? 2 : 1))
    }),
  }
  const report: RecoveryReport = { runId: target.runId, target, scenario: crash ? 'crash-recovery' : 'long-heartbeat', status: 'running',
    scenarioStarted: false, cleanup: 'pending', restored: false, events: [], observations: [] }
  return { adapter, report }
}
describe('real recovery orchestration with fake transport', () => {
  it.each([false, true])('completes scenario, restores and cleans with crash=%s', async crash => {
    const { adapter, report } = fixture(crash)
    // Keep the completed observation on time relative to the selected wait budget.
    adapter.processingTimeoutMs = 30000
    await runRecovery(report.scenario, adapter, report)
    expect(report.status).toBe('passed')
    expect(report.cleanup).toBe('complete')
    expect(adapter.crash).toHaveBeenCalledTimes(crash ? 1 : 0)
    expect(adapter.cleanup).toHaveBeenCalledOnce()
    if (crash) expect(report.observations.some(j => j.status === 'PROCESSING' && j.databaseNowMs >= j.leaseMs!)).toBe(true)
  })
  it('refuses crash without attempt budget before setup', async () => {
    const { adapter, report } = fixture(true)
    adapter.maximumAttempts = 1
    await expect(runRecovery(report.scenario, adapter, report)).rejects.toThrow('budget')
    expect(adapter.prepare).not.toHaveBeenCalled()
  })
  it('restores even when the crash command response fails', async () => {
    const { adapter, report } = fixture(true)
    adapter.crash = vi.fn(async () => { throw new Error('crash response lost') })
    await expect(runRecovery(report.scenario, adapter, report)).rejects.toThrow('crash response lost')
    expect(adapter.restore).toHaveBeenCalled()
    expect(report.cleanup).toBe('retained')
    expect(adapter.cleanup).not.toHaveBeenCalled()
  })
  it('retains resources when safe cleanup cannot be verified', async () => {
    const { adapter, report } = fixture(false)
    adapter.observe = async () => ({ events: [], job: { status: 'PROCESSING', attempt: 1, worker_id: 'old', leaseMs: 20000, databaseNowMs: adapter.now() } })
    await expect(runRecovery(report.scenario, adapter, report)).rejects.toThrow('timed out')
    expect(adapter.cleanup).not.toHaveBeenCalled()
    expect(report.cleanup).toBe('retained')
  })
  it.each(['source_downloaded', 'manifest_published', 'lease_renewed', 'visibility_extended', 'record_acknowledged'])('rejects missing %s', outcome => {
    const s = completed()
    s.events = s.events.filter(e => e.outcome !== outcome)
    expect(() => validateCompletion(s, target, 1, 1000)).toThrow()
  })
  it('rejects a short encode and incorrect message identity', () => {
    const short = completed()
    short.events.find(e => e.outcome === 'encode_finished')!.at = 2000
    expect(() => validateCompletion(short, target, 1, 1000)).toThrow('too short')
    const wrong = completed(2)
    wrong.events.filter(e => e.outcome === 'queue_received')[1]!.message_id = 'another'
    expect(() => validateCompletion(wrong, target, 2, 1000)).toThrow('message')
  })
  it('allowlists correlated structured logs and merges publication context', () => {
    const log = JSON.stringify({ timestamp: '2026-09-09T00:00:00Z', span: { worker_id: 'old', attempt: 1 },
      fields: { video_id: target.videoId, job_id: target.jobId, outcome: 'segment_published', object_key: target.prefix + 'hls/segment-00000.ts', receipt_handle: 'secret', database_url: 'secret' } })
    const result = parseEvents('not JSON\n' + log, target)
    expect(result[0]).toMatchObject({ attempt: 1, worker_id: 'old' })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(parseEvents(log.replace(target.jobId, 'other'), target)).toEqual([])
  })
})

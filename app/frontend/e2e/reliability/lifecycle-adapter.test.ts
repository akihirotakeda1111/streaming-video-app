import { describe, expect, it, vi } from 'vitest'
import { DockerLifecycleAdapter } from './lifecycle-adapter.js'
import { duplicateTarget } from './duplicate-driver.js'
import { DockerDuplicateAdapter } from './duplicate-adapter.js'
import type { Scenario } from './lifecycle-driver.js'

function fixture(scenario: Scenario = 'crash-recovery') {
  const worker = 'a'.repeat(64),
    database = 'b'.repeat(64)
  const control = (identity: string) => ({
    identity,
    startedAt: '2026-09-10T00:00:00Z',
    scope: 'owned',
    adapter: 'docker',
    observable: true,
    controllable: true,
    controls: ['stop', 'start'],
    restore: 'start',
  })
  const boundary = {
    status: 'verified',
    account: '123456789012',
    region: 'us-east-1',
    sourceQueue: 'source',
    deadLetterQueue: 'dlq',
    buckets: ['input', 'output'],
    dockerEngine: 'engine',
    worker: control(worker),
    database: control(database),
    workerSettings: { heartbeat: 1, visibility: 4, lease: 4, retry: 4, attempts: 3 },
    alarms: [],
    verifiedAt: 'now',
  }
  const state = {
    running: true,
    startedAt: boundary.worker.startedAt,
    databaseStartedAt: boundary.database.startedAt,
    engine: 'engine',
    scope: 'owned',
    otherWork: 0,
    uncertainStop: false,
    uncertainStart: false,
    failStart: false,
    restartPolicy: 'no',
    schema: 1,
  }
  const calls: string[][] = []
  const execute = (tool: string, args: string[], input?: string) => {
    expect(tool).toBe('docker')
    calls.push(args)
    if (args.includes('info')) return JSON.stringify({ ID: state.engine })
    if (args.includes('inspect')) {
      const id = args.at(-1)!
      return JSON.stringify([
        {
          Id: id,
          State: {
            Running: id === worker ? state.running : true,
            StartedAt: id === worker ? state.startedAt : state.databaseStartedAt,
          },
          Config: {
            Labels: {
              'com.streaming-video.e2e.scope': state.scope,
              'com.streaming-video.e2e.disposable': 'true',
            },
          },
          HostConfig: { RestartPolicy: { Name: state.restartPolicy } },
        },
      ])
    }
    if (args.includes('stop')) {
      state.running = false
      if (state.uncertainStop) throw new Error('timeout')
      return worker
    }
    if (args.includes('start')) {
      if (state.failStart) throw new Error('cannot start')
      state.running = true
      state.startedAt = '2026-09-10T00:01:00Z'
      if (state.uncertainStart) throw new Error('timeout')
      return worker
    }
    if (args.includes('psql') && input?.includes("'active'"))
      return JSON.stringify({ active: state.otherWork })
    if (args.includes('logs'))
      return JSON.stringify({ fields: { heartbeat_observation_schema: state.schema } })
    throw new Error('Unexpected transport operation')
  }
  const env = {
    E2E_PROCESSING_TIMEOUT_MS: '10000',
    E2E_VISIBILITY_TIMEOUT_MS: '5000',
    E2E_NAVIGATION_TIMEOUT_MS: '1000',
    E2E_LEASE_TIMEOUT_MS: '5000',
    E2E_CLOCK_SKEW_MS: '10',
    E2E_DOCKER_HOST: 'unix:///dedicated.sock',
  }
  class TestAdapter extends DockerLifecycleAdapter {
    override readJob() { return super.readJob() }
    override readLogs() { return super.readLogs() }
    setTarget() {
      this.target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
    }
    check() {
      this.unchanged()
    }
  }
  const adapter = new TestAdapter(boundary, scenario, env, execute)
  adapter.setTarget()
  return { adapter, boundary, env, execute, state, calls, worker, database }
}
describe('controlled Docker worker lifecycle', () => {
  it.each(['crash-recovery', 'long-heartbeat'] as const)('discards a 14 ms reversal and reobserves %s', async (scenario) => {
    const { adapter } = fixture(scenario)
    const job = { status: 'PROCESSING', attempt: 1, workerId: 'worker', leaseMs: 5000, observedAtMs: 1000, updatedAtMs: 900 }
    const read = vi.spyOn(adapter, 'readJob').mockReturnValueOnce(job)
      .mockReturnValue({ ...job, observedAtMs: 1105, leaseMs: 6000 })
    const logs = vi.spyOn(adapter, 'readLogs').mockReturnValue('')
    adapter.now = vi.fn().mockReturnValueOnce(1020).mockReturnValueOnce(1006)
      .mockReturnValueOnce(1100).mockReturnValueOnce(1110)
    const snapshot = await adapter.observe()
    expect(read).toHaveBeenCalledTimes(2)
    expect(logs).toHaveBeenCalledTimes(2)
    expect(snapshot).toMatchObject({ localBeforeMs: 1100, localAfterMs: 1110, job: { observedAtMs: 1105, leaseMs: 6000 } })
  })
  it('stops after three reversed observations and retains the last diagnostic', async () => {
    const { adapter } = fixture()
    const read = vi.spyOn(adapter, 'readJob').mockReturnValue({ status: 'PROCESSING', attempt: 1, workerId: 'worker', leaseMs: 5000, observedAtMs: 1000, updatedAtMs: 900 })
    vi.spyOn(adapter, 'readLogs').mockReturnValue('')
    let call = 0
    adapter.now = () => call++ % 2 === 0 ? 1020 : 1006
    await expect(adapter.observe()).rejects.toMatchObject({ clockDiagnostic: { cause: 'local_clock_reversed', excessMs: 14, localBeforeMs: 1020, localAfterMs: 1006 } })
    expect(read).toHaveBeenCalledTimes(3)
  })
  it.each([800, 1200])('does not retry DB clock skew violations (%s)', async (observedAtMs) => {
    const { adapter } = fixture()
    const read = vi.spyOn(adapter, 'readJob').mockReturnValue({ status: 'PROCESSING', attempt: 1, workerId: 'worker', leaseMs: 5000, observedAtMs, updatedAtMs: 900 })
    vi.spyOn(adapter, 'readLogs').mockReturnValue('')
    adapter.now = () => 1000
    await expect(adapter.observe()).rejects.toThrow('Database clock is outside')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('does not retry DB read failures', async () => {
    const { adapter } = fixture()
    const read = vi.spyOn(adapter, 'readJob').mockImplementation(() => { throw new Error('DB unavailable') })
    vi.spyOn(adapter, 'readLogs').mockReturnValue('')
    await expect(adapter.observe()).rejects.toThrow('DB unavailable')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('stops abruptly and restores only the same verified worker; DB remains running', async () => {
    const f = fixture()
    await f.adapter.stop()
    f.adapter.check() // Read-only DB observations remain possible while stopped.
    await f.adapter.restore()
    f.adapter.check()
    expect(f.calls.filter((a) => a.includes('stop') || a.includes('start'))).toEqual([
      [
        '--host',
        f.env.E2E_DOCKER_HOST,
        'container',
        'stop',
        '--signal',
        'SIGKILL',
        '--timeout',
        '0',
        f.worker,
      ],
      ['--host', f.env.E2E_DOCKER_HOST, 'container', 'start', f.worker],
    ])
    await f.adapter.restore()
    expect(f.calls.filter((a) => a.includes('start'))).toHaveLength(1)
  })
  it.each(['engine', 'scope', 'databaseStartedAt', 'startedAt'] as const)(
    'rejects changed %s before any control',
    async (field) => {
      const f = fixture()
      f.state[field] = 'changed'
      await expect(f.adapter.stop()).rejects.toThrow('changed')
      expect(f.calls.some((a) => a.includes('stop') || a.includes('start'))).toBe(false)
    },
  )
  it('refuses controls for long heartbeat or when other active work appears', async () => {
    const long = fixture('long-heartbeat')
    await expect(long.adapter.stop()).rejects.toThrow('Unexpected')
    const f = fixture()
    f.state.otherWork = 1
    await expect(f.adapter.stop()).rejects.toThrow('Other work')
    expect(f.calls.some((a) => a.includes('stop'))).toBe(false)
  })
  it('restores when an uncertain stop actually took effect', async () => {
    const f = fixture()
    f.state.uncertainStop = true
    await expect(f.adapter.stop()).rejects.toThrow()
    await f.adapter.restore()
    expect(f.state.running).toBe(true)
  })
  it('does not accept an external restart as its own restoration', async () => {
    const f = fixture()
    await f.adapter.stop()
    f.state.running = true
    f.state.startedAt = 'external-start'
    await expect(f.adapter.restore()).rejects.toThrow('outside')
    expect(f.calls.some((a) => a.includes('start'))).toBe(false)
  })
  it('records uncertain start as a failure while preserving verified restoration', async () => {
    const f = fixture()
    await f.adapter.stop()
    f.state.uncertainStart = true
    await expect(f.adapter.restore()).rejects.toThrow('response was uncertain')
    f.adapter.check()
    await f.adapter.restore()
    expect(f.calls.filter((a) => a.includes('start'))).toHaveLength(1)
  })
  it('retries restoration without deleting data when start failed', async () => {
    const f = fixture()
    await f.adapter.stop()
    f.state.failStart = true
    await expect(f.adapter.restore()).rejects.toThrow('restoration failed')
    f.state.failStart = false
    await f.adapter.restore()
    expect(f.state.running).toBe(true)
  })
  it('validates observation schema and restart policy before preparing resources', async () => {
    const prepare = vi.spyOn(DockerDuplicateAdapter.prototype, 'prepare').mockResolvedValue()
    try {
      const f = fixture()
      const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
      f.state.restartPolicy = 'always'
      await expect(f.adapter.prepare(target)).rejects.toThrow('restart policy')
      f.state.restartPolicy = 'no'
      f.state.schema = 0
      await expect(f.adapter.prepare(target)).rejects.toThrow('schema 1')
      expect(prepare).not.toHaveBeenCalled()
      f.state.schema = 1
      await f.adapter.prepare(target)
      expect(prepare).toHaveBeenCalledWith(target)
    } finally {
      prepare.mockRestore()
    }
  })
  it('requires explicit clock tolerance and a spare crash attempt', () => {
    const f = fixture()
    for (const skew of ['', '0', '-1', 'NaN', '5001'])
      expect(
        () =>
          new DockerLifecycleAdapter(
            f.boundary,
            'crash-recovery',
            { ...f.env, E2E_CLOCK_SKEW_MS: skew },
            f.execute,
          ),
      ).toThrow('E2E_CLOCK_SKEW_MS')
    expect(
      () =>
        new DockerLifecycleAdapter(
          { ...f.boundary, workerSettings: { ...f.boundary.workerSettings, attempts: 1 } },
          'crash-recovery',
          f.env,
          f.execute,
        ),
    ).toThrow('remaining attempt')
  })
})

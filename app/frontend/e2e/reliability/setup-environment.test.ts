import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupEnvironment } from '../../../scripts/setup_reliability_env.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reliability-setup-'))
  roots.push(root)
  const valid = join(root, "normal video's 動画.mp4"), invalid = join(root, 'invalid.mp4')
  writeFileSync(valid, 'normal placeholder'); writeFileSync(invalid, 'invalid')
  const runtime = {
    AWS_REGION: 'us-east-1', VIDEO_INPUT_BUCKET: 'input', VIDEO_OUTPUT_BUCKET: 'output',
    VIDEO_ENCODING_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/source',
    WORKER_HEARTBEAT_INTERVAL_SECONDS: '5', WORKER_VISIBILITY_EXTENSION_SECONDS: '30',
    WORKER_LEASE_DURATION_SECONDS: '30', WORKER_RETRY_DELAY_SECONDS: '10',
    WORKER_MAXIMUM_ATTEMPTS: '3', FRONTEND_ORIGIN: 'http://localhost:5173',
  }
  const state = { fail: '', stale: false }
  const execute = vi.fn((tool, args, options) => {
    if (state.fail === tool) throw new Error('private-value')
    if (tool === 'terraform') return JSON.stringify(runtime)
    expect(options.env.VIDEO_INPUT_BUCKET).toBe('input')
    if (args.includes('ps')) return args.at(-1) === 'worker' ? 'a'.repeat(64) : 'b'.repeat(64)
    if (args.includes('inspect')) return JSON.stringify([{ Config: { Env: Object.entries(runtime)
      .map(([name, value]) => `${name}=${state.stale && name === 'VIDEO_INPUT_BUCKET' ? 'old' : value}`) } }])
    return ''
  })
  const discover = vi.fn((options, command) => {
    command('aws', ['sts'], { env: { AWS_PROFILE: 'runner' } })
    return { E2E_VALID_FIXTURE: options.fixture, E2E_INVALID_FIXTURE: options.invalidFixture }
  })
  const options = { account: '123456789012', fixture: valid, 'invalid-fixture': invalid,
    'clock-skew-ms': '100', 'terraform-directory': root, 'docker-host': 'unix:///var/run/docker.sock' }
  return { root, valid, runtime, options, execute, discover, state }
}
describe('Linux reliability setup orchestration', () => {
  it.each([false, true])('loads settings with optional Worker startup: %s', (start) => {
    const f = fixture(), before = { ...process.env }
    const result = setupEnvironment({ ...f.options, 'start-worker': start }, f.execute, f.discover)
    expect(result.E2E_VALID_FIXTURE).toBe(f.valid)
    expect(result.VIDEO_ENCODING_QUEUE_URL).toBe(f.runtime.VIDEO_ENCODING_QUEUE_URL)
    expect(f.execute.mock.calls[0][0]).toBe('terraform')
    expect(f.execute.mock.calls.filter(([, args]) => args.includes('up'))).toHaveLength(start ? 1 : 0)
    expect(f.execute.mock.calls.every(([tool, args]) => tool !== 'docker' || args.slice(0, 2).join(' ') === '--host unix:///var/run/docker.sock')).toBe(true)
    expect(f.discover.mock.calls[0][0]).toMatchObject({ full: true, disposable: true, clockSkewMs: '100' })
    expect(process.env).toEqual(before)
  })
  it.each(['terraform', 'docker', 'aws'])('stops on %s failure without changing the host environment', (tool) => {
    const f = fixture(), before = { ...process.env }
    f.state.fail = tool
    expect(() => setupEnvironment(f.options, f.execute, f.discover)).toThrow('Shell settings were not changed')
    expect(process.env).toEqual(before)
    if (tool !== 'aws') expect(f.discover).not.toHaveBeenCalled()
  })
  it('rejects stale Worker settings before discovery', () => {
    const f = fixture(); f.state.stale = true
    expect(() => setupEnvironment(f.options, f.execute, f.discover)).toThrow('Worker/Terraform consistency')
    expect(f.discover).not.toHaveBeenCalled()
  })
  it.each(['unknown', 'newline', 'account'])('rejects invalid Terraform output: %s', (kind) => {
    const f = fixture()
    if (kind === 'unknown') Object.assign(f.runtime, { PATH: 'untrusted' })
    if (kind === 'newline') f.runtime.AWS_REGION = 'us-east-1\nPATH=untrusted'
    if (kind === 'account') f.runtime.VIDEO_ENCODING_QUEUE_URL = f.runtime.VIDEO_ENCODING_QUEUE_URL.replace('123456789012', '999999999999')
    expect(() => setupEnvironment({ ...f.options, 'start-worker': true }, f.execute, f.discover)).toThrow('Terraform output')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it.each(['npipe:////./pipe/docker_engine', 'tcp://remote:2375'])('rejects non-Linux or remote Docker endpoints: %s', (host) => {
    const f = fixture()
    expect(() => setupEnvironment({ ...f.options, 'docker-host': host }, f.execute, f.discover)).toThrow('local inputs')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects generated multiline values before returning any settings', () => {
    const f = fixture()
    f.discover.mockReturnValue({ E2E_VALID_FIXTURE: 'bad\nvalue', E2E_INVALID_FIXTURE: '' })
    expect(() => setupEnvironment(f.options, f.execute, f.discover)).toThrow('E2E generation')
  })
})

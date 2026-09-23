import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverEnvironment, runtimeLayout, ROOT } from '../../../scripts/generate_scalability_env.mjs'
import { setupEnvironment } from '../../../scripts/setup_scalability_env.mjs'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scalability-setup-')))
  roots.push(root)
  for (const role of ['delivery', 'compute']) {
    const dir = join(root, role), data = join(dir, 'tf-data'), state = join(dir, 'terraform.tfstate')
    mkdirSync(data, { recursive: true })
    writeFileSync(state, '{}')
    writeFileSync(join(dir, 'backend.tfbackend'), `path = ${JSON.stringify(state)}\n`)
    writeFileSync(join(data, 'terraform.tfstate'), JSON.stringify({ backend: { type: 'local', config: { path: state } } }))
  }
  const options = { runtime: root, account: '123456789012', 'api-url': 'https://api.example.com',
    'frontend-url': 'http://localhost:5173', fixture: join(root, "fixture ' 日本語.mp4") }
  writeFileSync(options.fixture, 'mock video')
  const writeVars = (role: string, values: Record<string, unknown>) => writeFileSync(join(root, role,
    role === 'delivery' ? 'terraform.tfvars' : 'compute.tfvars'), Object.entries(values).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n'))
  writeVars('delivery', { aws_account_id: options.account, aws_region: 'ap-northeast-1', instance: 'load', frontend_origin: options['frontend-url'] })
  const compute = { allowed_account_ids: [options.account], aws_region: 'ap-northeast-1', project_name: 'streaming-video',
    environment: 'scale-e2e-load', frontend_origin: options['frontend-url'], shared_state_path: join(root, 'delivery', 'terraform.tfstate'),
    worker_autoscaling_enabled: true, worker_autoscaling_min_capacity: 1, worker_autoscaling_max_capacity: 4,
    worker_acceptable_queue_delay_seconds: 900, worker_representative_processing_seconds: 300,
    worker_scale_out_cooldown_seconds: 180, worker_scale_in_cooldown_seconds: 600 }
  writeVars('compute', compute)
  const outputs: Record<string, string> = { aws_region: 'ap-northeast-1', environment_identity: 'scalability-e2e-load',
    video_input_bucket_name: 'sv-scale-e2e-load-123456789012-ap-northeast-1-input', playback_base_url: 'https://example.cloudfront.net',
    video_encoding_queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/streaming-video-scalability-e2e-load-encoding',
    ecs_cluster: 'streaming-video-scale-e2e-load', api_service: 'streaming-video-scale-e2e-load-api', worker_service: 'streaming-video-scale-e2e-load-worker',
    orchestration_state_machine: 'arn:aws:states:ap-northeast-1:123456789012:stateMachine:streaming-video-scale-e2e-load-orchestration',
    api_image_digest: `sha256:${'a'.repeat(64)}`, worker_image_digest: `sha256:${'b'.repeat(64)}` }
  const state = { height: 720, duration: '150', account: options.account, checkFails: false, cors: true }
  const execute = vi.fn((tool: string, args: readonly string[], opts: any) => {
    if (tool === 'terraform' && args.includes('output')) {
      expect(opts.env.TF_WORKSPACE).toBe('default')
      expect(opts.env.TF_CLI_ARGS_output).toBeUndefined()
      expect(opts.env.TF_DATA_DIR).toMatch(/tf-data$/)
      return JSON.stringify(outputs[args.at(-1)!])
    }
    if (tool === 'aws' && args[0] === 'sts') return JSON.stringify({ Account: state.account, Secret: 'do-not-emit' })
    if (tool === 'ffprobe' && args[0] === '-v') return JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: state.height, duration: state.duration }] })
    if (tool === 'python' && args.includes('--check')) {
      expect(JSON.parse(readFileSync(opts.env.SCALABILITY_E2E_CONFIG, 'utf8')).fixture_duration_seconds).toBe(150)
      if (state.checkFails) throw Error('private-diagnostic')
    }
    return ''
  })
  const request = vi.fn(async () => new Response(null, { status: 200, headers: {
    'access-control-allow-origin': state.cors ? options['frontend-url'] : '*',
    'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'Content-Type',
  } }))
  return { root, options, outputs, execute, request, state, compute, writeVars }
}

it('publishes a private handoff only after check and uses only read-only commands', async () => {
  const f = fixture()
  vi.stubEnv('TF_CLI_ARGS_output', '-state=wrong.tfstate')
  const settings = await setupEnvironment(f.options, f.execute, f.request)
  expect(settings.SCALABILITY_E2E_CONFIG).toBe(join(f.root, 'handoff.json'))
  expect(settings.SCALABILITY_E2E_EVIDENCE_ROOT).toBe(join(f.root, 'evidence'))
  expect(settings).not.toHaveProperty('SCALABILITY_E2E_ALLOW_LIVE')
  expect(settings).not.toHaveProperty('SCALABILITY_E2E_EVIDENCE_DIR')
  expect(readFileSync(settings.SCALABILITY_E2E_CONFIG, 'utf8')).not.toContain('do-not-emit')
  expect(f.execute.mock.calls.filter(([tool]) => tool === 'aws').map(([, args]) => args.slice(0, 2))).toEqual([['--version'], ['sts', 'get-caller-identity']])
  expect(f.execute.mock.calls.filter(([tool]) => tool === 'terraform').every(([, args]) => args[0] === 'version' || args[1] === 'output')).toBe(true)
  expect(f.execute.mock.calls.some(([, args]) => args.includes('--full'))).toBe(false)
  expect(await setupEnvironment(f.options, f.execute, f.request)).toEqual(settings)
})
it('rejects initialized backend mismatch before CLI discovery', () => {
  const f = fixture()
  writeFileSync(join(f.root, 'compute', 'tf-data', 'terraform.tfstate'), JSON.stringify({ backend: { type: 'local', config: { path: join(f.root, 'delivery', 'terraform.tfstate') } } }))
  expect(() => discoverEnvironment(f.options, f.execute)).toThrow('backend path')
  expect(f.execute).not.toHaveBeenCalled()
})
it('rejects a non-default workspace', () => {
  const f = fixture()
  writeFileSync(join(f.root, 'compute', 'tf-data', 'environment'), 'production')
  expect(() => runtimeLayout(f.root)).toThrow('workspace')
})
it.each(['account', 'height', 'duration', 'fixed', 'custom-url'])('rejects invalid %s', kind => {
  const f = fixture()
  if (kind === 'account') f.state.account = '999999999999'
  if (kind === 'height') f.state.height = 360
  if (kind === 'duration') f.state.duration = 'Infinity'
  if (kind === 'fixed') f.writeVars('compute', { ...f.compute, worker_autoscaling_max_capacity: 5 })
  if (kind === 'custom-url') f.options['api-url'] = 'https://private:secret@api.example.com'
  expect(() => discoverEnvironment(f.options, f.execute)).toThrow()
})
it.each(['check', 'cors'])('does not publish handoff when %s fails', async kind => {
  const f = fixture()
  f.state.checkFails = kind === 'check'; f.state.cors = kind !== 'cors'
  await expect(setupEnvironment(f.options, f.execute, f.request)).rejects.toThrow('Shell settings were not changed')
  expect(existsSync(join(f.root, 'handoff.json'))).toBe(false)
})
it('preserves an existing different handoff', async () => {
  const f = fixture()
  writeFileSync(join(f.root, 'handoff.json'), '{"retained":true}')
  await expect(setupEnvironment(f.options, f.execute, f.request)).rejects.toThrow()
  expect(readFileSync(join(f.root, 'handoff.json'), 'utf8')).toBe('{"retained":true}')
})

it('generated handoff passes the real offline runner and invalid budget fails', () => {
  const f = fixture(), config = discoverEnvironment(f.options, f.execute).config
  const path = join(f.root, 'handoff.json')
  const check = () => execFileSync(process.env.SCALABILITY_TEST_PYTHON || 'python',
    [join(ROOT, 'app/scripts/run_scalability_e2e.py'), '--check'], {
      encoding: 'utf8', env: { ...process.env, SCALABILITY_E2E_CONFIG: path }, stdio: ['ignore', 'pipe', 'pipe'],
    })
  writeFileSync(path, JSON.stringify(config))
  expect(JSON.parse(check()).batchSize).toBe(5)
  writeFileSync(path, JSON.stringify({ ...config, runtime_budget_seconds: 1 }))
  expect(check).toThrow()
})

it('Bash wrapper exports literal values and preserves all variables on failure', () => {
  const script = `
node() { printf '%s\\n' 'AWS_REGION=ap-northeast-1' 'SCALABILITY_E2E_CONFIG=/private/path with spaces/handoff.json'; }
source app/scripts/setup_scalability_env.sh || exit 10
[[ $AWS_REGION == ap-northeast-1 && $SCALABILITY_E2E_CONFIG == '/private/path with spaces/handoff.json' ]] || exit 11
node() { printf '%s\\n' 'AWS_REGION=bad'; return 2; }
if source app/scripts/setup_scalability_env.sh; then exit 12; fi
[[ $AWS_REGION == ap-northeast-1 ]] || exit 13
readonly AWS_DEFAULT_REGION=retained
node() { printf '%s\\n' 'AWS_REGION=bad' 'AWS_DEFAULT_REGION=bad'; }
if source app/scripts/setup_scalability_env.sh; then exit 14; fi
[[ $AWS_REGION == ap-northeast-1 && $AWS_DEFAULT_REGION == retained ]] || exit 15
`
  expect(() => execFileSync(process.env.SCALABILITY_TEST_BASH || 'bash', ['--noprofile', '--norc', '-c', script],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })).not.toThrow()
})

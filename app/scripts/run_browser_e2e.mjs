import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizePlaybackBaseURL } from './generate_reliability_env.mjs'

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url))
const cli = fileURLToPath(new URL('../frontend/node_modules/@playwright/test/cli.js', import.meta.url))

/** @param {string[]} args */
export function runBrowserE2E(args, env = process.env, execute = spawnSync) {
  const child = { ...env }
  const discovery = args.includes('--list')
  if (discovery) Object.assign(child, {
    E2E_ENVIRONMENT: 'disposable', E2E_DISCOVERY: 'true',
    E2E_FRONTEND_URL: 'http://127.0.0.1:5173', E2E_API_URL: 'http://127.0.0.1:8000',
  })
  if (args.includes('--project=reliability') || args.some((a, i) => a === '--project' && args[i + 1] === 'reliability')) {
    child.E2E_INCLUDE_RELIABILITY = 'true'
  }
  /** @param {string[]} options */
  const run = options => {
    const result = execute(process.execPath, [cli, 'test', ...options], { cwd: frontend, env: child, stdio: 'inherit' })
    if (result.error || result.signal) return 2
    return result.status ?? 2
  }
  // Preserve explicit selectors and offline discovery. The default command is the CI suite.
  if (args.length) return run(args)
  for (const name of ['AWS_REGION', 'E2E_OUTPUT_BUCKET', 'E2E_AWS_ACCOUNT_ID', 'PLAYBACK_BASE_URL', 'OUTPUT_S3_ENDPOINT']) {
    if (!child[name]?.trim()) throw new Error(`${name} is required for browser delivery E2E`)
  }
  if (!/^\d{12}$/.test(child.E2E_AWS_ACCOUNT_ID ?? '')) throw new Error('E2E_AWS_ACCOUNT_ID must contain 12 digits')
  child.PLAYBACK_BASE_URL = normalizePlaybackBaseURL(child.PLAYBACK_BASE_URL ?? '')
  const outputEndpoint = `https://${child.E2E_OUTPUT_BUCKET}.s3.${child.AWS_REGION}.amazonaws.com`
  if (child.OUTPUT_S3_ENDPOINT?.replace(/\/$/, '') !== outputEndpoint) {
    throw new Error('OUTPUT_S3_ENDPOINT must match the dedicated regional output bucket')
  }
  child.OUTPUT_S3_ENDPOINT = outputEndpoint
  delete child.E2E_DISCOVERY
  delete child.E2E_INCLUDE_RELIABILITY
  delete child.E2E_INCLUDE_DELIVERY_REPLAY
  delete child.E2E_RUN_ID
  delete child.E2E_PLAYBACK_EVIDENCE_RUN
  delete child.E2E_LEGACY_DELIVERY_FIXTURES
  child.PLAYWRIGHT_HTML_OPEN = 'never'
  const gate = run(['--grep', '@preflight', '--retries', '0'])
  if (gate !== 0) return gate
  return run(['--grep-invert', '@preflight'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runBrowserE2E(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : 'Browser E2E could not start'); process.exitCode = 2 }
}

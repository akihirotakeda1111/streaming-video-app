import { execFile } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const frontendDir = fileURLToPath(new URL('..', import.meta.url))
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))

async function listTests(project: string, discovery = false): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('E2E_')))
  const { stdout } = await execute(
    process.execPath,
    [playwrightCli, 'test', '--list', `--project=${project}`, '--reporter=list'],
    {
      cwd: frontendDir,
      timeout: 20_000,
      env: {
        ...env,
        E2E_ENVIRONMENT: 'disposable',
        E2E_FRONTEND_URL: 'http://127.0.0.1:5173',
        E2E_API_URL: 'http://127.0.0.1:8000',
        E2E_PROJECT: project === 'reliability' ? 'chromium' : project,
        ...(discovery ? { E2E_DISCOVERY: 'true' } : {}),
      },
    },
  )
  return stdout
}

describe('Playwright project isolation', () => {
  it.each(['chromium', 'firefox', 'webkit'])(
    'keeps reliability and helper tests out of %s',
    async (project) => {
      const output = await listTests(project)
      expect(output).toContain(`[${project}]`)
      expect(output).toContain('@phase1-pipeline')
      expect(output).not.toContain('@reliability')
      expect(output).not.toContain('runtime.spec.ts')
      expect(output).not.toContain('.test.ts')
    },
    30_000,
  )

  it('discovers only reliability specs without live inputs or opt-in', async () => {
    const output = await listTests('reliability', true)
    expect(output).toContain('[reliability]')
    expect(output).toContain('runtime.spec.ts')
    expect(output).not.toContain('@phase1-pipeline')
    expect(output).not.toContain('.test.ts')
  }, 30_000)
})

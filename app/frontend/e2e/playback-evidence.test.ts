import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { persistPlaybackEvidence } from './playback-evidence.js'

it('persists correlated, redacted observations on success and failure without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playback-evidence-'))
  try {
    for (const passed of [true, false]) {
      const runId = passed ? 'e2e-11111111-1111-4111-8111-111111111111' : 'e2e-22222222-2222-4222-8222-222222222222'
      const directory = join(root, runId)
      await mkdir(directory)
      const env = { E2E_RUN_ID: runId, E2E_EVIDENCE_DIR: directory }
      const diagnostics = {
        'pipeline-status': { videoId: 'video', jobId: 'job', jobStatus: passed ? 'COMPLETED' : 'PROCESSING' },
        'browser-playback': { advancement: passed ? 0.2 : undefined },
        'direct-upload-network': { url: 'https://example.test/upload?token=private-value' },
      }
      await persistPlaybackEvidence(diagnostics, passed, env)
      const text = await readFile(join(directory, 'phase1-pipeline-evidence.json'), 'utf8')
      expect(text).not.toContain('private-value')
      expect(JSON.parse(text)).toMatchObject({
        scenario: 'phase1-pipeline', runId, status: passed ? 'passed' : 'failed', videoId: 'video', jobId: 'job',
        diagnostics: { 'pipeline-status': diagnostics['pipeline-status'] },
      })
      if (passed) expect(JSON.parse(text).diagnostics['browser-playback'].advancement).toBe(0.2)
      await expect(persistPlaybackEvidence(diagnostics, passed, env)).rejects.toThrow()
      expect(await readFile(join(directory, 'phase1-pipeline-evidence.json'), 'utf8')).toBe(text)
    }
    await persistPlaybackEvidence({}, false, {})
    await persistPlaybackEvidence({}, false, { E2E_EVIDENCE_DIR: root })
    await expect(persistPlaybackEvidence({}, false, { E2E_RUN_ID: 'invalid', E2E_EVIDENCE_DIR: root })).rejects.toThrow('run-scoped')
    expect(await readdir(root)).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

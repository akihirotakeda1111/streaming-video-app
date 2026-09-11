import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachSafeDiagnostic, safeDiagnostic } from '../diagnostics.js'
import { verifyLiveBoundary } from './safety.mjs'
import { duplicateTarget } from './duplicate-driver.js'
import { DockerFfmpegExhaustionAdapter } from './ffmpeg-exhaustion-adapter.js'
import { runFfmpegExhaustion, type ExhaustionSnapshot } from './ffmpeg-exhaustion-driver.js'

test.describe('@ffmpeg-exhaustion', () => {
  test('invalid media exhausts FFmpeg attempts and is isolated in the run-owned DLQ', async ({}, testInfo) => {
    test.setTimeout(900000)
    let report: Record<string, unknown> = { scenario: 'ffmpeg-exhaustion', status: 'unverified', scenarioStarted: false, liveResourcesVerified: false, runId: process.env.E2E_RUN_ID }
    let destination: string | undefined
    let adapter: DockerFfmpegExhaustionAdapter | undefined
    try {
      const boundary = verifyLiveBoundary()
      report = { ...report, liveResourcesVerified: true, verification: boundary }
      const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
      const target = duplicateTarget(runId)
      const directory = process.env.E2E_EVIDENCE_DIR || join(process.env.E2E_EVIDENCE_DIR!, runId)
      await mkdir(directory, { recursive: true })
      destination = join(directory, 'ffmpeg-exhaustion-evidence.json')
      adapter = new DockerFfmpegExhaustionAdapter(boundary)
      const snapshots: ExhaustionSnapshot[] = []
      const original = adapter.observe.bind(adapter)
      adapter.observe = async () => { const value = await original(); snapshots.push(value); return value }
      await writeFile(destination, JSON.stringify(safeDiagnostic({ ...report, target, snapshots }), null, 2) + '\n', { flag: 'wx' })
      await runFfmpegExhaustion(adapter, target)
      await adapter.cleanup()
      report = { ...report, target, snapshots, status: 'passed', scenarioStarted: true, cleanup: 'retained-dlq-message-visible-for-human-run-cleanup' }
    } catch {
      report = { ...report, status: 'unverified', reason: 'FFmpeg exhaustion setup, observation, or cleanup did not complete' }
      throw new Error('FFmpeg exhaustion did not pass; inspect redacted run evidence')
    } finally {
      const safe = safeDiagnostic(report)
      if (destination) await writeFile(destination, JSON.stringify(safe, null, 2) + '\n')
      await attachSafeDiagnostic(testInfo, 'ffmpeg-exhaustion-evidence', safe)
    }
  })
})

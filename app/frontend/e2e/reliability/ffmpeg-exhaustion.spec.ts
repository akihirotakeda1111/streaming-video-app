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
    let report: Record<string, unknown> = {
      scenario: 'ffmpeg-exhaustion',
      status: 'unverified',
      scenarioStarted: false,
      liveResourcesVerified: false,
      runId: process.env.E2E_RUN_ID,
    }
    let destination: string | undefined
    let evidenceCreated = false
    let adapter: DockerFfmpegExhaustionAdapter | undefined
    try {
      const boundary = verifyLiveBoundary()
      report = { ...report, liveResourcesVerified: true, verification: boundary }
      const runId = process.env.E2E_RUN_ID || `e2e-${randomUUID()}`
      const target = duplicateTarget(runId)
      const directory = process.env.E2E_EVIDENCE_DIR!
      await mkdir(directory, { recursive: true })
      destination = join(directory, 'ffmpeg-exhaustion-evidence.json')
      const snapshots: ExhaustionSnapshot[] = []
      report = { ...report, runId, target, snapshots, phase: 'setup', cleanup: 'not-started' }
      adapter = new DockerFfmpegExhaustionAdapter(boundary)
      test.setTimeout(
        adapter.exhaustionMs +
          adapter.stabilityMs +
          Number(process.env.E2E_UPLOAD_TIMEOUT_MS) +
          adapter.processingMs +
          180000,
      )
      const original = adapter.observe.bind(adapter)
      adapter.observe = async (receiveDlq) => {
        const value = await original(receiveDlq)
        snapshots.push(value)
        return value
      }
      await writeFile(
        destination,
        JSON.stringify(safeDiagnostic({ ...report, target, snapshots }), null, 2) + '\n',
        { flag: 'wx' },
      )
      evidenceCreated = true
      report = {
        ...report,
        scenarioStarted: true,
        phase: 'scenario',
        cleanup: 'retained-until-verified',
      }
      await runFfmpegExhaustion(adapter, target)
      report = { ...report, phase: 'cleanup' }
      await adapter.cleanup()
      report = {
        ...report,
        target,
        snapshots,
        status: 'passed',
        scenarioStarted: true,
        cleanup: 'retained-dlq-message-visible-for-human-run-cleanup',
      }
    } catch (error) {
      report = {
        ...report,
        status: 'unverified',
        reason:
          error instanceof Error
            ? error.message
            : 'FFmpeg exhaustion setup, observation, or cleanup did not complete',
      }
      throw new Error('FFmpeg exhaustion did not pass; inspect redacted run evidence')
    } finally {
      const safe = safeDiagnostic(report)
      if (destination && evidenceCreated)
        await writeFile(destination, JSON.stringify(safe, null, 2) + '\n')
      await attachSafeDiagnostic(testInfo, 'ffmpeg-exhaustion-evidence', safe)
    }
  })
})

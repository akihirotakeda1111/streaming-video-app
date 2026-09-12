import { writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { safeDiagnostic, type SafeDiagnostic } from './diagnostics.js'

/** Persist the full runner's final upload evidence without changing standalone playback. */
export async function persistPlaybackEvidence(
  diagnostics: Record<string, SafeDiagnostic>,
  passed: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runId = env.E2E_RUN_ID
  const directory = env.E2E_EVIDENCE_DIR
  if (!runId) return
  if (!/^e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)
    || !directory || !isAbsolute(directory) || basename(directory) !== runId) {
    throw new Error('Playback evidence requires a run-scoped destination')
  }
  const report: Record<string, unknown> = {
    scenario: 'phase1-pipeline', runId, status: passed ? 'passed' : 'failed',
    observedAt: new Date().toISOString(),
    videoId: diagnostics['pipeline-status']?.videoId,
    jobId: diagnostics['pipeline-status']?.jobId,
    diagnostics,
  }
  const evidence = safeDiagnostic(report)
  await writeFile(join(directory, 'phase1-pipeline-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
}

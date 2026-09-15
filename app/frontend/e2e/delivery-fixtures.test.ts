import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDeliveryTargets, parseLegacyDeliveryFixtures, parsePlaybackRunEvidence } from './delivery-fixtures.js'

const inventory = () => ({ capturedAt: '2025-01-01T00:00:00Z', cutoverAt: '2025-02-01T00:00:00Z',
  jobs: ['phase1', 'phase2'].map((phase, index) => {
    const videoId = `${index + 1}1111111-1111-4111-8111-111111111111`
    const jobId = '33333333-3333-4333-8333-333333333333'
    return { phase, videoId, jobId, manifestKey: `videos/${videoId}/jobs/${jobId}/hls/index.m3u8`, manifestETag: '"abcd"' }
  }) })

describe('pre-cutover delivery inventory', () => {
  it('accepts explicit Phase 1 and Phase 2 legacy keys', () => {
    expect(parseLegacyDeliveryFixtures(JSON.stringify(inventory())).jobs).toHaveLength(2)
  })
  it('rejects inventory captured after the cutover', () => {
    expect(() => parseLegacyDeliveryFixtures(JSON.stringify({ ...inventory(), capturedAt: '2025-03-01T00:00:00Z' }))).toThrow()
  })
  it('rejects missing phase coverage, moved keys, missing fingerprints, and duplicate jobs', () => {
    for (const change of [
      (value: ReturnType<typeof inventory>) => { value.jobs[1]!.phase = 'phase1' },
      (value: ReturnType<typeof inventory>) => { value.jobs[0]!.manifestKey = 'moved/index.m3u8' },
      (value: ReturnType<typeof inventory>) => { value.jobs[0]!.manifestETag = '' },
      (value: ReturnType<typeof inventory>) => { value.jobs[1] = value.jobs[0]! },
    ]) {
      const value = inventory()
      change(value)
      expect(() => parseLegacyDeliveryFixtures(JSON.stringify(value))).toThrow()
    }
  })
})

const sourceRun = 'e2e-11111111-1111-4111-8111-111111111111'
function playbackEvidence() {
  const job = inventory().jobs[0]!
  return { scenario: 'phase1-pipeline', status: 'passed', runId: sourceRun,
    observedAt: '2025-01-01T00:00:00Z', videoId: job.videoId, jobId: job.jobId,
    diagnostics: {
      'pipeline-status': { videoId: job.videoId, jobId: job.jobId, jobStatus: 'COMPLETED' },
      'browser-playback': { delivery: { outputBucket: 'output', manifestKey: job.manifestKey, manifestETag: job.manifestETag } },
    } }
}

describe('completed playback run selection', () => {
  it('reuses a successful run without claiming pre-cutover compatibility', () => {
    const targets = parsePlaybackRunEvidence(JSON.stringify(playbackEvidence()), sourceRun, 'output')
    expect(targets.verificationScope).toBe('completed-job-replay')
    expect(targets.sourceRunId).toBe(sourceRun)
    expect(targets.cutoverAt).toBeUndefined()
    expect(targets.jobs[0]!.manifestETag).toBe('"abcd"')
  })
  it('rejects failed, mismatched, stale-format, and different-bucket evidence', () => {
    for (const changes of [{ status: 'failed' }, { runId: 'other' }, { scenario: 'queue-monitoring' },
      { observedAt: 'invalid' }, { diagnostics: {} }, { jobId: 'other' }]) {
      expect(() => parsePlaybackRunEvidence(JSON.stringify({ ...playbackEvidence(), ...changes }), sourceRun, 'output')).toThrow()
    }
    expect(() => parsePlaybackRunEvidence(JSON.stringify(playbackEvidence()), sourceRun, 'different')).toThrow()
  })
  it('loads only the specified sibling run and fails on missing sources or ambiguous selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-selection-'))
    try {
      await mkdir(join(root, sourceRun))
      const file = join(root, sourceRun, 'phase1-pipeline-evidence.json')
      await writeFile(file, JSON.stringify(playbackEvidence()))
      const env = { E2E_EVIDENCE_DIR: join(root, 'current'), E2E_RUN_ID: 'current',
        E2E_OUTPUT_BUCKET: 'output', E2E_PLAYBACK_EVIDENCE_RUN: sourceRun }
      expect((await loadDeliveryTargets(env)).sourceRunId).toBe(sourceRun)
      await expect(loadDeliveryTargets({ ...env, E2E_LEGACY_DELIVERY_FIXTURES: 'legacy.json' })).rejects.toThrow()
      await expect(loadDeliveryTargets({ ...env, E2E_PLAYBACK_EVIDENCE_RUN: '../outside' })).rejects.toThrow()
      await expect(loadDeliveryTargets({ ...env, E2E_PLAYBACK_EVIDENCE_RUN: undefined })).rejects.toThrow()
      await rm(file)
      await expect(loadDeliveryTargets(env)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

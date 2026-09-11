import { describe, expect, it } from 'vitest'
import { validateExhaustionResult } from './ffmpeg-exhaustion-driver.js'

const target = { runId: 'e2e-11111111-1111-4111-8111-111111111111', videoId: '22222222-2222-4222-8222-222222222222', jobId: '11111111-1111-4111-8111-111111111111', prefix: 'videos/22222222-2222-4222-8222-222222222222/jobs/11111111-1111-4111-8111-111111111111/', sourceKey: 'videos/22222222-2222-4222-8222-222222222222/jobs/11111111-1111-4111-8111-111111111111/source.mp4' }
const good = { job: { status: 'FAILED', attempt: 3, failure: 'ffmpeg processing failed', updatedAtMs: 10 }, events: [], dlq: [{ messageId: 'message-1', receivedAt: '2026-01-01T00:00:00.000Z', jobId: target.jobId, videoId: target.videoId, sourceKey: target.sourceKey }] }

describe('FFmpeg exhaustion result', () => {
  it('requires durable details, bounded attempt, and exact DLQ ownership', () => {
    expect(() => validateExhaustionResult({ ...good, job: { ...good.job, status: 'PROCESSING' } }, good, target, 3)).toThrow('durable FAILED')
    expect(() => validateExhaustionResult(good, { ...good, dlq: [] }, target, 3)).toThrow('DLQ')
    expect(() => validateExhaustionResult(good, good, target, 3)).not.toThrow()
  })
})

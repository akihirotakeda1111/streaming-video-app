import { describe, expect, it } from 'vitest'
import { correlateRunOwnedPoisonDlq } from './dlq-correlation.js'

const malformed = '{"Records":['
const unknown = JSON.stringify({ Records: [{ eventSource: 'aws:s3', eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'e2e-source.example' }, object: { key: 'videos/11111111-1111-4111-8111-111111111111/jobs/22222222-2222-4222-8222-222222222222/source.mp4' } } }] })

describe('poison DLQ correlation', () => {
  it('correlates exact malformed and unknown-job bodies without retaining bodies', () => {
    const result = correlateRunOwnedPoisonDlq([
      { messageId: 'malformed', body: malformed, receivedAt: '2026-09-11T00:00:00Z' },
      { messageId: 'unknown', body: unknown, receivedAt: '2026-09-11T00:00:01Z' },
    ], [
      { messageId: 'malformed', body: malformed, kind: 'malformed' },
      { messageId: 'unknown', body: unknown, kind: 'unknown-job', canonicalIds: { videoId: '11111111-1111-4111-8111-111111111111', jobId: '22222222-2222-4222-8222-222222222222' } },
    ])
    expect(result.map((item) => item.kind)).toEqual(['malformed', 'unknown-job'])
    expect(result[0]).not.toHaveProperty('body')
    expect(result[0]).not.toHaveProperty('receiptHandle')
  })

  it('does not accept an unrelated body for a run-owned message ID', () => {
    expect(correlateRunOwnedPoisonDlq([
      { messageId: 'malformed', body: '{}', receivedAt: '2026-09-11T00:00:00Z' },
    ], [{ messageId: 'malformed', body: malformed, kind: 'malformed' }])).toEqual([])
  })
})

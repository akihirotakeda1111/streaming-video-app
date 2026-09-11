import { describe, expect, it } from 'vitest'
import { correlateRunOwnedDlq, receiveRunOwnedDlq } from './dlq-correlation.js'

const target = { jobId: '11111111-1111-4111-8111-111111111111', videoId: '22222222-2222-4222-8222-222222222222', sourceKey: 'videos/22222222-2222-4222-8222-222222222222/jobs/11111111-1111-4111-8111-111111111111/source.mp4' }
const body = JSON.stringify({ job_id: target.jobId, video_id: target.videoId, key: target.sourceKey })

describe('run-owned DLQ correlation', () => {
  it('returns redacted canonical identity and never receipt handles', () => {
    const result = correlateRunOwnedDlq([{ messageId: 'message-1', body, receivedAt: '2026-01-01T00:00:00Z', receiveCount: 3 }], target)
    expect(result).toEqual([{ messageId: 'message-1', receivedAt: '2026-01-01T00:00:00.000Z', receiveCount: 3, jobId: target.jobId, videoId: target.videoId, sourceKey: target.sourceKey }])
    expect(JSON.stringify(result)).not.toContain('ReceiptHandle')
  })

  it('rejects partial correlation and bounds the AWS observation', () => {
    expect(() => correlateRunOwnedDlq([{ messageId: 'message-1', body: JSON.stringify({ job_id: target.jobId }), receivedAt: new Date().toISOString() }], target)).toThrow('partially')
    const calls: string[][] = []
    const result = receiveRunOwnedDlq('https://sqs.us-east-1.amazonaws.com/123456789012/dlq', target, { region: 'us-east-1', timeoutMs: 1000, execute: (_tool, args) => { calls.push(args); return JSON.stringify({ Messages: [{ MessageId: 'message-1', Body: body, ReceiptHandle: 'secret', Attributes: { ApproximateReceiveCount: '3' } }] }) } })
    expect(result).toHaveLength(1)
    expect(calls[0]).toContain('receive-message')
    expect(calls[0]).not.toContain('delete-message')
  })
})

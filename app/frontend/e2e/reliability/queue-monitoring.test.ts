import { describe, expect, it } from 'vitest'
import { observeQueueMonitoring } from './queue-monitoring.js'

describe('queue monitoring', () => {
  it('uses only read-only queue, metric, and alarm operations and preserves alarm state', async () => {
    const calls: string[][] = []
    const execute = (_file: string, args: readonly string[]) => {
      calls.push([...args])
      if (args[0] === 'sqs') return JSON.stringify({ Attributes: { ApproximateNumberOfMessagesVisible: '2', ApproximateAgeOfOldestMessage: '7' } })
      if (args[0] === 'cloudwatch' && args[1] === 'get-metric-data') {
        const queries = JSON.parse(args[3]!) as { Id: string }[]
        return JSON.stringify({ MetricDataResults: queries.map(query => ({ Id: query.Id, Values: [1] })) })
      }
      return JSON.stringify({ MetricAlarms: [{ AlarmName: 'source-age', StateValue: 'INSUFFICIENT_DATA', StateReason: 'not enough datapoints' }] })
    }
    const report = await observeQueueMonitoring({
      region: 'us-east-1', sourceQueueArn: 'arn:aws:sqs:us-east-1:123456789012:source', deadLetterQueueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
      alarmIdentifiers: ['source-age'], evidenceDir: '/no-evidence', runId: 'e2e-11111111-1111-4111-8111-111111111111', timeoutMs: 1000,
      execute, now: () => 1_700_000_000_000, sleep: async () => {},
    })
    expect(report.status).toBe('outstanding')
    expect(report.alarmObservations[0]?.state).toBe('INSUFFICIENT_DATA')
    expect(report.outstanding).toEqual(['ffmpeg-exhaustion evidence is outstanding', 'poison-isolation evidence is outstanding'])
    expect(calls.every(args => !['receive-message', 'delete-message', 'purge-queue', 'send-message'].includes(args[1] || ''))).toBe(true)
  })
})


import { describe, expect, it } from 'vitest'
import { diagnoseMetric } from './metric-diagnostics.js'

const end = Date.parse('2026-09-11T13:00:00Z'),
  start = end - 300000
const metric = () => ({
  Id: 'sourcebacklog',
  StatusCode: 'Complete',
  Values: [0],
  Timestamps: ['2026-09-11T12:59:00+00:00'],
})
const diagnose = (response: unknown) =>
  diagnoseMetric(response, 'sourcebacklog', 'ApproximateNumberOfMessagesVisible', start, end)

describe('metric diagnostics', () => {
  it.each([
    ['no-datapoints', { Values: [], Timestamps: [] }],
    ['partial-data', { StatusCode: 'PartialData' }],
    ['service-error', { StatusCode: 'Forbidden' }],
    ['service-error', { StatusCode: 'InternalError' }],
    ['invalid-status', { StatusCode: 'unexpected' }],
    ['invalid-values', { Values: [null] }],
    ['invalid-values', { Values: [-1] }],
    ['invalid-timestamps', { Timestamps: ['2026-09-11T12:59:00'] }],
    ['outside-window', { Timestamps: ['2026-09-11T12:00:00Z'] }],
    ['outside-window', { Timestamps: ['2026-09-11T14:00:00Z'] }],
    ['invalid-response', { Timestamps: [] }],
  ])('classifies %s without claiming a usable point', (reason, fields) => {
    const result = diagnose({ MetricDataResults: [{ ...metric(), ...(fields as object) }] })
    expect(result.reason).toBe(reason)
    expect(result.point).toBeUndefined()
    expect(result.statusCode).toBeDefined()
    expect(result.samples).toBeDefined()
  })
  it('distinguishes malformed, missing, and duplicate responses', () => {
    expect(diagnose({}).reason).toBe('invalid-response')
    expect(diagnose({ MetricDataResults: [] }).reason).toBe('missing-result')
    expect(diagnose({ MetricDataResults: [metric(), metric()] }).reason).toBe('duplicate-result')
  })
  it('preserves zero and the normalized timestamp', () => {
    expect(diagnose({ MetricDataResults: [metric()] })).toMatchObject({
      reason: 'observed',
      valueCount: 1,
      timestampCount: 1,
      point: { value: 0, timestamp: '2026-09-11T12:59:00.000Z' },
    })
  })
  it('bounds and redacts samples and service messages', () => {
    const result = diagnose({
      Messages: Array(10).fill({ Code: 'Warning', Value: 'Authorization: Bearer private-value' }),
      MetricDataResults: [
        {
          ...metric(),
          Values: Array(10).fill(1),
          Timestamps: Array(10).fill('https://example.test/?token=private-value'),
        },
      ],
    })
    expect(result.samples).toHaveLength(3)
    expect(result.messages).toHaveLength(5)
    expect(JSON.stringify(result)).not.toContain('private-value')
    expect(result.reason).toBe('invalid-timestamps')
  })
})

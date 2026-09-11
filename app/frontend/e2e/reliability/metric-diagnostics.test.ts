import { describe, expect, it } from 'vitest'
import { diagnoseMetric } from './metric-diagnostics.js'
import { utcTime } from './queue-monitoring-evidence.js'

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
    '2026-09-11T21:59:00+09:00',
    '2026-09-11T05:59:00-07:00',
    '2026-09-11T18:29:00+05:30',
    '2026-09-11T12:59:00Z',
  ])('normalizes explicit offsets before checking the observation window: %s', (timestamp) => {
    expect(
      diagnose({ MetricDataResults: [{ ...metric(), Timestamps: [timestamp] }] }),
    ).toMatchObject({
      reason: 'observed',
      point: { value: 0, timestamp: '2026-09-11T12:59:00.000Z' },
    })
  })
  it('accepts the reported JST CloudWatch samples and selects the latest UTC point', () => {
    const result = diagnoseMetric(
      {
        MetricDataResults: [
          {
            Id: 'dlqage',
            StatusCode: 'Complete',
            Values: [4465, 4407, 4305],
            Timestamps: [
              '2026-09-11T23:07:00+09:00',
              '2026-09-11T23:06:00+09:00',
              '2026-09-11T23:05:00+09:00',
            ],
          },
        ],
      },
      'dlqage',
      'ApproximateAgeOfOldestMessage',
      Date.parse('2026-09-11T14:03:36.877Z'),
      Date.parse('2026-09-11T14:08:36.877Z'),
    )
    expect(result).toMatchObject({
      reason: 'observed',
      point: { value: 4465, timestamp: '2026-09-11T14:07:00.000Z' },
    })
  })
  it('still rejects offset timestamps outside the requested UTC window', () => {
    expect(
      diagnose({ MetricDataResults: [{ ...metric(), Timestamps: ['2026-09-11T23:07:00+09:00'] }] })
        .reason,
    ).toBe('outside-window')
  })
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

describe('explicit timestamp validation', () => {
  it.each([
    ['2026-09-12T00:07:00.123+09:00', '2026-09-11T15:07:00.123Z'],
    ['2026-09-10T23:07:00-07:00', '2026-09-11T06:07:00.000Z'],
    ['2026-09-11T14:07:00+00:00', '2026-09-11T14:07:00.000Z'],
  ])('handles date boundaries and fractions: %s', (input, expected) => {
    expect(utcTime(input)).toBe(Date.parse(expected))
  })
  it.each([
    '2026-09-11T23:07:00',
    '2026-09-11T23:07:00+24:00',
    '2026-09-11T23:07:00+09:60',
    '2026-09-11T24:07:00+09:00',
    '2026-02-30T23:07:00+09:00',
    '2026-13-11T23:07:00Z',
    'not-a-time',
    null,
  ])('rejects malformed or timezone-free timestamps: %s', (input) => {
    expect(utcTime(input)).toBeUndefined()
  })
})

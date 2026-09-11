import { safeDiagnostic } from '../diagnostics.js'
import { utcTime } from './queue-monitoring-evidence.js'

export interface MetricDiagnostic {
  id: string
  metricName: string
  reason:
    | 'observed'
    | 'no-datapoints'
    | 'missing-result'
    | 'duplicate-result'
    | 'invalid-response'
    | 'partial-data'
    | 'service-error'
    | 'invalid-status'
    | 'invalid-values'
    | 'invalid-timestamps'
    | 'outside-window'
    | 'request-error'
  statusCode?: string
  valueCount?: number
  timestampCount?: number
  samples?: unknown
  messages?: unknown
  returnedIds?: unknown
  errorCode?: string
  point?: { value: number; timestamp: string }
}

/** Bounded, redacted response summaries distinguish absent data from rejected data. */
export function diagnoseMetric(
  response: any,
  id: string,
  metricName: string,
  start: number,
  end: number,
): MetricDiagnostic {
  const diagnostic: MetricDiagnostic = { id, metricName, reason: 'invalid-response' }
  const boundedText = (value: unknown) =>
    typeof value === 'string' ? value.slice(0, 512) : undefined
  const messageSummary = (messages: any[]) =>
    messages
      .slice(0, 5)
      .map((message) => ({ code: boundedText(message?.Code), value: boundedText(message?.Value) }))
  Object.assign(
    diagnostic,
    safeDiagnostic({
      messages: messageSummary(Array.isArray(response?.Messages) ? response.Messages : []),
    }),
  )
  if (!Array.isArray(response?.MetricDataResults)) return diagnostic
  Object.assign(
    diagnostic,
    safeDiagnostic({
      returnedIds: response.MetricDataResults.slice(0, 10).map((result: any) =>
        boundedText(result?.Id),
      ),
    }),
  )
  const matches = response.MetricDataResults.filter((result: any) => result?.Id === id)
  if (!matches.length) return { ...diagnostic, reason: 'missing-result' }
  if (matches.length !== 1) return { ...diagnostic, reason: 'duplicate-result' }
  const result = matches[0]
  const messages = [
    ...(Array.isArray(response.Messages) ? response.Messages : []),
    ...(Array.isArray(result.Messages) ? result.Messages : []),
  ]
    .slice(0, 5)
    .map((message) => ({ code: boundedText(message?.Code), value: boundedText(message?.Value) }))
  const values = result.Values,
    timestamps = result.Timestamps
  Object.assign(
    diagnostic,
    safeDiagnostic({
      statusCode: boundedText(result.StatusCode),
      valueCount: Array.isArray(values) ? values.length : undefined,
      timestampCount: Array.isArray(timestamps) ? timestamps.length : undefined,
      samples: Array.from(
        {
          length: Math.min(
            3,
            Math.max(
              Array.isArray(values) ? values.length : 0,
              Array.isArray(timestamps) ? timestamps.length : 0,
            ),
          ),
        },
        (_, index) => ({
          value:
            typeof values?.[index] === 'number'
              ? values[index]
              : (boundedText(values?.[index]) ?? null),
          timestamp: boundedText(timestamps?.[index]) ?? null,
        }),
      ),
      messages,
    }),
  )
  if (result.StatusCode === 'PartialData') return { ...diagnostic, reason: 'partial-data' }
  if (['InternalError', 'Forbidden'].includes(result.StatusCode))
    return { ...diagnostic, reason: 'service-error' }
  if (result.StatusCode !== 'Complete') return { ...diagnostic, reason: 'invalid-status' }
  if (!Array.isArray(values) || !Array.isArray(timestamps) || values.length !== timestamps.length)
    return diagnostic
  if (!values.length) return { ...diagnostic, reason: 'no-datapoints' }
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0))
    return { ...diagnostic, reason: 'invalid-values' }
  const times = timestamps.map(utcTime)
  if (times.some((time) => time === undefined))
    return { ...diagnostic, reason: 'invalid-timestamps' }
  if (times.some((time) => time! > end)) return { ...diagnostic, reason: 'outside-window' }
  const recent = values
    .map((value, index) => ({ value, time: times[index]! }))
    .filter((point) => point.time >= start)
  if (!recent.length) return { ...diagnostic, reason: 'outside-window' }
  const latest = recent.reduce((a, b) => (a.time > b.time ? a : b))
  return {
    ...diagnostic,
    reason: 'observed',
    point: { value: latest.value, timestamp: new Date(latest.time).toISOString() },
  }
}

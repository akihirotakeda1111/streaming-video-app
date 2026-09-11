import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeQueueMonitoring } from './queue-monitoring.js'
import { correlateMonitoringEvidence } from './queue-monitoring-evidence.js'
import { duplicateTarget } from './duplicate-driver.js'

const now = 1_700_000_000_000
const iso = new Date(now - 1000).toISOString()
const options = {
  region: 'us-east-1',
  sourceQueueArn: 'arn:aws:sqs:us-east-1:123456789012:source',
  deadLetterQueueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
  alarmIdentifiers: ['source-age'],
  evidenceDir: '/no-evidence',
  runId: 'e2e-11111111-1111-4111-8111-111111111111',
  timeoutMs: 1000,
  now: () => now,
}
const context = { ...options, now }
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function artifacts() {
  const target = duplicateTarget(options.runId)
  const common = {
    status: 'passed',
    runId: options.runId,
    target,
    scenarioStarted: true,
    liveResourcesVerified: true,
    verification: {
      status: 'verified',
      sourceQueue: options.sourceQueueArn,
      deadLetterQueue: options.deadLetterQueueArn,
      account: '123456789012',
      region: options.region,
      verifiedAt: new Date(now - 5000).toISOString(),
      workerSettings: { attempts: 1 },
    },
  }
  const ffmpeg = {
    ...common,
    scenario: 'ffmpeg-exhaustion',
    snapshots: [
      {
        job: { status: 'FAILED', attempt: 1, observedAtMs: now - 1000 },
        events: [{ outcome: 'final_failed', attempt: 1, at: now - 2000 }],
        dlq: [
          {
            messageId: 'ffmpeg-message',
            jobId: target.jobId,
            videoId: target.videoId,
            sourceKey: target.sourceKey,
            receivedAt: iso,
          },
        ],
      },
      {
        job: { status: 'FAILED', attempt: 1, observedAtMs: now - 500 },
        events: [{ outcome: 'final_failed', attempt: 1, at: now - 2000 }],
        dlq: [],
      },
    ],
  }
  const canonicalIds = {
    videoId: '22222222-2222-4222-8222-222222222222',
    jobId: '33333333-3333-4333-8333-333333333333',
  }
  const poison = {
    ...common,
    scenario: 'poison-isolation',
    result: {
      target,
      phase: 'complete',
      cleanup: 'complete',
      unknownJobCount: 0,
      observations: [{ observedAt: iso, status: 'COMPLETED', attempt: 1, poisonCount: 2 }],
      poison: [
        {
          kind: 'malformed',
          messageId: 'malformed-message',
          bodySha256: 'a'.repeat(64),
          receivedAt: iso,
        },
        {
          kind: 'unknown-job',
          messageId: 'unknown-message',
          bodySha256: 'b'.repeat(64),
          canonicalIds,
          receivedAt: iso,
        },
      ],
      identities: [
        {
          kind: 'malformed',
          messageId: 'malformed-message',
          bodySha256: 'a'.repeat(64),
          sentAt: iso,
        },
        {
          kind: 'unknown-job',
          messageId: 'unknown-message',
          bodySha256: 'b'.repeat(64),
          canonicalIds,
          sentAt: iso,
        },
      ],
    },
  }
  return { ffmpeg, poison }
}

async function evidenceDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'queue-monitoring-test-'))
  directories.push(directory)
  const { ffmpeg, poison } = artifacts()
  await writeFile(join(directory, 'ffmpeg-exhaustion-evidence.json'), JSON.stringify(ffmpeg))
  await writeFile(join(directory, 'poison-isolation-evidence.json'), JSON.stringify(poison))
  return directory
}

function transport(change?: (response: any, args: readonly string[]) => void) {
  return vi.fn((_file: string, args: readonly string[]) => {
    let response: any
    if (args[0] === 'sqs') {
      expect(args.slice(args.indexOf('--attribute-names') + 1, args.indexOf('--region'))).toEqual([
        'ApproximateNumberOfMessages',
      ])
      response = { Attributes: { ApproximateNumberOfMessages: '2' } }
    } else if (args[1] === 'get-metric-data') {
      response = {
        MetricDataResults: JSON.parse(args[3]!).map((query: any) => ({
          Id: query.Id,
          StatusCode: 'Complete',
          Values: [0, 7],
          Timestamps: [iso, new Date(now - 60000).toISOString()],
        })),
      }
    } else {
      expect(args[1]).toBe('describe-alarms')
      response = {
        MetricAlarms: [
          {
            AlarmName: 'source-age',
            StateValue: 'INSUFFICIENT_DATA',
            StateReason: 'not enough datapoints',
          },
        ],
      }
    }
    change?.(response, args)
    return JSON.stringify(response)
  })
}

describe('queue monitoring', () => {
  it('records actual metrics independently from SQS attributes, including zero and metric timestamps', async () => {
    const execute = transport()
    const report = await observeQueueMonitoring({
      ...options,
      execute,
      evidenceDir: await evidenceDirectory(),
    })
    expect(report.status).toBe('passed')
    expect(report.queueObservations).toHaveLength(2)
    expect(report.queueObservations[0]).toMatchObject({
      backlog: 0,
      ageSeconds: 0,
      attributeBacklog: 2,
      backlogTimestamp: iso,
      ageTimestamp: iso,
      metricStatus: 'observed',
    })
    expect(report.alarmObservations[0]).toMatchObject({
      state: 'INSUFFICIENT_DATA',
      reason: 'not enough datapoints',
      observationStatus: 'observed',
    })
    expect(
      execute.mock.calls.every(([, args]) =>
        ['get-queue-attributes', 'get-metric-data', 'describe-alarms'].includes(args[1]!),
      ),
    ).toBe(true)
  })
  it('keeps standalone monitoring outstanding without prerequisite evidence', async () => {
    const report = await observeQueueMonitoring({ ...options, execute: transport() })
    expect(report.outstanding).toEqual([
      'ffmpeg-exhaustion evidence is outstanding',
      'poison-isolation evidence is outstanding',
    ])
  })
  it('accepts the AWS CLI UTC offset timestamp representation', async () => {
    const execute = transport((response) => {
      for (const metric of response.MetricDataResults || [])
        metric.Timestamps = metric.Timestamps.map((time: string) => time.replace('Z', '+00:00'))
    })
    const report = await observeQueueMonitoring({ ...options, execute })
    expect(report.queueObservations[0]).toMatchObject({
      backlogTimestamp: iso,
      ageTimestamp: iso,
      metricStatus: 'observed',
    })
  })
  it.each(['missing', 'invalid'] as const)(
    'does not fabricate an alarm state when %s',
    async (status) => {
      const execute = transport((response) => {
        if (response.MetricAlarms)
          response.MetricAlarms =
            status === 'missing' ? [] : [{ AlarmName: 'source-age', StateValue: 'invented' }]
      })
      const report = await observeQueueMonitoring({
        ...options,
        execute,
        evidenceDir: await evidenceDirectory(),
      })
      expect(report.status).toBe('outstanding')
      expect(report.alarmObservations[0]?.observationStatus).toBe(status)
      expect(report.alarmObservations[0]?.state).toBeUndefined()
    },
  )
  it.each(['missing', 'partial', 'stale', 'invalid', 'wrong-id', 'missing-time'])(
    'retains delayed metrics without claiming observation: %s',
    async (fault) => {
      let clock = now
      const execute = transport((response) => {
        if (!response.MetricDataResults) return
        const metric = response.MetricDataResults[0]
        if (fault === 'missing') metric.Values = []
        if (fault === 'partial') metric.StatusCode = 'PartialData'
        if (fault === 'stale')
          metric.Timestamps = [
            new Date(now - 600000).toISOString(),
            new Date(now - 500000).toISOString(),
          ]
        if (fault === 'invalid') metric.Values = [null, 1]
        if (fault === 'wrong-id') metric.Id = 'unexpected'
        if (fault === 'missing-time') delete metric.Timestamps
      })
      const report = await observeQueueMonitoring({
        ...options,
        execute,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
      })
      expect(report.status).toBe('outstanding')
      expect(report.queueObservations[0]?.metricStatus).toBe('metric-delay')
      expect(report.queueObservations[0]?.backlog).toBeUndefined()
      expect(report.metricObservation).toHaveProperty('lastObservation')
      expect(execute.mock.calls).toHaveLength(20)
    },
  )
  it('waits for delayed data to become available within the deadline', async () => {
    let clock = now,
      snapshots = 0
    const execute = transport((response) => {
      if (response.MetricAlarms) snapshots++
      if (response.MetricDataResults && snapshots === 1) response.MetricDataResults = []
    })
    const report = await observeQueueMonitoring({
      ...options,
      execute,
      evidenceDir: await evidenceDirectory(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    expect(report.status).toBe('passed')
    expect(snapshots).toBe(2)
  })
  it('aborts an in-flight observation without a final snapshot or extra AWS call', async () => {
    vi.useFakeTimers()
    let aborted = false
    const execute = vi.fn(
      (_file: string, _args: readonly string[], settings: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          settings.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    const pending = observeQueueMonitoring({ ...options, execute, now: Date.now })
    await vi.advanceTimersByTimeAsync(1000)
    const report = await pending
    expect(aborted).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(report.queueObservations).toEqual([])
    expect(report.alarmObservations[0]?.observationStatus).toBe('not-observed')
    expect(report.status).toBe('outstanding')
  })
  it('rejects option-like identifiers before any command', async () => {
    const execute = transport()
    await expect(
      observeQueueMonitoring({
        ...options,
        execute,
        alarmIdentifiers: ['source-age', '--profile', 'other'],
      }),
    ).rejects.toThrow('E2E_ALARM_IDENTIFIERS')
    expect(execute).not.toHaveBeenCalled()
  })
  it('preserves the last snapshot when a later CLI request is cancelled', async () => {
    vi.useFakeTimers()
    const respond = transport((response) => {
      if (response.MetricDataResults) response.MetricDataResults = []
    })
    let calls = 0,
      aborted = false
    const execute = (_file: string, args: readonly string[], settings: { signal: AbortSignal }) => {
      if (++calls <= 5) return respond(_file, args)
      return new Promise<string>((_resolve, reject) => {
        settings.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
    }
    const pending = observeQueueMonitoring({ ...options, execute, now: Date.now })
    await vi.advanceTimersByTimeAsync(1000)
    const report = await pending
    expect(aborted).toBe(true)
    expect(calls).toBe(6)
    expect(report.queueObservations).toHaveLength(2)
    expect(report.queueObservations[0]).toMatchObject({
      attributeBacklog: 2,
      metricStatus: 'metric-delay',
    })
  })
})

describe('explicit prerequisite run references', () => {
  const ffmpegRun = 'e2e-22222222-2222-4222-8222-222222222222'
  const poisonRun = 'e2e-33333333-3333-4333-8333-333333333333'
  async function references() {
    const root = await evidenceDirectory()
    const directory = join(root, options.runId)
    await mkdir(directory)
    const artifactsByScenario: Record<string, any> = artifacts()
    for (const [key, run, scenario] of [
      ['ffmpeg', ffmpegRun, 'ffmpeg-exhaustion'],
      ['poison', poisonRun, 'poison-isolation'],
    ] as const) {
      const evidence = artifactsByScenario[key]
      evidence.runId = run
      evidence.target.runId = run
      await mkdir(join(root, run))
      await writeFile(join(root, run, `${scenario}-evidence.json`), JSON.stringify(evidence))
    }
    return { root, directory }
  }
  it('reads two distinct earlier runs without changing their artifacts or the monitoring run ID', async () => {
    const { root, directory } = await references()
    const file = join(root, ffmpegRun, 'ffmpeg-exhaustion-evidence.json')
    const before = await readFile(file, 'utf8')
    const report = await observeQueueMonitoring({
      ...options,
      execute: transport(),
      evidenceDir: directory,
      ffmpegEvidenceRun: ffmpegRun,
      poisonEvidenceRun: poisonRun,
    })
    expect(report.status).toBe('passed')
    expect(report.runId).toBe(options.runId)
    expect(report.correlatedEvidence.map((item) => [item.requestedRunId, item.runId])).toEqual([
      [ffmpegRun, ffmpegRun],
      [poisonRun, poisonRun],
    ])
    expect(await readFile(file, 'utf8')).toBe(before)
  })
  it('leaves an unspecified prerequisite outstanding without searching sibling directories', async () => {
    const { directory } = await references()
    const report = await observeQueueMonitoring({
      ...options,
      execute: transport(),
      evidenceDir: directory,
      ffmpegEvidenceRun: ffmpegRun,
    })
    expect(report.outstanding).toEqual(['poison-isolation evidence is outstanding'])
  })
  it.each(['missing', 'mismatch', 'environment', 'malformed'])(
    'keeps invalid references outstanding: %s',
    async (fault) => {
      const { root, directory } = await references()
      const file = join(root, ffmpegRun, 'ffmpeg-exhaustion-evidence.json')
      const evidence = JSON.parse(await readFile(file, 'utf8'))
      if (fault === 'missing') await rm(file)
      if (fault === 'mismatch') {
        evidence.runId = options.runId
        await writeFile(file, JSON.stringify(evidence))
      }
      if (fault === 'environment') {
        evidence.verification.sourceQueue = 'other'
        await writeFile(file, JSON.stringify(evidence))
      }
      if (fault === 'malformed') await writeFile(file, '{')
      const report = await observeQueueMonitoring({
        ...options,
        execute: transport(),
        evidenceDir: directory,
        ffmpegEvidenceRun: ffmpegRun,
        poisonEvidenceRun: poisonRun,
      })
      expect(report.outstanding).toEqual(['ffmpeg-exhaustion evidence is outstanding'])
      expect(report.correlatedEvidence[0]).toMatchObject({
        requestedRunId: ffmpegRun,
        evidenceComplete: false,
      })
    },
  )
  it('rejects a junction redirect outside the selected run', async () => {
    const root = await evidenceDirectory()
    const directory = join(root, options.runId)
    await mkdir(directory)
    // Junctions require no elevated symlink privilege on Windows.
    await symlink(root, join(root, ffmpegRun), process.platform === 'win32' ? 'junction' : 'dir')
    const report = await observeQueueMonitoring({
      ...options,
      execute: transport(),
      evidenceDir: directory,
      ffmpegEvidenceRun: ffmpegRun,
    })
    expect(report.correlatedEvidence[0]).toMatchObject({
      requestedRunId: ffmpegRun,
      evidenceComplete: false,
    })
  })
  it.each(['../outside', 'C:/outside', '', `${ffmpegRun}/child`])(
    'rejects a path as a run ID before AWS calls',
    async (value) => {
      const execute = transport()
      await expect(
        observeQueueMonitoring({ ...options, execute, ffmpegEvidenceRun: value }),
      ).rejects.toThrow('run directory name')
      expect(execute).not.toHaveBeenCalled()
    },
  )
})

describe('scenario evidence correlation', () => {
  it('reads actual timestamps and retains earlier FFmpeg DLQ receipts', () => {
    const { ffmpeg, poison } = artifacts()
    expect(correlateMonitoringEvidence(ffmpeg, ffmpeg.scenario, context)).toEqual({
      evidenceComplete: true,
      evidenceTimestamp: new Date(now - 500).toISOString(),
    })
    expect(correlateMonitoringEvidence(poison, poison.scenario, context)).toEqual({
      evidenceComplete: true,
      evidenceTimestamp: iso,
    })
  })
  it.each(['run', 'target', 'queue', 'scenario', 'time', 'dlq', 'terminal'])(
    'rejects incomplete FFmpeg correlation: %s',
    (fault) => {
      const evidence: any = artifacts().ffmpeg
      if (fault === 'run') evidence.runId = 'e2e-other'
      if (fault === 'target') evidence.target.sourceKey = 'unrelated'
      if (fault === 'queue') evidence.verification.deadLetterQueue = 'other'
      if (fault === 'scenario') evidence.scenario = 'other'
      if (fault === 'time') delete evidence.snapshots[0].job.observedAtMs
      if (fault === 'dlq') evidence.snapshots[0].dlq[0].jobId = 'other'
      if (fault === 'terminal') evidence.snapshots[1].job.status = 'PROCESSING'
      expect(
        correlateMonitoringEvidence(evidence, 'ffmpeg-exhaustion', context).evidenceComplete,
      ).toBe(false)
    },
  )
  it.each(['empty', 'hash', 'identity', 'time', 'environment', 'target', 'terminal'])(
    'rejects incomplete poison correlation: %s',
    (fault) => {
      const evidence: any = artifacts().poison
      if (fault === 'empty') evidence.result.poison = []
      if (fault === 'hash') evidence.result.poison[0].bodySha256 = 'c'.repeat(64)
      if (fault === 'identity')
        evidence.result.poison[1].canonicalIds = { jobId: 'other', videoId: 'other' }
      if (fault === 'time')
        evidence.result.observations[0].observedAt = new Date(now + 1000).toISOString()
      if (fault === 'environment') delete evidence.verification
      if (fault === 'target') evidence.result.target = {}
      if (fault === 'terminal') evidence.result.phase = 'observe'
      expect(
        correlateMonitoringEvidence(evidence, 'poison-isolation', context).evidenceComplete,
      ).toBe(false)
    },
  )
})

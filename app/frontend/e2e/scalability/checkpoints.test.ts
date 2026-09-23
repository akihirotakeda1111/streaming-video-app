import { describe, expect, it } from 'vitest'
import {
  activitiesFromHits,
  childIntervalsFromHistory,
  childOverlap,
  evaluateScalability,
  jobIdFromLogMessage,
  overallStatus,
  parentConcurrency,
  taskArnFromLogStream,
  withEcsTimings,
  type ChildInterval,
  type HistoryEvent,
  type JobRecord,
  type ParentActivity,
  type ServiceSample,
} from './checkpoints.js'
import { buildWorkloadDocument } from './evidence.js'

const taskA = 'arn:aws:ecs:us-east-1:123456789012:task/cluster/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const taskB = 'arn:aws:ecs:us-east-1:123456789012:task/cluster/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function jobs(): JobRecord[] {
  return [
    { videoId: 'video-1', jobId: 'job-1', status: 'COMPLETED', createdAt: '2026-09-23T00:00:00.000Z', completedAt: '2026-09-23T00:10:00.000Z', elapsedSeconds: 600 },
    { videoId: 'video-2', jobId: 'job-2', status: 'COMPLETED', createdAt: '2026-09-23T00:00:01.000Z', completedAt: '2026-09-23T00:11:00.000Z', elapsedSeconds: 659 },
  ]
}

function samples(): ServiceSample[] {
  return [
    { observedAt: '2026-09-23T00:00:00.000Z', runningCount: 1, desiredCount: 1, taskArns: [taskA] },
    { observedAt: '2026-09-23T00:03:00.000Z', runningCount: 2, desiredCount: 2, taskArns: [taskA, taskB] },
    { observedAt: '2026-09-23T00:20:00.000Z', runningCount: 1, desiredCount: 1, taskArns: [taskA] },
  ]
}

function activities(): ParentActivity[] {
  return [
    { taskArn: taskA, jobId: 'job-1', startedAt: '2026-09-23T00:01:00.000Z', endedAt: '2026-09-23T00:08:00.000Z' },
    { taskArn: taskB, jobId: 'job-2', startedAt: '2026-09-23T00:02:00.000Z', endedAt: '2026-09-23T00:09:00.000Z' },
  ]
}

function intervals(): ChildInterval[] {
  return [
    {
      rendition: '360p', taskArn: taskA,
      stepFunctionsStart: '2026-09-23T00:04:00.000Z', stepFunctionsEnd: '2026-09-23T00:07:00.000Z',
      ecsStartedAt: '2026-09-23T00:04:05.000Z', ecsStoppedAt: '2026-09-23T00:06:50.000Z',
    },
    {
      rendition: '720p', taskArn: taskB,
      stepFunctionsStart: '2026-09-23T00:04:10.000Z', stepFunctionsEnd: '2026-09-23T00:07:10.000Z',
      ecsStartedAt: '2026-09-23T00:04:15.000Z', ecsStoppedAt: '2026-09-23T00:06:40.000Z',
    },
  ]
}

describe('scalability checkpoint evaluation', () => {
  it('passes only when every measured checkpoint passes', () => {
    const checkpoints = evaluateScalability({
      attempted: true,
      minimumCapacity: 1,
      batchSize: 2,
      jobs: jobs(),
      samples: samples(),
      activities: activities(),
      childIntervals: intervals(),
      playbackAttempted: true,
      observationErrors: [],
      playback: {
        usedVideoJs: true, master: true, playlist360: true, playlist720: true,
        segment360: true, segment720: true, decoded: true, advanced: true, switched: true,
      },
    })
    expect(overallStatus(checkpoints)).toBe('passed')
    expect(Object.values(checkpoints).map((checkpoint) => checkpoint.status)).toEqual([
      'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS',
    ])
  })

  it('fails closed when scale-out, overlap, or playback was not proven', () => {
    const checkpoints = evaluateScalability({
      attempted: true,
      minimumCapacity: 1,
      batchSize: 2,
      jobs: [{ ...jobs()[0]!, status: 'TIMED_OUT', error: 'did not complete before the run deadline' }],
      samples: [samples()[0]!],
      activities: [],
      childIntervals: [],
      playbackAttempted: false,
      observationErrors: ['aws ecs describe-services failed'],
    })
    expect(checkpoints.parentScaleOut.status).toBe('FAIL')
    expect(checkpoints.parentJobConcurrency.status).toBe('FAIL')
    expect(checkpoints.childExecutionOverlap.status).toBe('FAIL')
    expect(checkpoints.allJobsCompleted.status).toBe('FAIL')
    expect(checkpoints.scaleIn.status).toBe('NOT RUN')
    expect(checkpoints.abrPlayback.status).toBe('NOT RUN')
    expect(overallStatus(checkpoints)).toBe('failed')
  })

  it('does not treat a service that stayed at one task as scale-in', () => {
    const checkpoints = evaluateScalability({
      attempted: true,
      minimumCapacity: 1,
      batchSize: 2,
      jobs: jobs(),
      samples: [samples()[0]!, { ...samples()[2]!, observedAt: '2026-09-23T00:20:00.000Z' }],
      activities: activities(),
      childIntervals: intervals(),
      playbackAttempted: true,
      observationErrors: [],
      playback: {
        usedVideoJs: true, master: true, playlist360: true, playlist720: true,
        segment360: true, segment720: true, decoded: true, advanced: true, switched: true,
      },
    })
    expect(checkpoints.parentScaleOut.status).toBe('FAIL')
    expect(checkpoints.scaleIn.status).toBe('FAIL')
  })

  it('correlates distinct parent tasks only when their job intervals overlap', () => {
    expect(parentConcurrency(activities()).pass).toBe(true)
    expect(parentConcurrency([
      activities()[0]!,
      { ...activities()[1]!, startedAt: '2026-09-23T00:09:01.000Z', endedAt: '2026-09-23T00:12:00.000Z' },
    ]).pass).toBe(false)
    const hits = activitiesFromHits([
      { taskArn: taskA, jobId: 'job-1', observedAt: '2026-09-23T00:01:00.000Z' },
      { taskArn: taskA, jobId: 'job-1', observedAt: '2026-09-23T00:08:00.000Z' },
      { taskArn: taskB, jobId: 'job-2', observedAt: '2026-09-23T00:02:00.000Z' },
      { taskArn: taskB, jobId: 'job-2', observedAt: '2026-09-23T00:09:00.000Z' },
    ])
    expect(parentConcurrency(hits).pass).toBe(true)
  })
})

describe('child execution history', () => {
  const events: HistoryEvent[] = [
    {
      id: 1, type: 'TaskScheduled', timestamp: '2026-09-23T00:04:00.000Z',
      taskScheduledEventDetails: {
        resourceType: 'ecs',
        parameters: JSON.stringify({
          Overrides: { ContainerOverrides: [{ Environment: [{ Name: 'CHILD_PAYLOAD_JSON', Value: JSON.stringify({ rendition: '360p' }) }] }] },
        }),
      },
    },
    { id: 2, previousEventId: 1, type: 'TaskStarted', timestamp: '2026-09-23T00:04:05.000Z', taskStartedEventDetails: { resourceType: 'ecs' } },
    {
      id: 3, previousEventId: 2, type: 'TaskSucceeded', timestamp: '2026-09-23T00:07:00.000Z',
      taskSucceededEventDetails: { resourceType: 'ecs', output: JSON.stringify({ encoder_result: { task_arn: taskA }, rendition: '360p' }) },
    },
    {
      id: 4, type: 'TaskScheduled', timestamp: '2026-09-23T00:04:10.000Z',
      taskScheduledEventDetails: {
        resourceType: 'ecs',
        parameters: JSON.stringify({
          Overrides: { ContainerOverrides: [{ Environment: [{ Name: 'CHILD_PAYLOAD_JSON', Value: JSON.stringify({ rendition: '720p' }) }] }] },
        }),
      },
    },
    { id: 5, previousEventId: 4, type: 'TaskStarted', timestamp: '2026-09-23T00:04:15.000Z', taskStartedEventDetails: { resourceType: 'ecs' } },
    {
      id: 6, previousEventId: 5, type: 'TaskSucceeded', timestamp: '2026-09-23T00:07:10.000Z',
      taskSucceededEventDetails: { resourceType: 'ecs', output: JSON.stringify({ TaskArn: taskB }) },
    },
  ]

  it('pairs distinct 360p and 720p task ARNs when Step Functions and ECS intervals overlap', () => {
    const parsed = withEcsTimings(childIntervalsFromHistory(events), [
      { taskArn: taskA, startedAt: 1780000000, stoppedAt: 1780000100 },
      { taskArn: taskB, startedAt: '2026-09-23T00:04:20.000Z', stoppedAt: '2026-09-23T00:06:40.000Z' },
    ])
    expect(parsed.map((interval) => interval.rendition).sort()).toEqual(['360p', '720p'])
    expect(childOverlap(parsed).pass).toBe(false)
    const overlapping = intervals()
    expect(childOverlap(overlapping).pass).toBe(true)
    expect(childOverlap([
      { ...overlapping[0]!, jobId: 'job-1' },
      { ...overlapping[1]!, jobId: 'job-2' },
    ]).pass).toBe(false)
    expect(childOverlap(overlapping.map((interval) => ({ ...interval, ecsStartedAt: undefined, ecsStoppedAt: undefined }))).reason)
      .toContain('ECS timestamps')
  })
})

describe('worker log correlation', () => {
  it('reads job ids and task ids without treating an arbitrary suffix as a task', () => {
    expect(jobIdFromLogMessage(JSON.stringify({ fields: { job_id: 'job-1', message: 'worker heartbeat observation' } }))).toBe('job-1')
    expect(taskArnFromLogStream(`worker/worker/${'a'.repeat(32)}`, 'us-east-1', '123456789012', 'cluster')).toBe(taskA)
    expect(taskArnFromLogStream('worker/worker/not-a-task', 'us-east-1', '123456789012', 'cluster')).toBeUndefined()
  })
})

describe('workload evidence', () => {
  it('omits absolute fixture paths and records an overall failure while checkpoints are incomplete', () => {
    const fixturePath = 'C:\\operator\\secret-scalability-fixture.mp4'
    const document = buildWorkloadDocument({
      attempted: false,
      minimumCapacity: 1,
      batchSize: 4,
      jobs: [],
      samples: [],
      activities: [],
      childIntervals: [],
      playbackAttempted: false,
      observationErrors: [],
      startedAt: '2026-09-23T00:00:00.000Z',
      error: `unable to read ${fixturePath}`,
      forbiddenPaths: [fixturePath],
      fixture: { name: 'clip.mp4', durationSeconds: 30, sizeBytes: 5, sha256: 'abc' },
    })
    const encoded = JSON.stringify(document)
    expect(encoded).not.toContain('secret-scalability-fixture')
    expect(encoded).not.toContain('fixture_path')
    expect(document.fixture).toEqual({ name: 'clip.mp4', durationSeconds: 30, sizeBytes: 5, sha256: 'abc' })
    expect(document.status).toBe('failed')
    expect(document.finalized).toBe(false)
    expect(document.checkpoints.parentScaleOut.status).toBe('NOT RUN')
  })

  it('keeps an unfinished observation from being accepted while every checkpoint is PASS', () => {
    const input = {
      attempted: true,
      minimumCapacity: 1,
      batchSize: 2,
      jobs: jobs(),
      samples: samples(),
      activities: activities(),
      childIntervals: intervals(),
      playbackAttempted: true,
      observationErrors: [],
      playback: {
        usedVideoJs: true, master: true, playlist360: true, playlist720: true,
        segment360: true, segment720: true, decoded: true, advanced: true, switched: true,
      },
      startedAt: '2026-09-23T00:00:00.000Z',
    }
    const intermediate = buildWorkloadDocument({ ...input, finalized: false })
    expect(Object.values(intermediate.checkpoints).every((checkpoint) => checkpoint.status === 'PASS')).toBe(true)
    expect(intermediate.finalized).toBe(false)
    expect(intermediate.status).toBe('failed')
    const finalized = buildWorkloadDocument({ ...input, finalized: true })
    expect(finalized.finalized).toBe(true)
    expect(finalized.status).toBe('passed')
    const slow = buildWorkloadDocument({
      ...input,
      finalized: true,
      submission: { windowSeconds: 60, elapsedSeconds: 61, withinWindow: false },
    })
    expect(slow.status).toBe('failed')
    expect(slow.submission).toMatchObject({ elapsedSeconds: 61, withinWindow: false })
  })
})

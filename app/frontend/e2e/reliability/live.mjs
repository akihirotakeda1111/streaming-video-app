// @ts-check
import { execFileSync } from 'node:child_process'

/** @param {Record<string, string | undefined>} env @param {boolean} live */
export function validateTargetSettings(env, live) {
  for (const [name, pattern] of /** @type {[string, RegExp][]} */ ([
    ['AWS_REGION', /^[a-z]{2}-[a-z]+-\d+$/],
    ['E2E_AWS_ACCOUNT_ID', /^\d{12}$/],
    ['E2E_DOCKER_HOST', /^(?:unix:\/\/\/[^\s]+|npipe:\/\/\/\/\.\/pipe\/docker_engine)$/],
  ])) {
    const value = env[name]?.trim()
    if (!value && live) throw new Error(`${name} is required for live preflight`)
    if (value && !pattern.test(value)) throw new Error(`${name} is malformed or unsupported`)
  }
}

/** @param {unknown} value @param {string} name @param {number} [maximum] */
function integer(value, name, maximum = 43200) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} is missing or outside the supported bound`)
  }
  return Number(value)
}

/**
 * Only the command transport is replaceable; tests always run the real policy.
 * @param {{env?: Record<string, string | undefined>, execute?: typeof execFileSync, now?: () => number}} options
 */
export function observeLiveBoundary({ env = process.env, execute = execFileSync, now = Date.now } = {}) {
  validateTargetSettings(env, true)
  const region = env.AWS_REGION?.trim()
  const account = env.E2E_AWS_ACCOUNT_ID?.trim()
  if (!region || !/^[a-z]{2}-[a-z]+-\d+$/.test(region) || !/^\d{12}$/.test(account || '')) {
    throw new Error('AWS_REGION and E2E_AWS_ACCOUNT_ID are required for live preflight')
  }
  const deadline = now() + 120000
  /** @param {string} name */
  const required = (name) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is required for live preflight`)
    return value
  }
  for (const kind of ['WORKER', 'DATABASE']) {
    const target = required(`E2E_${kind}_OBSERVATION`)
    if (!/^docker:[a-f0-9]{64}$/.test(target) || required(`E2E_${kind}_PROCESS_CONTROL`) !== target) {
      throw new Error('observation and control require the same full Docker container ID')
    }
  }
  /** @param {string} tool @param {string[]} args @returns {any} */
  const json = (tool, args) => {
    const remaining = deadline - now()
    if (remaining <= 0) throw new Error('live preflight deadline exceeded')
    try {
      const output = execute(tool, args, {
        env: { ...process.env, ...env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
        encoding: 'utf8', timeout: Math.min(10000, remaining), maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (now() >= deadline) throw new Error('deadline')
      return output.trim() ? JSON.parse(output) : {}
    } catch {
      throw new Error(`read-only ${tool} observation failed (permission, timeout, or unsupported response)`)
    }
  }
  /** @param {string[]} args */
  const aws = (args) => json('aws', [...args, '--region', region, '--output', 'json'])
  if (aws(['sts', 'get-caller-identity'])?.Account !== account) throw new Error('AWS account does not match the disposable target')
  /** @param {string} value */
  const queueUrl = (value) => {
    const url = value.startsWith('https://') ? value : aws(['sqs', 'get-queue-url', '--queue-name', value])?.QueueUrl
    const prefix = `https://sqs.${region}.amazonaws.com/${account}/`
    if (typeof url !== 'string' || !url.startsWith(prefix) || !/^[A-Za-z0-9_-]+(?:\.fifo)?$/.test(url.slice(prefix.length))) {
      throw new Error('queue URL is outside the configured account or region')
    }
    return url
  }
  const sourceUrl = queueUrl(required('E2E_SOURCE_QUEUE'))
  const dlqUrl = queueUrl(required('E2E_DLQ'))
  if (sourceUrl === dlqUrl) throw new Error('source queue and DLQ must differ')
  const source = aws(['sqs', 'get-queue-attributes', '--queue-url', sourceUrl, '--attribute-names', 'All'])?.Attributes
  const dlq = aws(['sqs', 'get-queue-attributes', '--queue-url', dlqUrl, '--attribute-names', 'All'])?.Attributes
  const sourceName = sourceUrl.split('/').at(-1)
  const dlqName = dlqUrl.split('/').at(-1)
  if (source?.QueueArn !== `arn:aws:sqs:${region}:${account}:${sourceName}` || dlq?.QueueArn !== `arn:aws:sqs:${region}:${account}:${dlqName}`) {
    throw new Error('observed queue ARN does not match the requested identity')
  }
  let redrive
  try { redrive = JSON.parse(source.RedrivePolicy) } catch { throw new Error('source queue redrive policy is malformed') }
  if (redrive?.deadLetterTargetArn !== dlq.QueueArn) throw new Error('source queue does not redrive to the configured DLQ')
  const attempts = integer(String(redrive?.maxReceiveCount), 'maxReceiveCount', 10)
  if (attempts !== Number(env.E2E_MAX_ATTEMPTS)) throw new Error('source queue max receive count does not match E2E_MAX_ATTEMPTS')
  const visibilityMs = integer(source.VisibilityTimeout, 'VisibilityTimeout') * 1000
  // These E2E values are observation budgets, not minimum deployment settings.
  if (visibilityMs > Number(env.E2E_VISIBILITY_TIMEOUT_MS)) throw new Error('E2E_VISIBILITY_TIMEOUT_MS cannot cover queue visibility')
  for (const bucket of [required('E2E_SOURCE_BUCKET'), required('E2E_OUTPUT_BUCKET')]) {
    aws(['s3api', 'head-bucket', '--bucket', bucket, '--expected-bucket-owner', account || ''])
    const location = aws(['s3api', 'get-bucket-location', '--bucket', bucket, '--expected-bucket-owner', account || ''])?.LocationConstraint
    const actualRegion = location === null ? 'us-east-1' : location === 'EU' ? 'eu-west-1' : location
    if (actualRegion !== region) throw new Error('bucket region does not match the disposable target')
  }
  const alarmNames = required('E2E_ALARM_IDENTIFIERS').split(',').map(x => x.trim()).filter(Boolean)
  const alarms = aws(['cloudwatch', 'describe-alarms', '--alarm-names', ...alarmNames])?.MetricAlarms
  const expected = new Set([`${sourceName}:ApproximateAgeOfOldestMessage`, `${sourceName}:ApproximateNumberOfMessagesVisible`, `${dlqName}:ApproximateNumberOfMessagesVisible`])
  if (!Array.isArray(alarms) || alarmNames.length !== 3 || new Set(alarmNames).size !== 3) throw new Error('three distinct source and DLQ alarms are required')
  for (const name of alarmNames) {
    const matches = alarms.filter(a => a.AlarmName === name)
    const alarm = matches[0]
    const dimension = alarm?.Dimensions
    if (matches.length !== 1 || alarm?.Namespace !== 'AWS/SQS' || alarm.Metrics || !Array.isArray(dimension) || dimension.length !== 1 || dimension[0]?.Name !== 'QueueName' || !expected.delete(`${dimension[0]?.Value}:${alarm.MetricName}`)) {
      throw new Error('alarm metric or queue target does not match the reliability contract')
    }
  }

  // Restrict control inference to direct local Engine access with its all-or-nothing authorization model.
  const host = required('E2E_DOCKER_HOST')
  if (!/^unix:\/\/\/[^\s]+$/.test(host) && host !== 'npipe:////./pipe/docker_engine') throw new Error('a direct local Docker Engine endpoint is required')
  /** @param {string[]} args */
  const docker = (args) => json('docker', ['--host', host, ...args])
  const info = docker(['info', '--format', '{{json .}}'])
  const authorization = info?.Plugins?.Authorization
  if (!info?.ID || (authorization !== null && (!Array.isArray(authorization) || authorization.length)) || info.OSType !== 'linux') {
    throw new Error('Docker control requires a Linux Engine without authorization plugins')
  }
  /** @param {'WORKER' | 'DATABASE'} kind */
  const container = (kind) => {
    const target = required(`E2E_${kind}_OBSERVATION`)
    const id = /^docker:([a-f0-9]{64})$/.exec(target)?.[1]
    if (!id || required(`E2E_${kind}_PROCESS_CONTROL`) !== target) throw new Error('observation and control require the same full Docker container ID')
    const scope = required(`E2E_${kind}_CONTROL_SCOPE`)
    const result = docker(['container', 'inspect', id])
    const c = result?.[0]
    if (!Array.isArray(result) || result.length !== 1 || c?.Id !== id || c?.State?.Running !== true || c.State.Paused || c.State.Restarting || !c.State.Pid || !c.State.StartedAt) throw new Error('disposable container is not stably running')
    if (c.Config?.Labels?.['com.streaming-video.e2e.disposable'] !== 'true' || c.Config?.Labels?.['com.streaming-video.e2e.scope'] !== scope || c.Config?.Labels?.['com.streaming-video.e2e.role'] !== kind.toLowerCase()) throw new Error('container ownership labels do not match the test-owned scope')
    if (c.HostConfig?.AutoRemove !== false || c.HostConfig?.Privileged !== false || c.HostConfig?.PidMode === 'host') throw new Error('container does not support isolated stop and restore')
    if (!Array.isArray(c.Mounts)) throw new Error('container storage ownership unavailable')
    for (const mount of c.Mounts) {
      if (mount.Type !== 'volume' || typeof mount.Name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(mount.Name)) throw new Error('only dedicated named Docker volumes are supported')
      const volumes = docker(['volume', 'inspect', mount.Name])
      const volume = volumes?.[0]
      if (!Array.isArray(volumes) || volumes.length !== 1 || volume?.Name !== mount.Name || volume.Driver !== 'local' || (volume.Options && Object.keys(volume.Options).length) || volume.Labels?.['com.streaming-video.e2e.disposable'] !== 'true' || volume.Labels?.['com.streaming-video.e2e.scope'] !== scope) throw new Error('volume ownership does not match the test-owned scope')
      const users = docker(['container', 'ls', '--all', '--no-trunc', '--filter', `volume=${mount.Name}`, '--format', '{{json .ID}}'])
      // One JSON string is valid; multiple lines are rejected by the transport.
      if (users !== id) throw new Error('container storage is attached outside its test-owned boundary')
    }
    return c
  }
  const worker = container('WORKER')
  const database = container('DATABASE')
  if (worker.Id === database.Id) throw new Error('worker and database must be distinct containers')
  if (worker.Path !== '/usr/local/bin/video-worker' || !Array.isArray(worker.Args) || worker.Args.length || JSON.stringify(worker.Config?.Entrypoint) !== '["/usr/local/bin/video-worker"]') throw new Error('worker must use the direct repository entrypoint')
  if (database.Path !== 'docker-entrypoint.sh' || database.Args?.[0] !== 'postgres') throw new Error('database must use the supported PostgreSQL entrypoint')
  if (database.State.Health?.Status !== 'healthy') throw new Error('database observation requires a healthy PostgreSQL healthcheck')
  /** @type {Record<string,string>} */
  const settings = {}
  if (!Array.isArray(worker.Config?.Env)) throw new Error('worker effective configuration unavailable')
  for (const entry of worker.Config.Env) {
    if (typeof entry !== 'string' || !entry.includes('=')) throw new Error('worker effective configuration malformed')
    const at = entry.indexOf('=')
    const key = entry.slice(0, at)
    if (Object.hasOwn(settings, key)) throw new Error('worker effective configuration is ambiguous')
    settings[key] = entry.slice(at + 1).trim()
  }
  if (settings.AWS_REGION !== region || settings.VIDEO_ENCODING_QUEUE_URL !== sourceUrl || settings.VIDEO_INPUT_BUCKET !== env.E2E_SOURCE_BUCKET?.trim() || settings.VIDEO_OUTPUT_BUCKET !== env.E2E_OUTPUT_BUCKET?.trim() || settings.VIDEO_INPUT_BUCKET === settings.VIDEO_OUTPUT_BUCKET) throw new Error('worker resource settings do not match observed targets')
  const heartbeat = integer(settings.WORKER_HEARTBEAT_INTERVAL_SECONDS, 'worker heartbeat')
  const visibility = integer(settings.WORKER_VISIBILITY_EXTENSION_SECONDS, 'worker visibility')
  const lease = integer(settings.WORKER_LEASE_DURATION_SECONDS, 'worker lease')
  const retry = integer(settings.WORKER_RETRY_DELAY_SECONDS, 'worker retry')
  if (integer(settings.WORKER_MAXIMUM_ATTEMPTS, 'worker attempts', 10) !== attempts) throw new Error('worker attempts do not match queue and E2E settings')
  if (heartbeat >= Math.min(visibility, lease) || Math.min(visibility, lease) - heartbeat < heartbeat) throw new Error('worker heartbeat requires at least one interval of safety margin')
  if (visibility * 1000 > Number(env.E2E_VISIBILITY_TIMEOUT_MS) || lease * 1000 > Number(env.E2E_LEASE_TIMEOUT_MS) || retry * 1000 > Number(env.E2E_DLQ_TIMEOUT_MS)) throw new Error('E2E observation budgets cannot cover worker timing settings')
  // Never include connection strings or the full inspect response in evidence/errors.
  let dbUrl
  try { dbUrl = new URL(settings.DATABASE_URL || '') } catch { throw new Error('worker database identity unavailable') }
  const networks = database.NetworkSettings?.Networks
  const linked = Object.entries(worker.NetworkSettings?.Networks || {}).some(([name, network]) => {
    const db = networks?.[name]
    return db && network?.NetworkID === db.NetworkID && [db.IPAddress, ...(db.Aliases || [])].includes(dbUrl.hostname)
  })
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol) || (dbUrl.port && dbUrl.port !== '5432') || !linked) throw new Error('worker database target does not match the observed container')
  for (const c of [worker, database]) {
    const latest = docker(['container', 'inspect', c.Id])?.[0]
    if (latest?.Id !== c.Id || latest.State?.StartedAt !== c.State.StartedAt || latest.State?.Running !== true || latest.State?.Paused || latest.State?.Restarting) throw new Error('container changed during live verification')
  }
  /** @param {any} c */
  const evidence = (c) => ({ adapter: 'docker', identity: c.Id, startedAt: c.State.StartedAt, scope: c.Config.Labels['com.streaming-video.e2e.scope'], observable: true, controllable: true, controls: ['stop', 'start'], restore: 'start the same retained container', })
  if (now() >= deadline) throw new Error('live preflight deadline exceeded')
  return { status: 'verified', account, region, sourceQueue: source.QueueArn, deadLetterQueue: dlq.QueueArn, buckets: [env.E2E_SOURCE_BUCKET, env.E2E_OUTPUT_BUCKET], dockerEngine: info.ID, worker: evidence(worker), database: evidence(database), workerSettings: { heartbeat, visibility, lease, retry, attempts }, alarms: alarmNames, verifiedAt: new Date().toISOString() }
}

// @ts-check
// Read-only configuration assistance. Does not authorize or execute an E2E run.
import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  validateSettings,
  URL_NAMES,
  IDENTITY_NAMES,
  TIMING_NAMES,
  SCOPE_NAMES,
} from "../frontend/e2e/reliability/safety.mjs";

/** @typedef {{worker: string, database: string, dockerHost?: string, account?: string,
 * profile?: string, frontendUrl?: string, apiUrl?: string, fixture?: string,
 * invalidFixture?: string, clockSkewMs?: string, full?: boolean,
 * evidenceDir?: string, alarms?: string, exclusive?: boolean}} Options */
class ConfigurationError extends Error {}
/** @param {string} message @returns {never} */
function fail(message) {
  throw new ConfigurationError(message);
}
const OUTPUT_NAMES = new Set([
  ...URL_NAMES,
  ...IDENTITY_NAMES,
  ...TIMING_NAMES,
  ...SCOPE_NAMES,
  "E2E_ENVIRONMENT",
  "E2E_RELIABILITY_DISPOSABLE",
  "AWS_REGION",
  "AWS_PROFILE",
  "E2E_AWS_ACCOUNT_ID",
  "E2E_DOCKER_HOST",
  "E2E_MAX_ATTEMPTS",
  "E2E_ALARM_IDENTIFIERS",
  "E2E_SOURCE_DLQ_RELATIONSHIP",
  "E2E_EVIDENCE_DIR",
  "E2E_DUPLICATE_EXCLUSIVE",
  "E2E_DUPLICATE_FIXTURE",
  "E2E_FFMPEG_INVALID_FIXTURE",
  "E2E_CLOCK_SKEW_MS",
  "E2E_PROJECT",
  "VIDEO_INPUT_BUCKET",
  "VIDEO_OUTPUT_BUCKET",
  "OUTPUT_S3_ENDPOINT",
  "FRONTEND_ORIGIN",
  "VITE_API_BASE_URL",
  "API_PORT",
  "FRONTEND_PORT",
]);
const safeName = (/** @type {unknown} */ value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
/** @param {unknown} value @param {string} label @param {number} [max] */
function positive(value, label, max = 43200) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > max)
    return fail(`Invalid ${label}; inspect the effective configuration`);
  return Number(value);
}

/** Only the command transport is replaceable; no shell commands or remote mutations.
 * @param {Options} options
 * @param {typeof execFileSync} [execute]
 * @returns {Record<string, string>}
 */
export function discoverEnvironment(options, execute = execFileSync) {
  if (options.full && (!options.exclusive || !options.fixture || !options.invalidFixture || !options.clockSkewMs))
    fail("--full requires --exclusive, --fixture, --invalid-fixture and --clock-skew-ms");
  const clockSkewMs = options.clockSkewMs === undefined
    ? "" : String(positive(options.clockSkewMs, "clock skew bound", 5000));
  if (!safeName(options.worker) || !safeName(options.database))
    fail("Worker and database names or IDs are required");
  const host =
    options.dockerHost ||
    process.env.DOCKER_HOST ||
    (process.platform === "win32"
      ? "npipe:////./pipe/docker_engine"
      : "unix:///var/run/docker.sock");
  if (
    !/^(?:unix:\/\/\/[^\s]+|npipe:\/\/\/\/\.\/pipe\/docker_engine)$/.test(host)
  )
    fail("Only a direct local Docker endpoint is supported");
  if (options.account && !/^\d{12}$/.test(options.account))
    fail("Expected account must have 12 digits");
  if (options.profile && !safeName(options.profile))
    fail("Unsupported AWS profile name");
  const deadline = Date.now() + 120000;
  /** @param {string} tool @param {string[]} args @returns {any} */
  const json = (tool, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return fail("Configuration discovery deadline exceeded");
    try {
      const raw = execute(tool, args, {
        encoding: "utf8",
        timeout: Math.min(10000, remaining),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AWS_EC2_METADATA_DISABLED: "true",
          AWS_PAGER: "",
          AWS_CLI_AUTO_PROMPT: "off",
        },
      });
      if (Date.now() >= deadline) throw new Error("deadline");
      return JSON.parse(raw || "{}");
    } catch {
      return fail(
        `Read-only ${tool} discovery failed; check CLI authentication, permissions and availability`,
      );
    }
  };
  /** @param {string} name @param {string} role */
  const inspect = (name, role) => {
    const rows = json("docker", ["--host", host, "container", "inspect", name]);
    const c = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
    if (!c || !/^[a-f0-9]{64}$/.test(c.Id) || !c.State?.Running)
      return fail("Expected one running container with a full ID");
    const labels = c.Config?.Labels;
    if (
      labels?.["com.streaming-video.e2e.disposable"] !== "true" ||
      labels?.["com.streaming-video.e2e.role"] !== role ||
      !safeName(labels?.["com.streaming-video.e2e.scope"])
    )
      return fail(
        "Container requires existing disposable, role and scope labels",
      );
    return c;
  };
  const worker = inspect(options.worker, "worker");
  const database = inspect(options.database, "database");
  if (worker.Id === database.Id) fail("Worker and database must be distinct");
  // Never copy Config.Env wholesale: credentials and DATABASE_URL remain private.
  const selected = new Set([
    "AWS_REGION",
    "VIDEO_ENCODING_QUEUE_URL",
    "VIDEO_INPUT_BUCKET",
    "VIDEO_OUTPUT_BUCKET",
    "WORKER_HEARTBEAT_INTERVAL_SECONDS",
    "WORKER_VISIBILITY_EXTENSION_SECONDS",
    "WORKER_LEASE_DURATION_SECONDS",
    "WORKER_RETRY_DELAY_SECONDS",
    "WORKER_MAXIMUM_ATTEMPTS",
  ]);
  /** @type {Record<string, string>} */
  const settings = {};
  if (!Array.isArray(worker.Config.Env))
    fail("Worker effective settings unavailable");
  for (const entry of worker.Config.Env) {
    if (typeof entry !== "string") fail("Worker effective settings malformed");
    const i = entry.indexOf("=");
    const name = entry.slice(0, i);
    if (!selected.has(name)) continue;
    if (Object.hasOwn(settings, name))
      fail("Worker effective settings are ambiguous");
    settings[name] = entry.slice(i + 1).trim();
  }
  const region = settings.AWS_REGION;
  if (!region || !/^[a-z]{2}-[a-z]+-\d+$/.test(region))
    fail("Worker AWS_REGION is missing or unsupported");
  /** @param {string[]} args @returns {any} */
  const aws = (args) =>
    json("aws", [
      ...args,
      "--region",
      region,
      "--output",
      "json",
      ...(options.profile ? ["--profile", options.profile] : []),
    ]);
  const account = aws(["sts", "get-caller-identity"]).Account;
  if (typeof account !== "string" || !/^\d{12}$/.test(account))
    fail("AWS account unavailable");
  if (options.account && options.account !== account)
    fail("AWS account differs from the expected account");
  const queuePrefix = `https://sqs.${region}.amazonaws.com/${account}/`;
  const sourceUrl = settings.VIDEO_ENCODING_QUEUE_URL;
  if (
    !sourceUrl?.startsWith(queuePrefix) ||
    !/^[A-Za-z0-9_-]+$/.test(sourceUrl.slice(queuePrefix.length))
  )
    fail(
      "Worker source queue must be Standard and in the selected AWS account/region",
    );
  const sourceName = sourceUrl.slice(queuePrefix.length);
  const arnPrefix = `arn:aws:sqs:${region}:${account}:`;
  const source = aws([
    "sqs",
    "get-queue-attributes",
    "--queue-url",
    sourceUrl,
    "--attribute-names",
    "All",
  ]).Attributes;
  if (source?.QueueArn !== arnPrefix + sourceName)
    fail("Source queue identity mismatch");
  let redrive;
  try {
    redrive = JSON.parse(source.RedrivePolicy);
  } catch {
    fail("Source RedrivePolicy unavailable");
  }
  const dlqArn = redrive?.deadLetterTargetArn;
  if (
    typeof dlqArn !== "string" ||
    !dlqArn.startsWith(arnPrefix) ||
    !/^[A-Za-z0-9_-]+$/.test(dlqArn.slice(arnPrefix.length)) ||
    dlqArn === source.QueueArn
  )
    fail(
      "Redrive target must be a distinct queue in the selected AWS account/region",
    );
  const dlqName = dlqArn.slice(arnPrefix.length);
  const dlqUrl = aws([
    "sqs",
    "get-queue-url",
    "--queue-name",
    dlqName,
  ]).QueueUrl;
  if (dlqUrl !== queuePrefix + dlqName) fail("DLQ URL mismatch");
  const dlq = aws([
    "sqs",
    "get-queue-attributes",
    "--queue-url",
    dlqUrl,
    "--attribute-names",
    "QueueArn",
  ]).Attributes;
  if (dlq?.QueueArn !== dlqArn) fail("DLQ ARN mismatch");
  const attempts = positive(
    redrive.maxReceiveCount,
    "queue maxReceiveCount",
    10,
  );
  if (
    positive(settings.WORKER_MAXIMUM_ATTEMPTS, "worker attempts", 10) !==
    attempts
  )
    fail("Worker and queue attempts differ");
  const heartbeat = positive(
    settings.WORKER_HEARTBEAT_INTERVAL_SECONDS,
    "worker heartbeat",
  );
  const extension = positive(
    settings.WORKER_VISIBILITY_EXTENSION_SECONDS,
    "worker visibility",
  );
  const lease = positive(
    settings.WORKER_LEASE_DURATION_SECONDS,
    "worker lease",
  );
  const retry = positive(settings.WORKER_RETRY_DELAY_SECONDS, "worker retry");
  const visibility = positive(source.VisibilityTimeout, "queue visibility");
  if (2 * heartbeat > Math.min(extension, lease))
    fail("Worker heartbeat safety margin is insufficient");
  // Add polling margin where possible without exceeding the existing validator's limit.
  const budget = (/** @type {number} */ seconds) => {
    if (seconds * 1000 > 900000)
      return fail("Worker/queue duration exceeds the supported E2E budget");
    return String(Math.min(900000, seconds * 1000 + 30000));
  };
  for (const key of ["VIDEO_INPUT_BUCKET", "VIDEO_OUTPUT_BUCKET"]) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings[key] || ""))
      fail("Worker bucket name unavailable or invalid");
  }
  if (settings.VIDEO_INPUT_BUCKET === settings.VIDEO_OUTPUT_BUCKET)
    fail("Source and output buckets must differ");
  const requestedAlarms = options.alarms?.split(",").map((s) => s.trim());
  if (
    requestedAlarms &&
    (requestedAlarms.length !== 3 ||
      new Set(requestedAlarms).size !== 3 ||
      requestedAlarms.some((n) => !safeName(n)))
  )
    fail("Use three distinct comma-separated alarm names");
  // AWS CLI handles pagination; bounded time/output rejects overly large inventories.
  const alarms = aws([
    "cloudwatch",
    "describe-alarms",
    "--alarm-types",
    "MetricAlarm",
    ...(requestedAlarms ? ["--alarm-names", ...requestedAlarms] : []),
  ]).MetricAlarms;
  if (!Array.isArray(alarms)) fail("CloudWatch alarm inventory unavailable");
  const alarmNames = [
    [sourceName, "ApproximateAgeOfOldestMessage"],
    [sourceName, "ApproximateNumberOfMessagesVisible"],
    [dlqName, "ApproximateNumberOfMessagesVisible"],
  ].map(([queue, metric]) => {
    const matching = alarms.filter(
      (/** @type {any} */ a) =>
        a.Namespace === "AWS/SQS" &&
        !a.Metrics &&
        a.MetricName === metric &&
        a.Dimensions?.length === 1 &&
        a.Dimensions[0].Name === "QueueName" &&
        a.Dimensions[0].Value === queue,
    );
    if (matching.length !== 1 || !safeName(matching[0].AlarmName))
      return fail(
        "Required alarms are missing or ambiguous; specify --alarms with three matching names",
      );
    return matching[0].AlarmName;
  });
  /** @type {Record<string, string>} */
  const env = {
    E2E_ENVIRONMENT: "disposable",
    E2E_RELIABILITY_DISPOSABLE: options.exclusive ? "true" : "",
    AWS_REGION: region,
    E2E_AWS_ACCOUNT_ID: account,
    E2E_DOCKER_HOST: host,
    E2E_FRONTEND_URL: options.frontendUrl || "http://127.0.0.1:5173",
    E2E_API_URL: options.apiUrl || "http://127.0.0.1:8000",
    E2E_SOURCE_QUEUE: sourceUrl,
    E2E_DLQ: dlqUrl,
    E2E_SOURCE_DLQ: dlqUrl,
    E2E_SOURCE_DLQ_RELATIONSHIP: "verified",
    E2E_SOURCE_BUCKET: settings.VIDEO_INPUT_BUCKET,
    E2E_OUTPUT_BUCKET: settings.VIDEO_OUTPUT_BUCKET,
    E2E_MAX_ATTEMPTS: String(attempts),
    E2E_ALARM_IDENTIFIERS: alarmNames.join(","),
    E2E_WORKER_OBSERVATION: `docker:${worker.Id}`,
    E2E_WORKER_PROCESS_CONTROL: `docker:${worker.Id}`,
    E2E_DATABASE_OBSERVATION: `docker:${database.Id}`,
    E2E_DATABASE_PROCESS_CONTROL: `docker:${database.Id}`,
    E2E_WORKER_CONTROL_SCOPE:
      worker.Config.Labels["com.streaming-video.e2e.scope"],
    E2E_DATABASE_CONTROL_SCOPE:
      database.Config.Labels["com.streaming-video.e2e.scope"],
    E2E_NAVIGATION_TIMEOUT_MS: "30000",
    E2E_UPLOAD_TIMEOUT_MS: "120000",
    E2E_PROCESSING_TIMEOUT_MS: "300000",
    E2E_VISIBILITY_TIMEOUT_MS: budget(Math.max(visibility, extension)),
    E2E_LEASE_TIMEOUT_MS: budget(lease),
    E2E_DLQ_TIMEOUT_MS: budget(retry),
    E2E_PLAYBACK_TIMEOUT_MS: "120000",
    E2E_EVIDENCE_DIR: resolve(
      options.evidenceDir || "artifacts/reliability-e2e",
    ),
    E2E_DUPLICATE_EXCLUSIVE: options.exclusive ? "true" : "",
    E2E_DUPLICATE_FIXTURE: "",
    E2E_FFMPEG_INVALID_FIXTURE: "",
    E2E_CLOCK_SKEW_MS: clockSkewMs,
    E2E_PROJECT: "chromium",
  };
  if (options.profile) env.AWS_PROFILE = options.profile;
  for (const [name, fixture] of Object.entries({
    E2E_DUPLICATE_FIXTURE: options.fixture,
    E2E_FFMPEG_INVALID_FIXTURE: options.invalidFixture,
  })) {
    if (!fixture) continue;
    const path = resolve(fixture);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      fail(`${name} file unavailable`);
    }
    if (
      !path.toLowerCase().endsWith(".mp4") ||
      !stat?.isFile() ||
      !stat.size ||
      stat.size > 1024 ** 3
    )
      fail(`${name} must be a nonempty .mp4 file of at most 1 GiB`);
    env[name] = path;
  }
  if (options.full && env.E2E_DUPLICATE_FIXTURE === env.E2E_FFMPEG_INVALID_FIXTURE)
    fail("Normal and invalid fixtures must use different files");
  if (clockSkewMs && Number(clockSkewMs) * 2 >= Math.min(extension, lease) * 1000)
    fail("Clock skew bound is too large for observed lease and visibility");
  if (options.full && (attempts < 2 || Number(env.E2E_PROCESSING_TIMEOUT_MS) <= 3 * heartbeat * 1000))
    fail("Observed Worker settings cannot support full-suite lifecycle checks");
  try {
    validateSettings(env, false);
  } catch {
    // Reuse the unchanged validator without printing supplied values.
    fail(
      "Generated settings do not satisfy the common validator; check URLs, names and scopes",
    );
  }
  // Compose startup values must point to the same resources and browser URLs
  // as the tests. Credentials and database connection strings remain manual.
  const frontend = new URL(env.E2E_FRONTEND_URL);
  const api = new URL(env.E2E_API_URL);
  Object.assign(env, {
    VIDEO_INPUT_BUCKET: env.E2E_SOURCE_BUCKET,
    VIDEO_OUTPUT_BUCKET: env.E2E_OUTPUT_BUCKET,
    OUTPUT_S3_ENDPOINT: `https://${env.E2E_OUTPUT_BUCKET}.s3.${region}.amazonaws.com`,
    FRONTEND_ORIGIN: frontend.origin,
    VITE_API_BASE_URL: env.E2E_API_URL.replace(/\/$/, "") + "/api/v1",
    API_PORT: api.port || (api.protocol === "https:" ? "443" : "80"),
    FRONTEND_PORT: frontend.port || (frontend.protocol === "https:" ? "443" : "80"),
  });
  return env;
}

/** @param {Record<string, string>} env */
export function renderPowerShell(env) {
  const lines = [
    "# Generated configuration only; this is not successful live preflight evidence.",
    "# Review account, resource identities, local URL defaults and workload budgets.",
    "# Secrets are deliberately omitted. Configure host AWS login and API_AWS_* credentials manually.",
    "# DATABASE_URL and Worker credentials remain in their existing containers; do not copy them here.",
    "# Empty disposable/exclusive values require confirmation; then set both to true.",
    "# Empty E2E_DUPLICATE_FIXTURE requires an absolute MP4 path.",
    "# Full suite also requires E2E_FFMPEG_INVALID_FIXTURE and a measured E2E_CLOCK_SKEW_MS bound.",
    "# Fixture checks cover path/size only; verify normal media and invalid media contents separately.",
    "# Start API/frontend with matching URLs and CORS; install Chromium and host FFmpeg.",
    "# API_PORT/FRONTEND_PORT follow the URLs. Compose serves HTTP; HTTPS requires a separately configured proxy.",
    "# HTTP_ADDR and default DATABASE_URL are supplied by Compose. Keep custom DB credentials aligned separately.",
  ];
  for (const [name, value] of Object.entries(env)) {
    if (!OUTPUT_NAMES.has(name) || /[\r\n\0]/.test(value))
      fail("Unsupported generated setting");
    lines.push(`$env:${name} = '${value.replaceAll("'", "''")}'`);
  }
  lines.push(
    "# Next: python app/scripts/run_reliability_e2e.py --check",
    "# Then: python app/scripts/run_reliability_e2e.py --live-preflight",
    "# After browser readiness and all settings are complete: python app/scripts/run_reliability_e2e.py --full",
  );
  return lines.join("\n") + "\n";
}

const HELP = `Generate PowerShell environment-setting commands from existing AWS/Docker resources.
Usage: node app/scripts/generate_reliability_env.mjs --worker NAME --database NAME [options]
  --account ID          Expected 12-digit account (recommended; otherwise use STS identity)
  --profile NAME        Existing AWS CLI profile; credentials are never emitted
  --docker-host HOST    Direct local Docker socket (default: DOCKER_HOST or platform socket)
  --frontend-url URL    Default http://127.0.0.1:5173; set the actual URL if different
  --api-url URL         Default http://127.0.0.1:8000; set the actual URL if different
  --fixture PATH        Existing MP4; otherwise emit an empty setting for manual completion
  --invalid-fixture PATH Existing nonempty invalid .mp4 for FFmpeg exhaustion
  --clock-skew-ms MS     Explicit clock skew upper bound, 1..5000; otherwise emit empty
  --full                Require all full-suite inputs; does not execute tests or verify media contents
  --evidence-dir PATH   Default artifacts/reliability-e2e under the current directory
  --alarms A,B,C        Select exactly three matching alarms when discovery is ambiguous
  --exclusive           Confirm these resources are disposable and exclusive to this test
  --output PATH         Create a new .ps1 file; default stdout; never overwrite an existing file
  --help                Show this help without contacting services
No infrastructure creation, Terraform, SQL, process control or scenario execution is performed.
`;

/** @param {string[]} [args] @param {typeof execFileSync} [execute] */
export function main(args = process.argv.slice(2), execute = execFileSync) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        worker: { type: "string" },
        database: { type: "string" },
        account: { type: "string" },
        profile: { type: "string" },
        "docker-host": { type: "string" },
        "frontend-url": { type: "string" },
        "api-url": { type: "string" },
        fixture: { type: "string" },
        "invalid-fixture": { type: "string" },
        "clock-skew-ms": { type: "string" },
        full: { type: "boolean" },
        "evidence-dir": { type: "string" },
        alarms: { type: "string" },
        exclusive: { type: "boolean" },
        output: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (!values.worker || !values.database)
      fail("--worker and --database are required; see --help");
    const env = discoverEnvironment(
      {
        worker: values.worker,
        database: values.database,
        account: values.account,
        profile: values.profile,
        dockerHost: values["docker-host"],
        frontendUrl: values["frontend-url"],
        apiUrl: values["api-url"],
        fixture: values.fixture,
        invalidFixture: values["invalid-fixture"],
        clockSkewMs: values["clock-skew-ms"],
        full: values.full,
        evidenceDir: values["evidence-dir"],
        alarms: values.alarms,
        exclusive: values.exclusive,
      },
      execute,
    );
    const output = renderPowerShell(env);
    if (values.output) {
      if (!values.output.toLowerCase().endsWith(".ps1"))
        fail("--output must name a new .ps1 file");
      try {
        writeFileSync(resolve(values.output), "\ufeff" + output, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch {
        fail(
          "Cannot create output file; parent must exist and destination must be new",
        );
      }
    } else process.stdout.write(output);
    return 0;
  } catch (error) {
    // No exception text: CLI parser/IO errors can contain supplied values or secrets.
    const reason =
      error instanceof ConfigurationError
        ? error.message
        : "Check arguments (--help) and local prerequisites";
    process.stderr.write(
      `Configuration generation failed: ${reason}. No settings were emitted.\n`,
    );
    return 2;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main();

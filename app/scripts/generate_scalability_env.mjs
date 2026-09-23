// Read-only discovery. Never initialize Terraform, change AWS, or submit jobs.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** @typedef {(tool: string, args: readonly string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string} CommandExecutor */
/** @typedef {Record<string, any>} Options */
/** @typedef {{directory: string, data: string, state: string}} RuntimeRole */
/** @param {string} message @returns {never} */
const fail = message => { throw new Error(message); };
/** @param {string} parent @param {string} path */
const inside = (parent, path) => { const rel = relative(parent, path); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
/** @param {unknown} error */
export const isMissing = error => error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** @param {string} tool @param {readonly string[]} args @param {NodeJS.ProcessEnv} [env] @param {CommandExecutor} [execute] */
export function command(tool, args, env = process.env, execute = execFileSync) {
  try {
    return execute(tool, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_EC2_METADATA_DISABLED: 'true', TF_INPUT: '0' },
    }).trim();
  } catch { return fail(`Read-only ${tool} command failed; check installation, authentication and configuration.`); }
}

// Intentionally accept literal JSON-compatible assignments only, not arbitrary HCL
// expressions. Read only named non-secret values; never echo file contents.
/** @param {string} text @param {string} name */
function literal(text, name) {
  const matches = [...text.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'gm'))];
  if (matches.length !== 1) fail(`Missing or ambiguous literal setting: ${name}`);
  try { return JSON.parse(matches[0][1]); } catch { fail(`Use a literal value for ${name}`); }
}
/** @param {unknown} actual @param {unknown} expected @param {string} label */
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Configuration mismatch: ${label}`);
}
/** @param {string} raw @param {boolean} [frontend] */
export function origin(raw, frontend = false) {
  try {
    const url = new URL(raw);
    if (typeof raw !== 'string' || /[\s\\]/.test(raw) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || (frontend && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Error();
    return url.origin;
  } catch { return fail('Supply credential-free HTTPS origins (frontend also accepts loopback HTTP).'); }
}

/** @param {string | undefined} raw */
export function runtimeLayout(raw) {
  if (!raw || !isAbsolute(raw)) fail('--runtime must be an existing absolute private directory');
  const runtime = realpathSync(raw);
  if (!statSync(runtime).isDirectory() || inside(realpathSync(ROOT), runtime)) fail('Runtime must be outside the repository');
  const layout = /** @type {{runtime: string, delivery: RuntimeRole, compute: RuntimeRole}} */ ({ runtime });
  for (const role of /** @type {const} */ (['delivery', 'compute'])) {
    const directory = realpathSync(resolve(runtime, role));
    const data = realpathSync(resolve(directory, 'tf-data'));
    const state = realpathSync(resolve(directory, 'terraform.tfstate'));
    if (!inside(runtime, directory) || !inside(directory, data) || !inside(directory, state) ||
        !statSync(data).isDirectory() || !statSync(state).isFile() || !statSync(state).size) fail('Invalid private runtime/state/data layout');
    const backend = readFileSync(resolve(directory, 'backend.tfbackend'), 'utf8');
    equal(literal(backend, 'path'), state, `${role} backend path`);
    const metadata = JSON.parse(readFileSync(resolve(data, 'terraform.tfstate'), 'utf8'));
    equal(metadata.backend?.type, 'local', `${role} initialized backend type`);
    equal(metadata.backend?.config?.path, state, `${role} initialized backend path`);
    // A workspace must not silently select another local state.
    try { equal(readFileSync(resolve(data, 'environment'), 'utf8').trim(), 'default', `${role} workspace`); }
    catch (error) { if (!isMissing(error)) throw error; }
    layout[role] = { directory, data, state };
  }
  if (layout.delivery.state === layout.compute.state || layout.delivery.data === layout.compute.data ||
      layout.delivery.directory === layout.compute.directory) fail('Delivery and compute must be isolated');
  return layout;
}

/** @param {Options} values @param {CommandExecutor} [execute] */
export function discoverEnvironment(values, execute = execFileSync) {
  const layout = runtimeLayout(values.runtime || process.env.SCALABILITY_RUNTIME);
  const api = origin(values['api-url']);
  const frontend = origin(values['frontend-url'], true);
  if (/\.elb\.amazonaws\.com(?:\.cn)?$/.test(new URL(api).hostname)) fail('Use the custom API DNS origin, not the ALB hostname');
  if (!/^\d{12}$/.test(values.account || '')) fail('--account requires the expected 12-digit AWS account');
  if (values.profile && !/^[\w.-]+$/.test(values.profile)) fail('Invalid profile name');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ...(values.profile ? { AWS_PROFILE: values.profile } : {}), TF_WORKSPACE: 'default' };
  // Inherited Terraform CLI injection must not override the selected backend/state.
  for (const name of Object.keys(env)) if (name.startsWith('TF_CLI_ARGS')) delete env[name];
  /** @param {'delivery' | 'compute'} role @param {string} name */
  const output = (role, name) => {
    const root = role === 'delivery' ? 'app/infra/terraform-e2e/scalability' : 'app/infra/terraform-compute';
    return JSON.parse(command('terraform', [`-chdir=${resolve(ROOT, root)}`, 'output', '-json', name],
      { ...env, TF_DATA_DIR: layout[role].data }, execute));
  };
  const d = Object.fromEntries(['aws_region', 'environment_identity', 'video_input_bucket_name', 'playback_base_url', 'video_encoding_queue_url']
    .map(name => [name, output('delivery', name)]));
  const c = Object.fromEntries(['ecs_cluster', 'api_service', 'worker_service', 'orchestration_state_machine', 'api_image_digest', 'worker_image_digest']
    .map(name => [name, output('compute', name)]));
  for (const value of [...Object.values(d), ...Object.values(c)]) if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) fail('Invalid Terraform output');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(d.aws_region) || !/^scalability-e2e-[a-z0-9-]+$/.test(d.environment_identity)) fail('Invalid dedicated environment identity');
  const identity = JSON.parse(command('aws', ['sts', 'get-caller-identity', '--region', d.aws_region, '--output', 'json'], env, execute));
  equal(identity.Account, values.account, 'STS account');
  const delivery = readFileSync(resolve(layout.delivery.directory, 'terraform.tfvars'), 'utf8');
  const compute = readFileSync(resolve(layout.compute.directory, 'compute.tfvars'), 'utf8');
  const instance = d.environment_identity.slice('scalability-e2e-'.length);
  for (const [name, expected] of Object.entries({ aws_account_id: values.account, aws_region: d.aws_region, instance, frontend_origin: frontend })) equal(literal(delivery, name), expected, name);
  for (const [name, expected] of Object.entries({ allowed_account_ids: [values.account], aws_region: d.aws_region,
    project_name: 'streaming-video', environment: `scale-e2e-${instance}`, frontend_origin: frontend,
    shared_state_path: layout.delivery.state, worker_autoscaling_enabled: true,
    worker_autoscaling_min_capacity: 1, worker_autoscaling_max_capacity: 4,
    worker_acceptable_queue_delay_seconds: 900, worker_representative_processing_seconds: 300,
    worker_scale_out_cooldown_seconds: 180, worker_scale_in_cooldown_seconds: 600,
  })) equal(literal(compute, name), expected, name);
  const prefix = `streaming-video-scale-e2e-${instance}`;
  if (prefix.length > 32 || c.ecs_cluster !== prefix ||
      !c.api_service.startsWith(`${prefix}-`) || !c.worker_service.startsWith(`${prefix}-`) ||
      !c.orchestration_state_machine.startsWith(`arn:aws:states:${d.aws_region}:${values.account}:stateMachine:${prefix}-`) ||
      d.video_input_bucket_name !== `sv-scale-e2e-${instance}-${values.account}-${d.aws_region}-input` ||
      !d.video_encoding_queue_url.startsWith(`https://sqs.${d.aws_region}.amazonaws.com/${values.account}/streaming-video-scalability-e2e-${instance}-`)) fail('Outputs are not from the dedicated account/environment');
  for (const name of ['api_image_digest', 'worker_image_digest']) if (!/^sha256:[a-f0-9]{64}$/.test(c[name])) fail('Immutable image digest missing');
  if (!values.fixture) fail('--fixture is required');
  const fixture = realpathSync(resolve(values.fixture));
  if (!statSync(fixture).isFile() || !statSync(fixture).size) fail('Fixture must be a nonempty file');
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-select_streams', 'v', fixture], env, execute));
  const stream = probe.streams?.find((/** @type {any} */ s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || Math.max(stream.width, stream.height) < 1280 || Math.min(stream.width, stream.height) < 720) fail('Fixture requires a real video stream of at least 720p');
  const duration = [stream.duration, probe.format?.duration].map(Number).find(n => Number.isFinite(n) && n > 0);
  if (!duration) fail('Fixture requires a positive finite duration');
  /** @param {string} name @param {number} fallback */
  const number = (name, fallback) => { const n = Number(values[name] ?? fallback); if (!Number.isFinite(n) || n <= 0) fail(`Invalid ${name}`); return n; };
  const config = {
    account_id: identity.Account, region: d.aws_region, environment: d.environment_identity,
    api_url: api, frontend_url: frontend, playback_base_url: origin(d.playback_base_url),
    cluster: c.ecs_cluster, api_service: c.api_service, worker_service: c.worker_service, parent_service: c.worker_service,
    input_bucket: d.video_input_bucket_name, step_functions_arn: c.orchestration_state_machine,
    api_image_digest: c.api_image_digest, worker_image_digest: c.worker_image_digest,
    distributed_mode: true, parent_min_capacity: 1, worker_max_concurrency: 1,
    fixture_path: fixture, fixture_duration_seconds: duration,
    worker_min_capacity: 1, worker_max_capacity: 4, backlog_per_worker_target: 3, processing_seconds: 300,
    scale_out_cooldown_seconds: 180, scale_in_cooldown_seconds: 600,
    submission_window_seconds: number('submission-window-seconds', 60), runtime_budget_seconds: number('runtime-budget-seconds', 3600),
  };
  return { config, layout, env };
}

/** @param {string} path @param {Record<string, unknown>} config */
export function writeHandoff(path, config) {
  // Refuse overwrite/symlinks; setup publishes only after --check succeeds.
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export const HELP = `Required: --runtime ABSOLUTE_PATH --account ID --api-url HTTPS_ORIGIN --frontend-url ORIGIN --fixture PATH
Optional: --profile NAME --submission-window-seconds 60 --runtime-budget-seconds 3600
Runtime must contain existing delivery/compute backend.tfbackend, terraform.tfstate,
tf-data metadata and delivery/terraform.tfvars, compute/compute.tfvars.
Writes a new private runtime/handoff.json; refuses to overwrite an existing handoff.
Read-only AWS/Terraform; does not deploy, start services, or run workloads.
`;
/** @param {string[]} args */
export function argumentsFor(args) {
  return parseArgs({ args, options: { ...Object.fromEntries(['runtime', 'account', 'api-url', 'frontend-url', 'fixture', 'profile',
    'submission-window-seconds', 'runtime-budget-seconds'].map(name => [name, { type: 'string' }])), help: { type: 'boolean' } } }).values;
}
export function main(args = process.argv.slice(2)) {
  try {
    const values = argumentsFor(args);
    if (values.help) { process.stderr.write(HELP); return 0; }
    const { config, layout } = discoverEnvironment(values);
    writeHandoff(resolve(layout.runtime, 'handoff.json'), config);
    process.stderr.write('Private handoff.json generated; run setup or runner --check before use.\n');
    return 0;
  } catch { process.stderr.write('Scalability generation failed; check inputs, private backend/state, Task 89 tfvars, CLI access and fixture. No secret diagnostics are printed.\n'); return 2; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();

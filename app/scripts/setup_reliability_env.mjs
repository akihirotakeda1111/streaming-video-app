// Linux setup orchestration; stdout contains validated NAME=value data only.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverEnvironment, validateGeneratedEnvironment } from './generate_reliability_env.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_NAMES = [
  'AWS_REGION', 'VIDEO_INPUT_BUCKET', 'VIDEO_OUTPUT_BUCKET', 'VIDEO_ENCODING_QUEUE_URL',
  'WORKER_HEARTBEAT_INTERVAL_SECONDS', 'WORKER_VISIBILITY_EXTENSION_SECONDS',
  'WORKER_LEASE_DURATION_SECONDS', 'WORKER_RETRY_DELAY_SECONDS',
  'WORKER_MAXIMUM_ATTEMPTS', 'FRONTEND_ORIGIN',
];
const HELP = `Use: source app/scripts/setup_reliability_env.sh [options]
Required: --account ID --fixture PATH --invalid-fixture PATH
  --clock-skew-ms MS    Clock skew upper bound, 1..5000; default 1000 ms
  --start-worker        Build/start Worker and dependencies after loading Terraform outputs
  --start-services      Build/start Worker, DB, API and frontend; wait for API/frontend health
  --terraform-directory PATH  Default: app/infra/terraform-e2e relative to this script
  --project NAME        Default: streaming-video-e2e
  --frontend-url URL    Default: http://localhost:5173
  --api-url URL         Default: http://localhost:8080
  --evidence-dir PATH   Default: artifacts/reliability-e2e relative to the current directory
  --docker-host HOST    DOCKER_HOST or unix:///var/run/docker.sock; local Linux socket only
  --profile NAME        Runner AWS profile (Terraform uses the calling shell's credentials)
  --alarms A,B,C        Optional three alarm names
  --help               Show help without contacting services
Requires Linux Node.js and Bash. Configure host/Worker/API credentials beforehand.
Does not apply Terraform or run E2E. Startup options can recreate existing containers.
`;

/** @typedef {{account?: string, fixture?: string, 'invalid-fixture'?: string,
 * 'clock-skew-ms'?: string, 'terraform-directory'?: string, project?: string,
 * 'frontend-url'?: string, 'api-url'?: string, 'evidence-dir'?: string,
 * 'docker-host'?: string, profile?: string, alarms?: string, 'start-worker'?: boolean,
 * 'start-services'?: boolean}} SetupOptions */
/** @param {SetupOptions} values
 * @param {import('./generate_reliability_env.mjs').CommandExecutor} [execute]
 * @param {typeof discoverEnvironment} [discover] */
export function setupEnvironment(values, execute = execFileSync, discover = discoverEnvironment) {
  let stage = 'local inputs';
  try {
    const account = values.account;
    if (!/^\d{12}$/.test(account || '')) throw Error();
    const clockSkewMs = values['clock-skew-ms'] ?? '1000';
    if (!/^\d+$/.test(clockSkewMs || '') || Number(clockSkewMs) < 1 || Number(clockSkewMs) > 5000) throw Error();
    const paths = [values.fixture, values['invalid-fixture']].map(path => {
      if (!path) throw Error();
      const absolute = resolve(path), stat = statSync(absolute);
      if (!absolute.toLowerCase().endsWith('.mp4') || !stat.isFile() || !stat.size || stat.size > 1024 ** 3) throw Error();
      return absolute;
    });
    if (paths[0] === paths[1]) throw Error();
    const project = values.project || 'streaming-video-e2e';
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw Error();
    const dockerHost = values['docker-host'] || process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
    if (!/^unix:\/\/\/[^\s]+$/.test(dockerHost)) throw Error();
    const frontendUrl = values['frontend-url'] || 'http://localhost:5173';
    const apiUrl = values['api-url'] || 'http://localhost:8080';
    for (const value of [frontendUrl, apiUrl]) {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      if (values['start-services'] && (url.protocol !== 'http:' || url.pathname !== '/' ||
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error();
    }
    if (values['start-services'] && new URL(frontendUrl).port === new URL(apiUrl).port) throw Error();
    const terraformDirectory = resolve(values['terraform-directory'] || resolve(scripts, '../infra/terraform-e2e'));
    if (!statSync(terraformDirectory).isDirectory()) throw Error();
    /** @param {string} tool @param {string[]} args */
    const command = (tool, args, env = process.env, timeout = 120000) => execute(tool, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 4 * 1024 * 1024, env,
    }).trim();

    if (values['start-services']) {
      stage = 'service credentials (set WORKER_AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY and API_AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY)';
      for (const role of ['WORKER', 'API']) {
        if (!process.env[`${role}_AWS_ACCESS_KEY_ID`]?.trim() || !process.env[`${role}_AWS_SECRET_ACCESS_KEY`]?.trim()) throw Error();
      }
    }

    stage = 'Terraform output (check state access and authentication)';
    const runtime = JSON.parse(command('terraform', [`-chdir=${terraformDirectory}`, 'output', '-json', 'compose_environment']));
    if (!runtime || Array.isArray(runtime) || Object.keys(runtime).length !== RUNTIME_NAMES.length) throw Error();
    for (const name of RUNTIME_NAMES) {
      if (typeof runtime[name] !== 'string' || !runtime[name].trim() || /[\r\n\0]/.test(runtime[name])) throw Error();
    }
    if (!runtime.VIDEO_ENCODING_QUEUE_URL.startsWith(`https://sqs.${runtime.AWS_REGION}.amazonaws.com/${account}/`)) throw Error();
    if (values['start-services'] && runtime.FRONTEND_ORIGIN !== new URL(frontendUrl).origin) {
      stage = 'frontend origin (match --frontend-url to Terraform frontend_origin / S3 CORS)';
      throw Error();
    }
    runtime.FRONTEND_ORIGIN = new URL(frontendUrl).origin;
    // All preparation stays in child environments. The parent Bash changes only on success.
    const childEnv = { ...process.env, ...runtime };
    const compose = ['--host', dockerHost, 'compose', '-p', project,
      '-f', resolve(scripts, '../compose.yaml'), '-f', resolve(scripts, '../compose.e2e.yaml')];
    if (values['start-worker'] || values['start-services']) {
      stage = 'Worker startup (check credentials and Compose configuration)';
      command('docker', [...compose, 'config', '--quiet'], childEnv);
      command('docker', [...compose, 'up', '--build', '-d', 'worker'], childEnv, 1800000);
    }
    stage = 'running Worker/DB lookup (start them first or use --start-services)';
    const worker = command('docker', [...compose, 'ps', '-q', 'worker'], childEnv);
    const database = command('docker', [...compose, 'ps', '-q', 'postgres'], childEnv);
    if (![worker, database].every(id => /^[a-f0-9]{12,64}$/.test(id))) throw Error();
    stage = 'Worker/Terraform consistency (recreate Worker with current settings if needed)';
    const containers = JSON.parse(command('docker', ['--host', dockerHost, 'container', 'inspect', worker], childEnv));
    if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(containers[0].Config?.Env)) throw Error();
    for (const name of RUNTIME_NAMES.filter(name => name !== 'FRONTEND_ORIGIN')) {
      const entries = containers[0].Config.Env.filter((/** @type {unknown} */ entry) => typeof entry === 'string' && entry.startsWith(`${name}=`));
      if (entries.length !== 1 || entries[0] !== `${name}=${runtime[name]}`) throw Error();
    }
    stage = 'E2E generation (check runner authentication, labels, alarms and inputs)';
    const settings = discover({
      worker, database, account, fixture: paths[0], invalidFixture: paths[1], clockSkewMs,
      frontendUrl, apiUrl, dockerHost, evidenceDir: values['evidence-dir'],
      profile: values.profile, alarms: values.alarms, disposable: true, full: true,
    }, (tool, args, options) => execute(tool, args, { ...options, env: { ...options.env, ...runtime } }));
    // Reuse the generator's allowlist/value validation, without evaluating shell code.
    validateGeneratedEnvironment(settings);
    if (values['start-services']) {
      stage = 'API/frontend startup (check API credentials, ports and container health)';
      const serviceEnv = { ...childEnv, ...settings };
      command('docker', [...compose, 'config', '--quiet'], serviceEnv);
      // Worker/DB identities were just captured. Do not recreate dependencies here.
      command('docker', [...compose, 'up', '--build', '-d', '--no-deps',
        '--wait', '--wait-timeout', '120', 'api', 'frontend'], serviceEnv, 1800000);
    }
    return { ...runtime, ...settings };
  } catch {
    throw new Error(`Reliability setup failed at: ${stage}. Shell settings were not changed. Containers already started are left running.`);
  }
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = Object.fromEntries(['account', 'fixture', 'invalid-fixture', 'clock-skew-ms',
      'terraform-directory', 'project', 'frontend-url', 'api-url', 'evidence-dir', 'docker-host',
      'profile', 'alarms'].map(name => [name, { type: 'string' }]));
    const { values } = parseArgs({ args, options: { ...options, 'start-worker': { type: 'boolean' },
      'start-services': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) { process.stderr.write(HELP); return 0; }
    if (process.platform !== 'linux') { process.stderr.write('Use Linux Node.js inside WSL/Linux.\n'); return 2; }
    const env = setupEnvironment(values);
    process.stdout.write(Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
    return 0;
  } catch (error) {
    process.stderr.write((error instanceof Error && error.message.startsWith('Reliability setup failed at:') ? error.message : 'Invalid setup arguments; use --help.') + '\n');
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();

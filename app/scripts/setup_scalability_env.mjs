// stdout is NAME=value data only, and only after every setup check passes.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, command, discoverEnvironment, HELP, isMissing, ROOT, writeHandoff } from './generate_scalability_env.mjs';

/** @param {{frontend_url: string, api_url: string}} config @param {typeof fetch} [request] */
export async function checkReachability(config, request = fetch) {
  /** @param {string} url @param {RequestInit} [options] */
  const get = async (url, options = {}) => {
    const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (!response.ok) throw Error('HTTP check failed');
    return response;
  };
  await get(config.frontend_url);
  const health = await get(`${config.api_url}/api/v1/health`, { headers: { Origin: config.frontend_url } });
  const cors = await get(`${config.api_url}/api/v1/videos`, { method: 'OPTIONS', headers: {
    Origin: config.frontend_url, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } });
  const tokens = (/** @type {string} */ name) => (cors.headers.get(name) || '').toLowerCase().split(',').map(s => s.trim());
  if ([health, cors].some(r => r.headers.get('access-control-allow-origin') !== config.frontend_url) ||
      !tokens('access-control-allow-methods').includes('post') || !tokens('access-control-allow-headers').includes('content-type')) throw Error('API CORS does not allow frontend POST/content-type');
}

/** @param {import('./generate_scalability_env.mjs').Options} values
 * @param {import('./generate_scalability_env.mjs').CommandExecutor} [execute] @param {typeof fetch} [request] */
export async function setupEnvironment(values, execute = execFileSync, request = fetch) {
  let stage = 'required CLIs';
  let temporary, candidate;
  try {
    const versions = /** @type {const} */ ([['node', ['--version']], ['python', ['--version']], ['aws', ['--version']],
      ['terraform', ['version', '-json']], ['ffprobe', ['-version']], ['ffmpeg', ['-version']]]);
    for (const [tool, args] of versions) command(tool, args, process.env, execute);
    stage = 'private runtime/backend/state, Terraform outputs, STS identity, Task 89 settings and fixture';
    const { config, layout, env } = discoverEnvironment(values, execute);
    stage = 'frontend/API reachability and CORS';
    await checkReachability(config, request);
    stage = 'handoff generation and runner --check';
    temporary = mkdtempSync(resolve(layout.runtime, '.scalability-setup-'));
    candidate = resolve(temporary, 'handoff.json');
    writeHandoff(candidate, config);
    const childEnv = { ...env, SCALABILITY_E2E_CONFIG: candidate, AWS_REGION: config.region, AWS_DEFAULT_REGION: config.region };
    command('python', [resolve(ROOT, 'app/scripts/run_scalability_e2e.py'), '--check'], childEnv, execute);
    const destination = resolve(layout.runtime, 'handoff.json');
    // Re-sourcing the same setup is safe. Never replace a different reviewed handoff.
    try {
      if (!lstatSync(destination).isFile() || JSON.stringify(JSON.parse(readFileSync(destination, 'utf8'))) !== JSON.stringify(config)) throw Error('Existing handoff differs');
      unlinkSync(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Exclusive creation also protects against a concurrently created destination.
      writeHandoff(destination, config);
      unlinkSync(candidate);
    }
    candidate = undefined;
    const settings = { SCALABILITY_RUNTIME: layout.runtime, SCALABILITY_E2E_CONFIG: destination,
      AWS_REGION: config.region, AWS_DEFAULT_REGION: config.region,
      SCALABILITY_E2E_EVIDENCE_ROOT: resolve(layout.runtime, 'evidence'),
      ...(values.profile ? { AWS_PROFILE: values.profile } : {}),
    };
    for (const value of Object.values(settings)) if (/[\r\n\0]/.test(value)) throw Error('Invalid export');
    return settings;
  } catch { throw new Error(`Scalability setup failed at: ${stage}. Shell settings were not changed. Existing handoffs must match; use a separate reviewed runtime for another environment.`); }
  finally {
    if (candidate) { try { unlinkSync(candidate); } catch { /* already absent */ } }
    if (temporary) { try { rmdirSync(temporary); } catch { /* do not remove unrelated files */ } }
  }
}

export async function main(args = process.argv.slice(2)) {
  try {
    const values = argumentsFor(args);
    if (values.help) { process.stderr.write(`Use: source app/scripts/setup_scalability_env.sh [options]\n${HELP}`); return 0; }
    if (process.platform !== 'linux') { process.stderr.write('Use Linux Node.js inside WSL/Linux.\n'); return 2; }
    const settings = await setupEnvironment(values);
    process.stdout.write(Object.entries(settings).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
    return 0;
  } catch (error) {
    process.stderr.write((error instanceof Error && error.message.startsWith('Scalability setup failed at:') ? error.message : 'Invalid setup arguments; use --help.') + '\n');
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

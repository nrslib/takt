import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { buildExecutionOutput, readExecutionEvidence } from '../manager-work-split-execution-result.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const executionCases = new Set(['stopped-background-execution', 'integrated-task-execution']);

export function executionConfig(config, vars) {
  if (!executionCases.has(vars.case) || !['ja', 'en'].includes(vars.lang)) throw new Error('Invalid execution case');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('Execution model is required');
  if (!Number.isSafeInteger(config.timeout_ms) || config.timeout_ms <= 0) throw new Error('Positive timeout_ms is required');
  if (config.judge_effort !== 'low') throw new Error('Execution judge_effort must be low');
  return { ...config, case: vars.case, lang: vars.lang };
}

export async function runExecutionWorker(config, artifactDir, signal) {
  const configPath = join(artifactDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const env = { ...process.env, TAKT_NOTIFY_WEBHOOK: '' };
  delete env.TAKT_PROVIDER;
  delete env.TAKT_MODEL;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./manager-work-split-execution-worker.mjs', import.meta.url)), configPath, artifactDir], {
    cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const stderrPath = join(artifactDir, 'worker-stderr.log');
  writeFileSync(stderrPath, '');
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => appendFileSync(stderrPath, chunk));
  let hardKill;
  let interrupted = false;
  const killGroup = (name) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => {
    interrupted = true;
    killGroup('SIGTERM');
    hardKill ??= setTimeout(() => killGroup('SIGKILL'), 5000);
  };
  // Three turns plus fixture setup/cleanup; each turn has its own deadline in the worker.
  const timer = setTimeout(stop, config.timeout_ms * 3 + 30000);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const status = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
      if (signal?.aborted) stop();
    });
    writeFileSync(join(artifactDir, 'worker-exit.json'), JSON.stringify({ ...status, interrupted }));
    if (interrupted || status.code !== 0) throw new Error(`Execution worker failed (${status.code}, ${status.signal}); see ${artifactDir}`);
    return JSON.parse(readFileSync(join(artifactDir, 'trial.json'), 'utf8'));
  } finally {
    clearTimeout(timer);
    clearTimeout(hardKill);
    signal?.removeEventListener('abort', stop);
    killGroup('SIGKILL');
  }
}

export default class ManagerExecutionProvider {
  constructor(options = {}) { this.config = options.config ?? {}; }
  id() { return `manager-execution:${this.config.model}`; }
  async callApi(_prompt, context, options = {}) {
    let artifactDir;
    try {
      const config = executionConfig(this.config, context.vars);
      const root = resolve(repoRoot, config.artifact_root ?? 'eval/.results/manager-execution');
      mkdirSync(root, { recursive: true });
      artifactDir = mkdtempSync(join(root, `${config.case}-${config.lang}-`));
      config.instruction_root = process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
      config.sdk_root = resolve(process.env.TAKT_CONFIG_DIR || join(homedir(), '.takt'), 'claude-sdk');
      const result = await runExecutionWorker(config, artifactDir, options.abortSignal);
      if (!result.complete) throw new Error(result.error);
      return { output: JSON.stringify(buildExecutionOutput(artifactDir, readExecutionEvidence(artifactDir))),
        metadata: { artifact_dir: artifactDir } };
    } catch (error) {
      return { error: error.message, metadata: { artifact_dir: artifactDir } };
    }
  }
}

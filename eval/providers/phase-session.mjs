import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phaseCase } from '../phase-awareness-cases.mjs';
import { phaseEnvironment } from './phase-cli.mjs';

const evalDir = fileURLToPath(new URL('../', import.meta.url));

export function phaseProviderConfig(config, context) {
  const merged = { ...config, case_id: context?.vars?.case_id ?? config.case_id };
  phaseCase(merged.case_id);
  if (!['codex', 'claude'].includes(merged.cli) || typeof merged.model !== 'string') throw new Error('phase-session requires cli and model');
  if (merged.isolate_working_dir !== true) throw new Error('phase-session always requires isolate_working_dir: true');
  if (typeof merged.dist_dir !== 'string' || !merged.dist_dir) throw new Error('phase-session requires dist_dir');
  if (merged.working_dir !== 'fixtures/phase-awareness') throw new Error('phase-session requires its fixed fixture');
  if (merged.cli === 'codex' && !['low', 'max'].includes(merged.reasoning_effort)) throw new Error('Missing Codex reasoning_effort');
  if (!Number.isInteger(merged.timeout_ms) || merged.timeout_ms <= 0) throw new Error('phase-session requires a positive timeout_ms');
  return { ...merged, dist_dir: resolve(evalDir, merged.dist_dir) };
}

export default class PhaseSessionProvider {
  constructor(options = {}) { this.config = options.config ?? {}; }
  id() { return `phase-session:${this.config.cli}:${this.config.model}:${this.config.reasoning_effort ?? ''}`; }

  async callApi(_prompt, context, options = {}) {
    let artifactDir;
    try {
      const config = phaseProviderConfig(this.config, context);
      const resultRoot = resolve(evalDir, config.artifact_root ?? '.results/phase-awareness');
      mkdirSync(resultRoot, { recursive: true });
      artifactDir = mkdtempSync(join(resultRoot, `${config.case_id}-`));
      const configPath = join(artifactDir, 'config.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      // Each attempt has its own process: baseline imports and the provider bridge cannot cross trials.
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./phase-session-worker.mjs', import.meta.url)), configPath, artifactDir], {
        cwd: resolve(evalDir, '..'), env: { ...phaseEnvironment(process.env), TAKT_CONFIG_DIR: join(evalDir, 'config') },
        timeout: config.timeout_ms * 8, killSignal: 'SIGTERM', signal: options.abortSignal, maxBuffer: 2 * 1024 * 1024,
      });
      const trial = JSON.parse(readFileSync(join(artifactDir, 'trial.json'), 'utf8'));
      if (!trial.complete) throw new Error(trial.error);
      return { output: JSON.stringify({ artifact_dir: artifactDir }), metadata: { artifact_dir: artifactDir, calls: trial.turns.length } };
    } catch (error) {
      return { error: error.message, metadata: { artifact_dir: artifactDir } };
    }
  }
}

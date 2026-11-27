import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveHeavyItTargets } from './heavy-it-guard.mjs';
import { resolveNpmInvocation } from './npm-invocation.mjs';

const vitestPath = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../vitest.config.it.heavy.parallel.ts', import.meta.url));
const vitestArgs = ['run', '--config', configPath, ...process.argv.slice(2)];

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit' });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
}

await resolveHeavyItTargets(vitestArgs);

// npm's pre hook cannot see the file arguments passed to the main script.
// A lowercase empty string can represent an explicit --ignore-scripts=false.
const ignoreScripts = process.env.npm_config_ignore_scripts ?? process.env.NPM_CONFIG_IGNORE_SCRIPTS;
if (ignoreScripts !== 'true') {
  const npm = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  const code = run(npm.executable, [...npm.args, 'run', 'test:deepseek-harness:types']);
  if (code !== 0) {
    process.exit(code);
  }
}

process.exitCode = run(process.execPath, [vitestPath, ...vitestArgs]);

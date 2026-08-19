#!/usr/bin/env node
/**
 * Run promptfoo eval suites sequentially without stopping on failures
 * (promptfoo exits non-zero when a test fails, which would break `&&` chains).
 *
 * Usage: node eval/scripts/run-evals.mjs [suite...] [--tier active|retained]
 *        [--prepare] [--list] [--promptfoo-flags...]
 * Default: active suites whose execution metadata permits the default run.
 * Example: npm run eval:prompts -- arch --repeat 3
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPT_EVAL_SUITES,
  PROMPT_EVAL_TIERS,
  promptEvalPrepareTargets,
  selectPromptEvalSuites,
} from '../suite-registry.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const repoRoot = resolve(evalDir, '..');

function parseArgs(args) {
  const names = [];
  const flags = [];
  let tier;
  let prepare = false;
  let list = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--tier') {
      tier = args[index + 1];
      index += 1;
      if (!PROMPT_EVAL_TIERS.includes(tier)) {
        throw new Error(`Unknown prompt eval tier "${tier}"`);
      }
    } else if (arg === '--prepare') {
      prepare = true;
    } else if (arg === '--list') {
      list = true;
    } else if (arg.startsWith('-')) {
      flags.push(...args.slice(index));
      break;
    } else {
      names.push(arg);
    }
  }
  if (tier !== undefined && names.length > 0) {
    throw new Error('Choose either explicit suite names or --tier, not both');
  }
  return { names, flags, tier, prepare, list };
}

function printRegistry() {
  for (const suite of PROMPT_EVAL_SUITES) {
    const execution = suite.execution.defaultEligible ? 'default' : 'explicit';
    console.log(
      `${suite.name}\ttier=${suite.tier}\texecution=${execution}`
      + `\tcost=${suite.execution.cost}\tcredentials=${suite.execution.credentials.join('+')}`,
    );
    console.log(`  ${suite.reason}`);
    if (!suite.execution.defaultEligible) console.log(`  execution: ${suite.execution.reason}`);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.list) {
  printRegistry();
  process.exit(0);
}
const selected = selectPromptEvalSuites(options);

if (options.prepare) {
  const targets = promptEvalPrepareTargets(selected);
  if (targets.length > 0) {
    const preparation = spawnSync('node', ['eval/scripts/prepare.mjs', ...targets], {
      stdio: 'inherit',
      cwd: repoRoot,
    });
    if (preparation.status !== 0) process.exit(preparation.status ?? 1);
  }
}

const summary = [];
for (const suite of selected) {
  const config = join(evalDir, suite.config);
  console.log(`\n=== suite: ${suite.name} (${suite.config}) ===`);
  const result = spawnSync('npx', ['promptfoo', 'eval', '-c', config, '--no-progress-bar', ...options.flags], {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  summary.push({ name: suite.name, code: result.status ?? 1 });
}

console.log('\n=== eval summary ===');
for (const { name, code } of summary) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}`);
}
process.exit(summary.some((s) => s.code !== 0) ? 1 : 0);

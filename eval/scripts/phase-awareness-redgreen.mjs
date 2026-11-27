import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { PHASE_CASES, PHASE_PROVIDERS, trialCount } from '../phase-awareness-cases.mjs';
import { gradePhaseTrial } from '../asserts/phase-awareness.mjs';
import { preparePhaseAwareness } from './prepare-phase-awareness.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function redGreenPlan({ smoke, redDist, greenDist }) {
  if (!redDist) throw new Error('--red-dist is required; specify the main build dist directory');
  return ['red', 'green'].flatMap((variant) => PHASE_PROVIDERS.flatMap((provider) => PHASE_CASES.map((entry) => ({
    provider, entry, variant, count: trialCount(entry, provider, variant, smoke),
    dist: variant === 'red' ? redDist : greenDist,
  })).filter((row) => row.count > 0)));
}

export function improvementVerdict(summary, caseId) {
  const select = (variant) => summary.find((row) => row.provider === 'luna-max' && row.case === caseId && row.variant === variant);
  const red = select('red');
  const green = select('green');
  if (summary.some((row) => row.invalid > 0 || row.valid < row.actual)
    || !red || !green || red.actual !== red.expected || green.actual !== green.expected) return '判定不能';
  return red.expected === 10 && green?.expected === 10
    && red.actual === 10 && green.actual === 10 && red.valid === 10 && green.valid === 10
    && red.pass <= 5 && green.pass === 10 ? '改善あり' : '改善を示せない';
}

export function validateTrialSessions(trials) {
  const allSessions = new Set();
  for (const trial of trials) {
    const first = trial.turns[0];
    if (!first || first.requestedSessionId || !first.sessionId) throw new Error('Trial did not start a fresh session');
    const kind = PHASE_CASES.find((entry) => entry.id === trial.case).kind;
    const expectedCalls = kind === 'judge' ? (trial.config.case_id === '6b' ? 3 : 1)
      : kind === 'judge-stale' ? 2
      : ['report-new', 'missing-new'].includes(kind) ? 1
      : ['report-same', 'report-stale', 'missing-same'].includes(kind) ? 2 : 3;
    if (trial.turns.length !== expectedCalls) throw new Error(`Wrong actual call count for ${trial.case}: ${trial.turns.length}/${expectedCalls}`);
    const prior = new Set();
    for (const turn of trial.turns) {
      if (turn.requestedSessionId && !prior.has(turn.requestedSessionId)) throw new Error('Resume refers to an external session');
      if (!turn.requestedSessionId && prior.has(turn.sessionId)) throw new Error('Fresh call reused an existing session');
      if (!turn.requestedSessionId && allSessions.has(turn.sessionId)) throw new Error('Session was shared across trials');
      prior.add(turn.sessionId);
      allSessions.add(turn.sessionId);
    }
  }
}

export function phaseMatrixPassed(summary, smoke) {
  if (!summary.every((row) => row.actual === row.expected && row.valid === row.expected)) return false;
  if (smoke) return summary.every((row) => row.pass === row.expected);
  const controls = summary.filter((row) => !['1', '2'].includes(row.case) || row.variant === 'green');
  return controls.every((row) => row.pass === row.expected)
    && ['1', '2'].every((id) => improvementVerdict(summary, id) === '改善あり');
}

function runPromptfoo(args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/.bin/promptfoo'), ...args], { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });
}

export async function runRedGreen(options) {
  const plan = redGreenPlan(options)
    .filter((row) => options.caseIds === undefined || options.caseIds.includes(row.entry.id))
    .filter((row) => options.groups === undefined || options.groups.includes(`${row.variant}:${row.provider.id}`));
  const runDir = options.outputDir;
  mkdirSync(join(runDir, 'trials'), { recursive: true });
  preparePhaseAwareness();
  const manifest = readFileSync(join(repoRoot, 'eval/prompts/phase-awareness.manifest.json'), 'utf8');
  writeFileSync(join(runDir, 'manifest.json'), manifest);
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
  const base = parse(readFileSync(join(repoRoot, 'eval/scenarios/phase-awareness/phase-awareness.yaml'), 'utf8'));
  // Configs remain beside their source suite so file:// paths keep the same meaning.
  const configDirectory = join(repoRoot, 'eval/scenarios/phase-awareness');
  const executions = [];
  try {
    const groupKeys = [...new Set(plan.map((row) => `${row.variant}:${row.provider.id}:${row.count}`))];
    for (const key of groupKeys) {
      const rows = plan.filter((row) => `${row.variant}:${row.provider.id}:${row.count}` === key);
      const { variant, provider, count, dist } = rows[0];
      console.log(`phase-awareness ${key}: ${rows.map((row) => row.entry.id).join(', ')}`);
      const suiteProvider = base.providers.find((item) => item.label === provider.id);
      const config = {
        ...base,
        description: `${base.description} ${key} ${options.smoke ? 'harness-smoke' : 'fixed-matrix'}`,
        providers: [{ ...suiteProvider, config: { ...suiteProvider.config, dist_dir: dist,
          artifact_root: join(runDir, 'trials'), variant } }],
        tests: base.tests.filter((item) => rows.some((row) => row.entry.id === item.vars.case_id)),
        evaluateOptions: { ...base.evaluateOptions, repeat: count,
          ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }) },
      };
      const configPath = join(configDirectory, `.phase-awareness-${process.pid}.json`);
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      const outputPath = join(runDir, `${variant}-${provider.id}-${count}.json`);
      const args = ['eval', '-c', configPath, '--no-cache', '--no-progress-bar', '--output', outputPath];
      writeFileSync(join(runDir, `${variant}-${provider.id}-${count}-command.json`), JSON.stringify({ command: 'promptfoo', args }, null, 2));
      executions.push({ key, ...await runPromptfoo(args, repoRoot, {
        ...process.env, PROMPTFOO_CONFIG_DIR: join(repoRoot, '.tmp/promptfoo'),
      }) });
      writeFileSync(join(runDir, 'executions.json'), JSON.stringify(executions, null, 2));
    }
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(join(configDirectory, `.phase-awareness-${process.pid}.json`), { force: true });
  }
  preparePhaseAwareness();
  if (manifest !== readFileSync(join(repoRoot, 'eval/prompts/phase-awareness.manifest.json'), 'utf8')) throw new Error('Frozen eval inputs changed during red/green');
  return summarizeRedGreen(plan, runDir, executions, options.smoke);
}

export async function summarizeRedGreen(plan, runDir, executions, smoke, gradeTrial = gradePhaseTrial) {
  const artifacts = readdirSync(join(runDir, 'trials')).map((path) => join(runDir, 'trials', path));
  const trials = [];
  for (const artifactDir of artifacts) {
    try {
      const trial = JSON.parse(readFileSync(join(artifactDir, 'trial.json'), 'utf8'));
      const grade = await gradeTrial(trial, { artifactDir });
      writeFileSync(join(artifactDir, 'grade.json'), JSON.stringify(grade, null, 2));
      trials.push({ ...trial, grade, artifactDir });
    } catch (error) {
      const config = JSON.parse(readFileSync(join(artifactDir, 'config.json'), 'utf8'));
      trials.push({ case: config.case_id, config, turns: [], grade: { valid: false, pass: false, reason: error.message }, artifactDir });
    }
  }
  let independenceError;
  try { validateTrialSessions(trials); } catch (error) { independenceError = error.message; }
  const summary = plan.map(({ provider, entry, variant, count }) => {
    const matches = trials.filter((trial) => trial.config.id === provider.id && trial.case === entry.id && trial.config.variant === variant);
    return {
      provider: provider.id, case: entry.id, variant, expected: count, actual: matches.length,
      valid: matches.filter((trial) => trial.grade.valid).length,
      invalid: matches.filter((trial) => !trial.grade.valid).length,
      pass: matches.filter((trial) => trial.grade.valid && trial.grade.pass).length,
      fail: matches.filter((trial) => trial.grade.valid && !trial.grade.pass).length,
      calls: matches.reduce((sum, trial) => sum + trial.turns.length, 0),
      results: matches.map((trial) => ({ artifactDir: trial.artifactDir, ...trial.grade })),
    };
  });
  const lines = ['| provider | ケース | red | green |', '|---|---|---|---|'];
  for (const provider of PHASE_PROVIDERS.filter((item) => !smoke || item.id === 'sol-low')) {
    for (const entry of PHASE_CASES) {
      const value = (variant) => {
        const row = summary.find((item) => item.provider === provider.id && item.case === entry.id && item.variant === variant);
        return row ? `${row.pass}/${row.expected}（不合格 ${row.fail}、無効 ${row.invalid}、実試行 ${row.actual}、CLI ${row.calls}）` : '対象外';
      };
      lines.push(`| ${provider.cli} ${provider.model} ${provider.reasoning_effort ?? ''} | ${entry.id} | ${value('red')} | ${value('green')} |`);
    }
  }
  lines.push('', ...['1', '2'].map((id) => `ケース${id} Luna max: ${improvementVerdict(summary, id)}${smoke ? '（ハーネス確認のみ）' : ''}`));
  if (independenceError) lines.push(`試行の独立性／実呼び出し件数: FAIL: ${independenceError}`);
  const report = { smoke, executions, independenceError, summary,
    improvement: Object.fromEntries(['1', '2'].map((id) => [id, improvementVerdict(summary, id)])) };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  console.log(`結果: ${runDir}`);
  return !independenceError && executions.every((execution) => [0, 100].includes(execution.code))
    && phaseMatrixPassed(summary, smoke);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = {
    smoke: false, greenDist: join(repoRoot, 'dist'),
    outputDir: join(repoRoot, 'eval/.results/phase-awareness', new Date().toISOString().replaceAll(':', '-')),
  };
  let planOnly = false;
  let reportOnly;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--smoke') options.smoke = true;
    else if (arg === '--cases') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --cases');
      options.caseIds = value.split(',');
      if (options.caseIds.some((id) => !PHASE_CASES.some((entry) => entry.id === id))) throw new Error('Unknown case ID in --cases');
    }
    else if (arg === '--groups') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --groups');
      options.groups = value.split(',');
    }
    else if (arg === '--max-concurrency') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--max-concurrency must be a positive integer');
      options.maxConcurrency = value;
    }
    else if (arg === '--plan') planOnly = true;
    else if (arg === '--report-only') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --report-only');
      reportOnly = resolve(value);
    }
    else if (arg === '--no-cache') { /* Always enforced on every promptfoo invocation. */ }
    else if (['--red-dist', '--green-dist', '--output-dir'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[{ '--red-dist': 'redDist', '--green-dist': 'greenDist', '--output-dir': 'outputDir' }[arg]] = resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (reportOnly) {
    const plan = JSON.parse(readFileSync(join(reportOnly, 'plan.json'), 'utf8'));
    const prior = JSON.parse(readFileSync(join(reportOnly, 'summary.json'), 'utf8'));
    process.exitCode = await summarizeRedGreen(plan, reportOnly, prior.executions, prior.smoke) ? 0 : 1;
  } else if (planOnly) console.log(JSON.stringify(redGreenPlan(options), null, 2));
  else process.exitCode = await runRedGreen(options) ? 0 : 1;
}

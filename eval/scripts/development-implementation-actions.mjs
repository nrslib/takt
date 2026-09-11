import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadWorkflowFromFile } from '../../dist/infra/config/loaders/workflowLoader.js';
import { codexSkillOverrides, runProcess } from '../providers/cli-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const models = [
  { cli: 'claude', model: 'claude-opus-5' },
  { cli: 'codex', model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
  { cli: 'kimi', model: 'kimi-code/k3' },
];
const checker = `import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { formatLabel } from '../src/label.mjs';
const check = process.argv[2];
assert.ok(['build', 'lint', 'unit', 'integration', 'artifact'].includes(check));
if (['unit', 'integration', 'artifact'].includes(check)) {
  assert.equal(formatLabel(' red apple '), 'RED APPLE');
  assert.equal(formatLabel('blue berry'), 'BLUE BERRY');
}
if (check === 'artifact') {
  mkdirSync('output', { recursive: true });
  writeFileSync('output/labels.json', JSON.stringify([' red apple ', 'blue berry'].map(formatLabel)));
  assert.deepEqual(JSON.parse(readFileSync('output/labels.json', 'utf8')), ['RED APPLE', 'BLUE BERRY']);
}
appendFileSync('checks.jsonl', JSON.stringify({ check, success: true, time: new Date().toISOString() }) + '\\n');
console.log(check + ' passed');
`;
const gates = `## Completion conditions
Run npm run build, npm run lint, npm test, and npm run test:it sequentially and verify success.
Do not run unrelated whole suites.
`;

function fixture(sample) {
  const files = {
    'package.json': JSON.stringify({ name: 'local-label-evaluation', private: true, type: 'module', scripts: {
      build: 'node scripts/check.mjs build', lint: 'node scripts/check.mjs lint',
      test: 'node scripts/check.mjs unit', 'test:it': 'node scripts/check.mjs integration',
      'test:artifact': 'node scripts/check.mjs artifact',
    } }, null, 2),
    'src/label.mjs': sample.initial_source,
    'scripts/check.mjs': checker,
    'reports/plan.md': sample.plan,
    'reports/test-report.md': 'scripts/check.mjs contains the existing contract checks. No dependencies are required.\n',
    'TASK.md': sample.task,
  };
  if (sample.prior_report) files['reports/implementation-report.md'] = sample.prior_report;
  return files;
}

export function actionGateCondition(projectConfig, revision) {
  const qualityGates = parse(projectConfig)?.workflow_overrides?.steps?.implement?.quality_gates;
  const smokeGate = Array.isArray(qualityGates)
    ? qualityGates.find(gate => typeof gate === 'string' && gate.includes('npm run test:e2e:smoke')) : undefined;
  assert.equal(typeof smokeGate, 'string',
    `${revision}: .takt/config.yaml has no implement quality gate for npm run test:e2e:smoke`);
  const condition = smokeGate.match(/((?:only )?when .+), and verify/);
  assert.ok(condition, `${revision}: smoke gate wording does not match the expected condition pattern`);
  return condition[1]
    .replace('CLI startup, workflow execution', 'tools/platform, command startup')
    .replace('config loading', 'configuration loading');
}

export function buildActionManifest(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision) && revision !== 'candidate') throw new Error('Use a full SHA or candidate');
  const resourceBase = revision === 'candidate' ? root : mkdtempSync(join(tmpdir(), 'takt-actions-baseline-'));
  if (revision !== 'candidate') {
    const archive = execFileSync('git', ['archive', revision, 'builtins'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', resourceBase], { input: archive });
  }
  const cases = readFileSync(join(root, 'eval/cases/development-implementation-actions.yaml'), 'utf8');
  const projectConfig = revision === 'candidate' ? readFileSync(join(root, '.takt/config.yaml'), 'utf8')
    : execFileSync('git', ['show', `${revision}:.takt/config.yaml`], { cwd: root, encoding: 'utf8' });
  const gateCondition = actionGateCondition(projectConfig, revision);
  const resourceRoot = join(resourceBase, 'builtins/ja');
  const loaderCwd = mkdtempSync(join(tmpdir(), 'takt-actions-loader-'));
  const workflow = loadWorkflowFromFile(join(resourceRoot, 'workflows/development-implement.yaml'), loaderCwd, { resourceRoot });
  const step = workflow.steps.find(item => item.name === 'implement');
  assert.equal(typeof step.instruction, 'string');
  const instruction = step.instruction.replaceAll('{report:plan.md}', 'reports/plan.md')
    .replaceAll('{report:test-report.md}', 'reports/test-report.md');
  const samples = parse(cases).map(sample => ({ ...sample, files: fixture(sample), prompt:
    `You are executing the implementation work phase with real local tools. Work only in the supplied project. Do not access credentials, network services, or other projects. Do not change scripts/check.mjs, package.json, TASK.md, or reports/plan.md.\nReport Directory: reports\nUser Request: Read TASK.md and implement the supplied task.\n\n## Implementation instruction\n${instruction}\n\n## Supplied plan\n${sample.plan}\n\n${gates}${sample.conditional_gate ? `Run npm run test:artifact ${gateCondition}.\n` : ''}`,
  }));
  return { revision, evaluation: 'tool-enabled-implementation-completion', models, casesHash: digest(cases), instruction, samples };
}

export function scoreActionArtifacts(sample, directory, raw = '', cli) {
  let receipts;
  let labels;
  try {
    receipts = existsSync(join(directory, 'checks.jsonl'))
      ? readFileSync(join(directory, 'checks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    labels = existsSync(join(directory, 'output/labels.json'))
      ? JSON.parse(readFileSync(join(directory, 'output/labels.json'), 'utf8')) : null;
  } catch {
    return { pass: false, reason: 'malformed_artifacts' };
  }
  const checks = receipts.filter(item => item?.success === true).map(item => item.check);
  const missing = sample.expected_checks.filter(check => !checks.includes(check));
  const immutableChanged = ['scripts/check.mjs', 'package.json', 'TASK.md', 'reports/plan.md']
    .filter(path => !existsSync(join(directory, path)) || readFileSync(join(directory, path), 'utf8') !== sample.files[path]);
  const artifactMatches = JSON.stringify(labels) === JSON.stringify(sample.expected_labels);
  const execution = executionEvidence(raw, cli, sample.expected_checks);
  return { pass: missing.length === 0 && immutableChanged.length === 0 && artifactMatches && execution.pass,
    missing, immutableChanged, artifactMatches, checks, labels, receipts, execution };
}

const scriptChecks = { build: 'build', lint: 'lint', test: 'unit', 'test:it': 'integration', 'test:artifact': 'artifact' };

function npmCheck(statement) {
  if (statement === 'npm test') return 'unit';
  const match = statement.match(/^npm run (?:--silent )?(build|lint|test|test:it|test:artifact)$/);
  return match ? scriptChecks[match[1]] : undefined;
}

function diagnostic(statement, variable) {
  if (/^set -(?:e|o pipefail)$/.test(statement)) return true;
  if (/^(?:cat (?:output\/labels\.json|checks\.jsonl)|tail -n [1-9]\d* checks\.jsonl)$/.test(statement)) return true;
  if (statement === 'echo') return true;
  const quoted = statement.match(/^echo "([^"`\\]*)"$/)?.[1];
  if (quoted === undefined || quoted.includes('passed')) return false;
  const withoutStatus = quoted.replaceAll('$?', '');
  const literal = variable ? withoutStatus.replace(new RegExp(`\\$${variable}(?!\\w)`, 'g'), '') : withoutStatus;
  return !/[$\r\n]/.test(literal);
}

// A closed syntax for fixture npm checks, sequential separators, diagnostics,
// and literal for loops. Unsupported shell syntax is unverified, never executed.
export function invokedChecks(command) {
  const wrapped = command.match(/^\/bin\/(?:ba|z)sh -lc '([^']*)'$/);
  const source = wrapped ? wrapped[1] : command;
  if (/[\r\n]/.test(source)) return [];
  const tokens = source.match(/(?:[^;&|<>`\\'"\r\n]|"[^"`\\\r\n]*"|'[^'`\\\r\n]*')+|&&|;/g);
  if (!tokens || tokens.join('') !== source) return [];
  const statements = tokens.filter(token => token !== ';' && token !== '&&').map(token => token.trim());
  const checks = [];
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    const loop = statement.match(/^for ([A-Za-z_][A-Za-z0-9_]*) in ((?:build|lint|test|test:it|test:artifact)(?: (?:build|lint|test|test:it|test:artifact))*)$/);
    if (loop) {
      const [, variable, scripts] = loop;
      const body = [];
      if (!statements[index + 1]?.startsWith('do ')) return [];
      index++;
      body.push(statements[index].slice(3));
      while (statements[++index] !== 'done') {
        if (index >= statements.length) return [];
        body.push(statements[index]);
      }
      const invocation = new RegExp(`^npm run (?:--silent )?\\$${variable}$`);
      if (body.filter(part => invocation.test(part)).length !== 1
        || body.some(part => !invocation.test(part) && !diagnostic(part, variable))) return [];
      checks.push(...scripts.split(' ').map(script => scriptChecks[script]));
    } else {
      const check = npmCheck(statement);
      if (check) checks.push(check);
      else if (!diagnostic(statement)) return [];
    }
  }
  return checks;
}

export function executionEvidence(raw, cli, expectedChecks) {
  const pending = new Map();
  const commands = [];
  let unparsedLines = 0;
  for (const line of raw.split('\n').filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      if (cli !== 'codex') throw error;
      unparsedLines++;
      continue;
    }
    if (cli === 'codex' && event.type === 'item.completed' && event.item?.type === 'command_execution') {
      commands.push({ command: event.item.command, output: event.item.aggregated_output,
        toolStatus: event.item.exit_code === 0 ? 'success' : 'failure', exitCode: event.item.exit_code });
    }
    if (cli === 'claude') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'tool_use' && part.name === 'Bash') pending.set(part.id, part.input.command);
        if (part.type === 'tool_result' && pending.has(part.tool_use_id)) {
          commands.push({ command: pending.get(part.tool_use_id), output: String(part.content),
            toolStatus: part.is_error ? 'failure' : 'success', exitCode: null });
        }
      }
    }
    if (cli === 'kimi') {
      for (const call of event.tool_calls ?? []) {
        if (call.function.name === 'Bash') pending.set(call.id, JSON.parse(call.function.arguments).command);
      }
      if (event.role === 'tool' && pending.has(event.tool_call_id)) {
        commands.push({ command: pending.get(event.tool_call_id), output: event.content,
          toolStatus: 'exit_code_unavailable', exitCode: null });
      }
    }
  }
  for (const command of commands) {
    command.output = typeof command.output === 'string' ? command.output : '';
    command.invokedChecks = invokedChecks(command.command);
  }
  const verifiedChecks = expectedChecks.filter(check => commands.some(command => command.toolStatus !== 'failure'
    && !/(?:^|\n)(?:\w*Error\b|npm (?:ERR!|error)\b|.*(?:exit code|exit status)\s*[:=]?\s*[1-9]\d*\b)/i.test(command.output)
    && command.invokedChecks.includes(check)
    && command.output.split('\n').some(line => line.trim() === `${check} passed`)));
  return { pass: verifiedChecks.length === expectedChecks.length, verifiedChecks, commands, unparsedLines,
    evidence: cli === 'kimi' ? 'command_and_checker_output_exit_code_unavailable' : 'command_and_provider_tool_result' };
}

async function callModel(model, prompt, cwd) {
  const options = { cwd, input: prompt, timeoutMs: 600_000 };
  if (model.cli === 'codex') {
    return runProcess('codex', ['exec', '-m', model.model, '-s', 'workspace-write', '--skip-git-repo-check',
      '-c', `model_reasoning_effort=${model.reasoning_effort}`,
      '-c', 'sandbox_workspace_write.network_access=false',
      ...codexSkillOverrides({ disable_inherited_skills: true }, cwd), '--json', '-'], options);
  }
  if (model.cli === 'claude') {
    return runProcess('claude', ['-p', '--model', model.model, '--tools', 'Read,Glob,Grep,Write,Edit,Bash',
      '--allowed-tools', 'Read,Glob,Grep,Write,Edit,Bash', '--permission-mode', 'dontAsk',
      '--setting-sources=project', '--output-format', 'stream-json', '--verbose'], options);
  }
  const emptySkills = join(cwd, '.empty-skills');
  mkdirSync(emptySkills, { recursive: true });
  return runProcess(process.env.TAKT_EVAL_KIMI_BIN || 'kimi', ['-m', model.model, '--skills-dir', emptySkills,
    '--output-format', 'stream-json', '-p', prompt], { ...options, input: undefined });
}

export function prepareActionSample(sampleRoot, files) {
  assert.ok(!existsSync(join(sampleRoot, 'result.json')), 'Cannot replace a completed action sample');
  if (existsSync(sampleRoot)) {
    const archive = mkdtempSync(`${sampleRoot}.interrupted-`);
    renameSync(sampleRoot, join(archive, 'sample'));
  }
  mkdirSync(sampleRoot, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), 'takt-actions-project-'));
  writeFileSync(join(sampleRoot, 'working-directory.txt'), cwd, { flag: 'wx' });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), content, { flag: 'wx' });
  }
  return cwd;
}

export async function runActionEvaluation(manifest, directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'manifest.json');
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(path)) assert.equal(readFileSync(path, 'utf8'), serialized);
  else writeFileSync(path, serialized, { flag: 'wx' });
  const manifestHash = digest(serialized);
  const rows = [];
  const settled = await Promise.allSettled(manifest.models.map(async model => {
    for (const sample of manifest.samples) {
      const sampleRoot = join(directory, `${model.cli}-${sample.id}`);
      const resultPath = join(sampleRoot, 'result.json');
      if (existsSync(resultPath)) {
        const saved = JSON.parse(readFileSync(resultPath, 'utf8'));
        assert.equal(saved.manifestHash, manifestHash);
        rows.push(saved);
        continue;
      }
      const cwd = prepareActionSample(sampleRoot, sample.files);
      const startedAt = new Date().toISOString();
      const start = Date.now();
      let raw;
      try {
        raw = await callModel(model, sample.prompt, cwd);
      } catch (error) {
        writeFileSync(join(sampleRoot, 'private-error.txt'), String(error), { mode: 0o600, flag: 'wx' });
        throw new Error(`${model.cli}/${sample.id}: provider failed; private diagnostic saved`);
      } finally {
        cpSync(cwd, join(sampleRoot, 'project'), { recursive: true });
      }
      writeFileSync(join(sampleRoot, 'provider-events.jsonl'), raw, { flag: 'wx' });
      const artifacts = scoreActionArtifacts(sample, cwd, raw, model.cli);
      const result = { manifestHash, model, id: sample.id, startedAt, durationMs: Date.now() - start,
        ...artifacts };
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
      rows.push(result);
      console.log(JSON.stringify({ model: model.cli, id: sample.id, pass: result.pass, missing: result.missing }));
    }
  }));
  writeFileSync(join(directory, 'summary.json'), `${JSON.stringify({ manifestHash, rows }, null, 2)}\n`);
  const rejected = settled.filter(result => result.status === 'rejected');
  if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'Provider calls failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, revision, directory] = process.argv.slice(2);
  assert.ok(['--prepare', '--run'].includes(mode));
  const manifest = buildActionManifest(revision);
  mkdirSync(resolve(directory), { recursive: true });
  const path = join(resolve(directory), 'manifest.json');
  if (mode === '--prepare') {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, samples: manifest.samples.length, models: manifest.models }));
  } else await runActionEvaluation(manifest, resolve(directory));
}

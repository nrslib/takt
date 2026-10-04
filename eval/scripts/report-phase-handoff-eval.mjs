#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate } from 'promptfoo';
import { digest, runReadOnlyModel, scoreExecutionBoundary } from '../providers/report-phase-handoff-model.mjs';

process.env.PROMPTFOO_DISABLE_TELEMETRY = 'true';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const casesPath = join(repoRoot, 'eval/cases/report-phase-handoff.json');
const fixturePath = join(repoRoot, 'eval/fixtures/report-phase-handoff');
const runtimeScript = join(repoRoot, 'eval/scripts/report-phase-handoff-runtime.mjs');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function fixtureFiles(directory = fixturePath) {
  return ['package.json', 'src/session-label.js', 'tests/session-label.test.js'].map(path => ({
    path, sha256: digest(readFileSync(join(directory, path))),
  }));
}

export function validateCases(cases) {
  if (cases.schemaVersion !== 1 || cases.repeats !== 3
    || JSON.stringify(cases.languages) !== JSON.stringify(['ja', 'en'])) throw new Error('Expected the fixed bilingual three-repeat protocol');
  if (cases.cases.length !== 3 || new Set(cases.cases.map(sample => sample.id)).size !== 3) throw new Error('Expected three distinct representative cases');
  for (const sample of cases.cases) {
    if (!['isolated-handoff', 'live-phase1-chain'].includes(sample.kind)
      || !sample.task || Object.values(sample.rubrics ?? {}).some(rubric => typeof rubric !== 'string' || !rubric.trim())
      || Object.keys(sample.rubrics ?? {}).length === 0) throw new Error('Invalid case ' + sample.id);
  }
  return cases;
}

export function captureRuntime({ revisionRoot, workspace, configDirectory, sample, language, directory, workResult }) {
  mkdirSync(directory, { recursive: true });
  const requestPath = join(directory, 'runtime-request.json');
  const resultPath = join(directory, 'runtime-capture.json');
  const { rubrics: _rubrics, ...inputs } = sample;
  writeJson(requestPath, { revisionRoot, workspace, configDirectory, sample: inputs, language, resultPath, ...(workResult === undefined ? {} : { workResult }) });
  const diagnostics = execFileSync(process.execPath, ['--experimental-test-module-mocks', runtimeScript, requestPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(join(directory, 'capture.stdout.log'), diagnostics);
  const captured = readJson(resultPath);
  if (captured.phase2Options.sessionIdPresent || captured.phase2Options.allowedTools.length !== 0) throw new Error('Invalid production Phase 2 capability boundary');
  if (sample.liveInput !== undefined
    && (!captured.phase1Prompt.includes(sample.liveInput)
      || captured.liveInstructions.length !== 1
      || captured.liveInstructions[0].state !== 'deliveredNextStep')) throw new Error('Live input was not dispatched to the implementation operation');
  if (sample.upstream !== undefined && !captured.phase1Prompt.includes(sample.upstream)) throw new Error('Actual Phase 1 is missing supplied upstream obligations');
  if (sample.reportContent !== undefined && !captured.phase1Prompt.includes(sample.reportContent)) throw new Error('Actual Phase 1 is missing the workflow-wide report body');
  return captured;
}

function buildRevision(revision, directory) {
  const commit = execFileSync('git', ['rev-parse', `${revision}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  mkdirSync(directory, { recursive: true });
  const archive = execFileSync('git', ['archive', commit], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  symlinkSync(join(repoRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const output = execFileSync('npm', ['run', 'build'], { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(join(directory, 'eval-build.log'), output);
  return commit;
}

async function freeze(baselineRevision, candidateRevision, directory) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length !== 0) throw new Error('Freeze requires a new output directory');
  const caseSource = readFileSync(casesPath, 'utf8');
  const cases = validateCases(JSON.parse(caseSource));
  writeFileSync(join(directory, 'cases.frozen.json'), caseSource);
  const fixture = fixtureFiles();
  const verification = {};
  for (const command of ['build', 'test']) {
    verification[command] = execFileSync('npm', ['run', command], { cwd: fixturePath, encoding: 'utf8' });
  }
  writeJson(join(directory, 'fixture-verification.json'), verification);
  const manifest = {
    schemaVersion: 1, status: 'frozen before model calls', casesHash: digest(caseSource),
    fixture, fixtureHash: digest(JSON.stringify(fixture)),
    target: cases.target, grader: cases.grader, repeats: cases.repeats, languages: cases.languages,
    permissions: { sandbox: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', inheritedSkills: false },
    maxConcurrency: 1, cache: false, node: process.version,
    p2ToolEnforcement: 'Production allowedTools=[] captured; SDK read-only permits reads. Prompt prohibits all tools and executed tool items deterministically fail the evaluation.',
    harnessHashes: ['scripts/report-phase-handoff-eval.mjs', 'scripts/report-phase-handoff-runtime.mjs', 'providers/report-phase-handoff-model.mjs']
      .map(path => ({ path, sha256: digest(readFileSync(join(repoRoot, 'eval', path))) })),
    revisions: {}, samples: [],
  };
  for (const [label, revision] of [['before', baselineRevision], ['candidate', candidateRevision]]) {
    const revisionRoot = join(directory, 'revisions', label);
    const commit = buildRevision(revision, revisionRoot);
    manifest.revisions[label] = { commit, root: revisionRoot };
    for (const language of cases.languages) for (const sample of cases.cases) {
      const id = `${language}-${sample.id}`;
      const sampleDirectory = join(directory, 'frozen', label, id);
      const workspace = join(directory, 'workspaces', label, id);
      cpSync(fixturePath, workspace, { recursive: true });
      const configDirectory = join(directory, 'configs', label, id);
      const captured = captureRuntime({ revisionRoot, workspace, configDirectory, sample, language, directory: sampleDirectory });
      writeFileSync(join(sampleDirectory, 'phase1.prompt.md'), captured.phase1Prompt);
      writeFileSync(join(sampleDirectory, 'phase2.prompt.md'), captured.phase2Prompt);
      const input = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'rubrics'));
      manifest.samples.push({
        id, revision: label, caseId: sample.id, language, kind: sample.kind, workspace, configDirectory,
        inputHash: digest(JSON.stringify(input)), rubricHashes: Object.entries(sample.rubrics).map(([metric, rubric]) => ({ metric, sha256: digest(rubric) })),
        phase1PromptHash: digest(captured.phase1Prompt), phase2PromptHash: digest(captured.phase2Prompt),
      });
    }
  }
  for (const sample of manifest.samples.filter(sample => sample.revision === 'before')) {
    const candidate = manifest.samples.find(row => row.revision === 'candidate' && row.id === sample.id);
    if (sample.inputHash !== candidate.inputHash || JSON.stringify(sample.rubricHashes) !== JSON.stringify(candidate.rubricHashes)) throw new Error('Frozen comparison input/rubric mismatch');
  }
  writeJson(join(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: manifest.status, casesHash: manifest.casesHash, fixtureHash: manifest.fixtureHash, target: manifest.target, samplesPerRevision: 18 }));
}

export function classifyResult(result) {
  const components = result.gradingResult?.componentResults ?? [];
  const output = typeof result.response?.output === 'string' ? result.response.output : '';
  const graderError = components.some(component => component.metadata?.graderError === true);
  const infrastructure = result.response?.error !== undefined || graderError
    || (result.failureReason === 2 && result.gradingResult === undefined) || output.trim() === '';
  return {
    status: infrastructure ? 'infrastructure_failure' : result.success === true ? 'pass' : 'model_failure',
    pass: !infrastructure && result.success === true,
    output,
    components: components.map(({ pass, score, reason, assertion }) => ({ pass, score, reason, metric: assertion?.metric })),
    reason: result.gradingResult?.reason ?? result.error ?? 'No grading result',
  };
}

async function runPhase(phase, directory) {
  const manifest = readJson(join(directory, 'manifest.json'));
  const frozenSource = readFileSync(join(directory, 'cases.frozen.json'), 'utf8');
  if (digest(frozenSource) !== manifest.casesHash || digest(JSON.stringify(fixtureFiles())) !== manifest.fixtureHash) throw new Error('Frozen inputs/fixture changed');
  const cases = validateCases(JSON.parse(frozenSource));
  if (phase === 'green') {
    const baseline = readJson(join(directory, 'red', 'summary.json'));
    if (baseline.infrastructureFailures !== 0 || baseline.modelFailures === 0 || baseline.rows.length !== 18) throw new Error('GREEN requires completed, observed semantic RED with no infrastructure errors');
  }
  const outputDirectory = join(directory, phase);
  mkdirSync(outputDirectory, { recursive: true });
  if (readdirSync(outputDirectory).length !== 0) throw new Error('Use a new output directory for each uncached evaluation phase');
  const revision = phase === 'red' ? 'before' : 'candidate';
  const samples = manifest.samples.filter(sample => sample.revision === revision)
    .flatMap(sample => Array.from({ length: cases.repeats }, (_, repeat) => ({ ...sample, repeat: repeat + 1, sampleId: `${sample.id}-r${repeat + 1}` })));
  const observations = new Map();
  let graderSequence = 0;
  const graderWorkspace = join(outputDirectory, 'grader-workspace');
  mkdirSync(graderWorkspace, { recursive: true });
  const grader = {
    id: () => 'report-phase-handoff-grader:gpt-6-sol-high',
    config: { maxRetries: 0 },
    callApi: async prompt => {
      const prefix = join(outputDirectory, `grader-${++graderSequence}`);
      try {
        const result = await runReadOnlyModel({ prompt, cwd: graderWorkspace, ...cases.grader, artifactPrefix: prefix });
        return { output: result.output, metadata: { trace: result.trace } };
      } catch (error) {
        writeFileSync(`${prefix}.private-error.txt`, String(error?.stack ?? error), { mode: 0o600 });
        return { error: 'Grader SDK/audit failure; private diagnostics retained' };
      }
    },
  };
  const provider = {
    id: () => 'report-phase-handoff-target:gpt-6-sol-high',
    config: { maxRetries: 0 },
    callApi: async (_prompt, context) => {
      const sample = samples.find(sample => sample.sampleId === context.vars.sampleId);
      if (!sample) return { error: 'Unknown frozen sample' };
      const source = cases.cases.find(source => source.id === sample.caseId);
      const artifactDirectory = join(outputDirectory, sample.sampleId);
      mkdirSync(artifactDirectory, { recursive: true });
      try {
        let phase1;
        let phase2Prompt = readFileSync(join(directory, 'frozen', revision, sample.id, 'phase2.prompt.md'), 'utf8');
        if (digest(phase2Prompt) !== sample.phase2PromptHash) throw new Error('Frozen Phase 2 prompt changed');
        if (sample.kind === 'live-phase1-chain') {
          const prompt = readFileSync(join(directory, 'frozen', revision, sample.id, 'phase1.prompt.md'), 'utf8');
          if (digest(prompt) !== sample.phase1PromptHash) throw new Error('Frozen Phase 1 prompt changed');
          phase1 = await runReadOnlyModel({ prompt, cwd: sample.workspace, ...cases.target, artifactPrefix: join(artifactDirectory, 'phase1') });
          const captured = captureRuntime({
            revisionRoot: manifest.revisions[revision].root, workspace: sample.workspace,
            configDirectory: sample.configDirectory, sample: source, language: sample.language,
            directory: artifactDirectory, workResult: phase1.output,
          });
          phase2Prompt = captured.phase2Prompt;
        }
        const phase2 = await runReadOnlyModel({ prompt: phase2Prompt, cwd: sample.workspace, ...cases.target, artifactPrefix: join(artifactDirectory, 'phase2') });
        const boundary = scoreExecutionBoundary(source, phase2.trace, phase1?.trace);
        observations.set(sample.sampleId, { boundary, phase1: phase1?.trace, phase2: phase2.trace });
        console.log(`${phase} ${sample.sampleId}: target complete; tools=${phase2.trace.toolCount}; execution=${boundary.pass}`);
        return { output: phase2.output, metadata: { boundary, phase1: phase1?.trace, phase2: phase2.trace } };
      } catch (error) {
        writeFileSync(join(artifactDirectory, 'private-error.txt'), String(error?.stack ?? error), { mode: 0o600 });
        return { error: 'Target SDK/runtime/audit failure; private diagnostics retained' };
      }
    },
  };
  const tests = samples.map(sample => {
    const source = cases.cases.find(source => source.id === sample.caseId);
    return {
      description: sample.sampleId, vars: { sampleId: sample.sampleId },
      assert: [
        { type: 'javascript', metric: 'report-handoff/execution-boundary', value: (_output, context) => observations.get(context.vars.sampleId)?.boundary ?? { pass: false, score: 0, reason: 'Missing execution receipts' } },
        ...Object.entries(source.rubrics).map(([metric, value]) => ({ type: 'llm-rubric', metric: `report-handoff/${metric}`, value })),
      ],
    };
  });
  const evaluation = await evaluate({
    prompts: [({ vars }) => vars.sampleId], providers: [provider], tests,
    defaultTest: { options: { provider: grader } }, writeLatestResults: false,
  }, { cache: false, maxConcurrency: 1, showProgressBar: false, writeLatestResults: false });
  // Full promptfoo data is local-only; exported summaries omit internal session IDs.
  writeJson(join(outputDirectory, 'promptfoo.json'), evaluation);
  const rows = evaluation.results.map(result => ({
    sampleId: samples[result.testIdx].sampleId,
    ...classifyResult(result), observation: observations.get(samples[result.testIdx].sampleId),
  }));
  const summary = {
    phase, commit: manifest.revisions[revision].commit, casesHash: manifest.casesHash,
    fixtureHash: manifest.fixtureHash, conditionsHash: digest(JSON.stringify({ target: manifest.target, grader: manifest.grader, permissions: manifest.permissions, repeats: manifest.repeats, languages: manifest.languages })),
    passed: rows.filter(row => row.status === 'pass').length,
    modelFailures: rows.filter(row => row.status === 'model_failure').length,
    infrastructureFailures: rows.filter(row => row.status === 'infrastructure_failure').length,
    graderCalls: graderSequence, rows,
  };
  writeJson(join(outputDirectory, 'summary.json'), summary);
  const exitCode = summary.infrastructureFailures > 0 ? 2 : summary.modelFailures > 0 ? 1 : 0;
  writeJson(join(outputDirectory, 'command.json'), { command: process.argv, exitCode });
  console.log(JSON.stringify({ phase, passed: summary.passed, modelFailures: summary.modelFailures, infrastructureFailures: summary.infrastructureFailures, exitCode }));
  return exitCode;
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'freeze' && args.length === 3) await freeze(args[0], args[1], resolve(args[2]));
  else if (['red', 'green'].includes(operation) && args.length === 1) process.exitCode = await runPhase(operation, resolve(args[0]));
  else throw new Error('Usage: report-phase-handoff-eval.mjs freeze BASELINE CANDIDATE OUT | red OUT | green OUT');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
  process.exit(process.exitCode ?? 0);
}

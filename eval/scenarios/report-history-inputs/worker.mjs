import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReadOnlyModel } from '../../providers/report-phase-handoff-model.mjs';
import { loadPhaseProduction } from '../../providers/phase-production.mjs';
import { loadWorkflowFromFile } from '../../../dist/infra/config/loaders/workflowFileLoader.js';
import { resolveWorkflowCallTarget } from '../../../dist/infra/config/loaders/workflowCallResolver.js';
import { getBuiltinWorkflowsDir } from '../../../dist/infra/config/paths.js';
import { ReportExecutionStore } from '../../../dist/core/workflow/report-execution-store.js';
import { buildWorkflowStepParticipationIdentity } from '../../../dist/core/workflow/workflow-step-participation-index.js';
import { getWorkflowReference } from '../../../dist/core/workflow/workflow-reference.js';
import { resolveDeclaredReportInputs } from '../../../dist/core/workflow/instruction/declared-report-inputs.js';
import { createSharedRuntime } from '../../../dist/core/workflow/engine/WorkflowEngineSetup.js';
import { createInitialState } from '../../../dist/core/workflow/engine/state-manager.js';
import { writeReportFile } from '../../../dist/core/workflow/report-writer.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
if (process.env.HOME !== resolve('home') || process.env.CODEX_HOME !== resolve('home/.codex')
  || process.env.TAKT_CONFIG_DIR !== resolve('home/.takt')) {
  throw new Error('Run the isolated evaluation through run.mjs');
}
const model = process.argv[2];
const roles = process.argv[3] === undefined ? ['fix-plan', 'loop-monitor'] : [process.argv[3]];
assert(roles.every(role => ['fix-plan', 'loop-monitor'].includes(role)));
const effort = 'high';
const directory = resolve('raw');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const api = await loadPhaseProduction(join(repository, 'dist'));
const summary = [];
const provider = api.getProvider('codex');
const originalSetup = provider.setup;
try {
  for (const role of roles) {
    try {
    const prefix = join(directory, role);
    const cwd = join(directory, role, 'project');
    const reportDir = join(cwd, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const workflow = loadWorkflowFromFile(join(getBuiltinWorkflowsDir('ja'), role === 'fix-plan' ? 'peer-review.yaml' : 'development-remediation.yaml'), cwd);
    const monitor = workflow.loopMonitors[0];
    const call = role === 'fix-plan' ? workflow.steps.find(step => step.name === 'remediation') : undefined;
    const source = workflow.steps.find(step => step.name === (role === 'fix-plan' ? 'review-adjudication' : 'fix'));
    const file = role === 'fix-plan' ? 'review-resolution.md' : 'fix-report.md';
    const child = call === undefined ? undefined : resolveWorkflowCallTarget(workflow, call, cwd);
    const step = role === 'fix-plan' ? child.steps.find(step => step.name === 'fix-plan')
      : { name: '_loop_judge_evaluation', edit: false, inputReports: monitor.judge.inputReports,
          instruction: monitor.judge.instruction.replaceAll('{cycle_count}', String(monitor.threshold)), passPreviousResponse: false };
    const state = createInitialState(workflow, { projectCwd: cwd });
    const runtime = createSharedRuntime(undefined, workflow.maxSteps);
    runtime.reportExecutions = new ReportExecutionStore(reportDir);
    const identity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), source.name, []);
    const previousProof = `PRIOR_${randomUUID()}`;
    const currentProof = `CURRENT_${randomUUID()}`;
    const oldBody = `前回の${role === 'fix-plan' ? '裁定' : '修正報告'}。照合証拠: ${previousProof}\n受入条件A: 未達。受入条件B: 未達。修正対象はAとB。`;
    const currentBody = `現在の${role === 'fix-plan' ? '裁定' : '修正報告'}。以下の背景は結論ではありません。\n${'背景の調査記録。\n'.repeat(1100)}\n照合証拠: ${currentProof}\n受入条件A: 達成。受入条件B: 未達。現在の修正対象はBだけ。Aの変更は完了し検証済み。Bは共有の正規化処理の配線が不足している。配線と検証を進められるため再計画は不要。`;
    for (const body of [oldBody, currentBody]) {
      const id = runtime.reportExecutions.begin(identity, source.name, reportDir, [file]);
      writeReportFile(reportDir, file, body, undefined, content => runtime.reportExecutions.capture(reportDir, file, content));
      runtime.reportExecutions.finish(id, true);
    }
    runtime.workflowStepParticipationIndex.record(workflow, source.name, [], [file]);
    state.stepOutputs.set(source.name, { persona: source.name, status: 'done', content: 'Report saved', timestamp: new Date() });
    const inputs = resolveDeclaredReportInputs(call ?? step, { workflow, state, sharedRuntime: runtime, projectCwd: cwd, lookupCwd: cwd, reportDir, resumeStackPrefix: [] });
    const prepared = new api.InstructionBuilder(step, {
      task: '渡された現在裁定を使い、履歴と比較してください。末尾に CURRENT_PROOF、PRIOR_PROOF、CURRENT_TARGETS、PROGRESS を記録してください。CURRENT_TARGETSはAとBのうち現在必要なもの、PROGRESSは改善／停滞／完了のいずれかにしてください。元ファイルのある資料は全文を読み、証拠を照合してください。ソースは変更しないでください。',
      iteration: 3, maxSteps: 10, stepIteration: 1, cwd, projectCwd: cwd, language: 'ja', userInputs: [], reportDir, declaredReportInputs: [inputs],
    }).prepare();
    assert(!prepared.text.includes(currentProof));
    assert(!prepared.text.includes(previousProof));
    provider.setup = ({ systemPrompt }) => ({ call: async (instruction) => {
      writeFileSync(`${prefix}.invocation.json`, JSON.stringify({ systemPrompt, instruction }, null, 2));
      const result = await runReadOnlyModel({ prompt: [systemPrompt, instruction].filter(Boolean).join('\n\n'), cwd, model, effort, artifactPrefix: prefix, executionEnvironment: { ...process.env }, shellEnvironmentPolicy: { inherit: 'none', set: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, TMPDIR: process.env.TMPDIR } }, signal: AbortSignal.timeout(240_000) });
      rmSync(`${prefix}.private-turn.json`);
      const successful = result.trace.commands.filter(command => command.exitCode === 0);
      for (const [path, marker] of [
        [inputs.reports[0].path, currentProof],
        [join(reportDir, runtime.reportExecutions.executions(identity)[0].reports[file]), previousProof],
      ]) {
        const local = relative(cwd, path);
        assert(successful.some(command => /\b(?:cat|sed|nl|head|rg|tail)\b/.test(command.command)
          && (command.command.includes(path) || command.command.includes(local)) && command.output.includes(marker)),
        'No successful read of the supplied fixed path contains its evidence');
      }
      assert(result.output.includes(currentProof) && result.output.includes(previousProof), 'Comparison omitted the read evidence');
      assert(/CURRENT_TARGETS[^\n]*B/.test(result.output) && !/CURRENT_TARGETS[^\n]*A/.test(result.output), 'Past targets replaced the current decision');
      assert(/PROGRESS[^\n]*改善/.test(result.output), 'Comparison did not recognize progress with remaining work');
      summary.push({ role, pass: true, model, effort, commands: successful, prompt: `${role}.prompt.md`, trace: `${role}.trace.json` });
      return { persona: step.name, status: 'done', content: result.output, timestamp: new Date() };
    } });
    const response = await api.runAgent(step.name, prepared.text, {
      cwd, projectCwd: cwd, executionPhase: 1, language: 'ja', personaPath: step.personaPath,
      resolvedExecution: { provider: 'codex', model, permissionMode: 'readonly', providerOptions: {} },
    });
    assert.equal(response.status, 'done', `Model failed: ${response.status}: ${response.content}`);
    } catch (error) {
      summary.push({ role, pass: false, error: error.message });
      process.exitCode = 1;
    }
  }
} catch (error) {
  summary.push({ pass: false, error: error.message });
  process.exitCode = 1;
} finally {
  provider.setup = originalSetup;
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ directory, results: summary.map(({ role, pass, error }) => ({ role, pass, error })) }));
}

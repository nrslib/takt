/**
 * WorkflowEngine integration tests: loop_monitors (cycle detection + judge)
 *
 * Covers:
 * - Loop monitor triggers judge when cycle threshold reached
 * - Judge decision overrides normal next step
 * - Cycle detector resets after judge intervention
 * - No trigger when threshold not reached
 * - Validation of loop_monitors config
 * - step:cycle_detected event emission
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowConfig, WorkflowStep, LoopMonitorConfig, LoopMonitorRule } from '../core/models/index.js';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { runReportPhase } from '../core/workflow/phase-runner.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { compileRuntimeProviderEnvironment } from '../infra/config/runtime-provider/environment.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfigCore.js';
import { writeReportFile } from '../core/workflow/report-writer.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { buildWorkflowResumePointEntry, getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence as mockBaseRunAgentSequence,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupWorkflowEngine,
} from './engine-test-helpers.js';

function mockRunAgentSequence(responses: ReturnType<typeof makeResponse>[]): void {
  mockBaseRunAgentSequence(responses.map((response) => (
    response.persona === 'supervisor' && response.status === 'done'
      ? { ...response, structuredOutput: { content: response.content } }
      : response
  )));
}

function loopJudgeRules(): LoopMonitorRule[] {
  return [
    normalizeRule({ condition: 'Healthy', next: 'ai_review' }) as LoopMonitorRule,
    normalizeRule({ condition: 'Unproductive', next: 'reviewers' }) as LoopMonitorRule,
  ];
}

/**
 * Build a workflow config with ai_review ↔ ai_fix loop and loop_monitors.
 */
function buildConfigWithLoopMonitor(
  threshold = 3,
  monitorOverrides: Partial<LoopMonitorConfig> = {},
): WorkflowConfig {
  const config = {
    name: 'test-loop-monitor',
    description: 'Test workflow with loop monitors',
    maxSteps: 30,
    initialStep: 'implement',
    loopMonitors: [
      {
        cycle: ['ai_review', 'ai_fix'],
        threshold,
        judge: {
          rules: loopJudgeRules(),
        },
        ...monitorOverrides,
      },
    ],
    steps: [
      makeStep('implement', {
        rules: [makeRule('done', 'ai_review')],
      }),
      makeStep('ai_review', {
        rules: [
          makeRule('No issues', 'reviewers'),
          makeRule('Issues found', 'ai_fix'),
        ],
      }),
      makeStep('ai_fix', {
        rules: [
          makeRule('Fixed', 'ai_review'),
          makeRule('No fix needed', 'reviewers'),
        ],
      }),
      makeStep('reviewers', {
        rules: [makeRule('All approved', 'COMPLETE')],
      }),
    ],
  };

  return config;
}

describe('report current versions and execution history in complete prompts', () => {
  let tmpDir: string;
  let originalConfigDir: string | undefined;
  const engines: WorkflowEngine[] = [];
  const plan = 'fix-plan.md';
  const report = 'fix-report.md';
  const bodyLimit = 8000;
  const reportsRoot = () => join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(tmpDir, 'global');
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    engines.splice(0).forEach(cleanupWorkflowEngine);
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function source() {
    return makeStep('remediation', {
      persona: 'writer',
      outputContracts: [{ name: plan, format: 'Write the plan' }, { name: report, format: 'Write the report' }],
      rules: [makeRule('done', 'consume')],
    });
  }

  function consumer(instruction: string, previous = 2) {
    const inputReports = { fromStep: 'remediation', reports: [plan, report], history: { previous } };
    return makeStep('consume', {
      persona: 'consumer', inputReports, instruction,
      rules: [makeRule('again', 'remediation'), makeRule('finished', 'COMPLETE')],
    });
  }

  function config(consume: WorkflowStep): WorkflowConfig {
    return { name: 'report-history', initialStep: 'remediation', maxSteps: 20, steps: [source(), consume] };
  }

  function start(workflow: WorkflowConfig, options: Partial<WorkflowEngineOptions> = {}): WorkflowEngine {
    const engine = new WorkflowEngine(workflow, tmpDir, 'Compare reports', {
      projectCwd: tmpDir, provider: 'mock', model: 'mock-model', language: 'en', ...options,
    });
    engines.push(engine);
    return engine;
  }

  async function useRealReportPhase(body: (name: string, occurrence: number) => string | Promise<string>) {
    const actual = await vi.importActual<typeof import('../core/workflow/phase-runner.js')>('../core/workflow/phase-runner.js');
    const active = new Map<string, { names: string[]; occurrence: number; index: number }>();
    vi.mocked(runReportPhase).mockImplementation(async (step, occurrence, context, onWritten) => {
      const identity = String(step.persona);
      active.set(identity, { names: step.outputContracts!.map(({ name }) => name), occurrence, index: 0 });
      try {
        return await actual.runReportPhase(step, occurrence, context, onWritten);
      } finally {
        active.delete(identity);
      }
    });
    const prompts: { persona: string; prompt: string }[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      const generating = active.get(String(persona));
      if (generating) {
        const name = generating.names[generating.index++];
        if (name === undefined) throw new Error('Unexpected extra report attempt');
        return makeResponse({ persona: String(persona), content: await body(name, generating.occurrence) });
      }
      prompts.push({ persona: String(persona), prompt });
      return makeResponse({ persona: String(persona), content: 'done',
        ...(String(persona) === 'supervisor' ? { structuredOutput: { content: 'done' } } : {}) });
    });
    return prompts;
  }

  function rounds(count: number) {
    mockRuleEvaluationSequence(Array.from({ length: count }, (_, index) => [
      { index: 0, method: 'phase3_tag' as const },
      { index: index === count - 1 ? 1 : 0, method: 'phase3_tag' as const },
    ]).flat());
  }

  function section(prompt: string, name: string): string {
    const begin = `${name}-BEGIN\n`;
    const end = `\n${name}-END`;
    expect(prompt).toContain(begin);
    expect(prompt).toContain(end);
    return prompt.split(begin)[1]!.split(end)[0]!;
  }

  function versionRows(text: string, root = reportsRoot()) {
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedRoot}/[^\\s\x60<>"|)]+`, 'g');
    return text.split('\n').flatMap((line) => [...line.matchAll(pattern)].map(([path]) => ({ line, path })))
      .filter(({ path }) => existsSync(path) && statSync(path).isFile());
  }

  it.each([bodyLimit - 1, bodyLimit])('keeps the entire current body at %i characters', async (length) => {
    const body = `${'x'.repeat(length - 4)}TAIL`;
    const prompts = await useRealReportPhase(() => body);
    rounds(1);
    const engine = start(config(consumer('CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END')));
    expect((await engine.run()).status).toBe('completed');
    expect(section(prompts.find(({ persona }) => persona === 'consumer')!.prompt, 'CURRENT')).toBe(body);
  });

  it.each(['placeholder', 'automatic input'] as const)('truncates %s at the limit and pins the exact body before another publication', async (mode) => {
    const body = `${'x'.repeat(bodyLimit)}Z`;
    const prompts = await useRealReportPhase((name) => name === plan ? body : 'short report');
    rounds(1);
    expect((await start(config(consumer(mode === 'placeholder'
      ? 'CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END'
      : 'Use the supplied reports'))).run()).status).toBe('completed');
    const prompt = prompts.find(({ persona }) => persona === 'consumer')!.prompt;
    const current = mode === 'placeholder' ? section(prompt, 'CURRENT') : prompt;
    expect(current).toContain(body.slice(0, bodyLimit));
    expect(current).not.toContain(body.slice(-32));
    expect(current).toMatch(/truncat|omitt|省略/i);
    const pinned = versionRows(current).filter(({ path }) => path !== join(reportsRoot(), plan));
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.some(({ path }) => readFileSync(path, 'utf8') === body)).toBe(true);
    writeReportFile(reportsRoot(), plan, 'NEW-PUBLIC-BODY');
    expect(pinned.some(({ path }) => readFileSync(path, 'utf8') === body)).toBe(true);
  });

  it('expands current and history references at their template positions in one running engine', async () => {
    const prompts = await useRealReportPhase((name, occurrence) => `BODY-${occurrence}-${name}`);
    rounds(4);
    expect((await start(config(consumer('CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END\nHISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END'))).run()).status)
      .toBe('completed');
    const consumers = prompts.filter(({ persona }) => persona === 'consumer');
    expect(consumers).toHaveLength(4);
    for (const [index, { prompt }] of consumers.entries()) {
      expect(section(prompt, 'CURRENT')).toBe(`BODY-${index + 1}-${plan}`);
      const history = section(prompt, 'HISTORY');
      expect(history).not.toContain('{report_history:');
      const rows = versionRows(history);
      const expected = Array.from({ length: Math.min(index, 2) }, (_, offset) => index - Math.min(index, 2) + offset + 1);
      expect(rows.map(({ path }) => readFileSync(path, 'utf8'))).toEqual(expected.map((n) => `BODY-${n}-${plan}`));
      const orders = rows.map(({ line }) => {
        const match = /(?:^|\s)order=(\S+)(?=\s|$)/.exec(line);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/^\d+$/);
        const order = Number(match![1]);
        expect(Number.isFinite(order)).toBe(true);
        return order;
      });
      for (let position = 1; position < orders.length; position++) {
        expect(orders[position]).toBeGreaterThan(orders[position - 1]!);
      }
      for (const { line, path } of rows) {
        expect(line).toContain('remediation');
        expect(line).toMatch(/completed|complete|done|完了/i);
        expect(path).not.toBe(join(reportsRoot(), plan));
      }
      expect(history).not.toContain('BODY-');
    }
  });

  it('pairs plan and report rows by execution and keeps identical bodies as distinct executions', async () => {
    const prompts = await useRealReportPhase(() => 'IDENTICAL-BODY');
    rounds(3);
    expect((await start(config(consumer('PLANS-BEGIN\n{report_history:fix-plan.md}\nPLANS-END\nREPORTS-BEGIN\n{report_history:fix-report.md}\nREPORTS-END'))).run()).status)
      .toBe('completed');
    const prompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    const plans = versionRows(section(prompt, 'PLANS'));
    const reports = versionRows(section(prompt, 'REPORTS'));
    expect(plans).toHaveLength(2);
    expect(reports).toHaveLength(2);
    expect(new Set([...plans, ...reports].map(({ path }) => path)).size).toBe(4);
    const metadata = (row: { line: string; path: string }, name: string) =>
      row.line.replaceAll(row.path, '<path>').replaceAll(name, '<report>');
    expect(plans.map((row) => metadata(row, plan))).toEqual(reports.map((row) => metadata(row, report)));
    expect(metadata(plans[0]!, plan)).not.toBe(metadata(plans[1]!, plan));
  });

  it('keeps inserted history placeholders, fenced examples and incomplete references literal', async () => {
    const body = '{report_history:fix-plan.md}\n```md\n{report:extra.md}\n```\n~~~md\n{report_history:extra.md}\n~~~';
    const prompts = await useRealReportPhase(() => body);
    rounds(2);
    writeReportFile(reportsRoot(), 'extra.md', 'UNRELATED-EXTRA');
    expect((await start(config(consumer('CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END\nHISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END\nINCOMPLETE-BEGIN\n{report:fix-plan.md\nINCOMPLETE-END'))).run()).status)
      .toBe('completed');
    const prompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(section(prompt, 'CURRENT')).toBe(body);
    expect(section(prompt, 'INCOMPLETE')).toBe('{report:fix-plan.md');
    const history = section(prompt, 'HISTORY');
    expect(versionRows(history).map(({ path }) => readFileSync(path, 'utf8'))).toEqual([body]);
    expect(history).not.toContain('UNRELATED-EXTRA');
  });

  it('appends every requested prior execution when no history placeholder is present', async () => {
    const prompts = await useRealReportPhase((name, n) => `BODY-${n}-${name}`);
    rounds(5);
    expect((await start(config(consumer('Compare the supplied current reports and prior executions', 4))).run()).status)
      .toBe('completed');
    const prompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(versionRows(prompt).map(({ path }) => readFileSync(path, 'utf8'))
      .filter((body) => body.endsWith(plan) && body !== `BODY-5-${plan}`))
      .toEqual([1, 2, 3, 4].map((n) => `BODY-${n}-${plan}`));
  });

  it('explains the available history count on the first and second executions', async () => {
    const prompts = await useRealReportPhase((name, n) => `BODY-${n}-${name}`);
    rounds(2);
    expect((await start(config(consumer('HISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END'))).run()).status)
      .toBe('completed');
    const histories = prompts.filter(({ persona }) => persona === 'consumer').map(({ prompt }) => section(prompt, 'HISTORY'));
    expect(versionRows(histories[0]!)).toEqual([]);
    expect(histories[0]).not.toContain('{report_history:');
    expect(histories[0]).toMatch(/0/);
    expect(histories[0]).toMatch(/2/);
    expect(versionRows(histories[1]!).map(({ path }) => readFileSync(path, 'utf8'))).toEqual([`BODY-1-${plan}`]);
    expect(histories[1]).toMatch(/1/);
    expect(histories[1]).toMatch(/2/);
  });

  it('excludes another run and parent call with the same producer occurrence and report names', async () => {
    let lineage = 'FOREIGN';
    const prompts = await useRealReportPhase((name, n) => `${lineage}-${n}-${name}`);
    const outer = { name: 'outer', initialStep: 'delegate', maxSteps: 10, steps: [
      makeStep('delegate', { kind: 'workflow_call', call: 'report-history' }),
    ] };
    const workflow = config(consumer('CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END\nHISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END'));
    rounds(2);
    expect((await start(workflow, { reportDirName: 'foreign-run',
      resumeStackPrefix: [buildWorkflowResumePointEntry(outer, 'delegate', 'workflow_call', 1, undefined, 1)],
    }).run()).status).toBe('completed');
    const foreignPrompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    const foreignRows = versionRows(section(foreignPrompt, 'HISTORY'), tmpDir);
    lineage = 'OWN';
    rounds(2);
    expect((await start(workflow, {
      resumeStackPrefix: [buildWorkflowResumePointEntry(outer, 'delegate', 'workflow_call', 2, undefined, 2)],
    }).run()).status).toBe('completed');
    const prompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(section(prompt, 'CURRENT')).toBe(`OWN-2-${plan}`);
    const ownRows = versionRows(section(prompt, 'HISTORY'), tmpDir);
    expect(foreignRows).toHaveLength(1);
    expect(ownRows.map(({ path }) => readFileSync(path, 'utf8'))).toEqual([`OWN-1-${plan}`]);
    for (const { path } of ownRows) expect(path.startsWith(reportsRoot() + '/')).toBe(true);
    expect(ownRows[0]!.line.replaceAll(ownRows[0]!.path, '<path>'))
      .not.toBe(foreignRows[0]!.line.replaceAll(foreignRows[0]!.path, '<path>'));
  });

  it.each(['parallel', 'nested workflow_call'] as const)('preserves history from the actual %s producer', async (mode) => {
    let occurrence = 0;
    const prompts = await useRealReportPhase((name) => {
      if (name === plan) occurrence += 1;
      return `BODY-${occurrence}-${name}`;
    });
    const childSource = { ...source(), name: 'write', rules: [makeRule('done', 'COMPLETE')] };
    const leaf: WorkflowConfig = { name: 'leaf', initialStep: 'write', maxSteps: 5,
      subworkflow: { callable: true }, steps: [childSource] };
    const child: WorkflowConfig = { name: 'child', initialStep: 'delegate', maxSteps: 5,
      subworkflow: { callable: true }, steps: [makeStep('delegate', { kind: 'workflow_call', call: 'leaf',
        rules: [makeRule('COMPLETE', 'COMPLETE')] })] };
    const workflow = config(consumer('CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END\nHISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END'));
    workflow.steps[0] = mode === 'parallel'
      ? makeStep('remediation', { parallel: [childSource], rules: [makeRule('all("done")', 'consume')] })
      : makeStep('remediation', { kind: 'workflow_call', call: 'child', rules: [makeRule('COMPLETE', 'consume')] });
    let consumed = 0;
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => ({
      index: step.name === 'consume' && ++consumed === 3 ? 1 : 0,
      method: step.parallel === undefined ? 'phase3_tag' : 'aggregate',
    }));
    const sharedRuntime: NonNullable<WorkflowEngineOptions['sharedRuntime']> = { startedAtMs: 0 };
    expect((await start(workflow, {
      workflowCallResolver: ({ step }) => step.call === 'leaf' ? leaf : child, sharedRuntime,
    }).run()).status).toBe('completed');
    const prompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(section(prompt, 'CURRENT')).toBe(`BODY-3-${plan}`);
    const rows = versionRows(section(prompt, 'HISTORY'));
    expect(rows.map(({ path }) => readFileSync(path, 'utf8'))).toEqual([`BODY-1-${plan}`, `BODY-2-${plan}`]);
    const store = sharedRuntime.reportExecutions!;
    const parentIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), 'remediation', []);
    const parents = store.executions(parentIdentity);
    for (const [index, { line }] of rows.entries()) {
      const match = /^- execution=(\S+) order=(\d+) completion_order=(\d+) status=completed producer=(\S+) origin_execution=(\S+) origin_producer=(\S+) origin_order=(\d+) origin_completion_order=(\d+) path=/.exec(line);
      expect(match).not.toBeNull();
      const callOccurrence = index + 1;
      const originIdentity = mode === 'parallel'
        ? buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), 'write', [], 'remediation')
        : buildWorkflowStepParticipationIdentity(getWorkflowReference(leaf), 'write', [
            buildWorkflowResumePointEntry(workflow, 'remediation', 'workflow_call', callOccurrence, undefined, callOccurrence),
            buildWorkflowResumePointEntry(child, 'delegate', 'workflow_call', 1, undefined, 1),
          ]);
      const parent = parents[index]!;
      const origin = store.executions(originIdentity)[mode === 'parallel' ? index : 0]!;
      expect(match![1]!.endsWith(`/${parent.id}`)).toBe(true);
      expect(Number(match![2])).toBe(parent.sequence);
      expect(Number(match![3])).toBe(parent.completionOrder);
      expect(match![4]).toBe('remediation');
      expect(match![5]!.endsWith(`/${origin.id}`)).toBe(true);
      expect(match![5]).not.toBe(match![1]);
      expect(match![6]).toBe('write');
      expect(Number(match![7])).toBe(origin.sequence);
      expect(Number(match![8])).toBe(origin.completionOrder);
    }
  });

  it('records each parallel child producer with its own start and completion in the complete prompt', async () => {
    let notifyAlphaStarted!: () => void;
    const alphaStarted = new Promise<void>((resolve) => { notifyAlphaStarted = resolve; });
    let releaseAlpha!: () => void;
    const alphaCanFinish = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const prompts = await useRealReportPhase(async (name) => {
      if (name === plan) {
        notifyAlphaStarted();
        await alphaCanFinish;
      }
      return `BODY-${name}`;
    });
    const alpha = makeStep('alpha', { persona: 'alpha-writer',
      outputContracts: [{ name: plan, format: 'Write the plan' }], rules: [makeRule('done', 'COMPLETE')] });
    const beta = makeStep('beta', { persona: 'beta-writer',
      outputContracts: [{ name: report, format: 'Write the report' }], rules: [makeRule('done', 'COMPLETE')] });
    const workflow = config(consumer('Compare the parallel producer executions', 0));
    workflow.steps[0] = makeStep('remediation', {
      parallel: [alpha, beta], rules: [makeRule('all("done")', 'consume')],
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => ({
      index: step.name === 'consume' ? 1 : 0,
      method: step.parallel === undefined ? 'phase3_tag' : 'aggregate',
    }));
    const sharedRuntime: NonNullable<WorkflowEngineOptions['sharedRuntime']> = { startedAtMs: 0 };
    const engine = start(workflow, { sharedRuntime });
    const store = sharedRuntime.reportExecutions!;
    const alphaIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), 'alpha', [], 'remediation');
    const betaIdentity = buildWorkflowStepParticipationIdentity(getWorkflowReference(workflow), 'beta', [], 'remediation');
    const finish = store.finish.bind(store);
    vi.spyOn(store, 'finish').mockImplementation((id, completed) => {
      finish(id, completed);
      if (completed && store.executions(betaIdentity).some((entry) => entry.id === id)) releaseAlpha();
    });
    const running = engine.run();
    await alphaStarted;
    expect((await running).status).toBe('completed');

    const prompt = prompts.find(({ persona }) => persona === 'consumer')!.prompt;
    const rows = new Map(prompt.split('\n').flatMap((line) => {
      const match = /^- remediation: ([^;]+); execution=([^;]+); order=(\d+); completion_order=(\d+); producer execution=([^;]+); producer start=(\d+); producer completion=(\d+)$/.exec(line);
      return match === null ? [] : [[match[1]!, {
        execution: match[2]!, order: Number(match[3]), completion: Number(match[4]),
        origin: match[5]!, start: Number(match[6]), originCompletion: Number(match[7]),
      }]];
    }));
    const alphaRow = rows.get(plan)!;
    const betaRow = rows.get(report)!;
    expect(rows.size).toBe(2);
    expect(alphaRow.execution).toBe(betaRow.execution);
    expect(alphaRow.origin).not.toBe(alphaRow.execution);
    expect(betaRow.origin).not.toBe(betaRow.execution);
    expect(alphaRow.origin).not.toBe(betaRow.origin);
    expect(alphaRow.order).toBeLessThan(alphaRow.start);
    expect(alphaRow.start).toBeLessThan(betaRow.start);
    expect(betaRow.originCompletion).toBeLessThan(alphaRow.originCompletion);
    expect(alphaRow.start).toBeLessThan(betaRow.originCompletion);
    expect(betaRow.start).toBeLessThan(alphaRow.originCompletion);
    expect(alphaRow.completion).toBeGreaterThan(alphaRow.originCompletion);
    expect(betaRow.completion).toBe(alphaRow.completion);

    const alphaExecution = store.executions(alphaIdentity)
      .find((entry) => entry.id === alphaRow.origin.split('/').at(-1));
    const betaExecution = store.executions(betaIdentity)
      .find((entry) => entry.id === betaRow.origin.split('/').at(-1));
    expect(alphaExecution).toMatchObject({ producer: 'alpha', sequence: alphaRow.start, completionOrder: alphaRow.originCompletion });
    expect(betaExecution).toMatchObject({ producer: 'beta', sequence: betaRow.start, completionOrder: betaRow.originCompletion });
  });

  it('restores pinned history and execution identities into the resumed run', async () => {
    const prompts = await useRealReportPhase((name, n) => `BODY-${n}-${name}`);
    const workflow = config(consumer('CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END\nHISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END'));
    rounds(2);
    const original = start(workflow);
    let resumePoint: ReturnType<WorkflowEngine['getResumePoint']>;
    let consumers = 0;
    original.on('step:start', (step) => {
      if (step.name !== 'consume' || ++consumers !== 2) return;
      resumePoint = structuredClone(original.getResumePoint());
      inheritResumeReportSnapshot({ cwd: tmpDir, sourceRunSlug: 'test-report-dir', targetRunSlug: 'resumed-run' });
    });
    expect((await original.run()).status).toBe('completed');
    const before = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(resumePoint).toBeDefined();
    expect(resumePoint?.stack[0]?.step).toBe('consume');
    mockRuleEvaluationSequence([{ index: 1, method: 'phase3_tag' }]);
    const resumed = start(workflow, { reportDirName: 'resumed-run', resumePoint,
      startStep: 'consume', initialIteration: resumePoint!.iteration });
    const abortReasons: string[] = [];
    resumed.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    expect((await resumed.run()).status, abortReasons.join('\n')).toBe('completed');
    const after = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(section(after, 'CURRENT')).toBe(section(before, 'CURRENT'));
    const resumedRoot = join(tmpDir, '.takt', 'runs', 'resumed-run', 'reports');
    const previousRows = versionRows(section(before, 'HISTORY'));
    const restoredRows = versionRows(section(after, 'HISTORY'), tmpDir);
    expect(previousRows).toHaveLength(1);
    expect(restoredRows).toHaveLength(1);
    expect(restoredRows.map(({ path }) => readFileSync(path, 'utf8'))).toEqual([`BODY-1-${plan}`]);
    for (const { path } of restoredRows) expect(path.startsWith(resumedRoot + '/')).toBe(true);
    expect(restoredRows[0]!.line.replaceAll(restoredRows[0]!.path, '<path>'))
      .toBe(previousRows[0]!.line.replaceAll(previousRows[0]!.path, '<path>'));
  });

  it('marks a missing historical report without filling it from an older execution', async () => {
    const prompts = await useRealReportPhase((name, n) => `BODY-${n}-${name}`);
    const workflow = config(consumer('PLANS-BEGIN\n{report_history:fix-plan.md}\nPLANS-END\nREPORTS-BEGIN\n{report_history:fix-report.md}\nREPORTS-END'));
    rounds(4);
    const engine = start(workflow);
    let produced = 0;
    engine.on('step:start', (step) => {
      if (step.name !== 'remediation' || ++produced !== 4) return;
      const previous = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
      const missing = versionRows(section(previous, 'REPORTS'))
        .find(({ path }) => readFileSync(path, 'utf8') === `BODY-2-${report}`);
      expect(missing).toBeDefined();
      rmSync(missing!.path);
    });
    expect((await engine.run()).status).toBe('completed');
    const finalPrompt = prompts.filter(({ persona }) => persona === 'consumer').at(-1)!.prompt;
    expect(versionRows(section(finalPrompt, 'PLANS')).map(({ path }) => readFileSync(path, 'utf8')))
      .toEqual([`BODY-2-${plan}`, `BODY-3-${plan}`]);
    const reportHistory = section(finalPrompt, 'REPORTS');
    expect(versionRows(reportHistory).map(({ path }) => readFileSync(path, 'utf8'))).toEqual([`BODY-3-${report}`]);
    expect(reportHistory).toMatch(/missing|unavailable|欠落|見つかりません/i);
  });

  it('passes current bodies, pinned history and Report Directory to the triggered judge', async () => {
    const prompts = await useRealReportPhase((name, n) => `BODY-${n}-${name}`);
    const judge = {
      persona: 'supervisor',
      inputReports: { fromStep: 'remediation', reports: [plan, report], history: { previous: 2 } },
      instruction: 'CURRENT-BEGIN\n{report:fix-plan.md}\nCURRENT-END\nHISTORY-BEGIN\n{report_history:fix-plan.md}\nHISTORY-END',
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' }) as LoopMonitorRule],
    };
    const workflow = config(consumer('Compare reports'));
    workflow.loopMonitors = [{ cycle: ['remediation', 'consume'], threshold: 3, judge }];
    mockRuleEvaluationSequence([
      ...Array.from({ length: 6 }, () => ({ index: 0, method: 'phase3_tag' as const })),
      { index: 0, method: 'ai_judge' },
    ]);
    expect((await start(workflow).run()).status).toBe('completed');
    const prompt = prompts.find(({ persona }) => persona === 'supervisor')!.prompt;
    expect(section(prompt, 'CURRENT')).toBe(`BODY-3-${plan}`);
    expect(versionRows(section(prompt, 'HISTORY')).map(({ path }) => readFileSync(path, 'utf8')))
      .toEqual([`BODY-1-${plan}`, `BODY-2-${plan}`]);
    expect(prompt).toContain(`Report Directory: ${reportsRoot()}`);
  });

  it('keeps the judge without input declarations free of report input context', async () => {
    const prompts = await useRealReportPhase(() => 'SOURCE-REPORT-BODY');
    const workflow = config(consumer('Compare reports'));
    workflow.loopMonitors = [{ cycle: ['remediation', 'consume'], threshold: 1,
      judge: { persona: 'supervisor', instruction: 'Judge cycle {cycle_count}',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' }) as LoopMonitorRule] } }];
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' }, { index: 0, method: 'phase3_tag' }, { index: 0, method: 'ai_judge' },
    ]);
    expect((await start(workflow).run()).status).toBe('completed');
    const prompt = prompts.find(({ persona }) => persona === 'supervisor')!.prompt;
    expect(prompt).toContain('Judge cycle 1');
    expect(prompt).not.toContain('Report Directory:');
    expect(versionRows(prompt)).toEqual([]);
    expect(prompt).not.toContain('SOURCE-REPORT-BODY');
  });

  it('rejects a runtime judge declaration referring to a producer outside the cycle', () => {
    const workflow = config(consumer('Compare reports'));
    const judge = { persona: 'supervisor', inputReports: { fromStep: 'remediation', reports: [plan] },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' }) as LoopMonitorRule] };
    workflow.loopMonitors = [{ cycle: ['consume'], threshold: 1, judge }];
    expect(() => start(workflow)).toThrow();
  });
});

describe('WorkflowEngine Integration: Loop Monitors', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =====================================================
  // 1. Cycle triggers judge → unproductive → skip to reviewers
  // =====================================================
  describe('Judge triggered on cycle threshold', () => {
    it('should run judge and redirect to reviewers when cycle is unproductive', async () => {
      const config = buildConfigWithLoopMonitor(2, {
        judge: {
          persona: 'supervisor',
          instruction: 'The loop repeated {cycle_count} times.',
          rules: loopJudgeRules(),
        },
      });
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        model: 'mock-model',
      });

      mockRunAgentSequence([
        // implement
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        // ai_review → issues found
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        // ai_fix → fixed → ai_review
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        // ai_review → issues found again
        makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
        // ai_fix → fixed → cycle threshold reached (2 cycles complete)
        makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
        // Judge runs (synthetic step)
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        // reviewers (after judge redirects here)
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix (issues found)
        { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review (fixed)
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix (issues found again)
        { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review (fixed) — but cycle detected!
        // Judge rule match: Unproductive (index 1) → reviewers
        { index: 1, method: 'ai_judge' },
        // reviewers → COMPLETE
        { index: 0, method: 'phase3_tag' },
      ]);

      const cycleDetectedFn = vi.fn();
      engine.on('step:cycle_detected', cycleDetectedFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(cycleDetectedFn).toHaveBeenCalledOnce();
      expect(cycleDetectedFn.mock.calls[0]?.[1]).toBe(2); // cycleCount
      // 7 iterations: implement + ai_review + ai_fix + ai_review + ai_fix + judge + reviewers
      expect(state.iteration).toBe(7);
    });

    it('should run judge and continue loop when cycle is healthy', async () => {
      const config = buildConfigWithLoopMonitor(2);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        model: 'mock-model',
      });

      mockRunAgentSequence([
        // implement
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        // Cycle 1: ai_review → ai_fix
        makeResponse({ persona: 'ai_review', content: 'Issues found: A' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed A' }),
        // Cycle 2: ai_review → ai_fix (threshold reached)
        makeResponse({ persona: 'ai_review', content: 'Issues found: B' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed B' }),
        // Judge says healthy → continue to ai_review
        makeResponse({ persona: 'supervisor', content: 'Loop is healthy, making progress' }),
        // ai_review → no issues
        makeResponse({ persona: 'ai_review', content: 'No issues remaining' }),
        // reviewers → COMPLETE
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review — cycle detected!
        // Judge: Healthy (index 0) → ai_review
        { index: 0, method: 'ai_judge' },
        // ai_review → reviewers (no issues)
        { index: 0, method: 'phase3_tag' },
        // reviewers → COMPLETE
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // 8 iterations: impl + ai_review*3 + ai_fix*2 + judge + reviewers
      expect(state.iteration).toBe(8);
    });

    it('should continue with the natural transition when judge returns non-done status', async () => {
      const config = buildConfigWithLoopMonitor(1);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        model: 'mock-model',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({
          persona: 'supervisor',
          status: 'error',
          content: 'judge failed',
          error: 'judge interrupted',
        }),
        // エンジンの fresh retry でも同じ error を返し、判定不能のまま自然遷移へ進む
        makeResponse({
          persona: 'supervisor',
          status: 'error',
          content: 'judge failed',
          error: 'judge interrupted',
        }),
        // 判定不能 → 自然遷移（ai_fix → ai_review）で続行
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      // 判定役の障害は走行を落とさない（自然遷移で続行して完走する）
      expect(state.status).toBe('completed');
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('should inherit resolved provider and model from the step that triggered the judge', async () => {
      const config = buildConfigWithLoopMonitor(1);
      config.loopMonitors![0]!.judge.persona = 'supervisor';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' }),
      }));
    });

    it('Given effective auto_routing selects the triggering step, When loop judge runs without overrides, Then it inherits the selected concrete candidate', async () => {
      const config = buildConfigWithLoopMonitor(1);
      config.loopMonitors![0]!.judge.persona = 'supervisor';
      const autoRouting = {
        strategy: 'balanced' as const,
        router: { provider: 'codex' as const, model: 'router-model' },
        candidates: [{
          name: 'workflow-candidate',
          description: 'Workflow and loop judge execution',
          provider: 'codex' as const,
          model: 'gpt-5',
          routingTier: 'medium' as const,
        }],
        defaultPool: 'general',
        candidatePools: { general: { candidates: ['workflow-candidate'], fallback: 'workflow-candidate' } },
        poolRules: {
          steps: {
            implement: 'general',
            ai_review: 'general',
            ai_fix: 'general',
            reviewers: 'general',
          },
        },
        rules: {
          steps: {
            implement: 'workflow-candidate',
            ai_review: 'workflow-candidate',
            ai_fix: 'workflow-candidate',
            reviewers: 'workflow-candidate',
          },
        },
      };

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        model: 'top-level-model',
        autoRouting,
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: 'gpt-5' }),
      }));
    });

    it('should prefer loop monitor judge provider and model overrides over the triggering step', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
        internalAgentSeats: {
          loopJudge: {
            provider: 'codex',
            model: 'gpt-5.2-codex',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: 'gpt-5.2-codex' }),
      }));
    });

    it.each([
      {
        name: 'provider only',
        provider: 'mock' as const,
        providerSource: 'cli' as const,
        model: 'mock/top-level-model',
        modelSource: 'project' as const,
        expected: {
          provider: 'mock',
          providerSource: 'cli',
          model: undefined,
          modelSource: 'default',
        },
      },
      {
        name: 'model only',
        provider: 'claude' as const,
        providerSource: 'project' as const,
        model: 'codex/cli-model',
        modelSource: 'cli' as const,
        expected: {
          provider: 'codex',
          providerSource: 'step',
          model: 'codex/cli-model',
          modelSource: 'cli',
        },
      },
      {
        name: 'provider and model',
        provider: 'mock' as const,
        providerSource: 'cli' as const,
        model: 'codex/cli-model',
        modelSource: 'cli' as const,
        expected: {
          provider: 'mock',
          providerSource: 'cli',
          model: 'codex/cli-model',
          modelSource: 'cli',
        },
      },
    ])('should preserve CLI $name over loop monitor judge overrides', async ({
      provider,
      providerSource,
      model,
      modelSource,
      expected,
    }) => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      const judgeStart = vi.fn();

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider,
        providerSource,
        model,
        modelSource,
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/step-model',
            },
          },
        },
        internalAgentSeats: {
          loopJudge: {
            provider: 'codex',
            model: 'codex/judge-model',
          },
        },
      });
      engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
        if (step.name.startsWith('_loop_judge_')) {
          judgeStart(providerInfo);
        }
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toMatchObject({
        resolvedExecution: expect.objectContaining({ provider: expected.provider, model: expected.model }),
      });
      expect(judgeStart).toHaveBeenCalledWith(expect.objectContaining(expected));
    });

    it('should not inherit the triggering model when judge provider override is set without model', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
        internalAgentSeats: {
          loopJudge: {
            provider: 'codex',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: undefined }),
      }));
    });

    it('should allow OpenCode default model after dropping a mismatched loop judge candidate', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
        providerSource: 'cli',
        providerRouting: {
          steps: {
            implement: { provider: 'opencode', model: 'opencode/step-model' },
            ai_review: { provider: 'opencode', model: 'opencode/step-model' },
            ai_fix: { provider: 'opencode', model: 'opencode/step-model' },
            reviewers: { provider: 'opencode', model: 'opencode/step-model' },
          },
        },
        internalAgentSeats: {
          loopJudge: { provider: 'claude', model: 'opus' },
        },
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({
          provider: 'opencode',
          model: undefined,
        }),
        allowDefaultModel: true,
      }));
    });

    it('should reject an OpenCode loop judge when no model candidate exists', () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      expect(() => new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
        providerSource: 'cli',
        providerRouting: {
          steps: {
            implement: { provider: 'opencode', model: 'opencode/step-model' },
            ai_review: { provider: 'opencode', model: 'opencode/step-model' },
            ai_fix: { provider: 'opencode', model: 'opencode/step-model' },
            reviewers: { provider: 'opencode', model: 'opencode/step-model' },
          },
        },
        internalAgentSeats: {
          loopJudge: { provider: 'claude' },
        },
      })).toThrow(/provider 'opencode' requires model/);
      expect(runAgent).not.toHaveBeenCalled();
    });

    it.each([undefined, 'selected-model'])('should preserve compiled loop judge profile model %s in providerInfo and execution', async (model) => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      const environment = compileRuntimeProviderEnvironment({
        defaults: { profile: 'base' },
        profiles: {
          base: { provider: 'codex', model: 'base-model' },
          selected: { provider: 'codex', ...(model === undefined ? {} : { model }) },
        },
        targets: { internal_agents: { 'loop-judge': { profile: 'selected' } } },
      });
      expect(environment.internalAgents?.loopJudge).toBeDefined();
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: environment.provider,
        providerSource: environment.providerSource,
        model: environment.model,
        modelSource: environment.modelSource,
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'codex',
              model: 'configured-model',
            },
          },
        },
        internalAgentSeats: environment.internalAgents,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const startedJudgeProviderInfo: Array<{ provider?: string; model?: string; modelSource?: string }> = [];
      engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
        if (step.name.startsWith('_loop_judge_')) {
          if (!providerInfo) {
            throw new Error('loop monitor judge providerInfo is required');
          }
          startedJudgeProviderInfo.push(providerInfo);
        }
      });

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(startedJudgeProviderInfo).toEqual([
        expect.objectContaining({
          provider: 'codex',
          model,
          modelSource: 'step',
        }),
      ]);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex' }),
      }));
      if (model === undefined) {
        expect(judgeCall![2].resolvedExecution?.model).toBeUndefined();
      } else {
        expect(judgeCall![2].resolvedExecution?.model).toBe('selected-model');
      }
    });

    it('should use fallback provider and model for loop monitor judge after rate limit fallback reaches threshold', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        model: 'sonnet',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'claude',
              model: 'sonnet',
            },
          },
        },
        rateLimitFallback: {
          switchChain: [{ provider: 'codex', model: 'gpt-5' }],
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({
          persona: 'ai_fix',
          status: 'rate_limited',
          content: '',
          error: 'Rate limit exceeded',
          errorKind: 'rate_limit',
        }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: 'gpt-5' }),
      }));
    });

    it('should override only judge model while keeping the triggering provider', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
          personas: {
            'loop-judge': {
              model: 'opencode/zai-coding-plan/glm-5.2',
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.2' }),
      }));
    });

    it('should keep explicit judge provider and model overrides ahead of personaProviders.loop-judge', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
        personaProviders: {
          'loop-judge': {
            provider: 'opencode',
            model: 'opencode/should-not-win',
          },
        },
        internalAgentSeats: {
          loopJudge: {
            provider: 'codex',
            model: 'gpt-5.2-codex',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: 'gpt-5.2-codex' }),
      }));
    });

    it('should prefer persona_providers.loop-judge over the triggering step provider', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
        personaProviders: {
          'loop-judge': {
            provider: 'codex',
            model: 'gpt-5.9-judge',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: 'gpt-5.9-judge' }),
      }));
    });

    it('should prefer provider_routing.personas.loop-judge over the triggering step provider', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
          personas: {
            'loop-judge': {
              provider: 'cursor',
              model: 'cursor-judge-model',
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'cursor', model: 'cursor-judge-model' }),
      }));
    });

    it('should prefer provider_routing.steps._loop_judge_<cycle> over the triggering step provider', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
            '_loop_judge_ai_review_ai_fix': {
              provider: 'claude-sdk',
              model: 'opus-judge-step',
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'claude-sdk', model: 'opus-judge-step' }),
      }));
    });

    it('should not inherit the triggering model when only the judge provider is set via persona_providers.loop-judge', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
        personaProviders: {
          'loop-judge': {
            provider: 'codex',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'codex', model: undefined }),
      }));
    });

    it('should prefer explicit judge provider and model over the rate-limit fallback provider', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        model: 'sonnet',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'claude',
              model: 'sonnet',
            },
          },
        },
        rateLimitFallback: {
          switchChain: [{ provider: 'codex', model: 'gpt-5' }],
        },
        internalAgentSeats: {
          loopJudge: {
            provider: 'cursor',
            model: 'cursor-override',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({
          persona: 'ai_fix',
          status: 'rate_limited',
          content: '',
          error: 'Rate limit exceeded',
          errorKind: 'rate_limit',
        }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedExecution: expect.objectContaining({ provider: 'cursor', model: 'cursor-override' }),
      }));
    });

    it('should pass loop monitor judge provider block options to runAgent', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        internalAgentSeats: {
          loopJudge: {
            provider: 'codex',
            model: 'gpt-5.2-codex',
            providerOptions: {
              codex: {
                networkAccess: true,
              },
              claude: {
                sandbox: {
                  allowUnsandboxedCommands: true,
                },
              },
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        sessionId: undefined,
        resolvedExecution: expect.objectContaining({
          providerOptions: {
            codex: {
              networkAccess: true,
            },
            claude: {
              sandbox: {
                allowUnsandboxedCommands: true,
              },
            },
          },
        }),
      }));
    });

    it('should merge loop monitor judge provider block options with engine provider options', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerOptions: {
          claude: {
            baseUrl: 'http://127.0.0.1:8787',
            sandbox: {
              allowUnsandboxedCommands: true,
            },
          },
        },
        internalAgentSeats: {
          loopJudge: {
            provider: 'claude',
            providerOptions: {
              claude: {
                allowedTools: ['Read'],
                effort: 'low',
              },
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const startedJudgeProviderOptions: unknown[] = [];
      engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
        if (step.name.startsWith('_loop_judge_')) {
          startedJudgeProviderOptions.push(providerInfo?.providerOptions);
        }
      });

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const expectedClaudeOptions = {
        claude: {
          allowedTools: ['Read'],
          baseUrl: 'http://127.0.0.1:8787',
          effort: 'low',
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      };
      expect(startedJudgeProviderOptions).toEqual([
        expect.objectContaining(expectedClaudeOptions),
      ]);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]?.resolvedExecution?.providerOptions).toEqual(expect.objectContaining({
        claude: expect.objectContaining({
          allowedTools: ['Read'],
          effort: 'low',
        }),
      }));
    });

    it('runs every loop monitor judge call in a fresh session and never persists returned sessions', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerRouting: {
          steps: {
            ai_fix: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Loop is healthy', sessionId: 'monitor-session-1' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected', sessionId: 'monitor-session-2' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'ai_judge' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      const judgeCalls = vi.mocked(runAgent).mock.calls.filter((call) => call[0] === 'supervisor');
      expect(state.status).toBe('completed');
      expect(judgeCalls.map((call) => call[2]?.sessionId)).toEqual([undefined, undefined]);
      expect(judgeCalls.every((call) => typeof call[2]?.onStream === 'function')).toBe(true);
      expect(judgeCalls.every((call) => typeof call[2]?.onActivity === 'function')).toBe(true);
      expect(state.personaSessions.has(
        '["supervisor","opencode","opencode/zai-coding-plan/glm-5.1"]',
      )).toBe(false);
    });

    it('keeps the loop monitor judge alive past one inactivity window while internal activity continues', async () => {
      vi.useFakeTimers();
      const inactivityTimeoutMs = 60_000;
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: loopJudgeRules(),
        },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        internalAgentSeats: {
          loopJudge: {
            provider: 'opencode',
            model: 'opencode/judge-model',
            providerOptions: {
              opencode: { guards: { callTimeoutMs: inactivityTimeoutMs } },
            },
          },
        },
      });
      const regularResponses = [
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ];
      let resolveJudgeStarted: (() => void) | undefined;
      const judgeStarted = new Promise<void>((resolve) => {
        resolveJudgeStarted = resolve;
      });
      let releaseStreamActivity: (() => void) | undefined;
      const streamActivity = new Promise<void>((resolve) => {
        releaseStreamActivity = resolve;
      });
      let releaseRetryActivity: (() => void) | undefined;
      const retryActivity = new Promise<void>((resolve) => {
        releaseRetryActivity = resolve;
      });
      let releaseJudgeCompletion: (() => void) | undefined;
      const judgeCompletion = new Promise<void>((resolve) => {
        releaseJudgeCompletion = resolve;
      });
      let judgeSignal: AbortSignal | undefined;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        if (options.outputSchema === undefined) {
          const response = regularResponses.shift();
          if (response === undefined) throw new Error('Unexpected regular agent call');
          return response;
        }
        judgeSignal = options.abortSignal;
        options.onActivity?.({ kind: 'attempt_started' });
        resolveJudgeStarted?.();
        await streamActivity;
        options.onStream?.({ type: 'text', data: { text: 'judge is still working' } });
        await retryActivity;
        options.onActivity?.({ kind: 'attempt_started' });
        await judgeCompletion;
        return makeResponse({
          persona: 'supervisor',
          content: 'Unproductive loop detected',
          structuredOutput: { content: 'Unproductive loop detected' },
        });
      });
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      try {
        const execution = engine.run();
        await judgeStarted;
        await vi.advanceTimersByTimeAsync(40_000);
        releaseStreamActivity?.();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(judgeSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        releaseRetryActivity?.();
        await vi.advanceTimersByTimeAsync(20_000);
        releaseJudgeCompletion?.();
        const state = await execution;

        expect(state.status).toBe('completed');
        expect(judgeSignal?.aborted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps loop-judge seat capabilities and permission across a model-only CLI override', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: { persona: 'supervisor', rules: loopJudgeRules() },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        model: 'opencode/cli-judge-model',
        modelSource: 'cli',
        internalAgentSeats: {
          loopJudge: {
            provider: 'opencode',
            model: 'opencode/seat-judge',
            providerOptions: { opencode: { networkAccess: false } },
            permissionMode: 'readonly',
          },
        },
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      await engine.run();

      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        failureDir: expect.stringMatching(/[/\\]failures$/),
        resolvedExecution: {
          provider: 'opencode',
          model: 'opencode/cli-judge-model',
          providerOptions: { opencode: { networkAccess: false } },
          permissionMode: 'readonly',
        },
        sessionId: undefined,
      }));
    });

    it('drops loop-judge seat capabilities and permission when a CLI provider override wins', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: { persona: 'supervisor', rules: loopJudgeRules() },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'codex',
        providerSource: 'cli',
        model: 'cli-model',
        modelSource: 'cli',
        internalAgentSeats: {
          loopJudge: {
            provider: 'claude',
            model: 'seat-model',
            providerOptions: {
              codex: { networkAccess: false },
              claude: { allowedTools: ['Read'] },
            },
            permissionMode: 'readonly',
          },
        },
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);

      await engine.run();

      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]?.resolvedExecution).toEqual({
        provider: 'codex',
        model: 'cli-model',
        providerOptions: undefined,
        permissionMode: undefined,
      });
    });

    it('rejects a completed loop-judge response that violates the typed text contract', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: { persona: 'supervisor', rules: loopJudgeRules() },
      } as Partial<LoopMonitorConfig>);
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });
      mockBaseRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed' }),
        {
          ...makeResponse({ persona: 'supervisor', content: 'invalid typed result' }),
          structuredOutput: { content: 42 },
        },
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'ai_judge' },
        { index: 0, method: 'phase3_tag' },
      ]);
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortReasons.some((reason) => /content.*string/i.test(reason))).toBe(true);
    });
  });

  // =====================================================
  // 2. No trigger when threshold not reached
  // =====================================================
  describe('No trigger before threshold', () => {
    it('should not trigger judge when fewer cycles than threshold', async () => {
      const config = buildConfigWithLoopMonitor(3); // threshold = 3, only do 1 cycle
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review
        { index: 0, method: 'phase3_tag' },  // ai_review → reviewers (no issues)
        { index: 0, method: 'phase3_tag' },  // reviewers → COMPLETE
      ]);

      const cycleDetectedFn = vi.fn();
      engine.on('step:cycle_detected', cycleDetectedFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(cycleDetectedFn).not.toHaveBeenCalled();
      // No judge was called, so only 5 iterations
      expect(state.iteration).toBe(5);
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
    });
  });

  // =====================================================
  // 3. Validation errors
  // =====================================================
  describe('Config validation', () => {
    it('should throw when loop_monitor cycle references nonexistent step', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = [
        {
          cycle: ['ai_review', 'nonexistent'],
          threshold: 3,
          judge: {
            rules: [normalizeRule({ condition: 'test', next: 'ai_review' }) as LoopMonitorRule],
          },
        },
      ];

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent');
    });

    it('should throw when loop_monitor judge rule references nonexistent step', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = [
        {
          cycle: ['ai_review', 'ai_fix'],
          threshold: 3,
          judge: {
            rules: [normalizeRule({ condition: 'test', next: 'nonexistent_target' }) as LoopMonitorRule],
          },
        },
      ];

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent_target');
    });

    it('should reject a bare OpenCode loop-judge model from runtime persona routing', () => {
      const config = buildConfigWithLoopMonitor(3);

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', {
          projectCwd: tmpDir,
          providerRouting: {
            personas: {
              'loop-judge': {
                provider: 'opencode',
                model: 'big-pickle',
              },
            },
          },
        });
      }).toThrow('Configuration error: loop_monitors.judge.model');
    });

    it('should reject a bare OpenCode loop-judge model from an internal runtime seat', () => {
      const config = buildConfigWithLoopMonitor(3);

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', {
          projectCwd: tmpDir,
          internalAgentSeats: {
            loopJudge: {
              provider: 'opencode',
              model: 'big-pickle',
            },
          },
        });
      }).toThrow('Configuration error: loop_monitors.judge.model');
    });

    it('should validate a loop judge through workflow-level effective auto routing', () => {
      const config = buildConfigWithLoopMonitor(3);
      const autoRouting = {
        strategy: 'balanced' as const,
        router: { provider: 'codex' as const, model: 'router-model' },
        candidates: [{
          name: 'loop-candidate',
          description: 'Loop monitor validation',
          provider: 'codex' as const,
          model: 'gpt-5',
          routingTier: 'medium' as const,
        }],
        defaultPool: 'general',
        candidatePools: { general: { candidates: ['loop-candidate'], fallback: 'loop-candidate' } },
        poolRules: {
          steps: {
            implement: 'general',
            ai_review: 'general',
            ai_fix: 'general',
            reviewers: 'general',
            _loop_judge_ai_review_ai_fix: 'general',
          },
        },
        rules: { steps: { ai_fix: 'loop-candidate' } },
      };

      expect(() => new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
        autoRouting,
      })).not.toThrow();
    });

    it('should validate a loop judge through inherited effective auto routing', () => {
      const config = buildConfigWithLoopMonitor(3);
      const inheritedAutoRouting = {
        strategy: 'balanced' as const,
        router: { provider: 'codex' as const, model: 'router-model' },
        candidates: [{
          name: 'loop-candidate',
          description: 'Loop monitor validation',
          provider: 'codex' as const,
          model: 'gpt-5',
          routingTier: 'medium' as const,
        }],
        defaultPool: 'general',
        candidatePools: { general: { candidates: ['loop-candidate'], fallback: 'loop-candidate' } },
        poolRules: {
          steps: {
            implement: 'general',
            ai_review: 'general',
            ai_fix: 'general',
            reviewers: 'general',
            _loop_judge_ai_review_ai_fix: 'general',
          },
        },
        rules: { steps: { ai_fix: 'loop-candidate' } },
      };

      expect(() => new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
        autoRouting: inheritedAutoRouting,
      })).not.toThrow();
    });
  });

  // =====================================================
  // 4. No loop monitors configured
  // =====================================================
  describe('No loop monitors', () => {
    it('should work normally without loop_monitors configured', async () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = undefined;
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();
      expect(state.status).toBe('completed');
      expect(state.iteration).toBe(3);
    });
  });
});

// =====================================================
// 判定役の障害は走行を落とさない（自然遷移で続行）
// =====================================================
describe('Judge failure falls back to the natural transition', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should continue with the natural next step when the judge agent errors', async () => {
    const config = buildConfigWithLoopMonitor(2, {
      judge: {
        persona: 'supervisor',
        instruction: 'The loop repeated {cycle_count} times.',
        rules: loopJudgeRules(),
      },
    });
    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'mock',
      model: 'mock-model',
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'Implementation done' }),
      makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
      makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
      makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
      makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
      // 判定役がプロバイダエラーで decision を返せない
      makeResponse({ persona: 'supervisor', content: '', status: 'error', error: 'provider exploded' }),
      // エンジンの fresh retry でも同じ error を返し、判定不能のまま自然遷移へ進む
      makeResponse({ persona: 'supervisor', content: '', status: 'error', error: 'provider exploded' }),
      // 自然遷移（ai_fix → ai_review）で続行し、承認 → reviewers → COMPLETE
      makeResponse({ persona: 'ai_review', content: 'No issues' }),
      makeResponse({ persona: 'reviewers', content: 'All approved' }),
    ]);

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },  // implement → ai_review
      { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix
      { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review
      { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix
      { index: 0, method: 'phase3_tag' },  // ai_fix → ai_review（ここで cycle 検出）
      // 判定役は error なのでルール照合なし
      { index: 0, method: 'phase3_tag' },  // ai_review → reviewers（No issues）
      { index: 0, method: 'phase3_tag' },  // reviewers → COMPLETE
    ]);

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(abortFn).not.toHaveBeenCalled();
  });
});

// =====================================================
// bounded replan 系譜の judge（family 形状の実行時検証）
// =====================================================
describe('Replan-family judge transitions (runtime)', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function buildReplanFamilyConfig(): WorkflowConfig {
    return {
      name: 'test-replan-family',
      description: 'family-shaped replan monitor',
      maxSteps: 40,
      initialStep: 'plan',
      loopMonitors: [
        {
          cycle: ['plan', 'write_tests', 'implement', 'reviewers', 'fix'],
          threshold: 2,
          judge: {
            persona: 'supervisor',
            instruction: 'The replan loop repeated {cycle_count} times.',
            rules: [
              normalizeRule({ condition: 'The latest fix ended with fixes complete', next: 'reviewers' }) as LoopMonitorRule,
              normalizeRule({ condition: 'Healthy replanning', next: 'plan' }) as LoopMonitorRule,
              normalizeRule({ condition: 'Same dead end repeats', next: 'ABORT' }) as LoopMonitorRule,
            ],
          },
        },
      ],
      steps: [
        makeStep('plan', {
          rules: [makeRule('Planned', 'write_tests'), makeRule('Cannot plan', 'ABORT')],
        }),
        makeStep('write_tests', { rules: [makeRule('Tests written', 'implement')] }),
        makeStep('implement', { rules: [makeRule('Implemented', 'reviewers')] }),
        makeStep('reviewers', {
          rules: [makeRule('Issues found', 'fix'), makeRule('All approved', 'COMPLETE')],
        }),
        makeStep('fix', {
          rules: [makeRule('Fixes complete', 'reviewers'), makeRule('Cannot proceed', 'plan')],
        }),
      ],
    };
  }

  /** 2周分の応答とルール一致を積み、judge の選択だけ差し替える */
  function primeTwoCycles(judgeMatch: { index: number; method: 'ai_judge' }, tail: {
    responses: ReturnType<typeof makeResponse>[];
    matches: { index: number; method: 'phase3_tag' }[];
  }): void {
    const cycleResponses = [
      makeResponse({ persona: 'plan', content: 'Planned' }),
      makeResponse({ persona: 'write_tests', content: 'Tests written' }),
      makeResponse({ persona: 'implement', content: 'Implemented' }),
      makeResponse({ persona: 'reviewers', content: 'Issues found' }),
      makeResponse({ persona: 'fix', content: 'Cannot proceed' }),
    ];
    mockRunAgentSequence([
      ...cycleResponses,
      ...cycleResponses,
      makeResponse({ persona: 'supervisor', content: 'judged' }),
      ...tail.responses,
    ]);
    const cycleMatches: { index: number; method: 'phase3_tag' }[] = [
      { index: 0, method: 'phase3_tag' }, // plan → write_tests
      { index: 0, method: 'phase3_tag' }, // write_tests → implement
      { index: 0, method: 'phase3_tag' }, // implement → reviewers
      { index: 0, method: 'phase3_tag' }, // reviewers → fix
      { index: 1, method: 'phase3_tag' }, // fix → plan（行き詰まり）
    ];
    mockRuleEvaluationSequence([
      ...cycleMatches,
      ...cycleMatches,
      judgeMatch,
      ...tail.matches,
    ]);
  }

  function collectStepStarts(target: WorkflowEngine): string[] {
    const names: string[] = [];
    // judge は合成ステップ（_loop_judge_...）として step:start を発火するため除外
    target.on('step:start', (step: WorkflowStep) => {
      if (!step.name.startsWith('_loop_judge')) {
        names.push(step.name);
      }
    });
    return names;
  }

  it('should return to reviewers when the judge sees the latest fix as complete', async () => {
    engine = new WorkflowEngine(buildReplanFamilyConfig(), tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'mock',
      model: 'mock-model',
    });
    primeTwoCycles({ index: 0, method: 'ai_judge' }, {
      responses: [makeResponse({ persona: 'reviewers', content: 'All approved' })],
      matches: [{ index: 1, method: 'phase3_tag' }],
    });
    const steps = collectStepStarts(engine);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(steps[steps.length - 1]).toBe('reviewers');
  });

  it('should return to plan when the judge sees healthy replanning', async () => {
    engine = new WorkflowEngine(buildReplanFamilyConfig(), tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'mock',
      model: 'mock-model',
    });
    primeTwoCycles({ index: 1, method: 'ai_judge' }, {
      responses: [makeResponse({ persona: 'plan', content: 'Cannot plan' })],
      matches: [{ index: 1, method: 'phase3_tag' }],
    });
    const steps = collectStepStarts(engine);

    const state = await engine.run();

    // judge → plan に戻り、その plan が計画不能を宣言して中断（planner が打ち切り権を持つ）
    expect(steps[steps.length - 1]).toBe('plan');
    expect(state.status).toBe('aborted');
  });

  it('should abort when the judge sees the same dead end repeating', async () => {
    engine = new WorkflowEngine(buildReplanFamilyConfig(), tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'mock',
      model: 'mock-model',
    });
    primeTwoCycles({ index: 2, method: 'ai_judge' }, { responses: [], matches: [] });
    const steps = collectStepStarts(engine);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    // judge の後に新しいステップは始まらない
    expect(steps[steps.length - 1]).toBe('fix');
  });
});

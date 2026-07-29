import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return { ...actual, RuleEvaluator: MockRuleEvaluator };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { runAgent } from '../agents/runner.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { isolateStepFragmentTestConfig } from './helpers/step-fragment-test-helpers.js';
import { initializeGitFixture } from './helpers/git-fixture.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function workflowSteps(fragmentName?: string): string {
  const review = fragmentName
    ? '  - uses: ' + fragmentName
    : [
        '  - name: review',
        '    instruction: review',
        '    required_permission_mode: edit',
        '    provider_options:',
        '      claude:',
        '        allowed_tools: [Read]',
        '    output_contracts:',
        '      report:',
        '        - name: review.md',
        '          format: review-finding-contract',
        '    rules:',
        '      - condition: issue',
        '        next: fix',
      ].join('\n');
  return [
    'name: fragment-runtime',
    'initial_step: review',
    'max_steps: 4',
    'workflow_config:',
    '  provider: claude',
    'finding_contract:',
    '  ledger_path: .takt/findings/ledger.json',
    '  raw_findings_path: .takt/findings/raw',
    '  manager:',
    '    persona: findings-manager',
    '    instruction: findings-manager',
    '    output_contract: findings-manager',
    'loop_monitors:',
    '  - cycle: [review, fix]',
    '    threshold: 1',
    '    judge:',
    '      rules:',
    '        - condition: stop',
    '          next: COMPLETE',
    'steps:',
    review,
    '  - name: fix',
    '    instruction: fix',
    '    rules:',
    '      - condition: fixed',
    '        next: review',
  ].join('\n') + '\n';
}

function resumableWorkflowSteps(fragmentName?: string): string {
  const review = fragmentName
    ? '  - uses: ' + fragmentName
    : [
        '  - name: review',
        '    instruction: review',
        '    rules:',
        '      - condition: issue',
        '        next: fix',
      ].join('\n');
  return [
    'name: fragment-resume-runtime',
    'initial_step: review',
    'max_steps: 4',
    'steps:',
    review,
    '  - name: fix',
    '    instruction: fix',
    '    rules:',
    '      - condition: fixed',
    '        next: review',
  ].join('\n') + '\n';
}

describe('workflow step fragment runtime contract', () => {
  let projectDir: string;
  let engines: WorkflowEngine[];
  let testCwds: string[];
  let restoreConfig: () => void;

  beforeEach(() => {
    restoreConfig = isolateStepFragmentTestConfig('takt-step-fragment-runtime-config-');
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-runtime-'));
    engines = [];
    testCwds = [];
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  afterEach(() => {
    for (const engine of engines) cleanupWorkflowEngine(engine);
    for (const cwd of testCwds) rmSync(cwd, { recursive: true, force: true });
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    restoreConfig();
  });

  it('executes fragment and inline steps with identical transitions, finding contract, resume point, and loop monitor result', async () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'name: review',
      'instruction: review',
      'required_permission_mode: edit',
      'provider_options:',
      '  claude:',
      '    allowed_tools: [Read]',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      'rules:',
      '  - condition: issue',
      '    next: fix',
      '',
    ].join('\n'));
    const inlinePath = writeFile(projectDir, '.takt/workflows/inline.yaml', workflowSteps());
    const fragmentPath = writeFile(projectDir, '.takt/workflows/fragment.yaml', workflowSteps('review'));
    writeFile(projectDir, '.takt/facets/output-contracts/review-finding-contract.md', 'Finding contract review report');
    const inline = loadWorkflowFromFile(inlinePath, projectDir);
    const fragment = loadWorkflowFromFile(fragmentPath, projectDir);

    const execute = async (config: typeof inline) => {
      const cwd = createTestTmpDir();
      testCwds.push(cwd);
      writeFile(cwd, 'src/reviewed.ts', 'export const reviewed = true;\n');
      initializeGitFixture(cwd, ['src/reviewed.ts']);
      const engine = new WorkflowEngine(config, cwd, 'test task', { projectCwd: cwd });
      engines.push(engine);
      const transitions: string[] = [];
      const cycleCounts: number[] = [];
      const ledgers: Array<{ findings: unknown[]; rawFindings: unknown[] }> = [];
      engine.on('step:complete', (step) => transitions.push(step.name));
      engine.on('step:cycle_detected', (_monitor, count) => cycleCounts.push(count));
      engine.on('findings:ledger', (ledger) => ledgers.push(ledger));
      vi.mocked(runAgent).mockReset();
      mockRunAgentSequence([
        makeResponse({
          persona: 'review',
          content: 'issue',
          structuredOutput: {
            rawFindings: [{
              rawFindingId: 'review-issue',
              familyTag: 'test',
              severity: 'high',
              title: 'Test finding',
              location: '',
              evidenceKind: 'locationless',
              verbatimExcerpt: '',
              snapshotId: '',
              description: 'A finding emitted by the reviewer.',
              suggestion: '',
              relation: 'new',
              targetFindingId: '',
            }],
          },
        }),
        makeResponse({
          persona: 'findings-manager',
          structuredOutput: {
            rawDecisions: [],
            disputeDecisions: [],
            conflictDecisions: [],
            invalidateDecisions: [],
            duplicateDecisions: [],
            dismissDecisions: [],
          },
        }),
        makeResponse({ persona: 'fix', content: 'fixed' }),
        makeResponse({ persona: 'supervisor', content: 'stop' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'ai_judge' },
      ]);

      const state = await engine.run();
      const resumePoint = engine.getResumePoint();
      const runAgentCalls = vi.mocked(runAgent).mock.calls.map(([, , options]) => ({
        stepName: options?.workflowMeta?.currentStep,
        allowedTools: options?.allowedTools,
        bypassPermissions: options?.bypassPermissions,
        providerOptions: options?.providerOptions,
        resolvedModel: options?.resolvedModel,
        resolvedProvider: options?.resolvedProvider,
        resolvedProviderOptions: options?.resolvedProviderOptions,
        requiredPermissionMode: options?.permissionResolution?.requiredPermissionMode,
      }));
      return { state, transitions, cycleCounts, ledgers, resumePoint, runAgentCalls };
    };

    const inlineResult = await execute(inline);
    const fragmentResult = await execute(fragment);

    expect(fragment.findingContract).toEqual(inline.findingContract);
    expect(fragmentResult.transitions).toEqual(inlineResult.transitions);
    expect(fragmentResult.cycleCounts).toEqual(inlineResult.cycleCounts);
    expect(fragmentResult.runAgentCalls).toEqual(inlineResult.runAgentCalls);
    expect(fragmentResult.runAgentCalls.find((call) => call.stepName === 'review')).toMatchObject({
      allowedTools: ['Read'],
      requiredPermissionMode: 'edit',
    });
    expect(inlineResult.ledgers).toHaveLength(1);
    expect(fragmentResult.ledgers).toHaveLength(1);
    for (const result of [inlineResult, fragmentResult]) {
      expect(result.ledgers[0]).toMatchObject({
        rawFindings: [{
          familyTag: 'test',
          severity: 'high',
          title: 'Test finding',
          relation: 'new',
        }],
        findings: [{
          severity: 'high',
          title: 'Test finding',
          provisional: { kind: 'unverified-locationless' },
        }],
      });
    }
    expect(inlineResult.state.status).toBe('aborted');
    expect(fragmentResult.state.status).toBe('aborted');
    expect(fragmentResult.resumePoint?.stack[0]).toMatchObject({ step: 'fix', kind: 'agent' });
    expect(fragmentResult.resumePoint?.stack[0]?.workflow_ref).toBe(getWorkflowReference(fragment));
    expect(fragmentResult.resumePoint?.stack[0]?.workflow_ref).not.toContain(fragmentPath);
    expect(fragmentResult.resumePoint?.stack[0]?.step_iterations).toEqual({
      review: 1,
      fix: 1,
      _loop_judge_review_fix: 1,
    });
    expect(fragmentResult.resumePoint?.stack[0]?.step_iterations)
      .toEqual(inlineResult.resumePoint?.stack[0]?.step_iterations);
  });

  it('resumes inline and fragment workflows from the same saved step, iteration, and transition', async () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'name: review',
      'instruction: review',
      'rules:',
      '  - condition: issue',
      '    next: fix',
      '',
    ].join('\n'));
    const inlinePath = writeFile(projectDir, '.takt/workflows/inline-resume.yaml', resumableWorkflowSteps());
    const fragmentPath = writeFile(projectDir, '.takt/workflows/fragment-resume.yaml', resumableWorkflowSteps('review'));
    const inline = loadWorkflowFromFile(inlinePath, projectDir);
    const fragment = loadWorkflowFromFile(fragmentPath, projectDir);

    const saveResumePointAtFixStart = async (config: typeof inline) => {
      const cwd = createTestTmpDir();
      testCwds.push(cwd);
      writeFile(cwd, 'src/reviewed.ts', 'export const reviewed = true;\n');
      initializeGitFixture(cwd, ['src/reviewed.ts']);
      const engine = new WorkflowEngine(config, cwd, 'test task', { projectCwd: cwd });
      engines.push(engine);
      let resumePoint: ReturnType<WorkflowEngine['getResumePoint']>;
      engine.on('step:start', (step) => {
        if (step.name === 'fix') {
          resumePoint = engine.getResumePoint();
          engine.abort();
        }
      });
      vi.mocked(runAgent).mockReset();
      mockRunAgentSequence([makeResponse({ persona: 'review', content: 'issue' })]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

      await engine.run();
      if (resumePoint === undefined) {
        throw new Error('Failed to save resume point at fix step start');
      }
      return resumePoint;
    };

    const resumeFromSavedPoint = async (
      config: typeof inline,
      resumePoint: NonNullable<ReturnType<WorkflowEngine['getResumePoint']>>,
    ) => {
      const cwd = createTestTmpDir();
      testCwds.push(cwd);
      writeFile(cwd, 'src/fixed.ts', 'export const fixed = true;\n');
      initializeGitFixture(cwd, ['src/fixed.ts']);
      const engine = new WorkflowEngine(config, cwd, 'test task', {
        projectCwd: cwd,
        startStep: 'fix',
        initialIteration: resumePoint.iteration,
        resumePoint,
      });
      engines.push(engine);
      const restoredStepIterations = Object.fromEntries(engine.getState().stepIterations);
      vi.mocked(runAgent).mockReset();
      mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'fixed' })]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

      const result = await engine.runSingleIteration();
      const state = engine.getState();
      return { result, state, restoredStepIterations };
    };

    const inlineResumePoint = await saveResumePointAtFixStart(inline);
    const fragmentResumePoint = await saveResumePointAtFixStart(fragment);
    const inlineResult = await resumeFromSavedPoint(inline, inlineResumePoint);
    const fragmentResult = await resumeFromSavedPoint(fragment, fragmentResumePoint);

    expect(fragmentResumePoint.stack[0]).toMatchObject({
      workflow_ref: getWorkflowReference(fragment),
      step: 'fix',
      step_iterations: { review: 1, fix: 1 },
    });
    expect(fragmentResult.restoredStepIterations).toEqual(fragmentResumePoint.stack[0]?.step_iterations);
    expect(fragmentResult.restoredStepIterations).toEqual(inlineResult.restoredStepIterations);
    expect(fragmentResult.result.nextStep).toBe('review');
    expect(fragmentResult.state.stepIterations).toEqual(inlineResult.state.stepIterations);
    expect(fragmentResult.state.stepIterations).toEqual(new Map([['review', 1], ['fix', 2]]));
    expect(fragmentResult.result).toMatchObject({ nextStep: inlineResult.result.nextStep });
  });
});

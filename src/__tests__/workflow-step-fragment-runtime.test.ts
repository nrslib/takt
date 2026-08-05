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

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from './helpers/workflow-engine.js';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/types.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { runAgent } from '../agents/runner.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  getAttachedWorkflowTrustInfo,
  getWorkflowSourcePath,
} from '../shared/workflowConfigMetadata.js';
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
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function schemaHasProperty(schema: unknown, property: string): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return false;
  }
  const properties = Reflect.get(schema, 'properties');
  return typeof properties === 'object'
    && properties !== null
    && !Array.isArray(properties)
    && property in properties;
}

function workflowSteps(fragmentName?: string): string {
  const review = fragmentName
    ? [
        '  - name: review',
        '    uses: ' + fragmentName,
        '    rules:',
        '      - condition: issue',
        '        next: fix',
      ].join('\n')
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
    ? [
        '  - name: review',
        '    uses: ' + fragmentName,
        '    rules:',
        '      - condition: issue',
        '        next: fix',
      ].join('\n')
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
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({
          systemPrompt: 'test system prompt',
          userInstruction: instruction,
        });
        if (schemaHasProperty(options?.outputSchema, 'rawFindings')) {
          const reportContent = 'A finding emitted by the reviewer.';
          return makeResponse({
            persona,
            content: reportContent,
            structuredOutput: {
              ...(schemaHasProperty(options?.outputSchema, 'reportContent')
                ? { reportContent }
                : {}),
              rawFindings: [{
                rawExcerpt: reportContent,
                candidate: {
                  rawFindingId: 'review-issue',
                  familyTag: 'test',
                  severity: 'high',
                  title: 'Test finding',
                  description: reportContent,
                  suggestion: null,
                  relation: 'new',
                  targetFindingIds: [],
                  target: null,
                  evidenceRequests: [],
                },
              }],
            },
          });
        }
        if (schemaHasProperty(options?.outputSchema, 'rawDecisions')) {
          return makeResponse({
            persona,
            content: 'manager complete',
            structuredOutput: {
              rawDecisions: [],
              disputeDecisions: [],
              conflictDecisions: [],
              invalidateDecisions: [],
              duplicateDecisions: [],
              dismissDecisions: [],
            },
          });
        }
        return makeResponse({
          persona,
          content: persona === 'supervisor' ? 'stop' : 'fixed',
        });
      });
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
      // FC intake 契約化後の landing: target 無し（review_scope）の独立 claim は
      // provisional finding ではなく intake-contract-incomplete reviewer anomaly に
      // 隔離され、product findings は空のまま completion を塞ぐ。
      expect(result.ledgers[0]).toMatchObject({
        rawFindings: [{
          familyTag: 'test',
          severity: 'high',
          title: 'Test finding',
          relation: 'new',
          target: { kind: 'review_scope' },
        }],
        findings: [],
        reviewerAnomalies: [{
          kind: 'intake-contract-incomplete',
          title: 'Test finding',
          intakeContract: {
            observationClass: 'claim-bearing',
            missingRequirements: ['target'],
          },
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
  }, 60_000);

  it('resumes inline and fragment workflows from the same saved step, iteration, and transition', async () => {
    writeFile(projectDir, '.takt/steps/review.yaml', [
      'name: review',
      'instruction: review',
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
    expect(fragmentResult.state.stepIterations).toEqual(new Map([['review', 1], ['fix', 1]]));
    expect(fragmentResult.result).toMatchObject({ nextStep: inlineResult.result.nextStep });
  });

  it('preserves source, trust, opaque resume identity, and relative workflow calls across resume', async () => {
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'auto_select' });
    writeFile(projectDir, '.takt/steps/delegate.yaml', [
      'kind: workflow_call',
      'call: ./children/child.yaml',
      '',
    ].join('\n'));
    const childPath = writeFile(projectDir, '.takt/workflows/children/child.yaml', [
      'name: child',
      'subworkflow:',
      '  callable: true',
      '  returns: [success]',
      'initial_step: done',
      'max_steps: 10',
      'steps:',
      '  - name: done',
      '    instruction: done',
      '    rules:',
      '      - condition: when(true)',
      '        return: success',
      '',
    ].join('\n'));
    const parentPath = writeFile(projectDir, '.takt/workflows/parent.yaml', [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 10',
      'steps:',
      '  - name: delegate',
      '    uses: delegate',
      '    rules:',
      '      - condition: success',
      '        next: COMPLETE',
      '      - condition: ABORT',
      '        next: ABORT',
      '',
    ].join('\n'));
    const loaded = loadWorkflowFromFile(parentPath, projectDir);
    const createEngine = (resumePoint?: WorkflowResumePoint) => {
      const engine = new WorkflowEngine(loaded, projectDir, 'test task', {
        projectCwd: projectDir,
        provider: 'mock',
        model: 'mock-model',
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
        ...(resumePoint === undefined ? {} : {
          startStep: resumePoint.stack[0]?.step,
          initialIteration: resumePoint.iteration,
          resumePoint,
        }),
      });
      engines.push(engine);
      return engine;
    };
    const engine = createEngine();
    const config = (engine as unknown as { config: WorkflowConfig }).config;
    const delegate = config.steps.find((step) => step.name === 'delegate');

    if (!delegate || delegate.kind !== 'workflow_call') {
      throw new Error('Expected the fragment to resolve to a workflow_call step');
    }

    const child = resolveWorkflowCallTarget(config, delegate, projectDir);
    let savedResumePoint: WorkflowResumePoint | undefined;
    const abortReasons: string[] = [];
    const completedSteps: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    engine.on('step:complete', (step) => completedSteps.push(step.name));
    engine.on('step:start', (step) => {
      if (step.name === 'done') savedResumePoint = engine.getResumePoint();
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return makeResponse({
        persona: 'done',
        content: 'done',
        structuredOutput: { rawFindings: [] },
      });
    });
    const firstState = await engine.run();
    if (savedResumePoint === undefined) {
      throw new Error(`Expected a child resume point (status: ${firstState.status}, abort: ${abortReasons.join(' ')})`);
    }

    const resumedEngine = createEngine(savedResumePoint);
    const resumedChildStepIterations: number[] = [];
    resumedEngine.on(
      'step:start',
      (step, _iteration, _instruction, _providerInfo, _workflowName, _resumeStepName, stepIteration) => {
        if (step.name === 'done' && stepIteration !== undefined) {
          resumedChildStepIterations.push(stepIteration);
        }
      },
    );
    const resumedState = await resumedEngine.run();

    expect(getWorkflowSourcePath(config)).toBe(parentPath);
    expect(getAttachedWorkflowTrustInfo(config)).toMatchObject({
      source: 'project',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });
    expect(child).not.toBeNull();
    expect(getWorkflowSourcePath(child!)).toBe(childPath);
    expect(getAttachedWorkflowTrustInfo(child!)).toMatchObject({
      source: 'project',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    });
    expect(firstState.status, `${abortReasons.join(' ')}; completed: ${completedSteps.join(', ')}`)
      .toBe('completed');
    expect(savedResumePoint.stack).toHaveLength(2);
    expect(savedResumePoint.stack[0]?.workflow_ref).toBe(getWorkflowReference(config));
    expect(savedResumePoint.stack[0]?.workflow_ref).not.toContain(parentPath);
    expect(savedResumePoint.stack[1]?.workflow_ref).toBe(getWorkflowReference(child!));
    expect(savedResumePoint.stack[1]?.step).toBe('done');
    expect(savedResumePoint.stack[1]?.step_iterations).toMatchObject({ done: 1 });
    expect(resumedState.status).toBe('completed');
    expect(resumedChildStepIterations).toEqual([1]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
  });
});

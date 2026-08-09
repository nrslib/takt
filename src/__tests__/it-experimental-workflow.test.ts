import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type WorkflowStep,
} from '../core/models/index.js';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import type { SelectorGitCommandRunner } from '../core/workflow/dynamic-parallel/selector-git-command-runner.js';
import { DefaultStructuredCaller } from '../agents/structured-caller.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import {
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import {
  getScenarioQueue,
  resetScenario,
  setMockScenario,
  type ScenarioEntry,
} from '../infra/mock/index.js';
import { cleanupWorkflowEngine } from './engine-test-helpers.js';

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockImplementation(async (
    step: WorkflowStep,
    _stepIteration: number,
    context: { reportDir: string; lastResponse?: string },
  ) => {
    mkdirSync(context.reportDir, { recursive: true });
    for (const contract of step.outputContracts ?? []) {
      writeFileSync(join(context.reportDir, contract.name), context.lastResponse ?? 'Mock report');
    }
  }),
  runStatusJudgmentPhase: vi.fn().mockImplementation((
    step: WorkflowStep,
    context: { interactive?: boolean; lastResponse?: string },
  ) => {
    const match = /RULE:(\d+)/u.exec(context.lastResponse ?? '');
    const candidateIndex = match === null ? -1 : Number.parseInt(match[1]!, 10);
    const candidate = semanticRuleCandidatesOf(
      step.rules ?? [],
      context.interactive === true,
    )[candidateIndex];
    if (candidate === undefined) {
      throw new RuleDetectionExhaustedError(step.name);
    }
    return { label: candidate.label, method: 'phase3_tag' as const };
  }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
}));

import { runReportPhase } from '../core/workflow/phase-runner.js';

const SELECTOR_PROVIDER = {
  provider: 'mock' as const,
  providerOptions: {},
  nativeTools: [],
};
const SELECTOR_GIT_COMMAND_RUNNER: SelectorGitCommandRunner = {
  run: async () => ({ output: Buffer.alloc(0), bytes: 0 }),
};

function findWorkflowStep(workflow: WorkflowConfig, stepName: string): WorkflowStep {
  const pending = [...workflow.steps];
  for (const step of pending) {
    if (step.name === stepName) return step;
    if (step.parallel !== undefined) pending.push(...getAllParallelSubSteps(step.parallel));
  }
  throw new Error(`Workflow step not found: ${stepName}`);
}

function loadCoreForWrapper(
  language: 'en' | 'ja',
  wrapper: WorkflowConfig,
  projectDir: string,
): WorkflowConfig {
  const delegation = wrapper.steps.find((step) => step.name === 'develop');
  if (delegation?.kind !== 'workflow_call' || typeof delegation.call !== 'string') {
    return wrapper;
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${delegation.call}.yaml`),
    projectDir,
    { callableArgs: delegation.args },
  );
}

function loadReviewForCore(
  language: 'en' | 'ja',
  core: WorkflowConfig,
  projectDir: string,
): WorkflowConfig {
  const review = findWorkflowStep(core, 'review');
  if (review.kind !== 'workflow_call' || typeof review.call !== 'string') {
    return core;
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${review.call}.yaml`),
    projectDir,
    { callableArgs: review.args },
  );
}

function findRuleIndex(step: WorkflowStep, ruleLabel: string): number {
  const ruleIndex = semanticRuleCandidatesOf(step.rules ?? [], false)
    .findIndex((candidate) => candidate.label === ruleLabel);
  if (ruleIndex < 0) {
    throw new Error(`Rule label not found for step "${step.name}": ${ruleLabel}`);
  }
  return ruleIndex;
}

function response(
  workflow: WorkflowConfig,
  stepName: string,
  persona: string,
  ruleLabel: string,
): ScenarioEntry {
  const ruleIndex = findRuleIndex(findWorkflowStep(workflow, stepName), ruleLabel);
  return {
    persona,
    status: 'done',
    content: `RULE:${ruleIndex}`,
  };
}

function selection(selectedIds: string[], rationale: string): ScenarioEntry {
  return {
    persona: 'takt-internal',
    status: 'done',
    content: rationale,
    structuredOutput: {
      selected_ids: selectedIds,
      rationale,
    },
  };
}

function reviewReportCalls(): WorkflowStep[] {
  return vi.mocked(runReportPhase).mock.calls
    .map(([step]) => step)
    .filter((step) => step.tags?.includes('review') === true);
}

describe('experimental builtin workflow', () => {
  let projectDir: string;
  let engines: WorkflowEngine[];

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-experimental-workflow-'));
    engines = [];
    vi.clearAllMocks();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    mkdirSync(join(projectDir, '.takt'), { recursive: true });
  });

  afterEach(() => {
    for (const engine of engines) cleanupWorkflowEngine(engine);
    resetScenario();
    rmSync(projectDir, { recursive: true, force: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each(['en', 'ja'] as const)('should keep the %s variants thin and isolate their injected pools when loading generic and TAKT wrappers', (language) => {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
    invalidateAllResolvedConfigCache();
    const generic = loadWorkflowFromFile(
      join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
      projectDir,
    );
    const takt = loadWorkflowFromFile(
      join(getBuiltinWorkflowsDir(language), 'takt-experimental.yaml'),
      projectDir,
    );

    for (const wrapper of [generic, takt]) {
      expect(wrapper.facetPools).toBeUndefined();
      expect(wrapper.steps).toHaveLength(1);
      expect(wrapper.steps[0]).toMatchObject({
        name: 'develop',
        kind: 'workflow_call',
        call: 'experimental-core',
      });
    }

    const genericCore = loadCoreForWrapper(language, generic, projectDir);
    const taktCore = loadCoreForWrapper(language, takt, projectDir);
    const genericImplement = findWorkflowStep(genericCore, 'implement');
    const taktImplement = findWorkflowStep(taktCore, 'implement');
    expect(genericImplement.dynamicFacets?.pool).toBe('coding-facets');
    expect(taktImplement.dynamicFacets?.pool).toBe('takt-coding-facets');
    expect(genericCore.facetPools?.['coding-facets']?.candidates.map(({ id }) => id))
      .toEqual(expect.arrayContaining(['frontend', 'backend']));
    const taktCandidateIds = taktCore.facetPools?.['takt-coding-facets']?.candidates.map(({ id }) => id) ?? [];
    expect(taktCandidateIds).not.toContain('frontend');
    expect(taktCandidateIds).not.toContain('backend');
    expect(findWorkflowStep(genericCore, 'review').call).toBe('experimental-review');
    expect(findWorkflowStep(taktCore, 'review').call).toBe('takt-experimental-review');
  });

  it('should fail fast when facet pool bindings are missing, wrongly typed, or unknown', () => {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: en\n');
    invalidateAllResolvedConfigCache();
    const corePath = join(getBuiltinWorkflowsDir('en'), 'experimental-core.yaml');
    expect(() => loadWorkflowFromFile(corePath, projectDir, {
      callableArgs: { implementation_pool: 'missing-pool' },
    })).toThrow('references unknown facet pool "missing-pool"');
    expect(() => loadWorkflowFromFile(corePath, projectDir, {
      callableArgs: { implementation_pool: ['coding-facets'] },
    })).toThrow('must be a scalar facet_pool_ref');

    const customDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(customDir, { recursive: true });
    const customPath = join(customDir, 'pool-contract.yaml');
    writeFileSync(customPath, `name: pool-contract
subworkflow:
  callable: true
  visibility: internal
  params:
    pool:
      type: facet_pool_ref
facet_pools:
  available:
    candidates:
      - id: candidate
        description: Candidate
        policy: coding
        knowledge: architecture
initial_step: implement
steps:
  - name: implement
    persona: coder
    policy: coding
    knowledge: architecture
    instruction: implement
    edit: true
    dynamic_facets:
      pool:
        $param: pool
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    expect(() => loadWorkflowFromFile(customPath, projectDir)).toThrow(
      'requires workflow_call arg "pool" for dynamic_facets.pool',
    );
  });

  it(
    'should complete the English experimental wrapper after reviewer fixes when review requires remediation',
    async () => {
      const language = 'en';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
        projectDir,
      );
      const scenarioWorkflow = loadCoreForWrapper(language, workflow, projectDir);
      const reviewWorkflow = loadReviewForCore(language, scenarioWorkflow, projectDir);
      setMockScenario([
        response(scenarioWorkflow, 'plan', 'planner', 'Requirements are clear and implementation is feasible'),
        response(scenarioWorkflow, 'write_tests', 'coder', 'Test creation is complete'),
        selection(['frontend'], 'Frontend implementation facets are required.'),
        response(scenarioWorkflow, 'implement', 'coder', 'Implementation is complete'),
        selection(['frontend-review'], 'The first review round covers frontend changes.'),
        response(reviewWorkflow, 'coding-review', 'coding-reviewer', 'needs_fix'),
        response(reviewWorkflow, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'needs_fix'),
        response(reviewWorkflow, 'frontend-review', 'frontend-reviewer', 'needs_fix'),
        selection([], 'No additional remediation facets are needed.'),
        response(scenarioWorkflow, 'fix', 'coder', 'Fix is complete'),
        selection(['security-review'], 'The second review round covers security changes.'),
        response(reviewWorkflow, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewWorkflow, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        response(reviewWorkflow, 'security-review', 'security-reviewer', 'approved'),
        response(scenarioWorkflow, 'supervise', 'supervisor', 'approved'),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement and review a frontend security change', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

      const state = await engine.run();

      expect(state.status, JSON.stringify({
        abortReasons,
        currentStep: state.currentStep,
        iteration: state.iteration,
        remainingScenarios: getScenarioQueue()?.remaining,
      })).toBe('completed');
      const resumePoint = engine.getResumePoint();
      const implementSelection = Object.values(resumePoint?.dynamic_facet_selections ?? {})
        .find((snapshot) => snapshot.step_name === 'implement');
      expect(implementSelection).toMatchObject({
        round: 1,
        selected_ids: ['frontend'],
      });
      const reviewSelection = Object.values(resumePoint?.dynamic_parallel_selections ?? {})
        .find((snapshot) => snapshot.step_name === 'review'
          && snapshot.selected_pool_ids.includes('security-review'));
      expect(reviewSelection).toMatchObject({
        round: 1,
        selected_pool_ids: ['security-review'],
        effective_selection_ids: [
          'coding-review',
          'ai-antipattern-review',
          'security-review',
        ],
      });
      expect(findWorkflowStep(reviewWorkflow, 'review').parallel)
        .toMatchObject({ selection: { mode: 'replace' } });

      const reportCalls = reviewReportCalls();
      expect(reportCalls.filter((step) => step.name === 'ai-antipattern-review')).toHaveLength(2);
      expect(reportCalls.filter((step) => step.name === 'coding-review')).toHaveLength(2);
      expect(reportCalls.filter((step) => step.name === 'frontend-review')).toHaveLength(1);
      expect(reportCalls.filter((step) => step.name === 'security-review')).toHaveLength(1);
      expect(reportCalls.some((step) => step.name === 'backend-review')).toBe(false);
      const aiAntipatternReport = reportCalls
        .find((step) => step.name === 'ai-antipattern-review')
        ?.outputContracts.find((contract) => contract.name === 'ai-antipattern-review.md');
      expect(aiAntipatternReport).toBeDefined();
      expect(getScenarioQueue()?.remaining).toBe(0);
    },
    60_000,
  );

  it(
    'should complete the TAKT experimental wrapper when TAKT testing facets and reviewers are selected',
    async () => {
      const language = 'en';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'takt-experimental.yaml'),
        projectDir,
      );
      const scenarioWorkflow = loadCoreForWrapper(language, workflow, projectDir);
      const reviewWorkflow = loadReviewForCore(language, scenarioWorkflow, projectDir);
      const reviewStep = findWorkflowStep(reviewWorkflow, 'review');
      if (reviewStep.parallel === undefined || !isDynamicParallelSubSteps(reviewStep.parallel)) {
        throw new Error('TAKT experimental review must use a dynamic parallel pool');
      }
      expect(reviewStep.parallel.pool.some((step) => step.name === 'testing-review')).toBe(true);
      expect(reviewStep.parallel.pool.some((step) => step.name === 'frontend-review')).toBe(false);
      expect(reviewStep.parallel.pool.some((step) => step.name === 'backend-review')).toBe(false);
      const fixedReviewers = reviewStep.parallel.fixed.filter((step) =>
        step.name === 'coding-review' || step.name === 'ai-antipattern-review',
      );
      expect(fixedReviewers).toHaveLength(2);
      expect(fixedReviewers.every((step) => step.knowledgeContents?.some(({ content }) =>
        content.includes('# TAKT Architecture Knowledge')) === true)).toBe(true);
      const implementStep = findWorkflowStep(scenarioWorkflow, 'implement');
      expect(implementStep.policyContents?.some(({ content }) =>
        content.includes('# TAKT Test Execution Policy'))).toBe(true);
      setMockScenario([
        response(scenarioWorkflow, 'plan', 'planner', 'Requirements are clear and implementation is feasible'),
        response(scenarioWorkflow, 'write_tests', 'coder', 'Test creation is complete'),
        selection(['testing'], 'The implementation changes test boundaries.'),
        response(scenarioWorkflow, 'implement', 'coder', 'Implementation is complete'),
        selection([], 'The fixed reviewers cover the changed test path.'),
        response(reviewWorkflow, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewWorkflow, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        response(scenarioWorkflow, 'supervise', 'supervisor', 'approved'),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement a TAKT testing change', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);

      const state = await engine.run();

      expect(state.status, JSON.stringify({
        currentStep: state.currentStep,
        iteration: state.iteration,
        remainingScenarios: getScenarioQueue()?.remaining,
      })).toBe('completed');
      const resumePoint = engine.getResumePoint();
      const implementSelection = Object.values(resumePoint?.dynamic_facet_selections ?? {})
        .find((snapshot) => snapshot.step_name === 'implement');
      expect(implementSelection).toMatchObject({
        selected_ids: ['testing'],
        selected_policy_refs: ['testing', 'takt-testing'],
        selected_knowledge_refs: ['takt', 'unit-testing', 'e2e-testing'],
      });
      const reviewSelection = Object.values(resumePoint?.dynamic_parallel_selections ?? {})
        .find((snapshot) => snapshot.step_name === 'review');
      expect(reviewSelection).toMatchObject({
        selected_pool_ids: [],
        effective_selection_ids: [
          'coding-review',
          'ai-antipattern-review',
        ],
      });
      const reportCalls = reviewReportCalls();
      const fixedReviewReportCalls = reportCalls.filter((step) =>
        step.name === 'coding-review' || step.name === 'ai-antipattern-review',
      );
      expect(fixedReviewReportCalls.map((step) => step.name).sort()).toEqual([
        'ai-antipattern-review',
        'coding-review',
      ]);
      expect(fixedReviewReportCalls.every((step) => step.knowledgeContents?.some(({ content }) =>
        content.includes('# TAKT Architecture Knowledge')) === true)).toBe(true);
      const implementReportStep = vi.mocked(runReportPhase).mock.calls
        .map(([step]) => step)
        .find((step) => step.name === 'implement');
      expect(implementReportStep?.policyContents?.some(({ content }) =>
        content.includes('# TAKT Test Execution Policy'))).toBe(true);
      expect(getScenarioQueue()?.remaining).toBe(0);
    },
  );

  it(
    'should abort the Japanese experimental wrapper when review findings cannot be remediated',
    async () => {
      const language = 'ja';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const wrapper = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
        projectDir,
      );
      const scenarioWorkflow = loadCoreForWrapper(language, wrapper, projectDir);
      const reviewWorkflow = loadReviewForCore(language, scenarioWorkflow, projectDir);
      setMockScenario([
        response(scenarioWorkflow, 'plan', 'planner', '要件が明確で実装可能'),
        response(scenarioWorkflow, 'write_tests', 'coder', 'テスト作成が完了した'),
        selection(['testing'], 'Testing implementation facets are required.'),
        response(scenarioWorkflow, 'implement', 'coder', '実装が完了した'),
        selection(['testing-review'], 'Testing review is required.'),
        response(reviewWorkflow, 'coding-review', 'coding-reviewer', 'needs_fix'),
        response(reviewWorkflow, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'needs_fix'),
        response(reviewWorkflow, 'testing-review', 'testing-reviewer', 'needs_fix'),
        selection([], 'No additional remediation facets are needed.'),
        response(scenarioWorkflow, 'fix', 'coder', '修正を進行できない'),
      ]);
      const engine = new WorkflowEngine(wrapper, projectDir, 'Implement a change that cannot be remediated', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortReasons).toEqual(['Workflow aborted by step transition']);
      expect(reviewReportCalls().filter((step) => step.name === 'ai-antipattern-review')).toHaveLength(1);
      expect(vi.mocked(runReportPhase).mock.calls.filter(([step]) => step.name === 'fix')).toHaveLength(1);
      expect(getScenarioQueue()?.remaining).toBe(0);
    },
    60_000,
  );
});

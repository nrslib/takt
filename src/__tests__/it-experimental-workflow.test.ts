import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowStep } from '../core/models/index.js';
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

function response(persona: string, ruleIndex: number): ScenarioEntry {
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
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;
  let engines: WorkflowEngine[];

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-experimental-workflow-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-experimental-workflow-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
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
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it(
    'runs fixed reviewers on every English review round and replaces the selected reviewer pool',
    async () => {
      const language = 'en';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
        projectDir,
      );
      workflow.initialStep = 'review';
      setMockScenario([
        selection(['frontend-review'], 'The first review round covers frontend changes.'),
        response('coding-reviewer', 1),
        response('ai-antipattern-reviewer', 1),
        response('frontend-reviewer', 1),
        selection([], 'No additional remediation facets are needed.'),
        response('coder', 0),
        selection(['security-review'], 'The second review round covers security changes.'),
        response('coding-reviewer', 0),
        response('ai-antipattern-reviewer', 0),
        response('security-reviewer', 0),
        response('supervisor', 1),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement and review a frontend security change', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        structuredCaller: new DefaultStructuredCaller(),
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
      expect(state.stepIterations.get('review')).toBe(2);
      expect(state.stepIterations.get('fix')).toBe(1);
      const reviewSelection = [...state.dynamicParallelSelections.values()]
        .find((snapshot) => snapshot.step_name === 'review');
      expect(reviewSelection).toMatchObject({
        round: 2,
        selected_pool_ids: ['security-review'],
        effective_selection_ids: [
          'coding-review',
          'ai-antipattern-review',
          'security-review',
        ],
      });
      expect(workflow.steps.find((step) => step.name === 'review')?.parallel)
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
      expect(existsSync(join(
        projectDir,
        '.takt',
        'runs',
        'test-report-dir',
        'reports',
        'ai-antipattern-review.md',
      ))).toBe(true);
      expect(getScenarioQueue()?.remaining).toBe(0);
    },
    60_000,
  );

  it(
    'routes the Japanese experimental review rejection through fix and aborts when remediation cannot proceed',
    async () => {
      const language = 'ja';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
        projectDir,
      );
      workflow.initialStep = 'review';
      setMockScenario([
        selection(['testing-review'], 'Testing review is required.'),
        response('coding-reviewer', 1),
        response('ai-antipattern-reviewer', 1),
        response('testing-reviewer', 1),
        selection([], 'No additional remediation facets are needed.'),
        response('coder', 3),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement a change that cannot be remediated', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        structuredCaller: new DefaultStructuredCaller(),
      });
      engines.push(engine);
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.stepIterations.get('review'), JSON.stringify({
        abortReasons,
        currentStep: state.currentStep,
        iteration: state.iteration,
        remainingScenarios: getScenarioQueue()?.remaining,
      })).toBe(1);
      expect(state.stepIterations.get('fix')).toBe(1);
      expect(reviewReportCalls().filter((step) => step.name === 'ai-antipattern-review')).toHaveLength(1);
      expect(getScenarioQueue()?.remaining).toBe(0);
    },
    60_000,
  );
});

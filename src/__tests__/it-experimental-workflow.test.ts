import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAllParallelSubSteps,
  type WorkflowConfig,
  type WorkflowStep,
} from '../core/models/index.js';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
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

const SELECTOR_PROVIDER = {
  provider: 'mock' as const,
  providerOptions: {},
  nativeTools: [],
};
const SELECTOR_GIT_COMMAND_RUNNER: SelectorGitCommandRunner = {
  run: async () => ({ output: Buffer.alloc(0), bytes: 0 }),
};
const COMPANION_DIFF_READER: CompanionDiffReader = {
  readBaselineSha: async () => 'test-baseline',
  readDiff: async () => ({
    status: 'ok',
    snapshot: {
      digest: 'empty-diff',
      changedLines: 0,
      content: '',
      changedFiles: [],
      fileFingerprints: {},
      hunkFingerprints: {},
      omittedBytes: 0,
      truncated: false,
    },
  }),
};
const COMPANION_DIFF_READER_WITH_FINDING: CompanionDiffReader = {
  readBaselineSha: async () => 'test-baseline',
  readDiff: async () => ({
    status: 'ok',
    snapshot: {
      digest: 'changed-diff',
      changedLines: 10,
      content: 'diff content',
      changedFiles: ['src/example.ts'],
      fileFingerprints: { 'src/example.ts': 'changed' },
      hunkFingerprints: { 'src/example.ts:1': 'changed' },
      omittedBytes: 0,
      truncated: false,
    },
  }),
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
    throw new Error(`Workflow "${wrapper.name}" step "develop" is not a workflow_call`);
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${delegation.call}.yaml`),
    projectDir,
    { callableArgs: delegation.args },
  );
}

function loadPeerReviewForCore(
  language: 'en' | 'ja',
  core: WorkflowConfig,
  projectDir: string,
): WorkflowConfig {
  const peerReview = findWorkflowStep(core, 'peer-review');
  if (peerReview.kind !== 'workflow_call' || typeof peerReview.call !== 'string') {
    throw new Error(`Workflow "${core.name}" step "peer-review" is not a workflow_call`);
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${peerReview.call}.yaml`),
    projectDir,
    { callableArgs: peerReview.args },
  );
}

function loadImplementationForCore(
  language: 'en' | 'ja',
  core: WorkflowConfig,
  projectDir: string,
): WorkflowConfig {
  const implementation = findWorkflowStep(core, 'implement');
  if (implementation.kind !== 'workflow_call' || typeof implementation.call !== 'string') {
    throw new Error(`Workflow "${core.name}" step "implement" is not a workflow_call`);
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${implementation.call}.yaml`),
    projectDir,
    { callableArgs: implementation.args },
  );
}

function loadRemediationForPeerReview(
  language: 'en' | 'ja',
  peerReview: WorkflowConfig,
  projectDir: string,
): WorkflowConfig {
  const remediation = findWorkflowStep(peerReview, 'remediation');
  if (remediation.kind !== 'workflow_call' || typeof remediation.call !== 'string') {
    throw new Error(`Workflow "${peerReview.name}" step "remediation" is not a workflow_call`);
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${remediation.call}.yaml`),
    projectDir,
    { callableArgs: remediation.args },
  );
}

function loadReviewerSuiteForPeerReview(
  language: 'en' | 'ja',
  peerReview: WorkflowConfig,
  projectDir: string,
): WorkflowConfig {
  const reviewers = findWorkflowStep(peerReview, peerReview.initialStep);
  if (reviewers.kind !== 'workflow_call' || typeof reviewers.call !== 'string') {
    throw new Error(
      `Workflow "${peerReview.name}" step "${peerReview.initialStep}" is not a workflow_call`,
    );
  }
  return loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${reviewers.call}.yaml`),
    projectDir,
    { callableArgs: reviewers.args },
  );
}

interface ReviewerStepReference {
  workflow: WorkflowConfig;
  step: WorkflowStep;
  persona: string;
}

function collectReviewerSteps(
  language: 'en' | 'ja',
  workflow: WorkflowConfig,
  projectDir: string,
): ReviewerStepReference[] {
  const reviewRoot = findWorkflowStep(workflow, workflow.initialStep);
  if (reviewRoot.parallel === undefined) {
    throw new Error(`Review workflow "${workflow.name}" has no parallel reviewers`);
  }

  return getAllParallelSubSteps(reviewRoot.parallel).flatMap((step) => {
    if (step.kind === 'workflow_call' && typeof step.call === 'string') {
      const nestedWorkflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), `${step.call}.yaml`),
        projectDir,
        { callableArgs: step.args },
      );
      return collectReviewerSteps(language, nestedWorkflow, projectDir);
    }
    if (typeof step.persona !== 'string') {
      throw new Error(`Persona not found for reviewer "${step.name}"`);
    }
    return [{ workflow, step, persona: step.persona }];
  });
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

function responseForNext(
  workflow: WorkflowConfig,
  stepName: string,
  nextStep: string,
): ScenarioEntry {
  const step = findWorkflowStep(workflow, stepName);
  const rule = step.rules?.find((candidate) => candidate.next === nextStep);
  const ruleLabel = rule === undefined
    ? undefined
    : semanticRuleCandidatesOf([rule], false)[0]?.label;
  if (ruleLabel === undefined) {
    throw new Error(`Semantic rule not found for transition "${stepName}" -> "${nextStep}"`);
  }
  if (typeof step.persona !== 'string') {
    throw new Error(`Persona not found for step "${stepName}"`);
  }
  return response(workflow, stepName, step.persona, ruleLabel);
}

function responseForReturn(
  workflow: WorkflowConfig,
  stepName: string,
  returnValue: string,
): ScenarioEntry {
  const step = findWorkflowStep(workflow, stepName);
  const rule = step.rules?.find((candidate) => candidate.returnValue === returnValue);
  const ruleLabel = rule === undefined
    ? undefined
    : semanticRuleCandidatesOf([rule], false)[0]?.label;
  if (ruleLabel === undefined) {
    throw new Error(`Semantic rule not found for return "${stepName}" -> "${returnValue}"`);
  }
  if (typeof step.persona !== 'string') {
    throw new Error(`Persona not found for step "${stepName}"`);
  }
  return response(workflow, stepName, step.persona, ruleLabel);
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

function rejectedCompanionFinding(): ScenarioEntry[] {
  return [
    {
      persona: 'ai-antipattern-review-companion',
      status: 'done',
      content: 'review',
      structuredOutput: {
        findings: [{
          severity: 'must_fix',
          file: 'src/example.ts',
          line: 1,
          finding: 'Observed defect',
        }],
        updates: [],
        notes: null,
      },
    },
    {
      persona: 'ai-antipattern-review-moderator',
      status: 'done',
      content: 'moderate',
      structuredOutput: {
        findings: [{
          action: 'reject',
          sourceIndex: 0,
          severity: null,
          finding: null,
          targetId: null,
        }],
        updates: [],
      },
    },
  ];
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

  it(
    'should run adjudication, verified remediation, follow-up review, and the final gate for takt-experimental',
    async () => {
      const language = 'en';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'takt-experimental.yaml'),
        projectDir,
      );
      const core = loadCoreForWrapper(language, workflow, projectDir);
      const implementation = loadImplementationForCore(language, core, projectDir);
      const peerReview = loadPeerReviewForCore(language, core, projectDir);
      const remediation = loadRemediationForPeerReview(language, peerReview, projectDir);
      const reviewerSuite = loadReviewerSuiteForPeerReview(language, peerReview, projectDir);
      setMockScenario([
        responseForNext(core, 'plan', 'write_tests'),
        responseForNext(core, 'write_tests', 'implement'),
        selection(['testing'], 'Testing implementation facets are required.'),
        responseForNext(implementation, 'implement', 'COMPLETE'),
        ...rejectedCompanionFinding(),
        selection(['architecture-review'], 'The first review round covers architecture changes.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'needs_fix'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'needs_fix'),
        response(reviewerSuite, 'architecture-review', 'architecture-reviewer', 'needs_fix'),
        responseForNext(peerReview, 'review-adjudication', 'remediation'),
        responseForNext(remediation, 'fix-plan', 'fix'),
        selection(['testing'], 'Testing remediation facets are required.'),
        responseForNext(remediation, 'fix', 'fix-verifier'),
        ...rejectedCompanionFinding(),
        responseForNext(remediation, 'fix-verifier', 'fix-retry'),
        selection(['testing'], 'Testing remediation facets are required for the retry.'),
        responseForNext(remediation, 'fix-retry', 'fix-verifier'),
        ...rejectedCompanionFinding(),
        responseForNext(remediation, 'fix-verifier', 'COMPLETE'),
        selection(['security-review'], 'The second review round covers security changes.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        response(reviewerSuite, 'security-review', 'security-reviewer', 'approved'),
        responseForNext(peerReview, 'review-adjudication', 'final-gate'),
        responseForNext(peerReview, 'final-gate', 'remediation'),
        responseForNext(remediation, 'fix-plan', 'fix'),
        selection(['security'], 'The final-gate remediation requires security facets.'),
        responseForNext(remediation, 'fix', 'fix-verifier'),
        ...rejectedCompanionFinding(),
        responseForNext(remediation, 'fix-verifier', 'COMPLETE'),
        selection([], 'The fixed reviewers cover the final-gate remediation.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        responseForNext(peerReview, 'review-adjudication', 'final-gate'),
        responseForNext(peerReview, 'final-gate', 'COMPLETE'),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement and review a frontend security change', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        companionProviders: {
          'ai-antipattern-review-companion': { provider: 'mock' },
          'ai-antipattern-review-moderator': { provider: 'mock' },
        },
        companionDiffReader: COMPANION_DIFF_READER_WITH_FINDING,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);
      const abortReasons: string[] = [];
      const companionSteps: string[] = [];
      const companionReviewRounds: string[] = [];
      const companionFindingEvents: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
      engine.on('companion:start', ({ step }) => companionSteps.push(step));
      engine.on('companion:review_round', ({ step }) => companionReviewRounds.push(step));
      engine.on('companion:finding', ({ findingId }) => companionFindingEvents.push(findingId));

      const state = await engine.run();

      expect(state.status, JSON.stringify({
        abortReasons,
        currentStep: state.currentStep,
        iteration: state.iteration,
        remainingScenarios: getScenarioQueue()?.remaining,
        companionSteps,
      })).toBe('completed');
      expect(getScenarioQueue()?.remaining).toBe(0);
      expect(companionSteps).toEqual(['implement', 'fix', 'fix-retry', 'fix']);
      expect(companionReviewRounds).toEqual(companionSteps);
      expect(companionFindingEvents).toEqual([]);
    },
    60_000,
  );

  it(
    'should route implementation, fix, and final-gate replanning through replan',
    async () => {
      const language = 'en';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
        projectDir,
      );
      const core = loadCoreForWrapper(language, workflow, projectDir);
      const implementation = loadImplementationForCore(language, core, projectDir);
      const peerReview = loadPeerReviewForCore(language, core, projectDir);
      const remediation = loadRemediationForPeerReview(language, peerReview, projectDir);
      const reviewerSuite = loadReviewerSuiteForPeerReview(language, peerReview, projectDir);
      setMockScenario([
        responseForNext(core, 'plan', 'write_tests'),
        responseForNext(core, 'write_tests', 'implement'),
        selection(['testing'], 'Testing implementation facets are required.'),
        responseForReturn(implementation, 'implement', 'need_replan'),
        responseForNext(core, 'replan', 'implement'),
        selection(['testing'], 'The replanned implementation still changes test boundaries.'),
        responseForNext(implementation, 'implement', 'COMPLETE'),
        selection([], 'The fixed TAKT reviewers cover the changed path.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'needs_fix'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'needs_fix'),
        responseForNext(peerReview, 'review-adjudication', 'remediation'),
        responseForNext(remediation, 'fix-plan', 'fix'),
        selection(['testing'], 'The fix uses the TAKT testing facets.'),
        responseForReturn(remediation, 'fix', 'need_replan'),
        responseForNext(core, 'replan', 'implement'),
        selection(['testing'], 'The second replanned implementation changes test boundaries.'),
        responseForNext(implementation, 'implement', 'COMPLETE'),
        selection([], 'The fixed TAKT reviewers cover the replanned path.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        responseForNext(peerReview, 'review-adjudication', 'final-gate'),
        responseForReturn(peerReview, 'final-gate', 'need_replan'),
        responseForNext(core, 'replan', 'implement'),
        selection(['testing'], 'The final-gate replan still changes test boundaries.'),
        responseForNext(implementation, 'implement', 'COMPLETE'),
        selection([], 'The fixed reviewers cover the final-gate replan.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        responseForNext(peerReview, 'review-adjudication', 'final-gate'),
        responseForNext(peerReview, 'final-gate', 'COMPLETE'),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement a TAKT change that requires replanning', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        companionProviders: {
          'ai-antipattern-review-companion': { provider: 'mock' },
          'ai-antipattern-review-moderator': { provider: 'mock' },
        },
        companionDiffReader: COMPANION_DIFF_READER,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);
      const visitedSteps: string[] = [];
      engine.on('step:start', (step) => visitedSteps.push(step.name));

      const state = await engine.run();

      expect(state.status, JSON.stringify({
        currentStep: state.currentStep,
        iteration: state.iteration,
        remainingScenarios: getScenarioQueue()?.remaining,
        visitedSteps,
      })).toBe('completed');
      expect(getScenarioQueue()?.remaining).toBe(0);
      expect(visitedSteps.filter((step) => step === 'replan')).toHaveLength(3);
      expect(visitedSteps.filter((step) => step === 'plan')).toHaveLength(1);
    },
    60_000,
  );

  it(
    'should keep the default workflow fixed while rerunning reviewers after verified remediation',
    async () => {
      const language = 'en';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'default.yaml'),
        projectDir,
      );
      const core = loadCoreForWrapper(language, workflow, projectDir);
      const implementation = loadImplementationForCore(language, core, projectDir);
      const peerReview = loadPeerReviewForCore(language, core, projectDir);
      const remediation = loadRemediationForPeerReview(language, peerReview, projectDir);
      const reviewerSuite = loadReviewerSuiteForPeerReview(language, peerReview, projectDir);
      const reviewerSteps = collectReviewerSteps(language, reviewerSuite, projectDir);
      const reviewResponses = (verdict: 'approved' | 'needs_fix'): ScenarioEntry[] =>
        reviewerSteps.map(({ workflow: reviewerWorkflow, step, persona }) =>
          response(reviewerWorkflow, step.name, persona, verdict));
      setMockScenario([
        responseForNext(core, 'plan', 'write_tests'),
        responseForNext(core, 'write_tests', 'implement'),
        responseForNext(implementation, 'implement', 'COMPLETE'),
        ...reviewResponses('needs_fix'),
        responseForNext(peerReview, 'review-adjudication', 'remediation'),
        responseForNext(remediation, 'fix-plan', 'fix'),
        responseForNext(remediation, 'fix', 'fix-verifier'),
        responseForNext(remediation, 'fix-verifier', 'COMPLETE'),
        ...reviewResponses('approved'),
        responseForNext(peerReview, 'review-adjudication', 'final-gate'),
        responseForNext(peerReview, 'final-gate', 'COMPLETE'),
      ]);
      const engine = new WorkflowEngine(workflow, projectDir, 'Implement and review a standard workflow change', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        companionDiffReader: COMPANION_DIFF_READER,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);
      const companionSteps: string[] = [];
      engine.on('companion:start', ({ step }) => companionSteps.push(step));

      const state = await engine.run();

      expect(state.status, JSON.stringify({
        currentStep: state.currentStep,
        iteration: state.iteration,
        remainingScenarios: getScenarioQueue()?.remaining,
      })).toBe('completed');
      expect(getScenarioQueue()?.remaining).toBe(0);
      expect(companionSteps).toEqual([]);
    },
    60_000,
  );

  it(
    'should abort the Japanese experimental wrapper when the final gate is blocked by the environment',
    async () => {
      const language = 'ja';
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`);
      invalidateAllResolvedConfigCache();
      const wrapper = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(language), 'experimental.yaml'),
        projectDir,
      );
      const core = loadCoreForWrapper(language, wrapper, projectDir);
      const implementation = loadImplementationForCore(language, core, projectDir);
      const peerReview = loadPeerReviewForCore(language, core, projectDir);
      const reviewerSuite = loadReviewerSuiteForPeerReview(language, peerReview, projectDir);
      setMockScenario([
        responseForNext(core, 'plan', 'write_tests'),
        responseForNext(core, 'write_tests', 'implement'),
        selection(['testing'], 'Testing implementation facets are required.'),
        responseForNext(implementation, 'implement', 'COMPLETE'),
        ...rejectedCompanionFinding(),
        selection(['testing-review'], 'Testing review is required.'),
        response(reviewerSuite, 'coding-review', 'coding-reviewer', 'approved'),
        response(reviewerSuite, 'ai-antipattern-review', 'ai-antipattern-reviewer', 'approved'),
        response(reviewerSuite, 'testing-review', 'testing-reviewer', 'approved'),
        responseForNext(peerReview, 'review-adjudication', 'final-gate'),
        responseForNext(peerReview, 'final-gate', 'ABORT'),
      ]);
      const engine = new WorkflowEngine(wrapper, projectDir, 'Implement a change that cannot be remediated', {
        projectCwd: projectDir,
        provider: 'mock',
        selectorProvider: SELECTOR_PROVIDER,
        selectorGitCommandRunner: SELECTOR_GIT_COMMAND_RUNNER,
        companionProviders: {
          'ai-antipattern-review-companion': { provider: 'mock' },
          'ai-antipattern-review-moderator': { provider: 'mock' },
        },
        companionDiffReader: COMPANION_DIFF_READER_WITH_FINDING,
        structuredCaller: new DefaultStructuredCaller(),
        workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
          resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
      });
      engines.push(engine);
      const abortReasons: string[] = [];
      const companionSteps: string[] = [];
      const companionReviewRounds: string[] = [];
      const companionFindingEvents: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
      engine.on('companion:start', ({ step }) => companionSteps.push(step));
      engine.on('companion:review_round', ({ step }) => companionReviewRounds.push(step));
      engine.on('companion:finding', ({ findingId }) => companionFindingEvents.push(findingId));

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortReasons).toEqual(['Workflow aborted by step transition']);
      expect(getScenarioQueue()?.remaining).toBe(0);
      expect(companionSteps).toEqual(['implement']);
      expect(companionReviewRounds).toEqual(companionSteps);
      expect(companionFindingEvents).toEqual([]);
    },
    60_000,
  );
});

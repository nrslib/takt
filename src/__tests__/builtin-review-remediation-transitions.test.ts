import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { detectCandidateIndex } from '../shared/utils/ruleIndex.js';
import type { WorkflowConfig, WorkflowRule, WorkflowStep } from '../core/models/index.js';

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockImplementation((step, ctx) => {
    const candidateIndex = detectCandidateIndex(ctx.lastResponse ?? '', step.name);
    const candidate = semanticRuleCandidatesOf(step.rules ?? [], ctx.interactive === true)[candidateIndex];
    if (!candidate) throw new RuleDetectionExhaustedError(step.name);
    return { label: candidate.label, method: 'phase3_tag' };
  }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';

type Language = 'en' | 'ja';
type WorkflowName = 'peer-review' | 'review-remediation';

const CASES: Array<{ language: Language; workflowName: WorkflowName }> = [
  { language: 'en', workflowName: 'peer-review' },
  { language: 'en', workflowName: 'review-remediation' },
  { language: 'ja', workflowName: 'peer-review' },
  { language: 'ja', workflowName: 'review-remediation' },
];

function ruleWithNext(rule: WorkflowRule, next: string): WorkflowRule {
  return { ...rule, next, returnValue: undefined };
}

function isolatedStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    instruction: 'Exercise the builtin remediation transition.',
    outputContracts: undefined,
  };
}

function loadRetryTransitionWorkflow(
  projectDir: string,
  language: Language,
  workflowName: WorkflowName,
): WorkflowConfig {
  const loaded = loadWorkflowFromFile(
    join(getBuiltinWorkflowsDir(language), `${workflowName}.yaml`),
    projectDir,
  );
  const stepsByName = new Map(loaded.steps.map((step) => [step.name, step]));
  const fixPlan = isolatedStep(stepsByName.get('fix-plan')!);
  const fixVerifier = isolatedStep(stepsByName.get('fix-verifier')!);
  const fixRetry = isolatedStep(stepsByName.get('fix-retry')!);

  if (!fixPlan.rules?.[0] || !fixVerifier.rules?.[0]) {
    throw new Error(`${workflowName} must define fix-plan and fix-verifier completion rules`);
  }

  fixPlan.rules = [ruleWithNext(fixPlan.rules[0], 'COMPLETE'), ...fixPlan.rules.slice(1)];
  fixVerifier.rules = [
    ruleWithNext(fixVerifier.rules[0], 'COMPLETE'),
    ...fixVerifier.rules.slice(1),
  ];

  return {
    ...loaded,
    initialStep: 'fix-verifier',
    maxSteps: 6,
    loopMonitors: undefined,
    steps: [fixPlan, fixVerifier, fixRetry],
  };
}

describe('builtin review remediation retry transitions', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-remediation-transition-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-remediation-transition-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    resetScenario();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each(CASES)(
    '$language/$workflowName executes incomplete -> fix-retry -> fix-verifier',
    async ({ language, workflowName }) => {
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');
      invalidateAllResolvedConfigCache();
      const config = loadRetryTransitionWorkflow(projectDir, language, workflowName);

      setMockScenario([
        { persona: 'coding-reviewer', status: 'done', content: '[FIX-VERIFIER:2]\nincomplete' },
        { persona: 'coder', status: 'done', content: '[FIX-RETRY:1]\ncomplete' },
        { persona: 'coding-reviewer', status: 'done', content: '[FIX-VERIFIER:1]\nverified' },
      ]);
      const visited: string[] = [];
      const engine = new WorkflowEngine(config, projectDir, 'Test remediation', {
        projectCwd: projectDir,
        provider: 'mock',
      });
      engine.on('step:start', (step) => visited.push(step.name));

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(visited).toEqual(['fix-verifier', 'fix-retry', 'fix-verifier']);
    },
  );

  it.each(CASES)(
    '$language/$workflowName sends retry plan revision to fix-plan',
    async ({ language, workflowName }) => {
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');
      invalidateAllResolvedConfigCache();
      const config = loadRetryTransitionWorkflow(projectDir, language, workflowName);
      setMockScenario([
        { persona: 'coding-reviewer', status: 'done', content: '[FIX-VERIFIER:2]\nincomplete' },
        { persona: 'coder', status: 'done', content: '[FIX-RETRY:2]\nrevise plan' },
        { persona: 'planner', status: 'done', content: '[FIX-PLAN:2]\nreplan task' },
      ]);
      const visited: string[] = [];
      const engine = new WorkflowEngine(config, projectDir, 'Test remediation', {
        projectCwd: projectDir,
        provider: 'mock',
      });
      engine.on('step:start', (step) => visited.push(step.name));

      const state = await engine.run();

      expect(state.returnValue).toBe('need_replan');
      expect(visited).toEqual(['fix-verifier', 'fix-retry', 'fix-plan']);
    },
  );

  it.each(CASES)(
    '$language/$workflowName returns need_replan directly from fix-retry',
    async ({ language, workflowName }) => {
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf-8');
      invalidateAllResolvedConfigCache();
      const config = loadRetryTransitionWorkflow(projectDir, language, workflowName);
      setMockScenario([
        { persona: 'coding-reviewer', status: 'done', content: '[FIX-VERIFIER:2]\nincomplete' },
        { persona: 'coder', status: 'done', content: '[FIX-RETRY:3]\nreplan task' },
      ]);
      const visited: string[] = [];
      const engine = new WorkflowEngine(config, projectDir, 'Test remediation', {
        projectCwd: projectDir,
        provider: 'mock',
      });
      engine.on('step:start', (step) => visited.push(step.name));

      const state = await engine.run();

      expect(state.returnValue).toBe('need_replan');
      expect(visited).toEqual(['fix-verifier', 'fix-retry']);
    },
  );
});

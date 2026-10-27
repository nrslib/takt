import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowConfig } from '../core/models/index.js';
import { getAllParallelSubSteps } from '../core/models/types.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import { validateWorkflowReportReferences } from '../core/workflow/instruction/report-reference-validation.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { createWorkflowCallResolver, createWorkflowExecutionContext } from '../features/tasks/execute/workflowExecutionContext.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import {
  cleanupWorkflowEngine, createTestTmpDir, makeResponse, makeStep, mockRunAgentSequence,
} from './engine-test-helpers.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const implementations = ['development-implement', 'development-implement-dynamic', 'development-implement-team'];
const remediations = ['development-remediation', 'development-remediation-dynamic', 'development-remediation-team', 'review-remediation'];
const scenarioEntries = ['default', 'takt-default', 'takt-default-team', 'maintenance', 'review-fix'];
const variants = (names: string[]) => (['ja', 'en'] as const).flatMap(language => names.map(name => ({ language, name })));
let directory: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runReportPhase).mockResolvedValue(undefined);
  directory = createTestTmpDir();
});
afterEach(() => {
  if (engine) cleanupWorkflowEngine(engine);
  engine = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function load(language: string, name: string): WorkflowConfig {
  const resourceRoot = resolve(repoRoot, 'builtins', language);
  mkdirSync(resolve(directory, '.takt'), { recursive: true });
  writeFileSync(resolve(directory, '.takt/config.yaml'), `language: ${language}\n`);
  return loadWorkflowFromFile(resolve(resourceRoot, 'workflows', `${name}.yaml`), directory);
}

function resolverFor(config: WorkflowConfig) {
  return createWorkflowCallResolver(createWorkflowExecutionContext(config, directory));
}

function replannerWarnings(config: WorkflowConfig, resolver = resolverFor(config)) {
  return validateWorkflowReportReferences(config, resolver, { projectCwd: directory, lookupCwd: directory })
    .filter(diagnostic => diagnostic.level === 'warning'
      && /step "fix-replan" references /.test(diagnostic.message))
    .map(diagnostic => diagnostic.message);
}

function resolvedRemediations(config: WorkflowConfig): WorkflowConfig[] {
  const resolver = resolverFor(config);
  const found: WorkflowConfig[] = [];
  const visit = (workflow: WorkflowConfig): void => {
    if (remediations.includes(workflow.name)) found.push(workflow);
    const visitStep = (step: WorkflowConfig['steps'][number]): void => {
      if (step.kind === 'workflow_call') {
        const child = resolver({ parentWorkflow: workflow, step, projectCwd: directory, lookupCwd: directory });
        if (!child) throw new Error(`Missing call target ${workflow.name}:${step.name}`);
        visit(child);
      }
      for (const subStep of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) visitStep(subStep);
    };
    workflow.steps.forEach(visitStep);
  };
  visit(config);
  return found;
}

function start(config: WorkflowConfig, initialStep: string, options: Pick<WorkflowEngineOptions, 'interactive' | 'onUserInput'> = {}): void {
  // Keep the shipped graph and return contract; replace agent execution details only.
  engine = new WorkflowEngine({
    ...config,
    initialStep,
    steps: config.steps.map(step => makeStep(step.name, { rules: step.rules })),
  }, directory, 'Complete required work without losing the accepted contract', {
    projectCwd: directory,
    provider: 'mock',
    model: 'mock-model',
    reportDirName: 'reports',
    ...options,
  });
}

async function execute(config: WorkflowConfig, stepName: string, ruleIndex: number) {
  const rule = config.steps.find(step => step.name === stepName)?.rules?.[ruleIndex];
  if (rule?.condition.kind !== 'semantic' || !engine) throw new Error('Missing semantic rule or engine');
  mockRunAgentSequence([makeResponse({ content: 'Recorded current work and remaining evidence.' })]);
  vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: rule.condition.label, method: 'phase3_tag' });
  return engine.runSingleIteration();
}

describe('shipped development completion and remediation routes', () => {
  it.each(variants(implementations))('$language/$name sends executable incompleteness to reimplement once, then hands remaining gaps to planning', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    const pending = await execute(config, 'implement', 2);
    expect(pending.nextStep).toBe('reimplement');
    expect(pending.isComplete).toBe(false);
    expect(pending.returnValue).toBeUndefined();
    const remaining = await execute(config, 'reimplement', 2);
    expect(remaining).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
    expect(remaining.nextStep).toBe('COMPLETE');
    start(config, 'reimplement');
    expect((await execute(config, 'reimplement', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(implementations))('$language/$name returns only an invalid plan to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 3)).returnValue).toBe('need_replan');
    start(config, 'reimplement');
    expect((await execute(config, 'reimplement', 3)).returnValue).toBe('need_replan');
  });

  it.each(variants(implementations))('$language/$name passes an external blocker to planning at either implementation step', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      start(config, stepName);
      const result = await execute(config, stepName, 4);
      expect(result).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
      expect(result.nextStep).toBe('COMPLETE');
    }
  });

  it.each(variants(implementations))('$language/$name collects an available user answer and resumes the same implementation step', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      const implementation = config.steps.find(step => step.name === stepName);
      if (!implementation) throw new Error(`Missing ${stepName} step`);
      expect(determineRuleTransition(implementation, 5)).toMatchObject({ nextStep: stepName, requiresUserInput: true });
      const onUserInput = vi.fn().mockResolvedValueOnce('Use the requested export target.');
      start(config, stepName, { interactive: true, onUserInput });
      const waiting = await execute(config, stepName, 5);
      expect(waiting).toMatchObject({ nextStep: stepName, isComplete: false });
      expect(waiting.returnValue).toBeUndefined();
      expect(onUserInput).toHaveBeenCalledOnce();
      expect((await execute(config, stepName, 0)).nextStep).toBe('COMPLETE');
    }
  });

  it.each(variants(implementations))('$language/$name passes a headless external blocker to planning without requesting input', async ({ language, name }) => {
    const config = load(language, name);
    for (const stepName of ['implement', 'reimplement']) {
      const onUserInput = vi.fn();
      start(config, stepName, { interactive: false, onUserInput });
      const result = await execute(config, stepName, 4);
      expect(result).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
      expect(result.nextStep).toBe('COMPLETE');
      expect(onUserInput).not.toHaveBeenCalled();
    }
  });

  it.each(variants(['development-core']))('$language routes implementation workflow results through the planning handoffs', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'implement');
    expect((await execute(config, 'implement', 0)).nextStep).toBe('peer-review');
    start(config, 'implement');
    expect((await execute(config, 'implement', 1)).nextStep).toBe('replan');
    start(config, 'implement');
    expect((await execute(config, 'implement', 2)).nextStep).toBe('replan');
    start(config, 'replan');
    expect((await execute(config, 'replan', 0)).nextStep).toBe('implement');
    start(config, 'replan');
    expect((await execute(config, 'replan', 1)).nextStep).toBe('peer-review');
    start(config, 'replan');
    expect((await execute(config, 'replan', 2)).nextStep).toBe('ABORT');
  });

  it.each(variants(scenarioEntries))('$language/$name propagates scenario repair replanning through the call chain', ({ language, name }) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const scenario = readFileSync(resolve(resourceRoot, 'facets/partials/instructions/requirement-scenario-maintenance.md'), 'utf8').trim();
    const configs = resolvedRemediations(load(language, name));
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      const step = config.steps.find(candidate => candidate.name === 'fix-replan');
      expect(step?.instructionRef).toContain('scenario-based-fix-replan');
      expect(step?.instruction).toContain(scenario);
      expect(step?.instruction).not.toContain('{{include:');
    }
  });

  it.each(['ja', 'en'] as const)('%s: builtin remediation graphs resolve their report references', (language) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const workflowDirectory = resolve(resourceRoot, 'workflows');
    const workflowFiles = readdirSync(workflowDirectory).filter(file => file.endsWith('.yaml'));
    const invalidReferences: string[] = [];
    for (const file of workflowFiles) {
      const config = load(language, file.slice(0, -'.yaml'.length));
      invalidReferences.push(...replannerWarnings(config).map(message => `${file}: ${message}`));
    }
    expect(invalidReferences).toEqual([]);
  });

  it.each(variants(remediations))('$language/$name detects missing fix-plan and fix-report producers', ({ language, name }) => {
    const config = load(language, name);
    for (const report of ['fix-plan.md', 'fix-report.md']) {
      const withoutProducer = {
        ...config,
        steps: config.steps.map(step => step.kind === 'system' || step.kind === 'workflow_call' ? step : ({
          ...step, outputContracts: step.outputContracts?.filter(contract => contract.name !== report),
        })),
      };
      expect(replannerWarnings(withoutProducer).some(message => message.includes(`{report:${report}}`))).toBe(true);
    }
    expect(config.steps.find(step => step.name === 'fix-verifier')?.outputContracts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fix-verification.md' })]));
  });

  it.each(['ja', 'en'] as const)('%s: detects a missing producer through the builtin call chain', (language) => {
    const config = load(language, 'takt-default');
    const resolver = resolverFor(config);
    for (const report of ['fix-plan.md', 'fix-report.md']) {
      const warnings = replannerWarnings(config, context => {
        const child = resolver(context);
        if (!child || !remediations.includes(child.name)) return child;
        child.steps = child.steps.map(step => step.kind === 'system' || step.kind === 'workflow_call' ? step : ({
          ...step, outputContracts: step.outputContracts?.filter(contract => contract.name !== report),
        }));
        return child;
      });
      expect(warnings.some(message => message.includes(`{report:${report}}`)
        && message.includes('takt-default:develop -> development-core:peer-review -> peer-review:remediation'))).toBe(true);
    }
  });

  it.each(variants(remediations))('$language/$name verifies repair before returning to follow-up review', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    expect((await execute(config, 'fix-plan', 0)).nextStep).toBe('fix');
    expect((await execute(config, 'fix', 0)).nextStep).toBe('fix-verifier');
    const verified = await execute(config, 'fix-verifier', 0);
    expect(verified).toMatchObject({ nextStep: 'COMPLETE', isComplete: true });
  });

  it.each(variants(remediations))('$language/$name can revise a defective repair plan before completion', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix');
    expect((await execute(config, 'fix', 1)).nextStep).toBe('fix-replan');
    expect((await execute(config, 'fix-replan', 0)).nextStep).toBe('fix');
    expect((await execute(config, 'fix', 0)).nextStep).toBe('fix-verifier');
    expect((await execute(config, 'fix-verifier', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(remediations))('$language/$name retries incomplete repairs through the independent verifier', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-verifier');
    expect((await execute(config, 'fix-verifier', 2)).nextStep).toBe('fix-retry');
    expect((await execute(config, 'fix-retry', 0)).nextStep).toBe('fix-verifier');
    expect((await execute(config, 'fix-verifier', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(remediations))('$language/$name replans invalid repair plans before verification', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-verifier');
    expect((await execute(config, 'fix-verifier', 1)).nextStep).toBe('verification-replan');
    expect((await execute(config, 'verification-replan', 0)).nextStep).toBe('fix');
    expect((await execute(config, 'fix', 0)).nextStep).toBe('fix-verifier');
  });

  it.each(variants(remediations))('$language/$name returns a task-wide plan defect to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    expect(await execute(config, 'fix-plan', 1)).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
  });

  it.each(variants(remediations))('$language/$name stops at a confirmed external blocker', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    expect(await execute(config, 'fix-plan', 2)).toMatchObject({ nextStep: 'ABORT', isComplete: true });
  });

  it.each(variants(['peer-review', 'simple-core', 'simple-mini', 'simple',
    'review-fix-frontend', 'review-fix-backend', 'review-fix-dual',
    'review-fix-dual-cqrs', 'review-fix-backend-cqrs']))(
    '$language/$name sends completed remediation to an independent review', ({ language, name }) => {
      const config = load(language, name);
      const remediation = config.steps.find(step => step.name === 'remediation');
      if (!remediation) throw new Error(`Missing remediation in ${name}`);
      const next = determineRuleTransition(remediation, 0)?.nextStep;
      expect(['follow-up-review', 'reviewers']).toContain(next);
      const review = config.steps.find(step => step.name === next);
      expect(review?.kind === 'workflow_call'
        || review?.edit === false
        || (review?.parallel !== undefined && getAllParallelSubSteps(review.parallel).every(part => part.edit === false))).toBe(true);
    },
  );

  it.each(variants(['simple-core', 'simple-mini', 'simple']))(
    '$language/$name keeps the initial review separate from repair evidence and routes remediation to follow-up review',
    ({ language, name }) => {
      const config = load(language, name);
      const initial = config.steps.find(step => step.name === 'review');
      const followUp = config.steps.find(step => step.name === 'follow-up-review');
      if (!initial || !followUp) throw new Error('Missing simple review steps');
      expect(initial.inputReports).toEqual(name === 'simple-mini'
        ? { fromStep: 'remediation', reports: ['review-resolution.md'], optionalIfUnrun: true }
        : undefined);
      expect(followUp.inputReports).toEqual({ fromStep: 'remediation', reports: ['fix-plan.md', 'fix-report.md', 'fix-verification.md'] });
      expect(initial.instruction).not.toContain('--step-remediation--workflow-');
      expect(followUp.instruction).not.toContain('--step-remediation--workflow-');
      expect(determineRuleTransition(config.steps.find(step => step.name === 'remediation')!, 0)?.nextStep)
        .toBe('follow-up-review');
      expect(determineRuleTransition(initial, 1)?.nextStep).toBe('remediation');
      expect(determineRuleTransition(followUp, 1)?.nextStep).toBe('remediation');
    },
  );

  it.each(variants(['review-fix-frontend', 'review-fix-backend', 'review-fix-dual',
    'review-fix-dual-cqrs', 'review-fix-backend-cqrs']))(
    '$language/$name counts the initial review in the monitored repair cycle', ({ language, name }) => {
      const config = load(language, name);
      const byName = (stepName: string) => {
        const step = config.steps.find(candidate => candidate.name === stepName);
        if (!step) throw new Error(`Missing ${stepName}`);
        return step;
      };
      const reviewer = byName('reviewers');
      expect(config.steps.some(step => step.name === 'initial-reviewers')).toBe(false);
      expect(reviewer.inputReports).toEqual({
        fromStep: 'remediation',
        reports: ['fix-plan.md', 'fix-report.md', 'fix-verification.md'],
        optionalIfUnrun: true,
      });
      expect(getAllParallelSubSteps(reviewer.parallel!).some(step => step.instruction?.includes('--step-remediation--workflow-'))).toBe(false);
      expect(determineRuleTransition(byName('gather'), 0)?.nextStep).toBe('reviewers');

      for (const firstDecision of ['approved', 'needs_fix'] as const) {
        const detector = new CycleDetector(config.loopMonitors);
        const route = (stepName: string, ruleIndex: number, expectedNext: string) => {
          const next = determineRuleTransition(byName(stepName), ruleIndex)?.nextStep;
          expect(next).toBe(expectedNext);
          return detector.recordAndCheck(stepName, next!);
        };
        expect(route('gather', 0, 'reviewers').triggered).toBe(false);
        if (firstDecision === 'needs_fix') {
          expect(route('reviewers', 2, 'remediation').triggered).toBe(false);
          expect(route('remediation', 0, 'reviewers').triggered).toBe(false);
        }
        for (let cycle = 1; cycle <= 3; cycle++) {
          expect(route('reviewers', 1, 'final-gate').triggered).toBe(false);
          expect(route('final-gate', 1, 'remediation').triggered).toBe(false);
          expect(route('remediation', 0, 'reviewers').triggered).toBe(cycle === 3);
        }
      }

      const exitDetector = new CycleDetector(config.loopMonitors);
      expect(exitDetector.recordAndCheck('reviewers', 'final-gate').triggered).toBe(false);
      expect(exitDetector.recordAndCheck('final-gate', 'COMPLETE').triggered).toBe(false);

      const noFixDetector = new CycleDetector(config.loopMonitors);
      expect(noFixDetector.recordAndCheck('reviewers', 'remediation').triggered).toBe(false);
      expect(determineRuleTransition(byName('remediation'), 1)?.nextStep).toBe('final-gate');
      expect(noFixDetector.recordAndCheck('remediation', 'final-gate').triggered).toBe(false);
    },
  );

  it.each(variants(['review-fix-frontend', 'review-fix-backend', 'review-fix-dual',
    'review-fix-dual-cqrs', 'review-fix-backend-cqrs', 'simple-core', 'simple', 'simple-mini']))(
    '$language/$name routes no_fix to judgment with the exact adjudication report', ({ language, name }) => {
      const config = load(language, name);
      const remediation = config.steps.find(step => step.name === 'remediation');
      if (!remediation?.rules) throw new Error('Missing remediation call');
      const noFixRule = remediation.rules.findIndex(rule =>
        rule.condition.kind === 'semantic' && rule.condition.label === 'no_fix');
      expect(noFixRule).toBeGreaterThanOrEqual(0);
      const targetName = name === 'simple-mini' ? 'review'
        : name === 'simple' || name === 'simple-core' ? 'supervise' : 'final-gate';
      expect(determineRuleTransition(remediation, noFixRule)?.nextStep).toBe(targetName);
      const target = config.steps.find(step => step.name === targetName);
      expect(target?.inputReports).toEqual({
        fromStep: 'remediation',
        reports: ['review-resolution.md'],
        optionalIfUnrun: true,
      });
      const child = load(language, 'review-remediation');
      expect(child.subworkflow?.returns).toContain('no_fix');
      const adjudication = child.steps.find(step => step.name === 'review-adjudication');
      expect(adjudication?.rules?.[1]?.returnValue).toBe('no_fix');
    },
  );

  it.each(variants(remediations))('$language/$name aborts repeated plan revisions when the monitor selects abort', async ({ language, name }) => {
    const config = load(language, name);
    const fix = config.steps.find(step => step.name === 'fix');
    const replan = config.steps.find(step => step.name === 'fix-replan');
    const monitor = config.loopMonitors?.find(item => item.cycle.length === 1 && item.cycle[0] === 'fix');
    const fixRule = fix?.rules?.[1];
    const replanRule = replan?.rules?.[0];
    const abortRule = monitor?.judge.rules.find(rule => rule.next === 'ABORT');
    if (!monitor || fixRule?.condition.kind !== 'semantic' || replanRule?.condition.kind !== 'semantic'
      || abortRule?.condition.kind !== 'semantic') throw new Error('Missing fix revision or monitor abort rules');
    start(config, 'fix');
    if (!engine) throw new Error('Missing engine');
    const responses = [];
    for (let cycle = 0; cycle < monitor.threshold; cycle++) {
      responses.push(makeResponse({ content: 'Product repair is incomplete and its plan needs revision.' }));
      responses.push(makeResponse({ content: 'Repair plan revised.' }));
      vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: fixRule.condition.label, method: 'phase3_tag' });
      vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: replanRule.condition.label, method: 'phase3_tag' });
    }
    responses.push(makeResponse({ content: 'No feasible path remains.' }));
    vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label: abortRule.condition.label, method: 'phase3_tag' });
    mockRunAgentSequence(responses);
    const result = await engine.run();
    expect(result.status).toBe('aborted');
  });

  it.each(variants(remediations))('$language/$name monitors repeated fix-plan revisions', ({ language, name }) => {
    const config = load(language, name);
    const detector = new CycleDetector(config.loopMonitors);
    for (let count = 1; count <= 4; count++) {
      const fix = config.steps.find(step => step.name === 'fix');
      const replan = config.steps.find(step => step.name === 'fix-replan');
      if (!fix || !replan) throw new Error('Missing repair steps');
      const next = determineRuleTransition(fix, 1)?.nextStep;
      expect(next).toBe('fix-replan');
      if (!next) throw new Error('Missing fix transition');
      expect(detector.recordAndCheck('fix', next).triggered).toBe(false);
      const resumed = determineRuleTransition(replan, 0)?.nextStep;
      if (!resumed) throw new Error('Missing replan transition');
      const result = detector.recordAndCheck('fix-replan', resumed);
      expect(result.triggered).toBe(count === 4);
    }
  });
});

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
      && /step "(?:fix-replan|verification-replan)" references /.test(diagnostic.message))
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

  it.each(variants(scenarioEntries))('$language/$name propagates both scenario replanners through the actual call chain', ({ language, name }) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const scenario = readFileSync(resolve(resourceRoot, 'facets/partials/instructions/requirement-scenario-maintenance.md'), 'utf8').trim();
    const configs = resolvedRemediations(load(language, name));
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      for (const stepName of ['fix-replan', 'verification-replan']) {
        const step = config.steps.find(candidate => candidate.name === stepName);
        expect(step?.instructionRef).toContain(`scenario-based-${stepName}`);
        expect(step?.instruction).toContain(scenario);
        expect(step?.instruction).not.toContain('{{include:');
        expect(step?.instruction?.includes('{report:fix-verification.md}')).toBe(stepName === 'verification-replan');
      }
    }
  });

  it.each(['ja', 'en'] as const)('%s: builtin remediation entry graphs have reachable reports for both replanners', (language) => {
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

  it.each(variants(remediations))('$language/$name places verification evidence inside the report list before shared revisions', ({ language, name }) => {
    const config = load(language, name);
    const instruction = config.steps.find(step => step.name === 'verification-replan')?.instruction;
    if (!instruction) throw new Error('Missing verification replanning instruction');
    const heading = language === 'ja' ? '**見直すこと:**' : '**Revisions to make:**';
    const reports = ['fix-plan.md', 'fix-report.md', 'fix-verification.md'];
    expect(reports.map(report => instruction.indexOf(`{report:${report}}`))).toEqual(
      [...reports.map(report => instruction.indexOf(`{report:${report}}`))].sort((a, b) => a - b),
    );
    expect(instruction.indexOf('{report:fix-verification.md}')).toBeLessThan(instruction.indexOf(heading));
  });

  it.each(variants(remediations))('$language/$name detects removal of every replanning report producer', ({ language, name }) => {
    const config = load(language, name);
    for (const report of ['fix-plan.md', 'fix-report.md', 'fix-verification.md']) {
      const withoutProducer = {
        ...config,
        steps: config.steps.map(step => step.kind === 'system' || step.kind === 'workflow_call' ? step : ({
          ...step, outputContracts: step.outputContracts?.filter(contract => contract.name !== report),
        })),
      };
      expect(replannerWarnings(withoutProducer).some(message => message.includes(`{report:${report}}`))).toBe(true);
    }
  });

  it.each(['ja', 'en'] as const)('%s: detects a removed producer through a resolved builtin call chain', (language) => {
    const config = load(language, 'takt-default');
    const resolver = resolverFor(config);
    for (const report of ['fix-plan.md', 'fix-report.md', 'fix-verification.md']) {
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

  it.each(variants(remediations))('$language/$name executes plan-scoped investigation in fix and preserves the repair path', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    const pending = await execute(config, 'fix-plan', 0);
    expect(pending.nextStep).toBe('fix');
    expect(pending.returnValue).toBeUndefined();
    expect((await execute(config, 'fix', 0)).nextStep).toBe('fix-verifier');
    expect((await execute(config, 'fix-verifier', 0)).nextStep).toBe('COMPLETE');
  });

  it.each(variants(remediations))('$language/$name assigns each plan revision request to its matching replanner', ({ language, name }) => {
    const config = load(language, name);
    for (const [stepName, expectedNext] of [
      ['fix', 'fix-replan'],
      ['fix-verifier', 'verification-replan'],
      ['fix-retry', 'verification-replan'],
    ] as const) {
      const step = config.steps.find(candidate => candidate.name === stepName);
      if (!step) throw new Error(`Missing ${stepName} step in ${language}/${name}`);
      const transition = determineRuleTransition(step, 1);
      if (!transition) throw new Error(`Missing rule 1 for ${stepName} in ${language}/${name}`);
      expect(transition.nextStep).toBe(expectedNext);
    }
  });

  it.each(variants(remediations))('$language/$name returns a task-wide plan defect to its caller', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    expect(await execute(config, 'fix-plan', 1)).toMatchObject({ isComplete: true, returnValue: 'need_replan' });
  });

  it.each(variants(remediations))('$language/$name stops at a confirmed external blocker', async ({ language, name }) => {
    const config = load(language, name);
    start(config, 'fix-plan');
    const result = await execute(config, 'fix-plan', 2);
    expect(result).toMatchObject({ nextStep: 'ABORT', isComplete: true });
    expect(result.returnValue).toBeUndefined();
  });

  const loopCases: {
    label: string;
    route: [string, number][];
    cycle: string[];
    judgeNext: string[];
  }[] = [
    {
      label: 'fix-only replanning', route: [['fix', 1], ['fix-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'verification replanning', route: [['fix', 0], ['fix-verifier', 1], ['verification-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'incomplete verification followed by plan_invalid',
      route: [['fix', 0], ['fix-verifier', 2], ['fix-retry', 0], ['fix-verifier', 1], ['verification-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'retry requesting replanning',
      route: [['fix', 0], ['fix-verifier', 2], ['fix-retry', 1], ['verification-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'alternating replanners',
      route: [['fix', 1], ['fix-replan', 0], ['fix', 0], ['fix-verifier', 1], ['verification-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'two fix replans per verification replan',
      route: [['fix', 1], ['fix-replan', 0], ['fix', 1], ['fix-replan', 0],
        ['fix', 0], ['fix-verifier', 1], ['verification-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'two verification replans per fix replan including retry',
      route: [['fix', 0], ['fix-verifier', 1], ['verification-replan', 0],
        ['fix', 0], ['fix-verifier', 2], ['fix-retry', 1], ['verification-replan', 0],
        ['fix', 1], ['fix-replan', 0]],
      cycle: ['fix'], judgeNext: ['fix', 'fix', 'fix-replan', 'ABORT'],
    },
    {
      label: 'retry verification', route: [['fix-retry', 0], ['fix-verifier', 2]],
      cycle: ['fix-retry', 'fix-verifier'],
      judgeNext: ['fix-retry', 'fix-retry', 'verification-replan', 'ABORT'],
    },
  ];

  describe.each(loopCases)('$label monitoring', ({ route, cycle, judgeNext }) => {
    it.each(variants(remediations))('$language/$name counts four repairs independently of replanning entry and preserves judge routing', ({ language, name }) => {
      const config = load(language, name);
      const detector = new CycleDetector(config.loopMonitors);
      let completedRepairs = 0;
      let triggered = false;
      for (let repetition = 1; repetition <= 8 && !triggered; repetition++) {
        for (const [stepName, ruleIndex] of route) {
          const step = config.steps.find(candidate => candidate.name === stepName);
          if (!step) throw new Error(`Missing ${stepName}`);
          const nextStep = determineRuleTransition(step, ruleIndex)?.nextStep;
          if (!nextStep) throw new Error(`Missing transition ${stepName}:${ruleIndex}`);
          if (stepName === cycle[0]) completedRepairs++;
          const result = detector.recordAndCheck(stepName, nextStep);
          const atThreshold = completedRepairs === 4 && nextStep === cycle[0];
          expect(result.triggered).toBe(atThreshold);
          if (!result.triggered) continue;
          expect(result.monitor?.cycle).toEqual(cycle);
          expect(result.monitor?.threshold).toBe(4);
          expect(result.cycleCount).toBe(4);
          if (cycle.length === 1) expect(['fix-replan', 'verification-replan']).toContain(stepName);
          const judgeStep = makeStep('judge', { rules: result.monitor?.judge.rules });
          expect(judgeNext.map((_, rule) => determineRuleTransition(judgeStep, rule)?.nextStep)).toEqual(judgeNext);
          triggered = true;
          break;
        }
      }
      expect(triggered).toBe(true);
      expect(completedRepairs).toBe(4);
    });
  });

  it.each(variants(remediations))('$language/$name never triggers on initial planning and keeps fix-plan as a history boundary', ({ language, name }) => {
    const config = load(language, name);
    const monitor = config.loopMonitors?.find(candidate => candidate.cycle.length === 1 && candidate.cycle[0] === 'fix');
    if (!monitor) throw new Error('Missing repair monitor');
    expect(monitor.ignoreSteps).not.toContain('fix-plan');
    const detector = new CycleDetector(config.loopMonitors);
    expect(detector.recordAndCheck('fix-plan', 'fix').triggered).toBe(false);
    // Even a history already containing four completed fixes must be cut by fix-plan.
    for (let count = 0; count < 4; count++) {
      expect(detector.recordAndCheck('fix', 'fix-replan').triggered).toBe(false);
    }
    expect(detector.recordAndCheck('fix-plan', 'fix').triggered).toBe(false);
    expect(detector.recordAndCheck('fix', 'fix-replan').triggered).toBe(false);
    expect(detector.recordAndCheck('fix-replan', 'fix').triggered).toBe(false);
  });

  describe.each(['fix-replan', 'verification-replan'])('%s repair boundary', (replanner) => {
    it.each(variants(remediations))('$language/$name applies all four judge decisions at the natural fix transition', async ({ language, name }) => {
      const config = load(language, name);
      const monitor = config.loopMonitors?.find(candidate => candidate.cycle.length === 1 && candidate.cycle[0] === 'fix');
      if (!monitor) throw new Error('Missing repair monitor');
      const route: [string, number][] = replanner === 'fix-replan'
        ? [['fix', 1], ['fix-replan', 0]]
        : [['fix', 0], ['fix-verifier', 2], ['fix-retry', 0], ['fix-verifier', 1], ['verification-replan', 0]];
      for (const [judgeIndex, rule] of monitor.judge.rules.entries()) {
        // The shipped threshold is exercised above. One cycle isolates judge
        // routing within the fixture's ten-step execution budget.
        start({ ...config, loopMonitors: config.loopMonitors?.map(candidate => (
          candidate === monitor ? { ...candidate, threshold: 1 } : candidate
        )) }, 'fix');
        const cycleDetected = vi.fn();
        engine!.on('step:cycle_detected', cycleDetected);
        const aborted = vi.fn();
        engine!.on('workflow:abort', aborted);
        const selections = [...route];
        if (judgeIndex < 2) selections.push(['fix', 0], ['fix-verifier', 0]);
        else if (judgeIndex === 2) selections.push(['fix-replan', 1]);
        const labels = selections.map(([stepName, index]) => {
          const condition = config.steps.find(step => step.name === stepName)?.rules?.[index]?.condition;
          if (condition?.kind !== 'semantic') throw new Error('Expected semantic rule');
          return condition.label;
        });
        if (rule.condition.kind !== 'semantic') throw new Error('Expected semantic judge rule');
        labels.splice(route.length, 0, rule.condition.label);
        mockRunAgentSequence(labels.map(() => makeResponse({
          content: 'Recorded current progress.', structuredOutput: { content: 'Recorded current progress.' },
        })));
        for (const label of labels) vi.mocked(runStatusJudgmentPhase).mockResolvedValueOnce({ label, method: 'phase3_tag' });
        const state = await engine!.run();
        expect(cycleDetected).toHaveBeenCalledOnce();
        expect(cycleDetected.mock.calls[0]?.[0]?.cycle).toEqual(['fix']);
        expect(state.status, JSON.stringify(aborted.mock.calls.map(call => call.slice(1)))).toBe(judgeIndex === 3 ? 'aborted' : 'completed');
        expect(state.currentStep).toBe(judgeIndex < 2 ? 'fix-verifier' : judgeIndex === 2 ? 'fix-replan' : replanner);
        cleanupWorkflowEngine(engine!);
        engine = undefined;
      }
    });
  });

});

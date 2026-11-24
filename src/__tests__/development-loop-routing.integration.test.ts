import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { determineRuleTransition } from '../core/workflow/engine/transitions.js';
import { validateWorkflowReportReferences } from '../core/workflow/instruction/report-reference-validation.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { writePhaseReportFixture } from './helpers/phase-report-fixture.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { createWorkflowCallResolver, createWorkflowExecutionContext } from '../features/tasks/execute/workflowExecutionContext.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';
import {
  cleanupWorkflowEngine, createTestTmpDir, makeResponse, makeStep, mockRunAgentSequence,
} from './engine-test-helpers.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const implementations = ['development-implement', 'development-implement-dynamic', 'development-implement-team'];
const variants = (names: string[]) => (['ja', 'en'] as const).flatMap(language => names.map(name => ({ language, name })));
let directory: string;
let engine: WorkflowEngine | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context, onReportWritten) => {
    for (const report of step.outputContracts ?? []) {
      writePhaseReportFixture(context, report.name, 'Current routing fixture report');
      onReportWritten?.(report.name);
    }
  });
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

function start(config: WorkflowConfig, initialStep: string, options: Pick<WorkflowEngineOptions, 'interactive' | 'onUserInput'> = {}): void {
  // Keep the shipped graph and return contract; replace agent execution details only.
  engine = new WorkflowEngine({
    ...config,
    initialStep,
    steps: config.steps.map(step => makeStep(step.name, { rules: step.rules, outputContracts: step.outputContracts })),
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
  it.each(variants(['development-core', 'simple-core', 'simple']))('$language/$name returns blocked test creation to planning before it resumes', async ({ language, name }) => {
    const config = load(language, name);
    for (const [ruleIndex, nextStep] of [[0, 'implement'], [1, 'implement'], [2, 'plan']] as const) {
      start(config, 'write_tests');
      expect((await execute(config, 'write_tests', ruleIndex)).nextStep).toBe(nextStep);
    }
    expect((await execute(config, 'plan', 0)).nextStep).toBe('write_tests');
    const writeTests = config.steps.find(step => step.name === 'write_tests');
    if (!writeTests) throw new Error('Missing write_tests step');
    expect(determineRuleTransition(writeTests, 3)).toMatchObject({ nextStep: 'write_tests', requiresUserInput: true });
  });

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

  it.each(['ja', 'en'] as const)('%s: passes the caller-supplied fix replan instruction into the resolved remediation workflow', (language) => {
    const resourceRoot = resolve(repoRoot, 'builtins', language);
    const workflowDirectory = resolve(directory, '.takt/workflows');
    const instructionDirectory = resolve(directory, '.takt/facets/instructions');
    mkdirSync(workflowDirectory, { recursive: true });
    mkdirSync(instructionDirectory, { recursive: true });
    writeFileSync(resolve(directory, '.takt/config.yaml'), `language: ${language}\n`);
    const instruction = 'Maintain the requirement scenario while revising the repair plan for this fixture.';
    writeFileSync(resolve(instructionDirectory, 'scenario-replan-fixture.md'), instruction);
    const parentPath = resolve(workflowDirectory, 'parent.yaml');
    writeFileSync(parentPath, `name: parent
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: development-remediation
    args:
      fix_replan_instruction: scenario-replan-fixture
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    const parent = loadWorkflowFromFile(parentPath, directory, { resourceRoot });
    const call = parent.steps.find(step => step.kind === 'workflow_call');
    if (call?.kind !== 'workflow_call') throw new Error('Missing fixture workflow call');
    expect(call.args?.fix_replan_instruction).toBe('scenario-replan-fixture');

    const child = resolverFor(parent)({ parentWorkflow: parent, step: call, projectCwd: directory, lookupCwd: directory });

    expect(child?.steps.map(step => step.instruction)).toEqual(
      expect.arrayContaining([expect.stringContaining(instruction)]),
    );
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
});

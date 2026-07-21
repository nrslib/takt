import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/index.js';

type Locale = 'en' | 'ja';

interface WorkflowStepRaw {
  name: string;
  parallel?: WorkflowStepRaw[];
  rules?: Array<{ condition: string; next?: string }>;
}

interface WorkflowRaw {
  steps: WorkflowStepRaw[];
}

const locales: Locale[] = ['en', 'ja'];
const miniWorkflows = [
  'frontend-mini',
  'backend-mini',
  'backend-cqrs-mini',
  'dual-mini',
  'dual-cqrs-mini',
];
const finalGateWorkflows = [
  'merge-readiness-final-gate',
  'merge-readiness-dual-final-gate',
];

function builtinPath(locale: Locale, ...segments: string[]): string {
  return join(process.cwd(), 'builtins', locale, ...segments);
}

function loadWorkflow(locale: Locale, name: string): WorkflowRaw {
  return parseYaml(readFileSync(builtinPath(locale, 'workflows', `${name}.yaml`), 'utf-8')) as WorkflowRaw;
}

function findStep(workflow: WorkflowRaw, name: string): WorkflowStepRaw {
  const step = workflow.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing step: ${name}`);
  }
  return step;
}

function expectBlockedAbortRoute(step: WorkflowStepRaw): void {
  expect(step.rules?.[0]).toEqual({ condition: 'any("BLOCKED")', next: 'ABORT' });
}

describe.each(locales)('builtin supervise BLOCKED routing (%s)', (locale) => {
  it.each([...miniWorkflows, ...finalGateWorkflows, 'cli'])('%s should pass workflow schema validation', (name) => {
    const workflow = loadWorkflow(locale, name);
    expect(WorkflowConfigRawSchema.safeParse(workflow).success).toBe(true);
  });

  it.each(miniWorkflows)('%s should prioritize BLOCKED over review fix routes', (name) => {
    const reviewers = findStep(loadWorkflow(locale, name), 'reviewers');
    const supervise = reviewers.parallel?.find((step) => step.name === 'supervise');

    expect(supervise?.rules?.map((rule) => rule.condition)).toContain('BLOCKED');
    expectBlockedAbortRoute(reviewers);
  });

  it.each(finalGateWorkflows)('%s should propagate supervisor BLOCKED as ABORT', (name) => {
    const finalGate = findStep(loadWorkflow(locale, name), 'final_gate');
    const supervise = finalGate.parallel?.find((step) => step.name === 'supervise');

    expect(supervise?.rules?.map((rule) => rule.condition)).toContain('BLOCKED');
    expectBlockedAbortRoute(finalGate);
  });

  it('cli should abort instead of returning to plan when supervision is BLOCKED', () => {
    const supervise = findStep(loadWorkflow(locale, 'cli'), 'supervise');
    const blockedRule = supervise.rules?.find((rule) => rule.condition === 'BLOCKED');
    const rejectRuleIndex = supervise.rules?.findIndex((rule) => rule.next === 'plan');

    expect(blockedRule?.next).toBe('ABORT');
    expect(supervise.rules?.indexOf(blockedRule!)).toBeLessThan(rejectRuleIndex!);
  });

  it('should require environment evidence in the shared supervise facets', () => {
    const instruction = readFileSync(builtinPath(locale, 'facets', 'instructions', 'supervise.md'), 'utf-8');
    const outputContract = readFileSync(
      builtinPath(locale, 'facets', 'output-contracts', 'supervisor-validation.md'),
      'utf-8',
    );

    expect(instruction).toContain('BLOCKED');
    expect(instruction).toContain('runtime.prepare');
    expect(outputContract).toMatch(/APPROVE \/ REJECT \/ BLOCKED/);
    expect(outputContract).toContain('runtime.prepare');
  });
});

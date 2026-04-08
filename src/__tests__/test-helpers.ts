/**
 * Shared helpers for unit tests and integration tests.
 *
 * Unlike engine-test-helpers.ts, this file has no mock dependencies and
 * can be safely imported from any test file without requiring vi.mock() setup.
 */

import type { WorkflowStep, WorkflowRule } from '../core/models/types.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';

export function makeRule(condition: string, next: string, extra: Partial<WorkflowRule> = {}): WorkflowRule {
  return { condition, next, ...extra };
}

export function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    personaDisplayName: 'tester',
    instruction: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

export function makeInstructionContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'test task',
    iteration: 1,
    maxSteps: 10,
    stepIteration: 1,
    cwd: '/tmp/test',
    projectCwd: '/tmp/project',
    userInputs: [],
    ...overrides,
  };
}

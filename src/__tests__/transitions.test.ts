/**
 * Tests for workflow transitions module
 */

import { describe, it, expect } from 'vitest';
import { determineNextStepByRules } from '../workflow/transitions.js';
import type { WorkflowStep } from '../models/types.js';

function createStepWithRules(rules: { condition: string; next: string }[]): WorkflowStep {
  return {
    name: 'test-step',
    agent: 'test-agent',
    agentDisplayName: 'Test Agent',
    instructionTemplate: '{task}',
    passPreviousResponse: false,
    rules: rules.map((r) => ({
      condition: r.condition,
      next: r.next,
    })),
  };
}

describe('determineNextStepByRules', () => {
  it('should return next step for valid rule index', () => {
    const step = createStepWithRules([
      { condition: 'Clear', next: 'implement' },
      { condition: 'Blocked', next: 'ABORT' },
    ]);

    expect(determineNextStepByRules(step, 0)).toBe('implement');
    expect(determineNextStepByRules(step, 1)).toBe('ABORT');
  });

  it('should return null for out-of-bounds index', () => {
    const step = createStepWithRules([
      { condition: 'Clear', next: 'implement' },
    ]);

    expect(determineNextStepByRules(step, 1)).toBeNull();
    expect(determineNextStepByRules(step, -1)).toBeNull();
    expect(determineNextStepByRules(step, 100)).toBeNull();
  });

  it('should return null when step has no rules', () => {
    const step: WorkflowStep = {
      name: 'test-step',
      agent: 'test-agent',
      agentDisplayName: 'Test Agent',
      instructionTemplate: '{task}',
      passPreviousResponse: false,
    };

    expect(determineNextStepByRules(step, 0)).toBeNull();
  });

  it('should handle COMPLETE as next step', () => {
    const step = createStepWithRules([
      { condition: 'All passed', next: 'COMPLETE' },
    ]);

    expect(determineNextStepByRules(step, 0)).toBe('COMPLETE');
  });

  it('should return null when rule exists but next is undefined', () => {
    // Parallel sub-step rules may omit `next` (optional field)
    const step: WorkflowStep = {
      name: 'sub-step',
      agent: 'test-agent',
      agentDisplayName: 'Test Agent',
      instructionTemplate: '{task}',
      passPreviousResponse: false,
      rules: [
        { condition: 'approved' },
        { condition: 'needs_fix' },
      ],
    };

    expect(determineNextStepByRules(step, 0)).toBeNull();
    expect(determineNextStepByRules(step, 1)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

function createState(stepOutputs = new Map<string, AgentResponse>()): WorkflowState {
  return {
    workflowName: 'rule-evaluation-integration',
    currentStep: 'reviewers',
    iteration: 1,
    status: 'running',
    stepOutputs,
    lastOutput: undefined,
    stepIterations: new Map(),
    personaSessions: new Map(),
    userInputs: [],
  };
}

function createContext(state: WorkflowState): RuleEvaluatorContext {
  return { state };
}

function createChildStep(name: string): WorkflowStep {
  return {
    name,
    persona: 'reviewer',
    personaDisplayName: name,
    instruction: 'Review',
    passPreviousResponse: false,
    rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
  };
}

describe('rule evaluation integration', () => {
  it('uses the first matching condition across machine, semantic, and aggregate rule types', () => {
    const architecture = createChildStep('architecture');
    const security = createChildStep('security');
    const state = createState(new Map<string, AgentResponse>([
      ['architecture', {
        persona: 'architecture',
        status: 'done',
        content: 'approved',
        timestamp: new Date(),
        matchedRuleIndex: 0,
      }],
      ['security', {
        persona: 'security',
        status: 'done',
        content: 'approved',
        timestamp: new Date(),
        matchedRuleIndex: 0,
      }],
    ]));
    const parent: WorkflowStep = {
      name: 'reviewers',
      persona: 'supervisor',
      personaDisplayName: 'reviewers',
      instruction: 'Route reviewer results',
      passPreviousResponse: false,
      parallel: [architecture, security],
      rules: [
        normalizeRule({ condition: 'when(true)', next: 'wait_before_next_scan' }),
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
        normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' }),
      ],
    };

    const result = new RuleEvaluator(parent, createContext(state))
      .evaluate({ label: 'approved', method: 'phase3_tag' });

    expect(result).toMatchObject({ index: 0 });
  });
});

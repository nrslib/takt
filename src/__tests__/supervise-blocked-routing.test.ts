import { describe, expect, it } from 'vitest';
import type {
  AgentResponse,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { AggregateEvaluator } from '../core/workflow/evaluation/AggregateEvaluator.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { makeRule, makeStep } from './test-helpers.js';

function createReviewers(): WorkflowStep {
  const codeReview = makeStep({
    name: 'code-review',
    rules: [
      makeRule('No review findings', 'COMPLETE'),
      makeRule('Review finding found', 'COMPLETE'),
    ],
  });
  const supervise = makeStep({
    name: 'supervise',
    rules: [
      makeRule('BLOCKED', 'COMPLETE'),
      makeRule('Verification failed', 'COMPLETE'),
    ],
  });

  return makeStep({
    name: 'reviewers',
    parallel: [codeReview, supervise],
    rules: [
      makeRule('any("BLOCKED")', 'ABORT'),
      makeRule('any("Review finding found")', 'review_fix'),
      makeRule('all("No review findings", "Verification failed")', 'supervise_fix'),
    ],
  });
}

function createState(stepOutputs: Map<string, AgentResponse>): WorkflowState {
  return {
    workflowName: 'supervise-blocked',
    currentStep: 'reviewers',
    iteration: 1,
    status: 'running',
    stepOutputs,
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
  };
}

function outputFor(step: WorkflowStep, selection: string): AgentResponse {
  const match = new RuleEvaluator(step, { state: createState(new Map()) }).evaluate({
    label: selection,
    method: 'structured_output',
  });
  if (match === undefined) {
    throw new Error(`No rule matched for ${step.name}: ${selection}`);
  }
  return {
    persona: step.name,
    status: 'done',
    content: selection,
    timestamp: new Date(0),
    matchedRuleIndex: match.index,
    matchedRuleMethod: match.method,
  };
}

function findChild(step: WorkflowStep, name: string): WorkflowStep {
  const child = step.parallel?.find((candidate) => candidate.name === name);
  if (child === undefined) {
    throw new Error(`Missing child step: ${name}`);
  }
  return child;
}

function selectedNext(step: WorkflowStep, state: WorkflowState): string | undefined {
  const match = new RuleEvaluator(step, { state }).evaluate(undefined);
  return match === undefined ? undefined : step.rules?.[match.index]?.next;
}

describe('supervise environment blocker routing', () => {
  it('should prioritize ABORT when BLOCKED and another review finding both match', () => {
    const reviewers = createReviewers();
    const codeReview = findChild(reviewers, 'code-review');
    const supervise = findChild(reviewers, 'supervise');
    const state = createState(new Map([
      [codeReview.name, outputFor(codeReview, 'Review finding found')],
      [supervise.name, outputFor(supervise, 'BLOCKED')],
    ]));
    const aggregate = new AggregateEvaluator(reviewers, state);

    expect(aggregate.evaluateCondition(reviewers.rules![0]!.condition)).toBe(true);
    expect(aggregate.evaluateCondition(reviewers.rules![1]!.condition)).toBe(true);
    expect(selectedNext(reviewers, state)).toBe('ABORT');
  });

  it('should route a normal verification failure to remediation', () => {
    const reviewers = createReviewers();
    const codeReview = findChild(reviewers, 'code-review');
    const supervise = findChild(reviewers, 'supervise');
    const state = createState(new Map([
      [codeReview.name, outputFor(codeReview, 'No review findings')],
      [supervise.name, outputFor(supervise, 'Verification failed')],
    ]));

    expect(selectedNext(reviewers, state)).toBe('supervise_fix');
  });
});

/**
 * Shared helpers for WorkflowEngine integration tests.
 *
 * Provides mock setup, factory functions, and a default workflow config
 * matching the parallel reviewers structure (plan → implement → ai_review → reviewers → supervise).
 */

import { vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkflowConfig, WorkflowStep, AgentResponse, WorkflowRule } from '../models/types.js';

// --- Mock imports (consumers must call vi.mock before importing this) ---

import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../workflow/rule-evaluator.js';
import type { RuleMatch } from '../workflow/rule-evaluator.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../workflow/phase-runner.js';
import { generateReportDir } from '../utils/session.js';

// --- Factory functions ---

export function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    agent: 'test-agent',
    status: 'done',
    content: 'test response',
    timestamp: new Date(),
    sessionId: `session-${randomUUID()}`,
    ...overrides,
  };
}

export function makeRule(condition: string, next: string, extra: Partial<WorkflowRule> = {}): WorkflowRule {
  return { condition, next, ...extra };
}

export function makeStep(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name,
    agent: `../agents/${name}.md`,
    agentDisplayName: name,
    instructionTemplate: `Run ${name}`,
    passPreviousResponse: true,
    ...overrides,
  };
}

/**
 * Build a workflow config matching the default.yaml parallel reviewers structure:
 * plan → implement → ai_review → (ai_fix↔) → reviewers(parallel) → (fix↔) → supervise
 */
export function buildDefaultWorkflowConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  const archReviewSubStep = makeStep('arch-review', {
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
  });

  const securityReviewSubStep = makeStep('security-review', {
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
  });

  return {
    name: 'test-default',
    description: 'Test workflow',
    maxIterations: 30,
    initialStep: 'plan',
    steps: [
      makeStep('plan', {
        rules: [
          makeRule('Requirements are clear', 'implement'),
          makeRule('Requirements unclear', 'ABORT'),
        ],
      }),
      makeStep('implement', {
        rules: [
          makeRule('Implementation complete', 'ai_review'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeStep('ai_review', {
        rules: [
          makeRule('No AI-specific issues', 'reviewers'),
          makeRule('AI-specific issues found', 'ai_fix'),
        ],
      }),
      makeStep('ai_fix', {
        rules: [
          makeRule('AI issues fixed', 'reviewers'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeStep('reviewers', {
        parallel: [archReviewSubStep, securityReviewSubStep],
        rules: [
          makeRule('all("approved")', 'supervise', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'approved',
          }),
          makeRule('any("needs_fix")', 'fix', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'needs_fix',
          }),
        ],
      }),
      makeStep('fix', {
        rules: [
          makeRule('Fix complete', 'reviewers'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeStep('supervise', {
        rules: [
          makeRule('All checks passed', 'COMPLETE'),
          makeRule('Requirements unmet', 'plan'),
        ],
      }),
    ],
    ...overrides,
  };
}

// --- Mock sequence helpers ---

/**
 * Configure runAgent mock to return a sequence of responses.
 */
export function mockRunAgentSequence(responses: AgentResponse[]): void {
  const mock = vi.mocked(runAgent);
  for (const response of responses) {
    mock.mockResolvedValueOnce(response);
  }
}

/**
 * Configure detectMatchedRule mock to return a sequence of rule matches.
 */
export function mockDetectMatchedRuleSequence(matches: (RuleMatch | undefined)[]): void {
  const mock = vi.mocked(detectMatchedRule);
  for (const match of matches) {
    mock.mockResolvedValueOnce(match);
  }
}

// --- Test environment setup ---

/**
 * Create a temporary directory with the required .takt/reports structure.
 * Returns the tmpDir path. Caller is responsible for cleanup.
 */
export function createTestTmpDir(): string {
  const tmpDir = join(tmpdir(), `takt-engine-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, '.takt', 'reports', 'test-report-dir'), { recursive: true });
  return tmpDir;
}

/**
 * Re-apply default mocks for phase-runner and session after vi.resetAllMocks().
 */
export function applyDefaultMocks(): void {
  vi.mocked(needsStatusJudgmentPhase).mockReturnValue(false);
  vi.mocked(runReportPhase).mockResolvedValue(undefined);
  vi.mocked(runStatusJudgmentPhase).mockResolvedValue('');
  vi.mocked(generateReportDir).mockReturnValue('test-report-dir');
}

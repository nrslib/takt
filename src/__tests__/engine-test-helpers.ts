/**
 * Shared helpers for PieceEngine integration tests.
 *
 * Provides mock setup, factory functions, and a default piece config
 * matching the parallel reviewers structure (plan → implement → ai_review → reviewers → supervise).
 */

import { vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PieceConfig, PieceMovement, AgentResponse, PieceRule } from '../core/models/index.js';

// --- Mock imports (consumers must call vi.mock before importing this) ---

import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/piece/index.js';
import type { RuleMatch } from '../core/piece/index.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../core/piece/index.js';
import { generateReportDir } from '../shared/utils/index.js';

// --- Factory functions ---

export function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'test-agent',
    status: 'done',
    content: 'test response',
    timestamp: new Date(),
    sessionId: `session-${randomUUID()}`,
    ...overrides,
  };
}

export function makeRule(condition: string, next: string, extra: Partial<PieceRule> = {}): PieceRule {
  return { condition, next, ...extra };
}

export function makeMovement(name: string, overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name,
    persona: `../personas/${name}.md`,
    personaDisplayName: name,
    instructionTemplate: `Run ${name}`,
    passPreviousResponse: true,
    ...overrides,
  };
}

/**
 * Build a piece config matching the default.yaml parallel reviewers structure:
 * plan → implement → ai_review → (ai_fix↔) → reviewers(parallel) → (fix↔) → supervise
 */
export function buildDefaultPieceConfig(overrides: Partial<PieceConfig> = {}): PieceConfig {
  const archReviewSubMovement = makeMovement('arch-review', {
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
  });

  const securityReviewSubMovement = makeMovement('security-review', {
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
  });

  return {
    name: 'test-default',
    description: 'Test piece',
    maxIterations: 30,
    initialMovement: 'plan',
    movements: [
      makeMovement('plan', {
        rules: [
          makeRule('Requirements are clear', 'implement'),
          makeRule('Requirements unclear', 'ABORT'),
        ],
      }),
      makeMovement('implement', {
        rules: [
          makeRule('Implementation complete', 'ai_review'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeMovement('ai_review', {
        rules: [
          makeRule('No AI-specific issues', 'reviewers'),
          makeRule('AI-specific issues found', 'ai_fix'),
        ],
      }),
      makeMovement('ai_fix', {
        rules: [
          makeRule('AI issues fixed', 'reviewers'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeMovement('reviewers', {
        parallel: [archReviewSubMovement, securityReviewSubMovement],
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
      makeMovement('fix', {
        rules: [
          makeRule('Fix complete', 'reviewers'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeMovement('supervise', {
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
 * Create a temporary directory with the required .takt/runs structure.
 * Returns the tmpDir path. Caller is responsible for cleanup.
 */
export function createTestTmpDir(): string {
  const tmpDir = join(tmpdir(), `takt-engine-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(tmpDir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(tmpDir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(tmpDir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
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

/**
 * Clean up PieceEngine instances to prevent EventEmitter memory leaks.
 * Call this in afterEach to ensure all event listeners are removed.
 */
type ListenerCleanupTarget = {
  removeAllListeners: () => void;
};

function isListenerCleanupTarget(value: unknown): value is ListenerCleanupTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'removeAllListeners' in value &&
    typeof value.removeAllListeners === 'function'
  );
}

export function cleanupPieceEngine(engine: unknown): void {
  if (isListenerCleanupTarget(engine)) {
    engine.removeAllListeners();
  }
}

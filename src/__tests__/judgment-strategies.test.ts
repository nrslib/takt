/**
 * Unit tests for FallbackStrategy judgment strategies
 *
 * Tests AutoSelectStrategy and canApply logic for all strategies.
 * Strategies requiring external agent calls (ReportBased, ResponseBased,
 * AgentConsult) are tested for canApply and input validation only.
 */

import { describe, it, expect } from 'vitest';
import {
  AutoSelectStrategy,
  ReportBasedStrategy,
  ResponseBasedStrategy,
  AgentConsultStrategy,
  JudgmentStrategyFactory,
  type JudgmentContext,
} from '../core/piece/judgment/FallbackStrategy.js';
import type { PieceMovement } from '../core/models/types.js';

function makeMovement(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'test-movement',
    personaDisplayName: 'tester',
    instructionTemplate: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

function makeContext(overrides: Partial<JudgmentContext> = {}): JudgmentContext {
  return {
    step: makeMovement(),
    cwd: '/tmp/test',
    ...overrides,
  };
}

describe('AutoSelectStrategy', () => {
  const strategy = new AutoSelectStrategy();

  it('should have name "AutoSelect"', () => {
    expect(strategy.name).toBe('AutoSelect');
  });

  describe('canApply', () => {
    it('should return true when movement has exactly one rule', () => {
      const ctx = makeContext({
        step: makeMovement({
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }),
      });
      expect(strategy.canApply(ctx)).toBe(true);
    });

    it('should return false when movement has multiple rules', () => {
      const ctx = makeContext({
        step: makeMovement({
          rules: [
            { condition: 'approved', next: 'implement' },
            { condition: 'rejected', next: 'review' },
          ],
        }),
      });
      expect(strategy.canApply(ctx)).toBe(false);
    });

    it('should return false when movement has no rules', () => {
      const ctx = makeContext({
        step: makeMovement({ rules: undefined }),
      });
      expect(strategy.canApply(ctx)).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return auto-selected tag for single-branch movement', async () => {
      const ctx = makeContext({
        step: makeMovement({
          name: 'review',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }),
      });

      const result = await strategy.execute(ctx);
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[REVIEW:1]');
    });
  });
});

describe('ReportBasedStrategy', () => {
  const strategy = new ReportBasedStrategy();

  it('should have name "ReportBased"', () => {
    expect(strategy.name).toBe('ReportBased');
  });

  describe('canApply', () => {
    it('should return true when reportDir and outputContracts are present', () => {
      const ctx = makeContext({
        reportDir: '/tmp/reports',
        step: makeMovement({
          outputContracts: [{ name: 'report.md' }],
        }),
      });
      expect(strategy.canApply(ctx)).toBe(true);
    });

    it('should return false when reportDir is missing', () => {
      const ctx = makeContext({
        step: makeMovement({
          outputContracts: [{ name: 'report.md' }],
        }),
      });
      expect(strategy.canApply(ctx)).toBe(false);
    });

    it('should return false when outputContracts is empty', () => {
      const ctx = makeContext({
        reportDir: '/tmp/reports',
        step: makeMovement({ outputContracts: [] }),
      });
      expect(strategy.canApply(ctx)).toBe(false);
    });

    it('should return false when outputContracts is undefined', () => {
      const ctx = makeContext({
        reportDir: '/tmp/reports',
        step: makeMovement(),
      });
      expect(strategy.canApply(ctx)).toBe(false);
    });
  });
});

describe('ResponseBasedStrategy', () => {
  const strategy = new ResponseBasedStrategy();

  it('should have name "ResponseBased"', () => {
    expect(strategy.name).toBe('ResponseBased');
  });

  describe('canApply', () => {
    it('should return true when lastResponse is non-empty', () => {
      const ctx = makeContext({ lastResponse: 'some response' });
      expect(strategy.canApply(ctx)).toBe(true);
    });

    it('should return false when lastResponse is undefined', () => {
      const ctx = makeContext({ lastResponse: undefined });
      expect(strategy.canApply(ctx)).toBe(false);
    });

    it('should return false when lastResponse is empty string', () => {
      const ctx = makeContext({ lastResponse: '' });
      expect(strategy.canApply(ctx)).toBe(false);
    });
  });
});

describe('AgentConsultStrategy', () => {
  const strategy = new AgentConsultStrategy();

  it('should have name "AgentConsult"', () => {
    expect(strategy.name).toBe('AgentConsult');
  });

  describe('canApply', () => {
    it('should return true when sessionId is non-empty', () => {
      const ctx = makeContext({ sessionId: 'session-123' });
      expect(strategy.canApply(ctx)).toBe(true);
    });

    it('should return false when sessionId is undefined', () => {
      const ctx = makeContext({ sessionId: undefined });
      expect(strategy.canApply(ctx)).toBe(false);
    });

    it('should return false when sessionId is empty string', () => {
      const ctx = makeContext({ sessionId: '' });
      expect(strategy.canApply(ctx)).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return failure when sessionId is not provided', async () => {
      const ctx = makeContext({ sessionId: undefined });
      const result = await strategy.execute(ctx);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('Session ID not provided');
    });
  });
});

describe('JudgmentStrategyFactory', () => {
  it('should create strategies in correct priority order', () => {
    const strategies = JudgmentStrategyFactory.createStrategies();
    expect(strategies).toHaveLength(4);
    expect(strategies[0]!.name).toBe('AutoSelect');
    expect(strategies[1]!.name).toBe('ReportBased');
    expect(strategies[2]!.name).toBe('ResponseBased');
    expect(strategies[3]!.name).toBe('AgentConsult');
  });
});

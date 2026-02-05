/**
 * Test for Fallback Strategies
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PieceMovement } from '../core/models/types.js';
import type { JudgmentContext } from '../core/piece/judgment/FallbackStrategy.js';
import {
  AutoSelectStrategy,
  ReportBasedStrategy,
  ResponseBasedStrategy,
  AgentConsultStrategy,
  JudgmentStrategyFactory,
} from '../core/piece/judgment/FallbackStrategy.js';

// Mock runAgent
vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

describe('JudgmentStrategies', () => {
  const mockStep: PieceMovement = {
    name: 'test-movement',
    agent: 'test-agent',
    rules: [
      { description: 'Rule 1', condition: 'approved' },
      { description: 'Rule 2', condition: 'rejected' },
    ],
  };

  const mockContext: JudgmentContext = {
    step: mockStep,
    cwd: '/test/cwd',
    language: 'en',
    reportDir: '/test/reports',
    lastResponse: 'Last response content',
    sessionId: 'session-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AutoSelectStrategy', () => {
    it('should apply when step has only one rule', () => {
      const singleRuleStep: PieceMovement = {
        name: 'single-rule',
        rules: [{ description: 'Only rule', condition: 'always' }],
      };
      const strategy = new AutoSelectStrategy();
      expect(strategy.canApply({ ...mockContext, step: singleRuleStep })).toBe(true);
    });

    it('should not apply when step has multiple rules', () => {
      const strategy = new AutoSelectStrategy();
      expect(strategy.canApply(mockContext)).toBe(false);
    });

    it('should return auto-selected tag', async () => {
      const singleRuleStep: PieceMovement = {
        name: 'single-rule',
        rules: [{ description: 'Only rule', condition: 'always' }],
      };
      const strategy = new AutoSelectStrategy();
      const result = await strategy.execute({ ...mockContext, step: singleRuleStep });
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[SINGLE-RULE:1]');
    });
  });

  describe('ReportBasedStrategy', () => {
    it('should apply when reportDir and report files are configured', () => {
      const strategy = new ReportBasedStrategy();
      const stepWithReport: PieceMovement = {
        ...mockStep,
        report: 'review-report.md',
      };
      expect(strategy.canApply({ ...mockContext, step: stepWithReport })).toBe(true);
    });

    it('should not apply when reportDir is missing', () => {
      const strategy = new ReportBasedStrategy();
      expect(strategy.canApply({ ...mockContext, reportDir: undefined })).toBe(false);
    });

    it('should not apply when step has no report files configured', () => {
      const strategy = new ReportBasedStrategy();
      // mockStep has no report field → getReportFiles returns []
      expect(strategy.canApply(mockContext)).toBe(false);
    });
  });

  describe('ResponseBasedStrategy', () => {
    it('should apply when lastResponse is provided', () => {
      const strategy = new ResponseBasedStrategy();
      expect(strategy.canApply(mockContext)).toBe(true);
    });

    it('should not apply when lastResponse is missing', () => {
      const strategy = new ResponseBasedStrategy();
      expect(strategy.canApply({ ...mockContext, lastResponse: undefined })).toBe(false);
    });

    it('should not apply when lastResponse is empty', () => {
      const strategy = new ResponseBasedStrategy();
      expect(strategy.canApply({ ...mockContext, lastResponse: '' })).toBe(false);
    });
  });

  describe('AgentConsultStrategy', () => {
    it('should apply when sessionId is provided', () => {
      const strategy = new AgentConsultStrategy();
      expect(strategy.canApply(mockContext)).toBe(true);
    });

    it('should not apply when sessionId is missing', () => {
      const strategy = new AgentConsultStrategy();
      expect(strategy.canApply({ ...mockContext, sessionId: undefined })).toBe(false);
    });

    it('should not apply when sessionId is empty', () => {
      const strategy = new AgentConsultStrategy();
      expect(strategy.canApply({ ...mockContext, sessionId: '' })).toBe(false);
    });
  });

  describe('JudgmentStrategyFactory', () => {
    it('should create strategies in correct order', () => {
      const strategies = JudgmentStrategyFactory.createStrategies();
      expect(strategies).toHaveLength(4);
      expect(strategies[0]).toBeInstanceOf(AutoSelectStrategy);
      expect(strategies[1]).toBeInstanceOf(ReportBasedStrategy);
      expect(strategies[2]).toBeInstanceOf(ResponseBasedStrategy);
      expect(strategies[3]).toBeInstanceOf(AgentConsultStrategy);
    });
  });
});

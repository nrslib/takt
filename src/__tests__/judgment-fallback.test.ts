/**
 * Test for Fallback Strategies
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PieceMovement } from '../core/models/types.js';
import type { JudgmentContext } from '../core/piece/judgment/FallbackStrategy.js';
import { runAgent } from '../agents/runner.js';
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
    persona: 'test-agent',
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
    it('should apply when reportDir and output contracts are configured', () => {
      const strategy = new ReportBasedStrategy();
      const stepWithOutputContracts: PieceMovement = {
        ...mockStep,
        outputContracts: [{ label: 'review', path: 'review-report.md' }],
      };
      expect(strategy.canApply({ ...mockContext, step: stepWithOutputContracts })).toBe(true);
    });

    it('should not apply when reportDir is missing', () => {
      const strategy = new ReportBasedStrategy();
      expect(strategy.canApply({ ...mockContext, reportDir: undefined })).toBe(false);
    });

    it('should not apply when step has no output contracts configured', () => {
      const strategy = new ReportBasedStrategy();
      // mockStep has no outputContracts field → getReportFiles returns []
      expect(strategy.canApply(mockContext)).toBe(false);
    });

    it('should use only latest report file from reports directory', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'takt-judgment-report-'));
      try {
        const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
        const historyDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'logs', 'reports-history');
        mkdirSync(reportDir, { recursive: true });
        mkdirSync(historyDir, { recursive: true });

        const latestFile = '05-architect-review.md';
        writeFileSync(join(reportDir, latestFile), 'LATEST-ONLY-CONTENT');
        writeFileSync(join(historyDir, '05-architect-review.20260210T061143Z.md'), 'OLD-HISTORY-CONTENT');

        const stepWithOutputContracts: PieceMovement = {
          ...mockStep,
          outputContracts: [{ name: latestFile }],
        };

        const runAgentMock = vi.mocked(runAgent);
        runAgentMock.mockResolvedValue({
          persona: 'conductor',
          status: 'done',
          content: '[TEST-MOVEMENT:1]',
          timestamp: new Date('2026-02-10T07:11:43Z'),
        });

        const strategy = new ReportBasedStrategy();
        const result = await strategy.execute({
          ...mockContext,
          step: stepWithOutputContracts,
          reportDir,
        });

        expect(result.success).toBe(true);
        expect(runAgentMock).toHaveBeenCalledTimes(1);
        const instruction = runAgentMock.mock.calls[0]?.[1];
        expect(instruction).toContain('LATEST-ONLY-CONTENT');
        expect(instruction).not.toContain('OLD-HISTORY-CONTENT');
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import {
  evaluateCondition,
  judgeStatus,
  runTagJudgeStage,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type TagJudgeRunOptions,
} from '../agents/judge-status-usecase.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', () => ({
  loadJudgmentSchema: vi.fn(() => ({
    type: 'object',
    required: ['step', 'reason'],
    properties: { step: { type: 'integer' }, reason: { type: 'string' } },
    additionalProperties: false,
  })),
  loadEvaluationSchema: vi.fn(() => ({
    type: 'object',
    required: ['matched_index', 'reason'],
    properties: { matched_index: { type: 'integer' }, reason: { type: 'string' } },
    additionalProperties: false,
  })),
}));

vi.mock('../agents/judge-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/judge-utils.js')>();
  return {
    ...actual,
    buildJudgePrompt: vi.fn(() => 'judge prompt'),
    detectJudgeIndex: vi.fn(() => -1),
  };
});

function doneResponse(content: string, structuredOutput?: Record<string, unknown>) {
  return {
    persona: 'tester',
    status: 'done' as const,
    content,
    timestamp: new Date('2026-02-12T00:00:00Z'),
    structuredOutput,
  };
}

type WithResolved = {
  resolvedProvider?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot' | 'mock';
  resolvedModel?: string;
};

function expectPhase3Isolation(options: unknown): void {
  expect(options).toEqual(expect.objectContaining({ allowedTools: [] }));
  expect(options).not.toHaveProperty('mcpServers');
  expect(options).not.toHaveProperty('mcpAssignment');
  expect(options).not.toHaveProperty('mcpServerIdentity');
}

describe('judge runAgent provider/model resolution (#556)', () => {
  const judgeBase: JudgeStatusOptions & WithResolved = {
    cwd: '/repo',
    stepName: 'review',
    provider: 'codex',
    resolvedProvider: 'codex',
    resolvedModel: 'gpt-5.2-codex',
    mcpServers: { review: { command: 'review-mcp' } },
    mcpAssignment: {
      servers: { review: { command: 'review-mcp' } },
      defaults: { servers: ['review'] },
    },
    mcpServerIdentity: 'review-mcp-identity',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('evaluateCondition', () => {
    it('Given resolvedProvider and resolvedModel When evaluateCondition runs Then runAgent receives them on RunAgentOptions', async () => {
      vi.mocked(runAgent).mockResolvedValue(doneResponse('x', { matched_index: 1, reason: 'first condition' }));

      const opts: EvaluateConditionOptions & WithResolved = {
        cwd: '/repo',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
        mcpServers: { review: { command: 'review-mcp' } },
        mcpAssignment: {
          servers: { review: { command: 'review-mcp' } },
          defaults: { servers: ['review'] },
        },
        mcpServerIdentity: 'review-mcp-identity',
      };
      await evaluateCondition('agent output', [{ index: 0, text: 'a' }], opts);

      expect(runAgent).toHaveBeenCalledWith(
        undefined,
        'judge prompt',
        expect.objectContaining({
          cwd: '/repo',
          resolvedExecution: expect.objectContaining({
            provider: 'codex',
            model: 'gpt-5.2-codex',
          }),
        }),
      );
      expectPhase3Isolation(vi.mocked(runAgent).mock.calls[0]?.[2]);
    });
  });

  describe('runTagJudgeStage', () => {
    it('Given resolvedProvider and resolvedModel When tag stage runs Then runAgent receives them', async () => {
      vi.mocked(runAgent).mockResolvedValue(doneResponse('', { content: '[REVIEW:1]' }));

      const runOpts: TagJudgeRunOptions & WithResolved = {
        cwd: '/repo',
        stepName: 'review',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
        mcpServers: { review: { command: 'review-mcp' } },
        mcpAssignment: {
          servers: { review: { command: 'review-mcp' } },
          defaults: { servers: ['review'] },
        },
        mcpServerIdentity: 'review-mcp-identity',
      };
      await runTagJudgeStage(
        'tag instruction',
        [{ label: 'done' }],
        runOpts,
      );

      expect(runAgent).toHaveBeenCalledWith(
        'conductor',
        'tag instruction',
        expect.objectContaining({
          cwd: '/repo',
          resolvedExecution: expect.objectContaining({
            provider: 'codex',
            model: 'gpt-5.2-codex',
          }),
        }),
      );
      expectPhase3Isolation(vi.mocked(runAgent).mock.calls[0]?.[2]);
    });
  });

  describe('judgeStatus', () => {
    it('Given resolvedProvider and resolvedModel When all three stages invoke runAgent Then each call includes them', async () => {
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no structured step'));
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('', { content: 'no tag' }));
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('ignored', { matched_index: 2, reason: 'second condition' }));

      await judgeStatus('structured', 'tag', [
        { label: 'a' },
        { label: 'b' },
      ], judgeBase);

      expect(runAgent).toHaveBeenCalledTimes(3);
      expect(runAgent).toHaveBeenNthCalledWith(
        1,
        'conductor',
        'structured',
        expect.objectContaining({
          resolvedExecution: expect.objectContaining({
            provider: 'codex',
            model: 'gpt-5.2-codex',
          }),
        }),
      );
      expect(runAgent).toHaveBeenNthCalledWith(
        2,
        'conductor',
        'tag',
        expect.objectContaining({
          resolvedExecution: expect.objectContaining({
            provider: 'codex',
            model: 'gpt-5.2-codex',
          }),
        }),
      );
      expect(runAgent).toHaveBeenNthCalledWith(
        3,
        undefined,
        'judge prompt',
        expect.objectContaining({
          resolvedExecution: expect.objectContaining({
            provider: 'codex',
            model: 'gpt-5.2-codex',
          }),
        }),
      );
      for (const call of vi.mocked(runAgent).mock.calls) {
        expectPhase3Isolation(call[2]);
      }
    });

    it('keeps the explicit no-tools boundary when the provider profile declares tools', async () => {
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('no structured step'));
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse('', { content: 'no tag' }));
      vi.mocked(runAgent).mockResolvedValueOnce(doneResponse(
        'ignored',
        { matched_index: 2, reason: 'second condition' },
      ));

      await judgeStatus('structured', 'tag', [
        { label: 'a' },
        { label: 'b' },
      ], {
        cwd: '/repo',
        stepName: 'review',
        resolvedProvider: 'claude',
        resolvedProviderOptions: { claude: { allowedTools: ['Read'] } },
      });

      for (const call of vi.mocked(runAgent).mock.calls) {
        expectPhase3Isolation(call[2]);
      }
    });
  });
});

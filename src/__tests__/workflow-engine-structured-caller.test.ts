import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn((provider: string) => ({
    supportsStructuredOutput: provider === 'claude',
  })),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(undefined),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { runAgent } from '../agents/runner.js';
import { makeRule, makeStep } from './test-helpers.js';

function createTestTmpDir(): string {
  const dir = join(tmpdir(), `takt-engine-structured-${randomUUID()}`);
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  return dir;
}

describe('WorkflowEngine structured caller defaults', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTestTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('step provider override が非対応 provider のとき judge に outputSchema を渡さない', async () => {
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_persona, instruction, options) => {
        options?.onPromptResolved?.({
          systemPrompt: 'system',
          userInstruction: instruction,
        });
        return {
          persona: 'reviewer',
          status: 'done',
          content: 'Needs AI judge',
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        };
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '[JUDGE:1]',
        timestamp: new Date('2026-04-01T00:00:01.000Z'),
      });

    const config: WorkflowConfig = {
      name: 'structured-caller-test',
      maxSteps: 3,
      initialStep: 'review',
      steps: [
        makeStep({
          name: 'review',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          provider: 'cursor',
          instruction: 'Review the response',
          rules: [
            makeRule('approved', 'COMPLETE', {
              isAiCondition: true,
              aiConditionText: 'is it approved?',
            }),
          ],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'claude',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
    });

    const result = await engine.run();

    expect(result.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    const [, prompt, judgeOptions] = vi.mocked(runAgent).mock.calls[1] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(judgeOptions).toEqual(expect.objectContaining({
      cwd,
      provider: 'cursor',
      resolvedProvider: 'cursor',
    }));
    expect(judgeOptions).not.toHaveProperty('outputSchema');
  });

  it('system step の ai() rule でも resolved cursor を使って prompt-based judge に切り替える', async () => {
    vi.mocked(runAgent).mockImplementationOnce(async (_persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: 'system',
        userInstruction: instruction,
      });
      return {
        persona: 'conductor',
        status: 'done',
        content: '[JUDGE:1]',
        timestamp: new Date('2026-04-01T00:00:02.000Z'),
      };
    });

    const config: WorkflowConfig = {
      name: 'system-structured-caller-test',
      maxSteps: 2,
      initialStep: 'route',
      steps: [
        makeStep({
          name: 'route',
          mode: 'system',
          persona: undefined,
          instruction: '',
          rules: [
            makeRule('approved', 'COMPLETE', {
              isAiCondition: true,
              aiConditionText: 'is this workflow ready to complete?',
            }),
            makeRule('fallback', 'ABORT', {
              condition: 'true',
            }),
          ],
        }),
      ],
    };

    const engine = new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      provider: 'cursor',
      model: 'cursor-fast',
      reportDirName: 'test-report-dir',
      detectRuleIndex: () => -1,
    });

    const result = await engine.run();

    expect(result.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    const [, prompt, judgeOptions] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(judgeOptions).toEqual(expect.objectContaining({
      cwd,
      resolvedProvider: 'cursor',
      resolvedModel: 'cursor-fast',
    }));
    expect(judgeOptions).not.toHaveProperty('outputSchema');
  });
});

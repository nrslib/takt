import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunAgent } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: mockRunAgent,
}));

import { PromptBasedStructuredCaller } from '../agents/structured-caller.js';
import { resolveStructuredStep } from '../agents/structured-caller/shared.js';

describe('PromptBasedStructuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should evaluate conditions from [JUDGE:N] tags without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:6]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.evaluateCondition(
      'agent output',
      [
        { index: 2, text: 'approved' },
        { index: 5, text: 'needs_fix' },
      ],
      { cwd: '/tmp/project', provider: 'cursor' },
    );

    expect(result).toBe(5);
    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Output ONLY the tag `[JUDGE:N]`'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
      }),
    );
  });

  it('should pass resolvedProvider and resolvedModel through evaluateCondition to runAgent (#556)', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    await caller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      {
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      },
    );

    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('[JUDGE:N]'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should parse decomposed parts from fenced JSON without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify([
          { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
          { id: 'p2', title: 'Second task', instruction: 'Do the second thing' },
        ]),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.decomposeTask('break down the work', 3, {
      cwd: '/tmp/project',
      provider: 'cursor',
      model: 'cursor-fast',
      persona: 'team-leader',
      personaPath: '/tmp/personas/team-leader.md',
    });

    expect(result).toEqual([
      { id: 'p1', title: 'First task', instruction: 'Do the first thing' },
      { id: 'p2', title: 'Second task', instruction: 'Do the second thing' },
    ]);
    expect(mockRunAgent).toHaveBeenCalledWith(
      'team-leader',
      expect.stringContaining('```json'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
        model: 'cursor-fast',
        personaPath: '/tmp/personas/team-leader.md',
        maxTurns: 5,
      }),
    );
    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should parse additional parts from fenced JSON without outputSchema', async () => {
    mockRunAgent.mockResolvedValue({
      persona: 'leader',
      status: 'done',
      content: [
        '```json',
        JSON.stringify({
          done: false,
          reasoning: 'Need one more pass',
          parts: [
            { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
          ],
        }),
        '```',
      ].join('\n'),
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.requestMoreParts(
      'original task',
      [{ id: 'p1', title: 'First', status: 'done', content: 'done' }],
      ['p1'],
      2,
      { cwd: '/tmp/project', provider: 'cursor' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'Need one more pass',
      parts: [
        { id: 'p2', title: 'Follow up', instruction: 'Handle remaining gap' },
      ],
    });
    expect(mockRunAgent).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('```json ... ```'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'cursor',
      }),
    );
  });

  it('should return auto_select without calling agent when only one rule exists', async () => {
    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [{ condition: 'approved', next: 'done' }],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'auto_select' });
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('should return structured_output when Stage 1 JSON step is valid', async () => {
    mockRunAgent.mockResolvedValueOnce({
      persona: 'conductor',
      status: 'done',
      content: '```json\n{"step": 2}\n```',
      timestamp: new Date(),
    });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      {
        cwd: '/tmp/project',
        stepName: 'review',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      },
    );

    expect(result).toEqual({ ruleIndex: 1, method: 'structured_output' });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenNthCalledWith(
      1,
      'conductor',
      expect.stringContaining('structured instruction'),
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'claude',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should return phase3_tag when Stage 1 fails and Stage 2 tag matches', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '[REVIEW:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'phase3_tag' });
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('should return ai_judge when Stage 1 and Stage 2 fail and evaluateCondition succeeds', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    );

    expect(result).toEqual({ ruleIndex: 1, method: 'ai_judge' });
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it('should exclude interactiveOnly rules from Stage 3 conditions when interactive is false', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:1]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'interactive-only-rule', next: 'blocked', interactiveOnly: true },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor', interactive: false },
    );

    // interactiveOnly rule (index 1) is excluded; only index 0 is passed to evaluateCondition
    // [JUDGE:1] → 0-based index 0, which maps to original index 0
    expect(result).toEqual({ ruleIndex: 0, method: 'ai_judge' });
    const [, judgePrompt] = mockRunAgent.mock.calls[2] ?? [];
    expect(judgePrompt).not.toContain('interactive-only-rule');
  });

  it('should include interactiveOnly rules in Stage 3 conditions when interactive is true', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no json block here',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no matching tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: '[JUDGE:2]',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();
    const result = await caller.judgeStatus(
      'structured instruction',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'interactive-only-rule', next: 'blocked', interactiveOnly: true },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor', interactive: true },
    );

    // interactiveOnly rule (index 1) is included; [JUDGE:2] → 0-based index 1, which maps to original index 1
    expect(result).toEqual({ ruleIndex: 1, method: 'ai_judge' });
    const [, judgePrompt] = mockRunAgent.mock.calls[2] ?? [];
    expect(judgePrompt).toContain('interactive-only-rule');
  });

  it('should surface JSON parse failures when no fallback can determine status', async () => {
    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '```json\n{"step": }\n```',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'no judge tag',
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'default',
        status: 'done',
        content: 'no judge tag',
        timestamp: new Date(),
      });

    const caller = new PromptBasedStructuredCaller();

    await expect(caller.judgeStatus(
      'structured',
      'tag instruction',
      [
        { condition: 'approved', next: 'done' },
        { condition: 'rejected', next: 'failed' },
      ],
      { cwd: '/tmp/project', stepName: 'review', provider: 'cursor' },
    )).rejects.toThrow('Structured response parsing failed');
  });
});

describe('resolveStructuredStep', () => {
  it('should convert 1-indexed step to 0-based rule index', () => {
    expect(resolveStructuredStep({ step: 1 })).toBe(0);
    expect(resolveStructuredStep({ step: 2 })).toBe(1);
  });

  it('should return -1 for step 0 (1-indexed, so 0 is invalid)', () => {
    expect(resolveStructuredStep({ step: 0 })).toBe(-1);
  });

  it('should return -1 for non-object values', () => {
    expect(resolveStructuredStep('foo')).toBe(-1);
    expect(resolveStructuredStep(42)).toBe(-1);
    expect(resolveStructuredStep(null)).toBe(-1);
    expect(resolveStructuredStep([])).toBe(-1);
  });

  it('should return -1 when step property is not a number', () => {
    expect(resolveStructuredStep({ step: 'two' })).toBe(-1);
    expect(resolveStructuredStep({ step: null })).toBe(-1);
  });
});

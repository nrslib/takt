import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeStructuredAgent } from '../agents/structured-caller/transport.js';
import { CompanionStructuredCaller } from '../core/workflow/companion/structured-call.js';

vi.mock('../agents/structured-caller/transport.js', () => ({
  executeStructuredAgent: vi.fn(),
}));

describe('CompanionStructuredCaller', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('deadline-scoped stream and activity callbacks reach the structured provider call', async () => {
    vi.mocked(executeStructuredAgent).mockResolvedValue({
      persona: 'security-reviewer',
      status: 'done',
      content: 'reviewed',
      timestamp: new Date('2026-08-14T00:00:00.000Z'),
      structuredOutput: { findings: [], updates: [] },
    });
    const onStream = vi.fn();
    const onActivity = vi.fn();
    const caller = new CompanionStructuredCaller({
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      onStream,
      onActivity,
      recordUsage: vi.fn(),
      recordCall: vi.fn(),
    });

    await caller.call({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      provider: { provider: 'mock' },
      systemPrompt: 'review system',
      prompt: 'review prompt',
      outputSchema: { type: 'object' },
    });

    expect(executeStructuredAgent).toHaveBeenCalledWith(
      'review prompt',
      { type: 'object' },
      expect.objectContaining({ onStream, onActivity }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import { runCompanionFixLoop } from '../core/workflow/companion/fix-loop.js';

function finding(id: string, text: string) {
  return { id, severity: 'must_fix' as const, file: 'src/a.ts', line: 1, finding: text };
}

function response(content: string, sessionId: string): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content,
    sessionId,
    timestamp: new Date('2026-08-08T00:00:00.000Z'),
  };
}

function terminalResponse(status: 'error' | 'blocked' | 'rate_limited'): AgentResponse {
  return {
    ...response(`fix ${status}`, 'session-terminal'),
    status,
    error: status === 'error' ? 'provider failed' : undefined,
  };
}

function phase1Options() {
  return {
    permissionMode: 'edit' as const,
    allowedTools: ['Read', 'Edit', 'Bash'],
    mcpServers: { test: { command: 'test-mcp' } },
    onStream: vi.fn(),
    provider: 'mock' as const,
    model: 'mock-model',
  };
}

describe('CT-COMP-08 same-session companion fix loop', () => {
  it('should fix only open must_fix findings with sequence 2+ while retaining original Phase 1 output', async () => {
    const original = response('original phase 1 result', 'session-1');
    const fixed = response('fixed the finding', 'session-2');
    const options = phase1Options();
    const completeReview = vi.fn()
      .mockResolvedValueOnce({
        openMustFix: [finding('security-reviewer-1', 'unsafe write')],
        escalated: false,
      })
      .mockResolvedValueOnce({ openMustFix: [], escalated: false });
    const executeFix = vi.fn().mockResolvedValue(fixed);

    const result = await runCompanionFixLoop({
      initialResponse: original,
      phase1Options: options,
      completeReview,
      executeFix,
    });

    expect(executeFix).toHaveBeenCalledOnce();
    expect(executeFix).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 2,
      phase: 1,
      sessionId: 'session-1',
      options: expect.objectContaining({
        permissionMode: 'edit',
        allowedTools: ['Read', 'Edit', 'Bash'],
        mcpServers: options.mcpServers,
        onStream: options.onStream,
        provider: 'mock',
        model: 'mock-model',
      }),
      instruction: expect.stringContaining('security-reviewer-1'),
    }));
    const instruction = executeFix.mock.calls[0]?.[0].instruction;
    expect(instruction).toContain('"severity":"must_fix"');
    expect(instruction).toContain('"file":"src/a.ts"');
    expect(instruction).toContain('"line":1');
    expect(instruction).not.toContain('- security-reviewer-1:');
    expect(result.phaseResponse).toBe(original);
    expect(result.latestSessionId).toBe('session-2');
    expect(result.fixRounds).toBe(1);
    expect(completeReview.mock.calls).toEqual([
      [{ implementerResponse: 'original phase 1 result', afterFix: false }],
      [{ implementerResponse: 'fixed the finding', afterFix: true, fixRound: 1 }],
    ]);
  });

  it('should proceed without another implementer call when no must_fix is open', async () => {
    const executeFix = vi.fn();

    const result = await runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: phase1Options(),
      completeReview: vi.fn().mockResolvedValue({ openMustFix: [], escalated: false }),
      executeFix,
    });

    expect(executeFix).not.toHaveBeenCalled();
    expect(result.fixRounds).toBe(0);
  });

  it('should keep running until implementer stopped, final review completed, and must_fix reached zero', async () => {
    const completeReview = vi.fn()
      .mockResolvedValueOnce({ openMustFix: [finding('security-reviewer-1', 'a')], escalated: false })
      .mockResolvedValueOnce({ openMustFix: [finding('security-reviewer-2', 'b')], escalated: false })
      .mockResolvedValueOnce({ openMustFix: [], escalated: false });
    const executeFix = vi.fn()
      .mockResolvedValueOnce(response('fix a', 'session-2'))
      .mockResolvedValueOnce(response('fix b', 'session-3'));

    const result = await runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: phase1Options(),
      completeReview,
      executeFix,
    });

    expect(completeReview).toHaveBeenCalledTimes(3);
    expect(executeFix.mock.calls.map(([attempt]) => attempt.sequence)).toEqual([2, 3]);
    expect(result.latestSessionId).toBe('session-3');
  });

  it.each(['error', 'blocked', 'rate_limited'] as const)(
    'should return a %s fix response as the terminal phase response',
    async (status) => {
      const executeFix = vi.fn().mockResolvedValue(terminalResponse(status));

      const result = await runCompanionFixLoop({
        initialResponse: response('done', 'session-1'),
        phase1Options: phase1Options(),
        completeReview: vi.fn().mockResolvedValue({
          openMustFix: [finding('security-reviewer-1', 'a')],
          escalated: false,
        }),
        executeFix,
      });

      expect(result.phaseResponse.status).toBe(status);
      expect(result.fixRounds).toBe(1);
    },
  );

  it('should not claim a successful post-fix completion for a non-done fix response', async () => {
    const completeReview = vi.fn().mockResolvedValue({
      openMustFix: [finding('security-reviewer-1', 'a')],
      escalated: false,
    });
    const result = await runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: phase1Options(),
      completeReview,
      executeFix: vi.fn().mockResolvedValue(terminalResponse('blocked')),
    });

    expect(result.fixRounds).toBe(1);
    expect(completeReview).toHaveBeenCalledOnce();
    expect(completeReview).toHaveBeenCalledWith({
      implementerResponse: 'done',
      afterFix: false,
    });
  });
});

describe('CT-COMP-10 fail-soft and abort lifecycle', () => {
  it('should not synthesize a successful terminal response when completion fails', async () => {
    const failure = new Error('review provider crashed');

    await expect(runCompanionFixLoop({
      initialResponse: response('implementation succeeded', 'session-1'),
      phase1Options: phase1Options(),
      completeReview: vi.fn().mockRejectedValue(failure),
      executeFix: vi.fn(),
    })).rejects.toBe(failure);
  });

  it('should stop completion and fix work when the main abort signal fires', async () => {
    const controller = new AbortController();
    const executeFix = vi.fn();
    const completeReview = vi.fn(async () => {
      controller.abort();
      return { openMustFix: [finding('security-reviewer-1', 'a')], escalated: false };
    });

    await expect(runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: phase1Options(),
      completeReview,
      executeFix,
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeFix).not.toHaveBeenCalled();
  });

  it('should use the completion trigger even when no live tool event was observed', async () => {
    const completeReview = vi.fn().mockResolvedValue({ openMustFix: [], escalated: false });

    await runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: phase1Options(),
      completeReview,
      executeFix: vi.fn(),
    });

    expect(completeReview).toHaveBeenCalledOnce();
  });
});

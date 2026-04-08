/**
 * Unit tests for blocked-handler
 *
 * Tests blocked state handling including user input callback flow.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleBlocked } from '../core/workflow/engine/blocked-handler.js';
import type { AgentResponse } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { makeStep } from './test-helpers.js';

function makeResponse(content: string): AgentResponse {
  return {
    persona: 'tester',
    status: 'blocked',
    content,
    timestamp: new Date(),
  };
}

function makeOptions(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return {
    projectCwd: '/tmp/project',
    ...overrides,
  };
}

describe('handleBlocked', () => {
  it('should return shouldContinue=false when no onUserInput callback', async () => {
    const result = await handleBlocked(
      makeStep(),
      makeResponse('blocked message'),
      makeOptions(),
    );

    expect(result.shouldContinue).toBe(false);
    expect(result.userInput).toBeUndefined();
  });

  it('should call onUserInput and return user input', async () => {
    const onUserInput = vi.fn().mockResolvedValue('user response');
    const result = await handleBlocked(
      makeStep(),
      makeResponse('質問: どうしますか？'),
      makeOptions({ onUserInput }),
    );

    expect(result.shouldContinue).toBe(true);
    expect(result.userInput).toBe('user response');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should return shouldContinue=false when user cancels (returns null)', async () => {
    const onUserInput = vi.fn().mockResolvedValue(null);
    const result = await handleBlocked(
      makeStep(),
      makeResponse('blocked'),
      makeOptions({ onUserInput }),
    );

    expect(result.shouldContinue).toBe(false);
    expect(result.userInput).toBeUndefined();
  });

  it('should pass extracted prompt in the request', async () => {
    const onUserInput = vi.fn().mockResolvedValue('answer');
    await handleBlocked(
      makeStep(),
      makeResponse('質問: 環境は何ですか？'),
      makeOptions({ onUserInput }),
    );

    const request = onUserInput.mock.calls[0]![0];
    expect(request.prompt).toBe('環境は何ですか？');
  });

  it('should pass the full content as prompt when no pattern matches', async () => {
    const onUserInput = vi.fn().mockResolvedValue('answer');
    const content = 'I need more information to continue';
    await handleBlocked(
      makeStep(),
      makeResponse(content),
      makeOptions({ onUserInput }),
    );

    const request = onUserInput.mock.calls[0]![0];
    expect(request.prompt).toBe(content);
  });

  it('should pass step and response in the request', async () => {
    const step = makeStep();
    const response = makeResponse('blocked');
    const onUserInput = vi.fn().mockResolvedValue('answer');

    await handleBlocked(step, response, makeOptions({ onUserInput }));

    const request = onUserInput.mock.calls[0]![0];
    expect(request.step).toBe(step);
    expect(request.response).toBe(response);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteClaudeCli } = vi.hoisted(() => ({
  mockExecuteClaudeCli: vi.fn(),
}));

vi.mock('../infra/claude/process.js', () => ({
  executeClaudeCli: mockExecuteClaudeCli,
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn(() => 'system prompt'),
}));

import { ClaudeClient } from '../infra/claude/client.js';
import type { ClaudeCallOptions } from '../infra/claude/client.js';

describe('ClaudeClient status normalization', () => {
  const options: ClaudeCallOptions = {
    cwd: '/tmp/takt-test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error status when call() receives an interrupted failure', async () => {
    mockExecuteClaudeCli.mockResolvedValue({
      success: false,
      interrupted: true,
      content: 'Interrupted by signal',
      error: 'SIGINT',
      sessionId: 'session-1',
    });

    const client = new ClaudeClient();

    const response = await client.call('coder', 'Implement feature', options);

    expect(response.status).toBe('error');
    expect(response.error).toBe('SIGINT');
    expect(response.content).toBe('Interrupted by signal');
  });

  it('should return error status when callCustom() receives an interrupted failure', async () => {
    mockExecuteClaudeCli.mockResolvedValue({
      success: false,
      interrupted: true,
      content: 'Interrupted by signal',
      error: 'SIGINT',
      sessionId: 'session-2',
    });

    const client = new ClaudeClient();

    const response = await client.callCustom('custom-coder', 'Implement feature', 'system prompt', options);

    expect(response.status).toBe('error');
    expect(response.error).toBe('SIGINT');
    expect(response.content).toBe('Interrupted by signal');
  });
});

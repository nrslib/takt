import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../features/interactive/conversationSession.js';
import {
  finishOperation,
  requestCancel,
  startOperation,
  type TaktAcpSessionState,
} from '../app/acp/sessionStore.js';

describe('ACP session store', () => {
  it('should preserve session state while removing the active abort controller on finish', () => {
    const conversationSession: ConversationSession = {
      handleUserMessage: vi.fn().mockResolvedValue({
        kind: 'assistant_response',
        content: 'ready',
      }),
      createTaskInstruction: vi.fn(),
    };
    const sessions = new Map<string, TaktAcpSessionState>([
      ['session-1', {
        cwd: '/repo',
        conversationSession,
        defaultAction: 'enqueue',
        mcpServers: {
          docs: {
            type: 'stdio',
            command: 'docs-mcp',
            args: ['serve'],
          },
        },
        cancelRequested: false,
        confirmationSequence: 3,
      }],
    ]);

    const abortController = startOperation(sessions, 'session-1');
    requestCancel(sessions, 'session-1');
    finishOperation(sessions, 'session-1', abortController);

    expect(sessions.get('session-1')).toEqual({
      cwd: '/repo',
      conversationSession,
      defaultAction: 'enqueue',
      mcpServers: {
        docs: {
          type: 'stdio',
          command: 'docs-mcp',
          args: ['serve'],
        },
      },
      cancelRequested: false,
      confirmationSequence: 3,
    });
    expect(sessions.get('session-1')).not.toHaveProperty('abortController');
  });

  it('should carry idle cancellation into the next operation', () => {
    const conversationSession: ConversationSession = {
      handleUserMessage: vi.fn().mockResolvedValue({
        kind: 'assistant_response',
        content: 'ready',
      }),
      createTaskInstruction: vi.fn(),
    };
    const sessions = new Map<string, TaktAcpSessionState>([
      ['session-1', {
        cwd: '/repo',
        conversationSession,
        defaultAction: 'enqueue',
        cancelRequested: false,
        confirmationSequence: 0,
      }],
    ]);

    requestCancel(sessions, 'session-1');
    expect(sessions.get('session-1')).toEqual({
      cwd: '/repo',
      conversationSession,
      defaultAction: 'enqueue',
      cancelRequested: true,
      confirmationSequence: 0,
    });

    const abortController = startOperation(sessions, 'session-1');

    expect(abortController.signal.aborted).toBe(true);
    expect(sessions.get('session-1')?.abortController).toBe(abortController);

    finishOperation(sessions, 'session-1', abortController);

    expect(sessions.get('session-1')).toEqual({
      cwd: '/repo',
      conversationSession,
      defaultAction: 'enqueue',
      cancelRequested: false,
      confirmationSequence: 0,
    });
  });
});

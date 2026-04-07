import { describe, it, expect, beforeEach } from 'vitest';

import {
  resetExecuteDefaultActionRoutingMocks,
  mockSelectAndExecuteTask,
  mockGetPieceDescription,
  mockSelectInteractiveMode,
  mockInteractiveMode,
  mockPassthroughMode,
  mockQuietMode,
  mockPersonaMode,
  mockDispatchConversationAction,
} from './helpers/executeDefaultActionRoutingMocks.js';

import { executeDefaultAction } from '../app/cli/routing.js';

function defaultPieceDesc(overrides: Record<string, unknown> = {}) {
  return {
    name: 'opt-in-piece',
    description: '',
    pieceStructure: '',
    movementPreviews: [],
    interactiveMode: 'quiet' as const,
    firstMovement: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  resetExecuteDefaultActionRoutingMocks({
    resolvedPieceName: 'opt-in-piece',
    defaultPieceDesc,
  });
});

describe('executeDefaultAction interactive opt-in', () => {
  it('Given no opt-in flags — When default action with no task — Then selectInteractiveMode is called', async () => {
    mockGetPieceDescription.mockReturnValue(defaultPieceDesc());

    await executeDefaultAction();

    expect(mockSelectInteractiveMode).toHaveBeenCalled();
  });

  it('Given skipInteractiveModeSelection true — When no task — Then selectInteractiveMode is not called', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        interactiveMode: 'assistant',
      }),
    );

    await executeDefaultAction();

    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
  });

  it('Given skipInteractiveModeSelection and interactive_mode none — When no task — Then no dialogue handlers and task is piece name', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        interactiveMode: 'none',
        name: 'my-workflow',
      }),
    );

    await executeDefaultAction();

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockPassthroughMode).not.toHaveBeenCalled();
    expect(mockQuietMode).not.toHaveBeenCalled();
    expect(mockPersonaMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'my-workflow' },
      expect.any(Object),
    );

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'my-workflow',
      expect.objectContaining({
        piece: 'opt-in-piece',
        skipTaskList: true,
        interactiveUserInput: false,
        pieceUserInputHandler: true,
        interactiveMetadata: expect.objectContaining({ confirmed: false, task: 'my-workflow' }),
      }),
      undefined,
    );
  });

  it('Given skipInteractiveModeSelection and interactive_mode none — When positional task — Then no dialogue and task is positional text', async () => {
    mockGetPieceDescription.mockReturnValue(
      defaultPieceDesc({
        skipInteractiveModeSelection: true,
        interactiveMode: 'none',
      }),
    );

    await executeDefaultAction('user supplied task');

    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
    expect(mockInteractiveMode).not.toHaveBeenCalled();

    expect(mockDispatchConversationAction).toHaveBeenCalledWith(
      { action: 'execute', task: 'user supplied task' },
      expect.any(Object),
    );

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'user supplied task',
      expect.objectContaining({
        interactiveUserInput: false,
        pieceUserInputHandler: true,
        interactiveMetadata: expect.objectContaining({ confirmed: false, task: 'user supplied task' }),
      }),
      undefined,
    );
  });
});

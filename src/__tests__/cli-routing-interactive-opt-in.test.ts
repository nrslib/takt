import { describe, it, expect, beforeEach } from 'vitest';

import {
  resetExecuteDefaultActionRoutingMocks,
  mockGetPieceDescription,
  mockSelectInteractiveMode,
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
});

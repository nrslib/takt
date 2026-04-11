import { describe, it, expect, beforeEach } from 'vitest';

import {
  resetExecuteDefaultActionRoutingMocks,
  mockGetPieceDescription,
  mockDeterminePiece,
  mockSelectInteractiveMode,
} from './helpers/executeDefaultActionRoutingMocks.js';

import { executeDefaultAction } from '../app/cli/routing.js';

describe('executeDefaultActionRoutingMocks (single mock installation)', () => {
  beforeEach(() => {
    resetExecuteDefaultActionRoutingMocks({
      resolvedPieceName: 'contract-piece',
      defaultPieceDesc: () => ({
        name: 'contract-piece',
        description: '',
        pieceStructure: '',
        movementPreviews: [],
        interactiveMode: 'quiet',
        firstMovement: undefined,
      }),
    });
  });

  it('reset wires shared helper mocks so executeDefaultAction reaches piece resolution', async () => {
    await executeDefaultAction();
    expect(mockDeterminePiece).toHaveBeenCalled();
    expect(mockGetPieceDescription).toHaveBeenCalled();
    expect(mockSelectInteractiveMode).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';

import { cleanupPieceEngine } from './engine-test-helpers.js';

describe('cleanupPieceEngine', () => {
  it('should remove all listeners when engine has removeAllListeners function', () => {
    const removeAllListeners = vi.fn();
    const engine = { removeAllListeners };

    cleanupPieceEngine(engine);

    expect(removeAllListeners).toHaveBeenCalledOnce();
  });

  it('should not throw when engine does not have removeAllListeners function', () => {
    expect(() => cleanupPieceEngine({})).not.toThrow();
    expect(() => cleanupPieceEngine(null)).not.toThrow();
    expect(() => cleanupPieceEngine(undefined)).not.toThrow();
    expect(() => cleanupPieceEngine({ removeAllListeners: 'no-op' })).not.toThrow();
  });
});

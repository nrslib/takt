import { describe, it, expect, vi } from 'vitest';

import { cleanupWorkflowEngine } from './engine-test-helpers.js';

describe('cleanupWorkflowEngine', () => {
  it('should remove all listeners when engine has removeAllListeners function', () => {
    const removeAllListeners = vi.fn();
    const engine = { removeAllListeners };

    cleanupWorkflowEngine(engine);

    expect(removeAllListeners).toHaveBeenCalledOnce();
  });

  it('should not throw when engine does not have removeAllListeners function', () => {
    expect(() => cleanupWorkflowEngine({})).not.toThrow();
    expect(() => cleanupWorkflowEngine(null)).not.toThrow();
    expect(() => cleanupWorkflowEngine(undefined)).not.toThrow();
    expect(() => cleanupWorkflowEngine({ removeAllListeners: 'no-op' })).not.toThrow();
  });
});

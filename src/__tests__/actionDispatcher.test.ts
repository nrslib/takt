import { describe, it, expect, vi } from 'vitest';

import { dispatchConversationAction } from '../features/interactive/actionDispatcher.js';

describe('dispatchConversationAction', () => {
  it('should dispatch to matching handler with full result payload', async () => {
    const execute = vi.fn().mockResolvedValue('executed');
    const saveTask = vi.fn().mockResolvedValue('saved');
    const cancel = vi.fn().mockResolvedValue('cancelled');

    const result = await dispatchConversationAction(
      { action: 'save_task', task: 'refine branch docs' },
      {
        execute,
        save_task: saveTask,
        cancel,
      },
    );

    expect(result).toBe('saved');
    expect(saveTask).toHaveBeenCalledWith({ action: 'save_task', task: 'refine branch docs' });
    expect(execute).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('should support synchronous handlers', async () => {
    const result = await dispatchConversationAction(
      { action: 'cancel', task: '' },
      {
        execute: () => true,
        save_task: () => true,
        cancel: () => false,
      },
    );

    expect(result).toBe(false);
  });
});


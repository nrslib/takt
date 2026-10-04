import { describe, expect, it } from 'vitest';
import * as tasksFeature from '../features/tasks/index.js';

describe('tasks feature public API', () => {
  it('does not expose run id generation internals', () => {
    expect('generateRunId' in (tasksFeature as Record<string, unknown>)).toBe(false);
  });
});

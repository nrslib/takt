import { describe, expect, it } from 'vitest';
import * as headlessSpawn from '../infra/claude-headless/headless-spawn.js';

describe('claude-headless headless-spawn exports', () => {
  it('does not export createExecError (module-local helper)', () => {
    expect('createExecError' in headlessSpawn).toBe(false);
  });
});

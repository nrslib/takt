import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  closeTargetPath: undefined as string | undefined,
  descriptorPaths: new Map<number, string>(),
  failFirstFragmentClose: false,
  failSecondFragmentWrite: false,
  fragmentWrites: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      state.descriptorPaths.set(descriptor, String(args[0]));
      return descriptor;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] === 'number' && state.failSecondFragmentWrite) {
        state.fragmentWrites += 1;
        if (state.fragmentWrites === 2) {
          throw new Error('simulated second fragment write failure');
        }
      }
      actual.writeFileSync(...args);
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      const path = state.descriptorPaths.get(args[0]);
      try {
        actual.closeSync(...args);
      } finally {
        state.descriptorPaths.delete(args[0]);
      }
      if (state.failFirstFragmentClose && path === state.closeTargetPath) {
        state.failFirstFragmentClose = false;
        throw new Error('simulated fragment close failure');
      }
    },
  };
});

import { copyReferencedBuiltinStepFragments } from '../features/config/ejectStepFragments.js';

describe('eject step fragment rollback', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-eject-fragment-rollback-'));
    state.closeTargetPath = undefined;
    state.descriptorPaths.clear();
    state.failFirstFragmentClose = false;
    state.failSecondFragmentWrite = false;
    state.fragmentWrites = 0;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('removes newly copied fragments after the second write fails without deleting existing files', () => {
    const targetDir = join(projectDir, '.takt', 'steps');
    const workflowPath = join(projectDir, '.takt', 'workflows', 'default.yaml');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'existing.yaml'), 'instruction: existing\n');
    state.failSecondFragmentWrite = true;

    expect(() => copyReferencedBuiltinStepFragments([
      'steps:',
      '  - name: gather',
      '    uses: gather',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '  - name: fix',
      '    uses: fix',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'en', targetDir, workflowPath, true)).toThrow('simulated second fragment write failure');

    expect(existsSync(join(targetDir, 'gather.yaml'))).toBe(false);
    expect(existsSync(join(targetDir, 'fix.yaml'))).toBe(false);
    expect(readFileSync(join(targetDir, 'existing.yaml'), 'utf-8')).toBe('instruction: existing\n');
  });

  it('removes a newly copied fragment after closing its descriptor fails', () => {
    const targetDir = join(projectDir, '.takt', 'steps');
    const workflowPath = join(projectDir, '.takt', 'workflows', 'default.yaml');
    state.closeTargetPath = join(targetDir, 'gather.yaml');
    state.failFirstFragmentClose = true;

    expect(() => copyReferencedBuiltinStepFragments([
      'steps:',
      '  - name: gather',
      '    uses: gather',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'en', targetDir, workflowPath, true)).toThrow('simulated fragment close failure');

    expect(existsSync(join(targetDir, 'gather.yaml'))).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(join(projectDir, '.takt'))).toBe(false);
  });

  it('keeps a pre-existing .takt directory after a fragment write fails', () => {
    const taktDir = join(projectDir, '.takt');
    const targetDir = join(taktDir, 'steps');
    const workflowPath = join(taktDir, 'workflows', 'default.yaml');
    mkdirSync(taktDir);
    state.closeTargetPath = join(targetDir, 'gather.yaml');
    state.failFirstFragmentClose = true;

    expect(() => copyReferencedBuiltinStepFragments([
      'steps:',
      '  - name: gather',
      '    uses: gather',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'en', targetDir, workflowPath, true)).toThrow('simulated fragment close failure');

    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(taktDir)).toBe(true);
  });
});

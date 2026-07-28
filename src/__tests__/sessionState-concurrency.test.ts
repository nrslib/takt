import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const conflict = vi.hoisted(() => ({ inject: false }));

vi.mock('../shared/utils/private-file.js', async () => {
  const actual = await vi.importActual<
    typeof import('../shared/utils/private-file.js')
  >('../shared/utils/private-file.js');
  return {
    ...actual,
    writePrivateFileWithModeExpected(
      ...args: Parameters<typeof actual.writePrivateFileWithModeExpected>
    ) {
      if (conflict.inject) {
        conflict.inject = false;
        actual.writePrivateFileWithModeExpected(...args);
        throw new actual.PrivateArtifactPublicationConflictError(
          'injected competing consumer',
        );
      }
      return actual.writePrivateFileWithModeExpected(...args);
    },
  };
});

import {
  saveSessionState,
  takeSessionState,
} from '../infra/config/project/sessionState.js';

const roots: string[] = [];

afterEach(() => {
  conflict.inject = false;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('session state concurrent consumption', () => {
  it('CAS競合で他consumerがconsumedにしたstateを返さない', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-session-consumer-'));
    roots.push(root);
    saveSessionState(root, 'publication-a', {
      status: 'success',
      timestamp: '2026-07-28T09:00:00.000Z',
      workflowName: 'workflow',
    });
    conflict.inject = true;

    expect(takeSessionState(root)).toBeNull();
  });
});

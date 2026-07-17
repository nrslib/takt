import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appendState = vi.hoisted(() => ({ removeAfterNextAppend: false }));

vi.mock('../shared/utils/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/private-file.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...actual,
    appendPrivateFile: vi.fn((filepath: string, content: string) => {
      actual.appendPrivateFile(filepath, content);
      if (appendState.removeAfterNextAppend) {
        appendState.removeAfterNextAppend = false;
        fs.rmSync(path.dirname(filepath), { recursive: true, force: true });
      }
    }),
  };
});

import { appendPrivateFile } from '../shared/utils/private-file.js';
import { appendNdjsonLine } from '../infra/fs/session.js';

describe('session log post-append recovery', () => {
  const testDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    appendState.removeAfterNextAppend = false;
    for (const testDir of testDirs) {
      rmSync(testDir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  it('recreates and re-appends when the log disappears after a successful append', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-session-post-append-'));
    testDirs.push(projectDir);
    const filepath = join(projectDir, '.takt', 'runs', 'run-1', 'logs', 'session.jsonl');
    mkdirSync(dirname(filepath), { recursive: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    appendState.removeAfterNextAppend = true;

    appendNdjsonLine(filepath, {
      type: 'workflow_complete',
      iterations: 1,
      endTime: '2026-07-20T00:00:00.000Z',
    });

    expect(existsSync(filepath)).toBe(true);
    expect(JSON.parse(readFileSync(filepath, 'utf-8'))).toMatchObject({
      type: 'workflow_complete',
      iterations: 1,
    });
    expect(vi.mocked(appendPrivateFile)).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(
      'Log directory disappeared during execution and was recreated',
    ));
  });
});

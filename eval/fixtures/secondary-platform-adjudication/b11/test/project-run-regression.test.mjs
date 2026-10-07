import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { beginProjectRun as previousRun } from '../src/project-run.previous.mjs';
import { beginProjectRun as currentRun } from '../src/project-run.mjs';

test('new start-time requirement breaks the previous Windows run path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-b11-'));
  const attemptPath = join(directory, 'last-project');
  try {
    assert.equal(previousRun(42, attemptPath).running, true);
    assert.throws(
      () => currentRun(42, { platform: 'win32' }, attemptPath),
      /process start time unavailable/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

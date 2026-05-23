import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateExecutionReportDir } from '../core/workflow/run/run-slug.js';

describe('generateExecutionReportDir', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should keep task execution report names separate from existing run directories', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-report-dir-test-'));

    try {
      const first = generateExecutionReportDir(root, 'Use saved task spec');
      fs.mkdirSync(path.join(root, '.takt', 'runs', first), { recursive: true });
      const second = generateExecutionReportDir(root, 'Use saved task spec');

      expect(second).not.toBe(first);
      expect(second).toBe(`${first}-2`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

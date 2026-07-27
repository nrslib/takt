import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanReportEntries } from '../core/workflow/report-file-index.js';

const cleanupDirectories = new Set<string>();

afterEach(() => {
  for (const directory of cleanupDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe('report file discovery', () => {
  it('excludes the internal report subtree before applying the entry limit', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-report-file-index-'));
    cleanupDirectories.add(reportDir);
    const internalDir = join(reportDir, '.takt-report-internal', 'history');
    mkdirSync(internalDir, { recursive: true });
    for (let index = 0; index < 1_024; index += 1) {
      writeFileSync(join(internalDir, `${index}.json`), '{}');
    }
    const publicReport = join(reportDir, 'review.md');
    writeFileSync(publicReport, '# Review');

    expect(scanReportEntries(reportDir)).toEqual({
      entries: [publicReport],
    });
  });

  it('uses the normalized classifier for internal and manifest entries', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'takt-report-file-index-'));
    cleanupDirectories.add(reportDir);
    mkdirSync(join(reportDir, '.TAKT-REPORT-INTERNAL', 'history'), { recursive: true });
    writeFileSync(join(reportDir, '.TAKT-REPORT-INTERNAL', 'history', 'private.json'), '{}');
    mkdirSync(join(reportDir, 'nested'), { recursive: true });
    writeFileSync(join(reportDir, 'nested', 'resume-artifacts.json'), '{}');
    const publicReport = join(reportDir, 'nested', 'review.md');
    writeFileSync(publicReport, '# Review');

    expect(scanReportEntries(reportDir).entries.filter((entry) => !entry.endsWith('nested')))
      .toEqual([publicReport]);
  });
});

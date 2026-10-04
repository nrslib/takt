import { describe, expect, it } from 'vitest';
import type { OutputContractEntry } from '../core/models/types.js';
import {
  getJudgmentReportFiles,
  getReportFiles,
} from '../core/workflow/output-contract-files.js';

const contracts: OutputContractEntry[] = [
  { name: 'required-review.md', format: 'required-review', useJudge: true },
  { name: 'default-review.md', format: 'default-review' },
  { name: 'excluded-review.md', format: 'excluded-review', useJudge: false },
];

describe('output contract files', () => {
  it('should return no report files when output contracts are absent or empty', () => {
    expect(getReportFiles(undefined)).toEqual([]);
    expect(getReportFiles([])).toEqual([]);
  });

  it('should return every output contract file in declaration order', () => {
    expect(getReportFiles(contracts)).toEqual([
      'required-review.md',
      'default-review.md',
      'excluded-review.md',
    ]);
  });

  it('should exclude only files explicitly disabled for status judgment', () => {
    expect(getJudgmentReportFiles(contracts)).toEqual([
      'required-review.md',
      'default-review.md',
    ]);
  });
});

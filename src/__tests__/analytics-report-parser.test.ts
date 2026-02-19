/**
 * Tests for analytics report parser — extracting findings from review markdown.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFindingsFromReport,
  extractDecisionFromReport,
  inferSeverity,
  emitFixActionEvents,
  emitRebuttalEvents,
} from '../features/analytics/report-parser.js';
import { initAnalyticsWriter } from '../features/analytics/writer.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import type { FixActionEvent } from '../features/analytics/events.js';

describe('parseFindingsFromReport', () => {
  it('should extract new findings from a review report', () => {
    const report = [
      '# Review Report',
      '',
      '## Result: REJECT',
      '',
      '## Current Iteration Findings (new)',
      '| # | finding_id | Category | Location | Issue | Fix Suggestion |',
      '|---|------------|---------|------|------|--------|',
      '| 1 | AA-001 | DRY | `src/foo.ts:42` | Duplication | Extract helper |',
      '| 2 | AA-002 | Export | `src/bar.ts:10` | Unused export | Remove |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toHaveLength(2);
    expect(findings[0].findingId).toBe('AA-001');
    expect(findings[0].status).toBe('new');
    expect(findings[0].ruleId).toBe('DRY');
    expect(findings[0].file).toBe('src/foo.ts');
    expect(findings[0].line).toBe(42);
    expect(findings[1].findingId).toBe('AA-002');
    expect(findings[1].status).toBe('new');
    expect(findings[1].ruleId).toBe('Export');
    expect(findings[1].file).toBe('src/bar.ts');
    expect(findings[1].line).toBe(10);
  });

  it('should extract persists findings', () => {
    const report = [
      '## Carry-over Findings (persists)',
      '| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |',
      '|---|------------|----------|----------|------|--------|',
      '| 1 | ARCH-001 | `src/a.ts:5` was X | `src/a.ts:5` still X | Still bad | Fix it |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingId).toBe('ARCH-001');
    expect(findings[0].status).toBe('persists');
  });

  it('should extract resolved findings', () => {
    const report = [
      '## Resolved Findings (resolved)',
      '| finding_id | Resolution Evidence |',
      '|------------|---------------------|',
      '| QA-003 | Fixed in src/c.ts |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingId).toBe('QA-003');
    expect(findings[0].status).toBe('resolved');
  });

  it('should handle mixed sections in one report', () => {
    const report = [
      '## 今回の指摘（new）',
      '| # | finding_id | カテゴリ | 場所 | 問題 | 修正案 |',
      '|---|------------|---------|------|------|--------|',
      '| 1 | AA-001 | DRY | `src/foo.ts:1` | Dup | Fix |',
      '',
      '## 継続指摘（persists）',
      '| # | finding_id | 前回根拠 | 今回根拠 | 問題 | 修正案 |',
      '|---|------------|----------|----------|------|--------|',
      '| 1 | AA-002 | Was bad | Still bad | Issue | Fix |',
      '',
      '## 解消済み（resolved）',
      '| finding_id | 解消根拠 |',
      '|------------|---------|',
      '| AA-003 | Fixed |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toHaveLength(3);
    expect(findings[0]).toEqual(expect.objectContaining({ findingId: 'AA-001', status: 'new' }));
    expect(findings[1]).toEqual(expect.objectContaining({ findingId: 'AA-002', status: 'persists' }));
    expect(findings[2]).toEqual(expect.objectContaining({ findingId: 'AA-003', status: 'resolved' }));
  });

  it('should return empty array when no finding sections exist', () => {
    const report = [
      '# Report',
      '',
      '## Summary',
      'Everything looks good.',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toEqual([]);
  });

  it('should stop collecting findings when a new non-finding section starts', () => {
    const report = [
      '## Current Iteration Findings (new)',
      '| # | finding_id | Category | Location | Issue | Fix |',
      '|---|------------|---------|------|------|-----|',
      '| 1 | F-001 | Bug | `src/a.ts` | Bad | Fix |',
      '',
      '## REJECT判定条件',
      '| Condition | Result |',
      '|-----------|--------|',
      '| Has findings | Yes |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingId).toBe('F-001');
  });

  it('should skip header rows in tables', () => {
    const report = [
      '## Current Iteration Findings (new)',
      '| # | finding_id | Category | Location | Issue | Fix |',
      '|---|------------|---------|------|------|-----|',
      '| 1 | X-001 | Cat | `file.ts:5` | Problem | Solution |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings).toHaveLength(1);
    expect(findings[0].findingId).toBe('X-001');
  });

  it('should parse location with line number from backtick-wrapped paths', () => {
    const report = [
      '## Current Iteration Findings (new)',
      '| # | finding_id | Category | Location | Issue | Fix |',
      '|---|------------|---------|------|------|-----|',
      '| 1 | F-001 | Bug | `src/features/analytics/writer.ts:27` | Comment | Remove |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings[0].file).toBe('src/features/analytics/writer.ts');
    expect(findings[0].line).toBe(27);
  });

  it('should handle location with multiple line references', () => {
    const report = [
      '## Current Iteration Findings (new)',
      '| # | finding_id | Category | Location | Issue | Fix |',
      '|---|------------|---------|------|------|-----|',
      '| 1 | F-001 | Bug | `src/a.ts:10, src/b.ts:20` | Multiple | Fix |',
      '',
    ].join('\n');

    const findings = parseFindingsFromReport(report);

    expect(findings[0].file).toBe('src/a.ts');
    expect(findings[0].line).toBe(10);
  });
});

describe('extractDecisionFromReport', () => {
  it('should return reject when report says REJECT', () => {
    const report = '## 結果: REJECT\n\nSome content';
    expect(extractDecisionFromReport(report)).toBe('reject');
  });

  it('should return approve when report says APPROVE', () => {
    const report = '## Result: APPROVE\n\nSome content';
    expect(extractDecisionFromReport(report)).toBe('approve');
  });

  it('should return null when no result section is found', () => {
    const report = '# Report\n\nNo result section here.';
    expect(extractDecisionFromReport(report)).toBeNull();
  });
});

describe('inferSeverity', () => {
  it('should return error for security-related finding IDs', () => {
    expect(inferSeverity('SEC-001')).toBe('error');
    expect(inferSeverity('SEC-NEW-xss')).toBe('error');
  });

  it('should return warning for other finding IDs', () => {
    expect(inferSeverity('AA-001')).toBe('warning');
    expect(inferSeverity('QA-001')).toBe('warning');
    expect(inferSeverity('ARCH-NEW-dry')).toBe('warning');
  });
});

describe('emitFixActionEvents', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-emit-fix-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    initAnalyticsWriter(true, testDir);
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should emit fix_action events for each finding ID in response', () => {
    const timestamp = new Date('2026-02-18T12:00:00.000Z');

    emitFixActionEvents('Fixed AA-001 and ARCH-002-barrel', 3, 'run-xyz', timestamp);

    const filePath = join(testDir, '2026-02-18.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const event1 = JSON.parse(lines[0]) as FixActionEvent;
    expect(event1.type).toBe('fix_action');
    expect(event1.findingId).toBe('AA-001');
    expect(event1.action).toBe('fixed');
    expect(event1.iteration).toBe(3);
    expect(event1.runId).toBe('run-xyz');
    expect(event1.timestamp).toBe('2026-02-18T12:00:00.000Z');

    const event2 = JSON.parse(lines[1]) as FixActionEvent;
    expect(event2.type).toBe('fix_action');
    expect(event2.findingId).toBe('ARCH-002-barrel');
    expect(event2.action).toBe('fixed');
  });

  it('should not emit events when response contains no finding IDs', () => {
    const timestamp = new Date('2026-02-18T12:00:00.000Z');

    emitFixActionEvents('No issues found, all good.', 1, 'run-abc', timestamp);

    const filePath = join(testDir, '2026-02-18.jsonl');
    expect(() => readFileSync(filePath, 'utf-8')).toThrow();
  });

  it('should deduplicate repeated finding IDs', () => {
    const timestamp = new Date('2026-02-18T12:00:00.000Z');

    emitFixActionEvents(
      'Fixed QA-001, confirmed QA-001 is resolved, also QA-001 again',
      2,
      'run-dedup',
      timestamp,
    );

    const filePath = join(testDir, '2026-02-18.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]) as FixActionEvent;
    expect(event.findingId).toBe('QA-001');
  });

  it('should match various finding ID formats', () => {
    const timestamp = new Date('2026-02-18T12:00:00.000Z');
    const response = [
      'Resolved AA-001 simple ID',
      'Fixed ARCH-NEW-dry with NEW segment',
      'Addressed SEC-002-xss with suffix',
    ].join('\n');

    emitFixActionEvents(response, 1, 'run-formats', timestamp);

    const filePath = join(testDir, '2026-02-18.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);

    const ids = lines.map((line) => (JSON.parse(line) as FixActionEvent).findingId);
    expect(ids).toContain('AA-001');
    expect(ids).toContain('ARCH-NEW-dry');
    expect(ids).toContain('SEC-002-xss');
  });
});

describe('emitRebuttalEvents', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-emit-rebuttal-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    initAnalyticsWriter(true, testDir);
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should emit fix_action events with rebutted action for finding IDs', () => {
    const timestamp = new Date('2026-02-18T12:00:00.000Z');

    emitRebuttalEvents('Rebutting AA-001 and ARCH-002-barrel', 3, 'run-xyz', timestamp);

    const filePath = join(testDir, '2026-02-18.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const event1 = JSON.parse(lines[0]) as FixActionEvent;
    expect(event1.type).toBe('fix_action');
    expect(event1.findingId).toBe('AA-001');
    expect(event1.action).toBe('rebutted');
    expect(event1.iteration).toBe(3);
    expect(event1.runId).toBe('run-xyz');

    const event2 = JSON.parse(lines[1]) as FixActionEvent;
    expect(event2.type).toBe('fix_action');
    expect(event2.findingId).toBe('ARCH-002-barrel');
    expect(event2.action).toBe('rebutted');
  });

  it('should not emit events when response contains no finding IDs', () => {
    const timestamp = new Date('2026-02-18T12:00:00.000Z');

    emitRebuttalEvents('No findings mentioned here.', 1, 'run-abc', timestamp);

    const filePath = join(testDir, '2026-02-18.jsonl');
    expect(() => readFileSync(filePath, 'utf-8')).toThrow();
  });
});

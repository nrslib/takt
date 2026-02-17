/**
 * Unit tests for report-reader
 *
 * Tests markdown report file reading and finding extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readReportFiles, extractFindings, readAndExtractFindings, readRecentConversations } from '../infra/fs/report-reader.js';

describe('extractFindings', () => {
  it('should extract findings from a markdown table', () => {
    const content = `
# Review Report

| finding_id | status | category | location |
|------------|--------|----------|----------|
| auth-null-check | new | security | auth.ts:15 |
| api-error-handler | persists | error-handling | api.ts:42 |
| input-validation | resolved | validation | form.ts:8 |
`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(3);
    expect(findings[0]).toEqual({
      id: 'auth-null-check',
      status: 'new',
      category: 'security',
      location: 'auth.ts:15',
    });
    expect(findings[1]).toEqual({
      id: 'api-error-handler',
      status: 'persists',
      category: 'error-handling',
      location: 'api.ts:42',
    });
    expect(findings[2]).toEqual({
      id: 'input-validation',
      status: 'resolved',
      category: 'validation',
      location: 'form.ts:8',
    });
  });

  it('should skip header rows', () => {
    const content = `| finding_id | status | category | location |
|------------|--------|----------|----------|
| issue-a | new | test | test.ts:1 |`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('issue-a');
  });

  it('should skip separator rows with dashes', () => {
    const content = `| --- | --- | --- | --- |
| issue-a | new | test | test.ts:1 |`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(1);
  });

  it('should skip rows with invalid status', () => {
    const content = `| issue-a | invalid_status | test | test.ts:1 |
| issue-b | new | test | test.ts:2 |`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('issue-b');
  });

  it('should handle content without any tables', () => {
    const content = `# Report
Everything looks good!`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(0);
  });

  it('should handle empty content', () => {
    const findings = extractFindings('');

    expect(findings).toHaveLength(0);
  });

  it('should handle case-insensitive status values', () => {
    const content = `| issue-a | NEW | test | test.ts:1 |
| issue-b | Persists | test | test.ts:2 |
| issue-c | RESOLVED | test | test.ts:3 |`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(3);
    expect(findings[0].status).toBe('new');
    expect(findings[1].status).toBe('persists');
    expect(findings[2].status).toBe('resolved');
  });

  it('should handle whitespace in table cells', () => {
    const content = `|  issue-a  |  new  |  test  |  test.ts:1  |`;

    const findings = extractFindings(content);

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('issue-a');
    expect(findings[0].status).toBe('new');
  });
});

describe('readReportFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `takt-report-reader-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should read all .md files from a directory', () => {
    writeFileSync(join(tmpDir, 'review.md'), '# Review\nContent here');
    writeFileSync(join(tmpDir, 'summary.md'), '# Summary\nSummary here');
    writeFileSync(join(tmpDir, 'notes.txt'), 'Not a markdown file');

    const files = readReportFiles(tmpDir);

    expect(files.size).toBe(2);
    expect(files.get('review.md')).toContain('Content here');
    expect(files.get('summary.md')).toContain('Summary here');
  });

  it('should return empty map for non-existent directory', () => {
    const files = readReportFiles('/non/existent/path');

    expect(files.size).toBe(0);
  });

  it('should return empty map for empty directory', () => {
    const files = readReportFiles(tmpDir);

    expect(files.size).toBe(0);
  });
});

describe('readAndExtractFindings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `takt-report-reader-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should aggregate findings from multiple report files', () => {
    writeFileSync(join(tmpDir, 'review-1.md'), `
| finding_id | status | category | location |
|------------|--------|----------|----------|
| issue-a | new | security | a.ts:1 |
`);
    writeFileSync(join(tmpDir, 'review-2.md'), `
| finding_id | status | category | location |
|------------|--------|----------|----------|
| issue-b | persists | quality | b.ts:2 |
`);

    const findings = readAndExtractFindings(tmpDir);

    expect(findings).toHaveLength(2);
    const ids = findings.map((f) => f.id);
    expect(ids).toContain('issue-a');
    expect(ids).toContain('issue-b');
  });

  it('should return empty array for directory with no findings', () => {
    writeFileSync(join(tmpDir, 'report.md'), '# Report\nAll good!');

    const findings = readAndExtractFindings(tmpDir);

    expect(findings).toHaveLength(0);
  });

  it('should return empty array for non-existent directory', () => {
    const findings = readAndExtractFindings('/non/existent/path');

    expect(findings).toHaveLength(0);
  });
});

describe('readRecentConversations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `takt-conversation-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should read step_complete records from NDJSON log files', () => {
    const records = [
      JSON.stringify({ type: 'piece_start', task: 'test', pieceName: 'default', startTime: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'step_start', step: 'ai_review', persona: 'reviewer', iteration: 1, timestamp: '2025-01-01T00:01:00Z' }),
      JSON.stringify({ type: 'step_complete', step: 'ai_review', persona: 'reviewer', status: 'done', content: 'Found issues', instruction: 'Review the code', timestamp: '2025-01-01T00:02:00Z' }),
      JSON.stringify({ type: 'step_complete', step: 'ai_fix', persona: 'coder', status: 'done', content: 'Fixed issues', instruction: 'Fix the code', timestamp: '2025-01-01T00:03:00Z' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'session-abc.jsonl'), records);

    const conversations = readRecentConversations(tmpDir, 3);

    expect(conversations).toHaveLength(2);
    expect(conversations[0].step).toBe('ai_review');
    expect(conversations[0].instruction).toBe('Review the code');
    expect(conversations[0].content).toBe('Found issues');
    expect(conversations[1].step).toBe('ai_fix');
  });

  it('should limit to most recent N entries', () => {
    const records = [
      JSON.stringify({ type: 'step_complete', step: 'step-1', persona: 'p', status: 'done', content: 'c1', instruction: 'i1', timestamp: '2025-01-01T00:01:00Z' }),
      JSON.stringify({ type: 'step_complete', step: 'step-2', persona: 'p', status: 'done', content: 'c2', instruction: 'i2', timestamp: '2025-01-01T00:02:00Z' }),
      JSON.stringify({ type: 'step_complete', step: 'step-3', persona: 'p', status: 'done', content: 'c3', instruction: 'i3', timestamp: '2025-01-01T00:03:00Z' }),
      JSON.stringify({ type: 'step_complete', step: 'step-4', persona: 'p', status: 'done', content: 'c4', instruction: 'i4', timestamp: '2025-01-01T00:04:00Z' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'session.jsonl'), records);

    const conversations = readRecentConversations(tmpDir, 2);

    expect(conversations).toHaveLength(2);
    expect(conversations[0].step).toBe('step-3');
    expect(conversations[1].step).toBe('step-4');
  });

  it('should return empty array for non-existent directory', () => {
    const conversations = readRecentConversations('/non/existent/path', 3);

    expect(conversations).toHaveLength(0);
  });

  it('should return empty array when no NDJSON files exist', () => {
    const conversations = readRecentConversations(tmpDir, 3);

    expect(conversations).toHaveLength(0);
  });

  it('should skip malformed JSON lines', () => {
    const records = [
      'not valid json',
      JSON.stringify({ type: 'step_complete', step: 'valid', persona: 'p', status: 'done', content: 'c', instruction: 'i', timestamp: '2025-01-01T00:01:00Z' }),
      '{ broken json',
    ].join('\n');

    writeFileSync(join(tmpDir, 'session.jsonl'), records);

    const conversations = readRecentConversations(tmpDir, 3);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].step).toBe('valid');
  });

  it('should include error field when present', () => {
    const records = [
      JSON.stringify({ type: 'step_complete', step: 'ai_fix', persona: 'coder', status: 'error', content: 'Failed', instruction: 'Fix', error: 'timeout', timestamp: '2025-01-01T00:01:00Z' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'session.jsonl'), records);

    const conversations = readRecentConversations(tmpDir, 3);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].error).toBe('timeout');
  });
});

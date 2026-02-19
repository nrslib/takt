/**
 * Tests for analytics purge — retention-based cleanup of JSONL files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { purgeOldEvents } from '../features/analytics/index.js';

describe('purgeOldEvents', () => {
  let eventsDir: string;

  beforeEach(() => {
    eventsDir = join(tmpdir(), `takt-test-analytics-purge-${Date.now()}`);
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(eventsDir, { recursive: true, force: true });
  });

  it('should delete files older than retention period', () => {
    // Given: Files from different dates
    writeFileSync(join(eventsDir, '2026-01-01.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-01-15.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-10.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-18.jsonl'), '{}', 'utf-8');

    // When: Purge with 30-day retention from Feb 18
    const now = new Date('2026-02-18T12:00:00Z');
    const deleted = purgeOldEvents(eventsDir, 30, now);

    // Then: Only files before Jan 19 should be deleted
    expect(deleted).toContain('2026-01-01.jsonl');
    expect(deleted).toContain('2026-01-15.jsonl');
    expect(deleted).not.toContain('2026-02-10.jsonl');
    expect(deleted).not.toContain('2026-02-18.jsonl');

    expect(existsSync(join(eventsDir, '2026-01-01.jsonl'))).toBe(false);
    expect(existsSync(join(eventsDir, '2026-01-15.jsonl'))).toBe(false);
    expect(existsSync(join(eventsDir, '2026-02-10.jsonl'))).toBe(true);
    expect(existsSync(join(eventsDir, '2026-02-18.jsonl'))).toBe(true);
  });

  it('should return empty array when no files to purge', () => {
    writeFileSync(join(eventsDir, '2026-02-18.jsonl'), '{}', 'utf-8');

    const now = new Date('2026-02-18T12:00:00Z');
    const deleted = purgeOldEvents(eventsDir, 30, now);

    expect(deleted).toEqual([]);
  });

  it('should return empty array when directory does not exist', () => {
    const nonExistent = join(eventsDir, 'does-not-exist');
    const deleted = purgeOldEvents(nonExistent, 30, new Date());

    expect(deleted).toEqual([]);
  });

  it('should delete all files when retention is 0', () => {
    writeFileSync(join(eventsDir, '2026-02-17.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-18.jsonl'), '{}', 'utf-8');

    const now = new Date('2026-02-18T12:00:00Z');
    const deleted = purgeOldEvents(eventsDir, 0, now);

    expect(deleted).toContain('2026-02-17.jsonl');
    // The cutoff date is Feb 18, and '2026-02-18' is not < '2026-02-18'
    expect(deleted).not.toContain('2026-02-18.jsonl');
  });

  it('should ignore non-jsonl files', () => {
    writeFileSync(join(eventsDir, '2025-01-01.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, 'README.md'), '# test', 'utf-8');
    writeFileSync(join(eventsDir, 'data.json'), '{}', 'utf-8');

    const now = new Date('2026-02-18T12:00:00Z');
    const deleted = purgeOldEvents(eventsDir, 30, now);

    expect(deleted).toContain('2025-01-01.jsonl');
    expect(deleted).not.toContain('README.md');
    expect(deleted).not.toContain('data.json');

    // Non-jsonl files should still exist
    expect(existsSync(join(eventsDir, 'README.md'))).toBe(true);
    expect(existsSync(join(eventsDir, 'data.json'))).toBe(true);
  });

  it('should handle 7-day retention correctly', () => {
    writeFileSync(join(eventsDir, '2026-02-10.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-11.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-12.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-17.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-18.jsonl'), '{}', 'utf-8');

    const now = new Date('2026-02-18T12:00:00Z');
    const deleted = purgeOldEvents(eventsDir, 7, now);

    // Cutoff: Feb 11
    expect(deleted).toContain('2026-02-10.jsonl');
    expect(deleted).not.toContain('2026-02-11.jsonl');
    expect(deleted).not.toContain('2026-02-12.jsonl');
    expect(deleted).not.toContain('2026-02-17.jsonl');
    expect(deleted).not.toContain('2026-02-18.jsonl');
  });
});

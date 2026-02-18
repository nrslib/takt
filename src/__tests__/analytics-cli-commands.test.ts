/**
 * Tests for analytics CLI command logic — metrics review and purge.
 *
 * Tests the command action logic by calling the underlying functions
 * with appropriate parameters, verifying the integration between
 * config loading, eventsDir resolution, and the analytics functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeReviewMetrics,
  formatReviewMetrics,
  parseSinceDuration,
  purgeOldEvents,
  resolveEventsDir,
} from '../features/analytics/index.js';
import type { GlobalConfig } from '../core/models/index.js';
import type { ReviewFindingEvent } from '../features/analytics/index.js';

describe('metrics review command logic', () => {
  let eventsDir: string;

  beforeEach(() => {
    eventsDir = join(tmpdir(), `takt-test-cli-metrics-${Date.now()}`);
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(eventsDir, { recursive: true, force: true });
  });

  it('should compute and format metrics from resolved eventsDir', () => {
    const events: ReviewFindingEvent[] = [
      {
        type: 'review_finding', findingId: 'f-001', status: 'new', ruleId: 'r-1',
        severity: 'error', decision: 'reject', file: 'a.ts', line: 1, iteration: 1,
        runId: 'r', timestamp: '2026-02-18T10:00:00.000Z',
      },
    ];
    writeFileSync(
      join(eventsDir, '2026-02-18.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );

    const durationMs = parseSinceDuration('30d');
    const sinceMs = new Date('2026-02-18T00:00:00Z').getTime();
    const result = computeReviewMetrics(eventsDir, sinceMs);
    const output = formatReviewMetrics(result);

    expect(output).toContain('Review Metrics');
    expect(result.rejectCountsByRule.get('r-1')).toBe(1);
  });

  it('should resolve eventsDir from globalConfig with custom eventsPath', () => {
    const config: GlobalConfig = {
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      analytics: { eventsPath: '/custom/path/events' },
    };

    expect(resolveEventsDir(config)).toBe('/custom/path/events');
  });

  it('should resolve eventsDir from globalConfig without custom eventsPath', () => {
    const config: GlobalConfig = {
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
    };

    const result = resolveEventsDir(config);
    expect(result).toContain('analytics');
    expect(result).toContain('events');
  });

  it('should parse since duration and compute correct time window', () => {
    const durationMs = parseSinceDuration('7d');
    const now = new Date('2026-02-18T12:00:00Z').getTime();
    const sinceMs = now - durationMs;

    expect(sinceMs).toBe(new Date('2026-02-11T12:00:00Z').getTime());
  });
});

describe('purge command logic', () => {
  let eventsDir: string;

  beforeEach(() => {
    eventsDir = join(tmpdir(), `takt-test-cli-purge-${Date.now()}`);
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(eventsDir, { recursive: true, force: true });
  });

  it('should purge files using eventsDir from config and retentionDays from config', () => {
    writeFileSync(join(eventsDir, '2025-12-01.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-18.jsonl'), '{}', 'utf-8');

    const retentionDays = 30;
    const deleted = purgeOldEvents(eventsDir, retentionDays, new Date('2026-02-18T12:00:00Z'));

    expect(deleted).toContain('2025-12-01.jsonl');
    expect(deleted).not.toContain('2026-02-18.jsonl');
  });

  it('should fallback to CLI retentionDays when config has no retentionDays', () => {
    writeFileSync(join(eventsDir, '2025-01-01.jsonl'), '{}', 'utf-8');

    const config: GlobalConfig = {
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      analytics: { eventsPath: eventsDir },
    };

    const cliRetentionDays = parseInt('30', 10);
    const retentionDays = config.analytics?.retentionDays ?? cliRetentionDays;
    const deleted = purgeOldEvents(resolveEventsDir(config), retentionDays, new Date('2026-02-18T12:00:00Z'));

    expect(deleted).toContain('2025-01-01.jsonl');
  });

  it('should use config retentionDays when specified', () => {
    writeFileSync(join(eventsDir, '2026-02-10.jsonl'), '{}', 'utf-8');
    writeFileSync(join(eventsDir, '2026-02-18.jsonl'), '{}', 'utf-8');

    const config: GlobalConfig = {
      language: 'en',
      defaultPiece: 'default',
      logLevel: 'info',
      analytics: { eventsPath: eventsDir, retentionDays: 5 },
    };

    const cliRetentionDays = parseInt('30', 10);
    const retentionDays = config.analytics?.retentionDays ?? cliRetentionDays;
    const deleted = purgeOldEvents(resolveEventsDir(config), retentionDays, new Date('2026-02-18T12:00:00Z'));

    expect(deleted).toContain('2026-02-10.jsonl');
    expect(deleted).not.toContain('2026-02-18.jsonl');
  });
});

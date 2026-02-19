/**
 * Tests for AnalyticsWriter — JSONL append, date rotation, ON/OFF toggle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import {
  initAnalyticsWriter,
  isAnalyticsEnabled,
  writeAnalyticsEvent,
} from '../features/analytics/index.js';
import type { MovementResultEvent, ReviewFindingEvent } from '../features/analytics/index.js';

describe('AnalyticsWriter', () => {
  let testDir: string;

  beforeEach(() => {
    resetAnalyticsWriter();
    testDir = join(tmpdir(), `takt-test-analytics-writer-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetAnalyticsWriter();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('ON/OFF toggle', () => {
    it('should not be enabled by default', () => {
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('should be enabled when initialized with enabled=true', () => {
      initAnalyticsWriter(true, testDir);
      expect(isAnalyticsEnabled()).toBe(true);
    });

    it('should not be enabled when initialized with enabled=false', () => {
      initAnalyticsWriter(false, testDir);
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('should not write when disabled', () => {
      initAnalyticsWriter(false, testDir);

      const event: MovementResultEvent = {
        type: 'movement_result',
        movement: 'plan',
        provider: 'claude',
        model: 'sonnet',
        decisionTag: 'done',
        iteration: 1,
        runId: 'run-1',
        timestamp: '2026-02-18T10:00:00.000Z',
      };

      writeAnalyticsEvent(event);

      const expectedFile = join(testDir, '2026-02-18.jsonl');
      expect(existsSync(expectedFile)).toBe(false);
    });
  });

  describe('event writing', () => {
    it('should append event to date-based JSONL file', () => {
      initAnalyticsWriter(true, testDir);

      const event: MovementResultEvent = {
        type: 'movement_result',
        movement: 'implement',
        provider: 'claude',
        model: 'sonnet',
        decisionTag: 'approved',
        iteration: 2,
        runId: 'run-abc',
        timestamp: '2026-02-18T14:30:00.000Z',
      };

      writeAnalyticsEvent(event);

      const filePath = join(testDir, '2026-02-18.jsonl');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8').trim();
      const parsed = JSON.parse(content) as MovementResultEvent;
      expect(parsed.type).toBe('movement_result');
      expect(parsed.movement).toBe('implement');
      expect(parsed.provider).toBe('claude');
      expect(parsed.decisionTag).toBe('approved');
    });

    it('should append multiple events to the same file', () => {
      initAnalyticsWriter(true, testDir);

      const event1: MovementResultEvent = {
        type: 'movement_result',
        movement: 'plan',
        provider: 'claude',
        model: 'sonnet',
        decisionTag: 'done',
        iteration: 1,
        runId: 'run-1',
        timestamp: '2026-02-18T10:00:00.000Z',
      };

      const event2: MovementResultEvent = {
        type: 'movement_result',
        movement: 'implement',
        provider: 'codex',
        model: 'o3',
        decisionTag: 'needs_fix',
        iteration: 2,
        runId: 'run-1',
        timestamp: '2026-02-18T11:00:00.000Z',
      };

      writeAnalyticsEvent(event1);
      writeAnalyticsEvent(event2);

      const filePath = join(testDir, '2026-02-18.jsonl');
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(lines[0]) as MovementResultEvent;
      const parsed2 = JSON.parse(lines[1]) as MovementResultEvent;
      expect(parsed1.movement).toBe('plan');
      expect(parsed2.movement).toBe('implement');
    });

    it('should create separate files for different dates', () => {
      initAnalyticsWriter(true, testDir);

      const event1: MovementResultEvent = {
        type: 'movement_result',
        movement: 'plan',
        provider: 'claude',
        model: 'sonnet',
        decisionTag: 'done',
        iteration: 1,
        runId: 'run-1',
        timestamp: '2026-02-17T23:59:00.000Z',
      };

      const event2: MovementResultEvent = {
        type: 'movement_result',
        movement: 'implement',
        provider: 'claude',
        model: 'sonnet',
        decisionTag: 'done',
        iteration: 2,
        runId: 'run-1',
        timestamp: '2026-02-18T00:01:00.000Z',
      };

      writeAnalyticsEvent(event1);
      writeAnalyticsEvent(event2);

      expect(existsSync(join(testDir, '2026-02-17.jsonl'))).toBe(true);
      expect(existsSync(join(testDir, '2026-02-18.jsonl'))).toBe(true);
    });

    it('should write review_finding events correctly', () => {
      initAnalyticsWriter(true, testDir);

      const event: ReviewFindingEvent = {
        type: 'review_finding',
        findingId: 'f-001',
        status: 'new',
        ruleId: 'no-any',
        severity: 'error',
        decision: 'reject',
        file: 'src/index.ts',
        line: 10,
        iteration: 1,
        runId: 'run-1',
        timestamp: '2026-03-01T08:00:00.000Z',
      };

      writeAnalyticsEvent(event);

      const filePath = join(testDir, '2026-03-01.jsonl');
      const content = readFileSync(filePath, 'utf-8').trim();
      const parsed = JSON.parse(content) as ReviewFindingEvent;
      expect(parsed.type).toBe('review_finding');
      expect(parsed.findingId).toBe('f-001');
      expect(parsed.ruleId).toBe('no-any');
    });
  });

  describe('directory creation', () => {
    it('should create events directory when enabled and dir does not exist', () => {
      const nestedDir = join(testDir, 'nested', 'analytics', 'events');
      expect(existsSync(nestedDir)).toBe(false);

      initAnalyticsWriter(true, nestedDir);

      expect(existsSync(nestedDir)).toBe(true);
    });

    it('should not create directory when disabled', () => {
      const nestedDir = join(testDir, 'disabled-dir', 'events');
      initAnalyticsWriter(false, nestedDir);

      expect(existsSync(nestedDir)).toBe(false);
    });
  });

  describe('resetInstance', () => {
    it('should reset to disabled state', () => {
      initAnalyticsWriter(true, testDir);
      expect(isAnalyticsEnabled()).toBe(true);

      resetAnalyticsWriter();
      expect(isAnalyticsEnabled()).toBe(false);
    });
  });
});

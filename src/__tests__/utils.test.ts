/**
 * Tests for takt utilities
 */

import { describe, it, expect } from 'vitest';
import { truncate, progressBar } from '../utils/ui.js';
import { generateSessionId, createSessionLog } from '../utils/session.js';

describe('truncate', () => {
  it('should not truncate short text', () => {
    const text = 'short';
    expect(truncate(text, 10)).toBe('short');
  });

  it('should truncate long text with ellipsis', () => {
    const text = 'this is a very long text';
    expect(truncate(text, 10)).toBe('this is...');
  });

  it('should handle exact length', () => {
    const text = '1234567890';
    expect(truncate(text, 10)).toBe('1234567890');
  });
});

describe('progressBar', () => {
  it('should show 0% for no progress', () => {
    const bar = progressBar(0, 100, 10);
    expect(bar).toContain('0%');
  });

  it('should show 100% for complete progress', () => {
    const bar = progressBar(100, 100, 10);
    expect(bar).toContain('100%');
  });

  it('should show intermediate progress', () => {
    const bar = progressBar(50, 100, 10);
    expect(bar).toContain('50%');
  });
});

describe('generateSessionId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    expect(id1).not.toBe(id2);
  });

  it('should generate string IDs', () => {
    const id = generateSessionId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should follow the new timestamp format', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/);
  });
});

describe('createSessionLog', () => {
  it('should create a session log with defaults', () => {
    const log = createSessionLog('test task', '/project', 'default');

    expect(log.task).toBe('test task');
    expect(log.projectDir).toBe('/project');
    expect(log.workflowName).toBe('default');
    expect(log.iterations).toBe(0);
    expect(log.status).toBe('running');
    expect(log.history).toEqual([]);
    expect(log.startTime).toBeDefined();
  });
});

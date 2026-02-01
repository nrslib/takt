/**
 * Unit tests for the mock scenario queue and loader.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ScenarioQueue,
  loadScenarioFile,
  setMockScenario,
  getScenarioQueue,
  resetScenario,
  type ScenarioEntry,
} from '../mock/scenario.js';

describe('ScenarioQueue', () => {
  it('should consume entries in order when no agent specified', () => {
    const queue = new ScenarioQueue([
      { status: 'done', content: 'first' },
      { status: 'done', content: 'second' },
    ]);

    expect(queue.consume('any-agent')?.content).toBe('first');
    expect(queue.consume('any-agent')?.content).toBe('second');
    expect(queue.consume('any-agent')).toBeUndefined();
  });

  it('should match agent-specific entries first', () => {
    const queue = new ScenarioQueue([
      { status: 'done', content: 'generic' },
      { agent: 'coder', status: 'done', content: 'coder response' },
      { status: 'done', content: 'second generic' },
    ]);

    // Coder should get its specific entry
    expect(queue.consume('coder')?.content).toBe('coder response');
    // Other agents get generic entries in order
    expect(queue.consume('reviewer')?.content).toBe('generic');
    expect(queue.consume('planner')?.content).toBe('second generic');
    expect(queue.remaining).toBe(0);
  });

  it('should fall back to unspecified entries when no agent match', () => {
    const queue = new ScenarioQueue([
      { agent: 'coder', status: 'done', content: 'coder only' },
      { status: 'done', content: 'fallback' },
    ]);

    // Reviewer has no specific entry -> gets the unspecified one
    expect(queue.consume('reviewer')?.content).toBe('fallback');
    // Coder still gets its own
    expect(queue.consume('coder')?.content).toBe('coder only');
    expect(queue.remaining).toBe(0);
  });

  it('should return undefined when queue is exhausted', () => {
    const queue = new ScenarioQueue([
      { status: 'done', content: 'only' },
    ]);

    queue.consume('agent');
    expect(queue.consume('agent')).toBeUndefined();
  });

  it('should track remaining count', () => {
    const queue = new ScenarioQueue([
      { status: 'done', content: 'a' },
      { status: 'done', content: 'b' },
      { status: 'done', content: 'c' },
    ]);

    expect(queue.remaining).toBe(3);
    queue.consume('x');
    expect(queue.remaining).toBe(2);
  });

  it('should not modify the original array', () => {
    const entries: ScenarioEntry[] = [
      { status: 'done', content: 'a' },
      { status: 'done', content: 'b' },
    ];

    const queue = new ScenarioQueue(entries);
    queue.consume('x');

    expect(entries).toHaveLength(2);
  });

  it('should handle mixed agent and unspecified entries correctly', () => {
    const queue = new ScenarioQueue([
      { agent: 'plan', status: 'done', content: '[PLAN:1]\nPlan done' },
      { agent: 'implement', status: 'done', content: '[IMPLEMENT:1]\nCode written' },
      { agent: 'ai_review', status: 'done', content: '[AI_REVIEW:1]\nNo issues' },
      { agent: 'supervise', status: 'done', content: '[SUPERVISE:1]\nAll good' },
    ]);

    expect(queue.consume('plan')?.content).toContain('[PLAN:1]');
    expect(queue.consume('implement')?.content).toContain('[IMPLEMENT:1]');
    expect(queue.consume('ai_review')?.content).toContain('[AI_REVIEW:1]');
    expect(queue.consume('supervise')?.content).toContain('[SUPERVISE:1]');
    expect(queue.remaining).toBe(0);
  });
});

describe('loadScenarioFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-scenario-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load valid scenario JSON', () => {
    const scenario = [
      { agent: 'plan', status: 'done', content: 'Plan done' },
      { status: 'blocked', content: 'Blocked' },
    ];
    const filePath = join(tempDir, 'scenario.json');
    writeFileSync(filePath, JSON.stringify(scenario));

    const entries = loadScenarioFile(filePath);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ agent: 'plan', status: 'done', content: 'Plan done' });
    expect(entries[1]).toEqual({ agent: undefined, status: 'blocked', content: 'Blocked' });
  });

  it('should default status to "done" if omitted', () => {
    const scenario = [{ content: 'Simple response' }];
    const filePath = join(tempDir, 'scenario.json');
    writeFileSync(filePath, JSON.stringify(scenario));

    const entries = loadScenarioFile(filePath);

    expect(entries[0].status).toBe('done');
  });

  it('should throw for non-existent file', () => {
    expect(() => loadScenarioFile('/nonexistent/file.json')).toThrow('Scenario file not found');
  });

  it('should throw for invalid JSON', () => {
    const filePath = join(tempDir, 'bad.json');
    writeFileSync(filePath, 'not json at all');

    expect(() => loadScenarioFile(filePath)).toThrow('not valid JSON');
  });

  it('should throw for non-array JSON', () => {
    const filePath = join(tempDir, 'object.json');
    writeFileSync(filePath, '{"key": "value"}');

    expect(() => loadScenarioFile(filePath)).toThrow('must contain a JSON array');
  });

  it('should throw for entry without content', () => {
    const filePath = join(tempDir, 'no-content.json');
    writeFileSync(filePath, '[{"status": "done"}]');

    expect(() => loadScenarioFile(filePath)).toThrow('must have a "content" string');
  });

  it('should throw for invalid status', () => {
    const filePath = join(tempDir, 'bad-status.json');
    writeFileSync(filePath, '[{"content": "test", "status": "invalid"}]');

    expect(() => loadScenarioFile(filePath)).toThrow('invalid status');
  });
});

describe('setMockScenario / getScenarioQueue / resetScenario', () => {
  afterEach(() => {
    resetScenario();
  });

  it('should set and retrieve scenario queue', () => {
    setMockScenario([
      { status: 'done', content: 'test' },
    ]);

    const queue = getScenarioQueue();
    expect(queue).not.toBeNull();
    expect(queue!.remaining).toBe(1);
  });

  it('should return null when no scenario is set', () => {
    expect(getScenarioQueue()).toBeNull();
  });

  it('should clear scenario when null is passed', () => {
    setMockScenario([{ status: 'done', content: 'test' }]);
    setMockScenario(null);

    expect(getScenarioQueue()).toBeNull();
  });

  it('should reset scenario state', () => {
    setMockScenario([{ status: 'done', content: 'test' }]);
    resetScenario();

    expect(getScenarioQueue()).toBeNull();
  });
});

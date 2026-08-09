import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callMock } from '../infra/mock/client.js';
import { loadScenarioFile, resetScenario, setMockScenario } from '../infra/mock/scenario.js';

describe('CT-COMP-12 mock provider companion scenarios', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-companion-mock-'));
  });

  afterEach(() => {
    resetScenario();
    rmSync(cwd, { recursive: true, force: true });
  });

  function load(entries: unknown[]) {
    const path = join(cwd, 'scenario.json');
    writeFileSync(path, JSON.stringify(entries), 'utf-8');
    return loadScenarioFile(path);
  }

  it('should parse, emit, and apply deterministic tool events and cwd-relative file writes', async () => {
    const scenario = load([{
      persona: 'coder',
      content: 'implementation complete',
      stream_events: [{
        type: 'tool_use',
        tool: 'Edit',
        id: 'tool-1',
        input: { file_path: 'src/a.ts' },
      }],
      file_writes: [{ path: 'src/a.ts', content: 'changed\n' }],
    }]);
    setMockScenario(scenario);
    const onStream = vi.fn();

    await callMock('coder', 'implement', { cwd, onStream });

    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_use',
      data: { tool: 'Edit', id: 'tool-1', input: { file_path: 'src/a.ts' } },
    });
    expect(readFileSync(join(cwd, 'src', 'a.ts'), 'utf-8')).toBe('changed\n');
  });

  it.each([
    ['absolute path', '/tmp/escape.ts'],
    ['parent traversal', '../escape.ts'],
  ])('should reject a %s file write outside the test cwd', async (_label, path) => {
    setMockScenario(load([{
      content: 'unsafe write',
      file_writes: [{ path, content: 'escape' }],
    }]));

    await expect(callMock('coder', 'implement', { cwd })).rejects.toThrow(/file_writes|cwd|path/i);
  });

  it('should reject a file write that escapes through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'takt-companion-mock-outside-'));
    symlinkSync(outside, join(cwd, 'linked'));
    setMockScenario(load([{
      content: 'unsafe write',
      file_writes: [{ path: 'linked/escape.ts', content: 'escape' }],
    }]));

    try {
      await expect(callMock('coder', 'implement', { cwd })).rejects.toThrow(/symlink|cwd|path/i);
      expect(existsSync(join(outside, 'escape.ts'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('should match companion calls by explicit name without consuming coder entries', async () => {
    setMockScenario(load([
      { persona: 'coder', content: 'coder response' },
      {
        persona: 'security-reviewer',
        content: 'review response',
        structured_output: { findings: [], updates: [] },
      },
    ]));

    const review = await callMock('security-reviewer', 'review', { cwd });
    const coder = await callMock('coder', 'implement', { cwd });

    expect(review.content).toBe('review response');
    expect(review.structuredOutput).toEqual({ findings: [], updates: [] });
    expect(coder.content).toBe('coder response');
  });
});

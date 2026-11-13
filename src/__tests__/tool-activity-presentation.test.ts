import { describe, expect, it } from 'vitest';
import { groupToolActivities, projectToolActivity, toolActivityDetail } from '../shared/tool-activity/index.js';
import type { ToolActivityEntry } from '../shared/tool-activity/index.js';
import { stableToolResultPrefix } from '../shared/tool-activity/result.js';
import { CI_RESULT_BYTES, CI_RESULT_LINES, COMPACT_INPUT_BYTES, COMPACT_RESULT_BYTES, DETAIL_RESULT_BYTES } from '../shared/tool-activity/presentation.js';
import { MAX_TRACKED_SENSITIVE_VALUES } from '../shared/utils/sensitiveText.js';

function entry(overrides: Partial<ToolActivityEntry> = {}): ToolActivityEntry {
  return {
    key: '1', toolId: 'item_0', tool: 'Bash', input: { command: 'printf ready' },
    output: '', result: 'ready', status: 'success', association: 'matched', startedAt: 1000, completedAt: 1250,
    ...overrides,
  };
}

describe('tool activity presentation', () => {
  it('should fail closed when display secret collection exceeds its candidate budget', () => {
    const token = Array.from({ length: MAX_TRACKED_SENSITIVE_VALUES + 1 }, (_, index) => `private-${index}`);
    const value = entry({ input: { token }, result: 'ready private-0' });
    expect(projectToolActivity(value).result.text).toBe('[REDACTED]');
  });

  it.each(['secret123', 'sec\x1b[31mret123', 'sec\rret123'])('should protect terminal-normalized secrets from input %j in every result page', (token) => {
    for (const text of ['ready secret123', 'ready sec\x1b[31mret123\x1b[0m', 'ready sec\rret123']) {
      for (const result of [text, JSON.stringify({ stdout: text })]) {
        const value = entry({ input: { command: 'printf ready', token }, result });
        const original = structuredClone(value);
        for (const page of [projectToolActivity(value).result, projectToolActivity(value, 'expanded').result, toolActivityDetail(value)]) {
          expect(page.text).toBe('ready [REDACTED]');
          expect(page.text).not.toMatch(/secret123|\x1b|\r/u);
        }
        expect(value).toEqual(original);
      }
    }
  });

  it.each([
    ['ready', 'ready'],
    ['[REDACTED] ready', '[REDACTED] ready'],
    ['["[REDACTED] ready"]', '[structured output omitted]'],
    ['{"stdout":"[REDACTED] ready"}', '[REDACTED] ready'],
    ['{"private_blob":"[REDACTED] ready"}', '[structured output omitted]'],
    ['{"stdout":"[REDACTED] ready"', '[structured output omitted]'],
  ])('should classify completed masked text while preserving structured selection: %s', (result, expected) => {
    for (const value of [entry({ result }), entry({ result: '', output: result })]) {
      for (const page of [projectToolActivity(value).result, projectToolActivity(value, 'expanded').result, toolActivityDetail(value)]) {
        expect(page.text).toBe(expected);
      }
    }
  });

  it('should defer an incomplete terminal control prefix until its terminator arrives', () => {
    expect(stableToolResultPrefix('ready\x1b]52;c;private')).toBe('ready');
    expect(stableToolResultPrefix('ready\x1b[32')).toBe('ready');
    expect(stableToolResultPrefix('ready\x1b]52;c;private\x07')).toBe('ready\x1b]52;c;private\x07');
  });
  it('should retain complete CSI sequences before streamed output', () => {
    const output = '\x1b[32mready\x1b[0m';

    expect(stableToolResultPrefix(output)).toBe(output);
    expect(stableToolResultPrefix(`${output}\x1b[3`)).toBe(output);
  });
  it('should retain reception order and observed times in individual and grouped projections', () => {
    const values = [
      entry({ key: 'first', startSequence: 1, completionSequence: 4, status: 'failure' }),
      entry({ key: 'second', startSequence: 2, completionSequence: 3 }),
    ];
    const expected = [
      { key: 'first', startSequence: 1, completionSequence: 4, status: 'failure', startedAt: 1000, completedAt: 1250, durationMs: 250 },
      { key: 'second', startSequence: 2, completionSequence: 3, status: 'success', startedAt: 1000, completedAt: 1250, durationMs: 250 },
    ];
    expect(values.map((value) => projectToolActivity(value))).toMatchObject(expected);
    expect(groupToolActivities(values).flatMap((group) => group.entries)).toMatchObject(expected);
  });

  it.each([
    ['MCP text', '{"content":[{"type":"text","text":"ready"}],"structured_content":null}', 'ready'],
    ['mixed MCP blocks', '{"stdout":"first","content":[{"type":"image","data":"private-image"},{"type":"text","text":"ready"},{"type":"text","text":4}]}', 'first\nready'],
    ['unknown field', '{"private_blob":[{"type":"text","text":"ready"}]}', '[structured output omitted]'],
    ['empty MCP', '{"content":[]}', '[structured output omitted]'],
    ['escaped key', '{"stdout":"ready secret123","api\\u005fkey":"secret123"}', 'ready [REDACTED]'],
    ['ANSI JSON', '\x1b[32m{"stdout":"ready secret123","api\\u005fkey":"secret123"}\x1b[0m', 'ready [REDACTED]'],
    ['info log', '[INFO] ready\n', '[INFO] ready'],
    ['error log', '[ERROR] failed', '[ERROR] failed'],
    ['incomplete JSON array', '[{"token":"secret123"', '[structured output omitted]'],
  ])('should safely select %s in compact, expanded and detail projections', (_name, result, expected) => {
    const value = entry({ result });
    const original = structuredClone(value);
    for (const page of [projectToolActivity(value).result, projectToolActivity(value, 'expanded').result, toolActivityDetail(value)]) {
      expect(page.text).toBe(expected);
      expect(page.text).not.toContain('secret123');
      expect(page.text).not.toContain('private-image');
      expect(page.text).not.toContain('\x1b');
    }
    expect(value).toEqual(original);
  });

  it.each([
    '[main 1a2b3c4] fix: keep tool history',
    '[1/3] Building\n[2/3] Linking',
    '[vitest] running 3 files',
    '{not json}',
  ])('should display finished output that starts with a bracket but is not JSON as text: %s', (result) => {
    const value = entry({ result });
    for (const page of [projectToolActivity(value).result, projectToolActivity(value, 'expanded').result, toolActivityDetail(value)]) {
      expect(page.text).toBe(result);
    }
  });

  it('should hold back unparsable bracketed output while the tool is still running', () => {
    expect(projectToolActivity(entry({ status: 'running', result: undefined, output: '{"stdout":"partial' })).result.text)
      .toBe('[structured output omitted]');
  });

  it.each([
    { tool: 'Bash', input: { command: 'npm test' }, action: 'Ran', expected: 'npm test' },
    { tool: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'summarize' }, action: 'WebFetch', expected: 'https://example.com/a' },
    { tool: 'Task', input: { description: 'investigate history', prompt: 'long prompt' }, action: 'Task', expected: 'investigate history' },
    { tool: 'Skill', input: { skill: 'coding' }, action: 'Skill', expected: 'coding' },
    { tool: 'Custom', input: { attempts: 3 }, action: 'Custom', expected: '3' },
    { tool: 'Custom', input: { api_key: 'secret123' }, action: 'Custom', expected: '[REDACTED]' },
    { tool: 'Read', input: { file_path: '日本語.ts' }, action: 'Read', expected: '日本語.ts' },
    { tool: 'Grep', input: { pattern: 'target.*' }, action: 'Used Grep', expected: 'target.*' },
    { tool: 'Edit', input: { file_path: 'file.ts', old_string: 'private edit body' }, action: 'Edit', expected: 'file.ts' },
    { tool: 'bash', input: { command: 'npm test' }, action: 'Ran', expected: 'npm test' },
    { tool: 'read', input: { filePath: '日本語.ts' }, action: 'Read', expected: '日本語.ts' },
    { tool: 'edit', input: { filePath: 'file.ts', oldString: 'private edit body' }, action: 'Edit', expected: 'file.ts' },
    { tool: 'grep', input: { pattern: 'target.*' }, action: 'Used Grep', expected: 'target.*' },
  ])('should select meaningful input and action for $tool', ({ tool, input, action, expected }) => {
    expect(projectToolActivity(entry({ tool, input }))).toMatchObject({ action, input: expected, status: 'success', durationMs: 250 });
  });

  it('should return at most three compact result lines with continuation metadata', () => {
    const value = projectToolActivity(entry({ result: 'one\ntwo\nthree\nfour' }));
    expect(value.result.text.split('\n')).toEqual(['one', 'two', 'three']);
    expect(value.result).toMatchObject({ truncated: true, hasMore: true });
  });

  it('should group the same read operation across provider spellings while retaining both paths', () => {
    const reads = [entry({ tool: 'read', input: { filePath: '日本語.ts' } }), entry({ tool: 'Read', input: { file_path: 'other.ts' } })];
    expect(groupToolActivities(reads)).toEqual([expect.objectContaining({ summary: 'Read 2 files', entries: expect.any(Array) })]);
    expect(groupToolActivities(reads)[0]!.entries.map((item) => item.input)).toEqual(['日本語.ts', 'other.ts']);
  });

  it('should not invent content or execution time for missing result and start', () => {
    const value = projectToolActivity(entry({ result: '', startedAt: undefined }));
    expect(value.result).toMatchObject({ text: '', truncated: false, hasMore: false });
    expect(value.durationMs).toBeUndefined();
  });

  it('should group five consecutive reads without losing individual targets and results', () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry({ key: String(index), tool: 'Read', input: { file_path: `${index}.ts` }, result: `result-${index}` }));
    const original = structuredClone(entries);
    const groups = groupToolActivities(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.summary).toBe('Read 5 files');
    expect(groups[0]!.entries.map((item) => [item.input, item.result.text])).toEqual(entries.map((item) => [item.input.file_path, item.result]));
    expect(entries).toEqual(original);
    expect(groupToolActivities([entries[0]!, entry(), entries[1]!])).toHaveLength(3);
  });

  it('should expose finite successive pages without dropping or repeating lines', () => {
    const value = entry({ result: '一\n二\n三\n四\n五\n六' });
    const first = toolActivityDetail(value, 0, 3, 1024);
    const second = toolActivityDetail(value, first.nextOffset, 3, 1024);
    expect(first).toMatchObject({ text: '一\n二\n三', hasMore: true });
    expect(second).toMatchObject({ text: '四\n五\n六', hasMore: false });
    expect(toolActivityDetail(value, second.nextOffset).text).toBe('');
  });

  it('should keep different tool identities separate when sanitizing their labels produces the same text', () => {
    const groups = groupToolActivities([
      entry({ tool: 'secret-first', input: { api_key: 'secret-first' } }),
      entry({ tool: 'secret-second', input: { api_key: 'secret-second' } }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries[0]!.tool).toBe(groups[1]!.entries[0]!.tool);
    expect(groups.map((group) => group.entries.length)).toEqual([1, 1]);
  });

  it.each(['compact', 'expanded'] as const)('should redact structured secrets and controls for %s projection without changing raw history', (mode) => {
    const value = entry({ input: { command: 'printf ready secret123\x1b[2J', api_key: 'secret123' }, result: '{"stdout":"ready\\nsecret123","token":"secret456"}' });
    const original = structuredClone(value);
    const projection = projectToolActivity(value, mode);
    expect(projection.input).toContain('printf ready');
    expect(projection.result.text).toContain('ready');
    for (const text of [projection.input, projection.result.text, toolActivityDetail(value).text]) {
      for (const secret of ['secret123', 'secret456']) expect(text).not.toContain(secret);
      expect(text).not.toContain('\x1b');
    }
    expect(value).toEqual(original);
  });

  it.each(['compact', 'expanded'] as const)('should redact tool and action labels before stripping terminal controls in %s mode', (mode) => {
    const secret = 'private\x1b[31mlabel';
    const value = entry({ tool: secret, input: { api_key: secret } });
    const projection = projectToolActivity(value, mode);
    for (const label of [projection.tool, projection.action]) {
      expect(label).toBe('[REDACTED]');
      expect(label).not.toContain('privatelabel');
    }
    expect(value.tool).toBe(secret);
  });

  it.each([
    '{"private_blob":{"text":"do-not-display"}}',
    '[{"token":"secret123"}]',
    '{"token":"secret123',
    '{"stdout":"ready secret123","api\\u005fkey":"secret123"}',
  ])('should not expose unselected structures or encoded secret keys: %s', (result) => {
    const value = entry({ result });
    for (const text of [projectToolActivity(value).result.text, projectToolActivity(value, 'expanded').result.text, toolActivityDetail(value).text]) {
      expect(text).not.toContain('do-not-display');
      expect(text).not.toContain('secret123');
      expect(text).not.toContain(result);
    }
  });

  it('should limit a giant single Japanese line by bytes and continue without broken characters', () => {
    const result = '日本語😀'.repeat(10_000);
    const value = entry({ result });
    const compact = projectToolActivity(value);
    expect(Buffer.byteLength(compact.result.text)).toBeLessThanOrEqual(COMPACT_RESULT_BYTES);
    const first = toolActivityDetail(value, 0, 3, 32);
    const second = toolActivityDetail(value, first.nextOffset, 3, 32);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(32);
    expect(first.text + second.text).toBe(result.slice(0, second.nextOffset));
    expect(first.hasMore).toBe(true);
    expect(first.text).not.toContain('�');
  });

  it('should use independent CI line and byte limits with explicit truncation metadata', () => {
    const value = entry({ result: Array.from({ length: CI_RESULT_LINES + 1 }, (_, index) => String(index)).join('\n') });
    expect(projectToolActivity(value).result.text.split('\n')).toHaveLength(3);
    const expanded = projectToolActivity(value, 'expanded');
    expect(expanded.result.text.split('\n')).toHaveLength(CI_RESULT_LINES);
    expect(expanded.result.truncated).toBe(true);
    const giant = projectToolActivity(entry({ result: 'x'.repeat(CI_RESULT_BYTES + 1) }), 'expanded');
    expect(Buffer.byteLength(giant.result.text)).toBeLessThanOrEqual(CI_RESULT_BYTES);
    expect(giant.result.hasMore).toBe(true);
    expect(toolActivityDetail(entry({ result: 'x'.repeat(DETAIL_RESULT_BYTES * 2) }), 0, 1000, 1_000_000).text.length).toBeLessThanOrEqual(DETAIL_RESULT_BYTES);
  });

  it('should retain output-only results and keep huge commands finite', () => {
    const projection = projectToolActivity(entry({ result: '', output: 'output-only', input: { command: '日本語'.repeat(10_000) } }), 'expanded');
    expect(projection.result.text).toBe('output-only');
    expect(Buffer.byteLength(projection.input)).toBeLessThanOrEqual(DETAIL_RESULT_BYTES);
    expect(projection.input).toContain('truncated');
  });

  it('should bound unknown tool and action names without losing the result', () => {
    const projection = projectToolActivity(entry({ tool: 'Custom' + '日'.repeat(10_000) }), 'expanded');
    for (const label of [projection.tool, projection.action]) {
      expect(Buffer.byteLength(label)).toBeLessThanOrEqual(COMPACT_INPUT_BYTES);
      expect(label).toContain('Custom');
      expect(label).toContain('[name truncated]');
      expect(label).not.toContain('�');
    }
    expect(projection.result.text).toBe('ready');
  });
});

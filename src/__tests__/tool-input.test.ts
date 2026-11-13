import { describe, expect, it } from 'vitest';
import { formatToolInput } from '../shared/ui/toolInput.js';

describe('tool input summaries', () => {
  it.each([
    { tool: 'Bash', input: { description: 'wrong field', command: 'npm test' }, expected: 'npm test' },
    { tool: 'Read', input: { offset: 4, file_path: 'src/read.ts' }, expected: 'src/read.ts' },
    { tool: 'Edit', input: { old_string: 'old text', file_path: 'src/edit.ts' }, expected: 'src/edit.ts' },
    { tool: 'Write', input: { content: 'file contents', file_path: 'src/write.ts' }, expected: 'src/write.ts' },
    { tool: 'Grep', input: { path: 'wrong path', pattern: 'target.*' }, expected: 'target.*' },
    { tool: 'Glob', input: { path: 'wrong path', pattern: '**/*.ts' }, expected: '**/*.ts' },
    { tool: 'Custom', input: { query: 'first value', other: 'second value' }, expected: 'first value' },
    { tool: 'Custom', input: {}, expected: '' },
  ])('should select the workflow summary field for $tool', ({ tool, input, expected }) => {
    expect(formatToolInput(tool, input)).toBe(expected);
  });

  it.each([
    { tool: 'Bash', key: 'command', limit: 60 },
    { tool: 'Read', key: 'file_path', limit: 60 },
    { tool: 'Custom', key: 'query', limit: 50 },
  ])('should preserve the existing length boundary for $tool', ({ tool, key, limit }) => {
    expect(formatToolInput(tool, { [key]: 'x'.repeat(limit) })).toBe('x'.repeat(limit));
    expect(formatToolInput(tool, { [key]: 'x'.repeat(limit + 1) })).toBe(`${'x'.repeat(limit - 3)}...`);
  });

  it('should normalize whitespace and sanitize terminal sequences before truncating', () => {
    const command = `first   second\n\t\x1b[31mthird\x1b[0m ${'x'.repeat(70)}`;
    expect(formatToolInput('Bash', { command })).toBe(`first second third ${'x'.repeat(38)}...`);
  });

  it('should redact known secrets before shortening a command without changing the input', () => {
    const secret = 'test-only-secret-value-that-crosses-the-preview-boundary';
    const input = { command: `printf ready ${secret}`, api_key: secret };
    const original = structuredClone(input);

    const preview = formatToolInput('Bash', input);

    expect(preview).toContain('printf ready');
    expect(preview).toContain('[REDACTED]');
    expect(preview).not.toContain('test-only-secret');
    expect(input).toEqual(original);
  });

  it('should remove ANSI sequences before matching known secrets in a command', () => {
    const secret = 'secret123';
    const preview = formatToolInput('Bash', { command: `printf sec\x1b[31mret123`, api_key: secret });

    expect(preview).not.toContain(secret);
    expect(preview).toContain('[REDACTED]');
  });

  it.each([
    { api_key: 'test-only-key', query: 'safe search' },
    { private_blob: { text: 'unselected content' }, query: 'safe search' },
  ])('should select a safe field for an unknown tool instead of its first field', (input) => {
    expect(formatToolInput('Custom', input)).toBe('safe search');
  });

  it.each([
    { input: { url: 'https://example.com/page', prompt: 'summarize' }, expected: 'https://example.com/page' },
    { input: { api_key: 'test-only-key' }, expected: '[REDACTED]' },
    { input: { items: ['first item'] }, expected: 'first item' },
  ])('should show the first input value of an unknown tool without a summary field: $expected', ({ input, expected }) => {
    expect(formatToolInput('Custom', input)).toBe(expected);
  });
});

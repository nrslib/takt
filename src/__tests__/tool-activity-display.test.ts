import { describe, expect, it } from 'vitest';
import { resolveToolActivityDisplayMode, ToolActivityDisplay } from '../shared/ui/ToolActivityDisplay.js';
import { CI_RESULT_LINES, COMPACT_RESULT_BYTES, COMPACT_RESULT_LINES } from '../shared/tool-activity/presentation.js';

describe('tool activity display', () => {
  it('should include completed secret fields when projecting buffered structured output', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '{"stdout":"ready secret123"}' } });
    expect(output).toEqual([]);
    display.handle({ type: 'tool_result', data: { id: 'a', content: '{"stdout":"ready secret123","api\\u005fkey":"secret123"}', isError: false } });
    expect(output).toContain('  │ ready [REDACTED]');
    expect(output.join('\n')).not.toContain('secret123');
    expect(output.filter((line) => line.includes('ready'))).toHaveLength(1);
  });

  it('should keep structured output budgets and avoid repeating a final projection after an incomplete flush', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '{"stdout":' } });
    display.flush();
    expect(output).toContain('  │ [structured output omitted]');
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '"ready"}' } });
    display.flush();
    display.handle({ type: 'tool_result', data: { id: 'a', content: '{"stdout":"ready"}', isError: false } });
    expect(output.filter((line) => line.includes('ready'))).toEqual(['  │ ready']);

    const bounded: string[] = [];
    const large = new ToolActivityDisplay('compact', false, (line) => bounded.push(line), false);
    const content = JSON.stringify({ stdout: 'one\ntwo\nthree\nfour' });
    large.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    large.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: content } });
    large.flush();
    large.flush();
    large.handle({ type: 'tool_result', data: { id: 'a', content, isError: false } });
    expect(bounded.filter((line) => line.startsWith('  │ '))).toEqual(['  │ one', '  │ two', '  │ three']);
    expect(bounded.filter((line) => line.includes('[output truncated; more available]'))).toHaveLength(1);
  });

  it.each(['compact', 'expanded'] as const)('should safely flush ANSI JSON chunks in %s mode without completing the tool', (mode) => {
    for (const chunks of [
      ['\x1b[32m{"stdout":"ready secret123","api\\u005fkey":"secret123"}\x1b[0m'],
      ['\x1b[', '32m', '{"stdout":"ready secret', '123","api\\u005fkey":"secret123"}', '\x1b[0', 'm'],
    ]) {
      const output: string[] = [];
      const display = new ToolActivityDisplay(mode, false, (line) => output.push(line), false);
      display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf ready' } } });
      for (const chunk of chunks) {
        const event = { type: 'tool_output' as const, data: { id: 'a', tool: 'Bash', output: chunk } };
        const original = structuredClone(event);
        display.handle(event);
        display.flush();
        expect(output.join('\n')).not.toMatch(/secret123|api\\u005fkey|\x1b/u);
        expect(event).toEqual(original);
      }
      display.flush();
      display.flush();
      expect(output.join('\n')).toContain('ready');
      expect(output.join('\n')).not.toMatch(/secret123|api\\u005fkey|\x1b/u);
      expect(output.filter((line) => line.includes('ready') && line.startsWith('  │ '))).toHaveLength(1);
      expect(display.history.entries()[0]).toMatchObject({ output: chunks.join(''), status: 'running' });
      display.handle({ type: 'tool_result', data: { id: 'a', content: chunks.join(''), isError: false } });
      expect(output.filter((line) => line.includes('ready') && line.startsWith('  │ '))).toHaveLength(1);
    }
  });

  it.each([
    ['[INFO] ready\n'],
    ['[IN', 'FO] ready\n'],
    ['\x1b[', '32m[IN', 'FO] ready\n', '\x1b[0', 'm'],
  ])('should retain a split log prefix once for chunks %j', (...chunks) => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    for (const chunk of chunks) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
      display.flush();
    }
    display.flush();
    display.handle({ type: 'tool_result', data: { id: 'a', content: chunks.join(''), isError: false } });
    expect(output.filter((line) => line.startsWith('  │ '))).toEqual(['  │ [INFO] ready']);
    expect(output.at(-1)).toBe('  ✓ Bash');
  });

  it.each([
    ['done '],
    ['first-', 'second-', 'third '],
    ['first \n', 'second \n'],
  ])('should not repeat compact output after flushing chunks %j', (...chunks) => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    for (const chunk of chunks) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
      display.flush();
    }
    display.handle({ type: 'tool_result', data: { id: 'a', content: chunks.join(''), isError: false } });
    expect(output.filter((line) => line.startsWith('  │ ')).map((line) => line.slice(4))).toEqual(chunks.map((chunk) => chunk.replace(/\n$/u, '')));
    expect(output.at(-1)).toBe('  ✓ Bash');
    expect(display.history.entries()[0]!.status).toBe('success');
  });

  it('should retain the compact line budget across partial-line flushes', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    const chunks = Array.from({ length: COMPACT_RESULT_LINES + 1 }, (_, index) => `part-${index}`);
    for (const chunk of chunks) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
      display.flush();
    }
    display.handle({ type: 'tool_result', data: { id: 'a', content: chunks.join(''), isError: false } });
    expect(output.filter((line) => line.startsWith('  │ '))).toHaveLength(COMPACT_RESULT_LINES);
    expect(output).toContain('  [output truncated; more available]');
  });

  it('should retain the compact byte budget including rendered line breaks across flushes', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    const chunks = ['x'.repeat(COMPACT_RESULT_BYTES - 1), 'y'];
    for (const chunk of chunks) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
      display.flush();
    }
    display.handle({ type: 'tool_result', data: { id: 'a', content: chunks.join(''), isError: false } });
    expect(output.filter((line) => line.startsWith('  │ '))).toEqual([`  │ ${chunks[0]}`]);
    expect(output).toContain('  [output truncated; more available]');
  });

  it('should not repeat a partial line across multiple flushes and completion', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    for (const chunk of ['first-', 'second-', 'third']) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
      display.flush();
    }
    display.handle({ type: 'tool_result', data: { id: 'a', content: 'first-second-third', isError: false } });
    expect(output.filter((line) => line.startsWith('  │ ')).map((line) => line.slice(4))).toEqual(['first-', 'second-', 'third']);
    expect(display.history.entries()[0]!.status).toBe('success');
  });

  it('should record omission when a later result exceeds an already displayed full page', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    const page = Array.from({ length: CI_RESULT_LINES }, (_, index) => `row-${index}`).join('\n');
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: page } });
    display.flush();
    expect(output.join('\n')).not.toContain('[output truncated; more available]');
    display.handle({ type: 'tool_result', data: { id: 'a', content: page + '\nrow-extra', isError: false } });
    expect(output.filter((line) => line.startsWith('  │ '))).toHaveLength(CI_RESULT_LINES);
    expect(output.join('\n')).toContain(`row-${CI_RESULT_LINES - 1}`);
    expect(output.join('\n')).not.toContain('row-extra');
    expect(output.filter((line) => line.includes('[output truncated; more available]'))).toHaveLength(1);
  });

  it('should apply the shared name limit to a compact streamed output header', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf ready' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Custom' + '日'.repeat(10_000), output: 'ready\n' } });
    display.flush();
    expect(output.join('\n')).toContain('ready');
    expect(output.join('\n')).toContain('[name truncated]');
    expect(Buffer.byteLength(output.join('\n'))).toBeLessThan(1024);
  });

  it('should sanitize the stored tool label when an output event has no label', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'test-secret-label', input: { api_key: 'test-secret-label' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: '', output: 'ready\n' } });
    display.flush();
    expect(output.join('\n')).toContain('ready');
    expect(output.join('\n')).not.toContain('test-secret-label');
  });

  it('should suppress structured streaming output even when its opening token follows a whitespace chunk', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Read', input: { file_path: 'safe.txt' } } });
    for (const chunk of ['\n ', '{"privateField":"must-stay-private"}\n']) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Read', output: chunk } });
    }
    display.flush();
    display.handle({ type: 'tool_result', data: { id: 'a', content: '', isError: false } });
    expect(output.join('\n')).toContain('structured output omitted');
    expect(output.join('\n')).not.toContain('must-stay-private');
  });

  it.each([
    { outputMode: 'silent' as const, expanded: true, expected: 'silent' },
    { outputMode: 'terminal' as const, expanded: true, expected: 'expanded' },
    { outputMode: 'terminal' as const, expanded: false, expected: 'compact' },
  ])('should resolve $outputMode with expanded=$expanded at the display boundary', ({ outputMode, expanded, expected }) => {
    expect(resolveToolActivityDisplayMode(outputMode, expanded)).toBe(expected);
  });

  it('should retain running status on flush and emit a later result only once', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'unique-output' } });
    display.flush();
    expect(display.history.entries()[0]!.status).toBe('running');
    expect(output.join('\n')).toContain('unique-output');
    display.handle({ type: 'tool_result', data: { id: 'a', content: 'unique-output', isError: false } });
    display.flush();
    expect(output.join('\n').match(/unique-output/g)).toHaveLength(1);
    expect(display.history.entries()[0]!.status).toBe('success');
  });

  it('should keep additional completed output after a running output flush', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'first-line' } });
    display.flush();
    display.handle({ type: 'tool_result', data: { id: 'a', content: 'first-line\nsecond-line', isError: false } });
    expect(output.join('\n').match(/first-line/g)).toHaveLength(1);
    expect(output.join('\n')).toContain('second-line');
  });

  it('should keep isError authoritative when successful content contains the word Error', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf done' } } });
    display.handle({ type: 'tool_result', data: { id: 'a', content: 'Error: this is diagnostic text', isError: false } });
    expect(display.history.entries()[0]!.status).toBe('success');
    expect(output.join('\n')).toContain('✓');
    expect(output.join('\n')).not.toContain('✗');
  });
});

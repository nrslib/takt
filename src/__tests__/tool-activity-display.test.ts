import { describe, expect, it, vi } from 'vitest';
import { resolveToolActivityDisplayMode, ToolActivityDisplay } from '../shared/ui/ToolActivityDisplay.js';
import { CI_RESULT_LINES, COMPACT_RESULT_BYTES, COMPACT_RESULT_LINES, DETAIL_RESULT_LINES } from '../shared/tool-activity/presentation.js';
import type { ToolActivityEntry } from '../shared/tool-activity/types.js';
import * as resultUtils from '../shared/tool-activity/result.js';
import { RunningToolResult } from '../shared/tool-activity/runningResult.js';
import { sanitizeSensitiveTextWithKnownValues } from '../shared/utils/sensitiveText.js';
import { scenarioText, secretFragmentsIn, splitSecretScenarios } from './helpers/split-secret-scenarios.js';

const turn = { operationId: 'turn', generation: 1 };

function startedEntry(input: Record<string, unknown>): ToolActivityEntry {
  return { key: '1', context: { callId: 'call', ...turn }, toolId: 'build', tool: 'Bash',
    input, output: '', status: 'running', association: 'matched', startedAt: 1000, startSequence: 1 };
}

function startedDisplay(input: Record<string, unknown>): ToolActivityDisplay {
  const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
  display.handle({ type: 'tool_use', data: { id: 'build', tool: 'Bash', input } });
  return display;
}

function appendOutput(display: ToolActivityDisplay, output: string): void {
  display.handle({ type: 'tool_output', data: { id: 'build', tool: 'Bash', output } });
}

describe('tool activity display', () => {
  it.each([
    '{"x":"\\u1234\\n\\\"\\\\", "data":[null,true,false,-1.25e+3,0,[],{}]}',
    '[{"empty":{}},[],0,-0,1e-2,12.5,true,false,null]',
  ])('keeps every valid JSON prefix structured: %s', (raw) => {
    const result = new RunningToolResult();
    for (let end = 1; end <= raw.length; end++) {
      const entry = { ...startedEntry({}), output: raw.slice(0, end) };
      result.read(entry);
      expect(result.preview(entry).text).toBe('');
    }
    expect(resultUtils.classifyToolResult(raw).kind).toBe('structured');
  });

  it.each([{}, { token: 'unrelated-credential' }])('flushes a compact unterminated output while the tool is still running with input %j', (input) => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'ready', tool: 'Bash', input: { command: 'printf ready; sleep 60', ...input } } });
    display.handle({ type: 'tool_output', data: { id: 'ready', tool: 'Bash', output: 'ready' } });
    display.flush();
    display.flush();
    expect(output.filter((line) => line.startsWith('  │ '))).toEqual(['  │ ready']);
    expect(display.history.entries()[0]?.status).toBe('running');
  });

  it.each([
    { mode: 'compact', input: { token: 's3cr3t' }, chunks: ['Downloading files', '\n'], expected: ['  │ Downloading file[REDACTED]', '  │ s'] },
    { mode: 'compact', input: {}, chunks: ['Authorization: Bear', 'er abc\n'], expected: ['  │ Authorization: [REDACTED]'] },
    { mode: 'expanded', input: { token: 's3cr3t' }, chunks: ['Downloading files', '\n'], expected: ['  │ Downloading file[REDACTED]', '  │ s'] },
  ] as const)('does not print a line again after flushing a masked tail in $mode mode: $chunks', ({ mode, input, chunks, expected }) => {
    const output: string[] = [];
    const display = new ToolActivityDisplay(mode, false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'held', tool: 'Bash', input } });
    for (const chunk of chunks) {
      display.handle({ type: 'tool_output', data: { id: 'held', tool: 'Bash', output: chunk } });
      display.flush();
    }
    expect(output.filter((line) => line.startsWith('  │ '))).toEqual(expected);
  });

  it.each([
    { chunks: ['{"stdout":"ok"}\n'], expected: 'ok' },
    { chunks: ['[1,2,3]\n'], expected: '[structured output omitted]' },
  ])('prints a compact structured result only once after streaming $chunks', ({ chunks, expected }) => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'json', tool: 'Bash', input: {} } });
    for (const chunk of chunks) {
      display.handle({ type: 'tool_output', data: { id: 'json', tool: 'Bash', output: chunk } });
      display.flush();
      display.flush();
    }
    display.handle({ type: 'tool_result', data: { id: 'json', content: chunks.join(''), isError: false } });
    display.flush();
    expect(output.filter((line) => line.startsWith('  │ '))).toEqual([`  │ ${expected}`]);
    expect(output.filter((line) => line.includes('Bash output:'))).toHaveLength(1);
    expect(output.filter((line) => line.includes('✓'))).toEqual(['  ✓ Bash']);
  });

  it('masks the input with a value that a later output reveals as a secret', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { command: 'echo revealed-value' } } });
    display.handle({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'tick\n' } });
    display.handle({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'api_key=revealed-value\n' } });
    expect(display.groups()[0]!.entries[0]!.input).not.toContain('revealed-value');
  });
  it.each(['silent', 'compact'] as const)('masks a secret value of the input in every later output in %s mode', (mode) => {
    const display = new ToolActivityDisplay(mode, false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { command: 'printf ready', token: 'input-secret' } } });
    display.handle({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'ready\n' } });
    for (let index = 0; index < 2; index++) display.handle({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'input-secret\n' } });
    expect(display.detail('1', 0).result.text).not.toContain('input-secret');
  });

  it('masks repeated credentials from the whole committed span before printing compact output', () => {
    const printed: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => printed.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: {} } });
    display.handle({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'using abc123secretvalue password=abc123secretvalue\n' } });
    display.flush();
    expect(printed.join('\n')).not.toContain('abc123secretvalue');
    expect(printed.join('\n')).toContain('using [REDACTED]');
  });
  it.each(['compact', 'expanded', 'silent'] as const)('should protect normalized secrets through split input, reads and flush in %s mode', (mode) => {
    for (const token of ['secret123', 'sec\x1b[31mret123']) {
      for (const chunks of [
        ['ready secret123\n'],
        ['ready sec\x1b[31mret123\x1b[0m\n'],
        ['ready sec\x1b[3', '1mret', '123\x1b[0m\n'],
      ]) {
        const output: string[] = [];
        const display = new ToolActivityDisplay(mode, false, (line) => output.push(line), false);
        display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf ready', token } } });
        const key = display.history.entries()[0]!.key;
        for (const chunk of chunks) {
          display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
          display.flush();
          for (const text of [output.join('\n'), display.groups()[0]!.entries[0]!.result.text, display.detail(key, 0).result.text]) {
            expect(text).not.toMatch(/sec(?:ret123)?|ret123|\x1b/u);
          }
        }
        expect(display.detail(key, 0).result.text).toBe('ready [REDACTED]');
        display.handle({ type: 'tool_result', data: { id: 'a', content: chunks.join(''), isError: false } });
        expect(display.detail(key, 0).result.text).toBe('ready [REDACTED]');
        expect(display.history.entries()[0]!.output).toBe(chunks.join(''));
        if (mode !== 'silent') expect(output.filter((line) => line.startsWith('  │ '))).toEqual(['  │ ready [REDACTED]']);
      }
    }
  });

  it('should preserve normalized consumption and pending secrets', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { token: 'secret123' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'ready\nsec\x1b[3' } });
    const key = display.history.entries()[0]!.key;
    expect(display.detail(key, 0).result.text).toBe('ready');
    for (const output of ['1mret', '123\x1b[0m\n', 'after\t日本語\n']) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output } });
      expect(display.detail(key, 0).result.text).not.toMatch(/secret|ret123|\x1b/u);
    }
    expect(display.detail(key, 0).result.text).toBe('ready\n[REDACTED]\nafter\t日本語');
  });

  it.each([false, true])('should preserve already masked completed results with isError=%s', (isError) => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    display.handle({ type: 'tool_result', data: { id: 'a', content: '[REDACTED] ready', isError } });
    const value = display.groups()[0]!.entries[0]!;
    expect(value).toMatchObject({ status: isError ? 'failure' : 'success', result: { text: '[REDACTED] ready' } });
    expect(display.detail(value.key, 0).result.text).toBe('[REDACTED] ready');
  });

  it('should hold a split redaction marker until the text prefix is complete', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    for (const chunk of ['[RED', 'ACTED']) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: chunk } });
      display.flush();
      expect(output).toEqual([]);
    }
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '] ready\n' } });
    display.handle({ type: 'tool_result', data: { id: 'a', content: '[REDACTED] ready\n', isError: false } });
    expect(output.filter((line) => line.startsWith('  │ '))).toEqual(['  │ [REDACTED] ready']);
  });


  describe('a secret value that the output reveals after it was already shown', () => {
    it('should apply a later-discovered value only to new running output', () => {
      const secret = 'late-value-012345';
      const display = startedDisplay({ command: 'deploy' });
      appendOutput(display, `using ${secret}\n`);
      expect(display.detail('1', 0).result.text).toBe(`using ${secret}`);

      appendOutput(display, `password=${secret}\n`);
      appendOutput(display, `using ${secret}\n`);
      const projection = display.groups()[0]!.entries[0]!;
      const expected = `using ${secret}\npassword=[REDACTED]\nusing [REDACTED]`;
      expect(projection.input).toBe('deploy');
      expect(projection.result.text).toBe(expected);
      expect(display.detail('1', 0).result.text).toBe(expected);
    });

  });

  describe('secret values that an output chunk splits in the middle of the value', () => {
    const inputs = [
      { known: false, input: { command: 'cat deploy.env' } },
      { known: true, input: { command: 'cat deploy.env', api_key: 'seed-secret' } },
    ];

    it.each(splitSecretScenarios.flatMap((scenario) => inputs.map(({ known, input }) => ({ scenario, known, input }))))(
      'should not show any part of the secret: $scenario.name (known=$known)', ({ scenario, input }) => {
        const display = startedDisplay(input);

        for (const chunk of scenario.chunks) {
          appendOutput(display, chunk);
          for (const text of [display.groups()[0]!.entries[0]!.result.text, display.detail('1', 0).result.text]) {
            expect(secretFragmentsIn(text, scenario)).toEqual([]);
          }
        }

        const text = scenarioText(scenario);
        expect(display.detail('1', 0).result.text).toBe(sanitizeSensitiveTextWithKnownValues(text, text).replace(/\n$/u, ''));
      },
    );

    it.each(splitSecretScenarios.flatMap((scenario) => (['compact', 'expanded'] as const).flatMap((mode) =>
      inputs.map(({ known, input }) => ({ scenario, mode, known, input })))))(
      'should not print any part of the secret: $scenario.name in $mode mode (known=$known)', ({ scenario, mode, input }) => {
        const printed: string[] = [];
        const display = new ToolActivityDisplay(mode, false, (line) => printed.push(line), false);
        display.handle({ type: 'tool_use', data: { id: 'build', tool: 'Bash', input } });

        for (const chunk of scenario.chunks) {
          display.handle({ type: 'tool_output', data: { id: 'build', tool: 'Bash', output: chunk } });
        }
        display.handle({ type: 'tool_result', data: { id: 'build', content: scenarioText(scenario), isError: false } });

        expect(secretFragmentsIn(printed.join('\n'), scenario)).toEqual([]);
      },
    );
  });

  it.each([1, 5])('should clone only the selected detail with %s unrelated entries', (count) => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    const [target] = display.handle({ type: 'tool_use', data: { id: 'target', tool: 'Bash', input: { command: 'printf ready' } } });
    const lines = Array.from({ length: DETAIL_RESULT_LINES + 5 }, (_, index) => `line-${index}`);
    display.handle({ type: 'tool_result', data: { id: 'target', content: lines.join('\n'), isError: false } });
    for (let index = 0; index < count; index += 1) {
      display.handle({ type: 'tool_use', data: { id: `other-${index}`, tool: 'Read', input: { file_path: `UNRELATED-${index}.ts` } } });
    }
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const first = display.detail(target!.key, 0);
      const second = display.detail(target!.key, first.result.nextOffset);
      expect(first.input).toBe('printf ready');
      expect(first.result).toMatchObject({ text: lines.slice(0, DETAIL_RESULT_LINES).join('\n'), hasMore: true });
      expect(second.result).toMatchObject({ text: lines.slice(DETAIL_RESULT_LINES).join('\n'), hasMore: false });
      expect(clone.mock.calls.length).toBeGreaterThan(0);
      for (const [value] of clone.mock.calls) expect(JSON.stringify(value)).not.toContain('UNRELATED-');
    } finally {
      clone.mockRestore();
    }
  });

  it('should preserve ordinary text beginning with a redacted value without reclassifying it as JSON', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { token: 'secret123' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'secret123 ready ' + 'safe '.repeat(100) } });
    const value = display.groups()[0]!.entries[0]!;
    expect(value.result.text).toContain('[REDACTED] ready');
    expect(display.detail(value.key, 0).result.text).toContain('[REDACTED] ready');
  });
  it.each([0, 11000])('should defer structured streaming content until the final result supplies all secret fields (padding=%i)', (padding) => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf ready' } } });
    const suffix = 'x'.repeat(padding);
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: JSON.stringify({ stdout: `ready secret123${suffix}` }) } });
    const key = display.groups()[0]!.entries[0]!.key;
    for (const result of [display.groups()[0]!.entries[0]!.result, display.detail(key, 0).result]) {
      expect(result.text).toBe('');
      expect(result.text).not.toContain('secret123');
    }
    display.handle({ type: 'tool_result', data: { id: 'a', content: JSON.stringify({ stdout: `ready secret123${suffix}`, token: 'secret123' }), isError: false } });
    expect(display.detail(key, 0).result.text).toBe(`ready [REDACTED]${suffix}`);
  });
  it('should read grouped projections and successive detail pages without writing in silent mode', () => {
    const writer = vi.fn();
    const display = new ToolActivityDisplay('silent', false, writer, false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Read', input: { file_path: 'a.ts' } } });
    const lines = Array.from({ length: DETAIL_RESULT_LINES + 5 }, (_, index) => `line-${index}`);
    display.handle({ type: 'tool_result', data: { id: 'a', content: lines.join('\n'), isError: false } });
    display.handle({ type: 'tool_use', data: { id: 'b', tool: 'Read', input: { file_path: 'b.ts' } } });
    expect(display.groups()[0]?.summary).toBe('Read 2 files');
    const key = display.groups()[0]!.entries[0]!.key;
    const first = display.detail(key, 0);
    const second = display.detail(key, first.result.nextOffset);
    expect(first.result).toMatchObject({ text: lines.slice(0, DETAIL_RESULT_LINES).join('\n'), hasMore: true });
    expect(second.result).toMatchObject({ text: lines.slice(DETAIL_RESULT_LINES).join('\n'), hasMore: false });
    expect(writer).not.toHaveBeenCalled();
    expect(() => display.detail('missing', 0)).toThrow(RangeError);
  });

  it('should never flush a partial known secret when reading running output repeatedly', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf safe', token: 'secret123' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'ready '.repeat(50) + 'secret' } });
    const key = display.groups()[0]!.entries[0]!.key;
    for (let read = 0; read < 3; read += 1) {
      const detail = display.detail(key, 0);
      expect(detail.status).toBe('running');
      expect(detail.result.text).toContain('ready');
      expect(detail.result.text).not.toContain('secret');
    }
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '123\n' + 'tail '.repeat(50) } });
    expect(display.detail(key, 0).result.text).toContain('[REDACTED]');
    display.handle({ type: 'tool_result', data: { id: 'a', content: '{"stdout":"done secret123","token":"secret123"}', isError: true } });
    expect(display.detail(key, 0)).toMatchObject({ status: 'failure', result: { text: 'done [REDACTED]' } });
    expect(display.history.entries()[0]!.output).toContain('secret123');
  });

  it('should keep an unfinished secret candidate private when compact output is flushed', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf secret123', api_key: 'secret123' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'ready '.repeat(50) + 'secret' } });

    display.flush();

    expect(output.join('\n')).not.toContain('secret');
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '123\n' + 'safe '.repeat(50) } });
    display.handle({ type: 'tool_result', data: { id: 'a', content: 'done secret123', isError: false } });
    expect(output.join('\n')).not.toContain('secret123');
    expect(output.join('\n')).toContain('[REDACTED]');
  });

  it('should keep OSC fragments private even when the redactor emits only part of a control sequence', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { token: 'known-secret' } } });
    const key = display.groups()[0]!.entries[0]!.key;
    for (const output of ['ready '.repeat(50) + '\x1b]', '52;c;PRIVATE_CLIPBOARD\x07', 'after '.repeat(50)]) {
      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output } });
      const text = display.detail(key, 0).result.text;
      expect(text).toContain('ready');
      expect(text).not.toContain('PRIVATE_CLIPBOARD');
      expect(text).not.toContain('\x1b');
    }
  });

  describe('output of more than 10,000 characters arriving at once for a tool whose input has a secret candidate', () => {
    const input = { command: 'make', token: 'secret123' };
    const lines = Array.from({ length: 1500 }, (_, index) => `line-${index}\n`).join('');

    it('should print the compact stream instead of only the redaction marker', () => {
      const output: string[] = [];
      const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
      display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input } });

      display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: lines } });

      expect(output).toContain('  │ line-0');
      expect(output.join('\n')).not.toContain('[REDACTED]');
    });
  });

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

  it('should include completed secret fields when printing held text output on completion', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('compact', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: {} } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: '[progress] secret123' } });
    expect(output).toEqual([]);
    display.handle({ type: 'tool_result', data: { id: 'a', content: '{"stdout":"[progress] secret123","token":"secret123"}', isError: false } });
    expect(output).toContain('  │ [progress] [REDACTED]');
    expect(output.join('\n')).not.toContain('secret123');
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

  it.each(['[INFO] ready', '[REDACTED] ready'])('should display known log prefixes on explicit flush: %s', (text) => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_output', data: { tool: 'Bash', output: text } });
    display.flush();
    expect(output).toContain(`  │ ${text}`);
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

  it('should flush readable running output while redacting a known trailing secret', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf output', api_key: 'private123' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'observed-output private123' } });

    display.flush();
    display.flush();

    expect(output).toContain('  │ observed-output [REDACTED]');
    expect(output.join('\n')).not.toContain('private123');
    expect(output.filter((line) => line.includes('observed-output'))).toHaveLength(1);
    expect(output.join('\n')).toContain('output: [running]');
    expect(display.history.entries()[0]!.status).toBe('running');
  });

  it('should keep a partial known secret private when flushing running output', () => {
    const output: string[] = [];
    const display = new ToolActivityDisplay('expanded', false, (line) => output.push(line), false);
    display.handle({ type: 'tool_use', data: { id: 'a', tool: 'Bash', input: { command: 'printf output', api_key: 'private123' } } });
    display.handle({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'observed-output private12' } });

    display.flush();

    expect(output.join('\n')).toContain('observed-output');
    expect(output.join('\n')).not.toContain('private12');
    expect(output.join('\n')).not.toContain('private123');
    expect(display.history.entries()[0]!.status).toBe('running');
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

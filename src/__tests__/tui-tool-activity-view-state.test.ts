import { describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';
import {
  createToolActivityViewState, moveToolActivityView, toggleToolActivityView, toolActivityViewPage,
  type ToolActivityViewLabels,
} from '../features/tui/toolActivityViewState.js';
import type { ToolActivityGroup, ToolActivityProjection } from '../shared/tool-activity/types.js';
import { ToolActivityDisplay } from '../shared/ui/ToolActivityDisplay.js';

const labels: ToolActivityViewLabels = { compact: 'compact', expanded: 'expanded', more: 'more', end: 'end', completion: 'completion', running: 'running' };

function fixture(content: string) {
  const entry: ToolActivityProjection = {
    key: 'a', tool: 'Bash', action: 'Ran', input: 'printf ready', status: 'success',
    startedAt: 1000, completedAt: 1250, durationMs: 250, completionSequence: 2,
    result: { text: 'one\ntwo\nthree', nextOffset: 14, hasMore: true, truncated: true },
  };
  const groups: ToolActivityGroup[] = [{ summary: 'Ran', entries: [entry] }];
  const detail = vi.fn((key: string, offset: number): ToolActivityProjection => {
    const selected = groups.flatMap((group) => group.entries).find((value) => value.key === key);
    expect(selected).toBeDefined();
    const newline = content.indexOf('\n', offset);
    const end = newline < 0 ? content.length : newline;
    return { ...selected!, result: {
      text: content.slice(offset, end), nextOffset: newline < 0 ? end : end + 1,
      hasMore: newline >= 0 && end + 1 < content.length, truncated: newline >= 0 && end + 1 < content.length,
    } };
  });
  return { groups, reader: { detail } };
}

describe('tool activity view state', () => {
  it.each([
    { tool: 'Bash', title: 'Bash Ran', input: { command: 'printf ready' }, summary: 'printf ready' },
    { tool: 'Grep', title: 'Grep Used Grep', input: { pattern: 'needle.*' }, summary: 'needle.*' },
    { tool: 'Read', title: 'Read', input: { file_path: 'source.ts' }, summary: 'source.ts' },
    { tool: 'Edit', title: 'Edit', input: { file_path: 'target.ts' }, summary: 'target.ts' },
  ].flatMap((example) => [false, true].map((isError) => ({ ...example, isError }))))(
    'shows the shared action and tool in compact and expanded $tool headers with failure=$isError',
    ({ tool, title, input, summary, isError }) => {
      const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
      display.handle({ type: 'tool_use', data: { id: 'tool', tool, input } });
      display.handle({ type: 'tool_result', data: { id: 'tool', content: 'ready', isError } });
      const initial = createToolActivityViewState();
      const groups = display.groups();
      const compact = toolActivityViewPage(display, groups, initial, 80, 10, labels);
      expect(compact.rows[0]).toMatch(new RegExp(`^${title} ${summary.replace(/[.*]/gu, '\\$&')} ${isError ? '✗' : '✓'} \\d+ ms$`, 'u'));
      expect(compact.heads).toEqual([0]);
      expect(compact.rows).toContain('ready');
      const expanded = toolActivityViewPage(display, groups, toggleToolActivityView(initial), 80, 10, labels);
      expect(expanded.rows[0]).toBe(`${isError ? '✗' : '✓'} ${title}`);
      expect(expanded.heads).toEqual([0]);
      expect(expanded.rows).toContain(summary);
      expect(expanded.rows).toContain('ready');
    },
  );

  it('shows the shared action for each Bash when expanding a group', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    for (const id of ['first', 'second']) {
      display.handle({ type: 'tool_use', data: { id, tool: 'Bash', input: { command: `printf ${id}` } } });
      display.handle({ type: 'tool_result', data: { id, content: `${id}-result`, isError: false } });
    }
    const initial = createToolActivityViewState();
    const groups = display.groups();
    const compact = toolActivityViewPage(display, groups, initial, 80, 20, labels);
    expect(compact.rows[0]).toContain('Ran 2 operations');
    const expanded = toolActivityViewPage(display, groups, toggleToolActivityView(initial), 80, 20, labels);
    expect(expanded.rows.filter((row) => row === '✓ Bash Ran')).toHaveLength(2);
    for (const id of ['first', 'second']) {
      expect(expanded.rows).toContain(`printf ${id}`);
      expect(expanded.rows).toContain(`${id}-result`);
    }
  });

  it('lays out the input and results of each entry in an expanded page', () => {
    const display = new ToolActivityDisplay('silent', false, vi.fn(), false);
    for (const id of ['first', 'second']) {
      display.handle({ type: 'tool_use', data: { id, tool: 'Bash', input: { command: `printf ${id} ${'long-argument '.repeat(8)}` } } });
      display.handle({ type: 'tool_result', data: { id, content: Array.from({ length: 8 }, (_, index) => `${id}-${index}`).join('\n'), isError: false } });
    }
    const groups = display.groups();

    const page = toolActivityViewPage(display, groups, toggleToolActivityView(createToolActivityViewState()), 30, 60, labels);

    expect(page.rows).toEqual(expect.arrayContaining(['first-0', 'first-7', 'second-0', 'second-7']));
  });

  it('moves from the latest position when consecutive page requests reuse an old render', () => {
    const { reader, groups } = fixture(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'));
    const first = toolActivityViewPage(reader, groups, createToolActivityViewState(), 20, 1, labels);
    const secondState = moveToolActivityView(createToolActivityViewState(), first, 'next');
    const stalePage = first;
    const secondPage = toolActivityViewPage(reader, groups, secondState, 20, 1, labels);
    const thirdState = moveToolActivityView(secondState, secondPage, 'next');

    expect(secondState.position).not.toEqual(thirdState.position);
    expect(thirdState.previous.at(-1)).toEqual(secondState.position);
    expect(moveToolActivityView(thirdState, stalePage, 'previous').position).toEqual(secondState.position);
  });
  it('stores only the visible prefix and keeps an undisplayed wide grapheme out of the source range', () => {
    const { reader, groups } = fixture('ready');
    const initial = createToolActivityViewState();
    const page = toolActivityViewPage(reader, groups, initial, 12, 1, labels);
    expect(page.rows).toEqual(['Ba… ✓ 250 ms']);
    const input = { ...initial, expanded: true, position: { ...initial.position, section: 'input' as const } };
    groups[0]!.entries[0]!.input = '日本語';
    const tiny = toolActivityViewPage(reader, groups, input, 1, 1, labels);
    expect(tiny.rows).toEqual(['…']);
  });
  it('preserves the rendered spaces for tabs in compact headers across widths', () => {
    const { reader, groups } = fixture('ready');
    groups[0]!.entries[0]!.input = 'printf\tready';
    const state = createToolActivityViewState();
    const wide = toolActivityViewPage(reader, groups, state, 80, 1, labels);
    expect(wide.rows).toEqual(['Bash Ran printf ready ✓ 250 ms']);
  });
  it('finishes the page safely when the selected unfinished entry is removed at turn termination', () => {
    const { reader, groups } = fixture('completed-result');
    const unfinished = { ...groups[0]!.entries[0]!, key: 'unfinished', status: 'running' as const };
    groups[0]!.entries.push(unfinished);
    const initial = toggleToolActivityView(createToolActivityViewState());
    const state = { ...initial, position: { ...initial.position, entry: 1, section: 'header' as const } };
    expect(toolActivityViewPage(reader, groups, state, 80, 2, labels).rows[0]).toContain('… Bash');
    groups[0]!.entries.pop();
    expect(toolActivityViewPage(reader, groups, state, 80, 2, labels)).toMatchObject({ rows: [], hasMore: false });
  });
  it.each([
    ['x', 96], ['x', 97], ['日', 48], ['日', 49],
  ])('should bound a wrapped compact result for %s repeated %s times', (character, count) => {
    const content = String(character).repeat(Number(count));
    const { reader, groups } = fixture(content);
    groups[0]!.entries[0]!.result = { text: content, nextOffset: content.length, hasMore: false, truncated: false };
    const state = createToolActivityViewState();
    const page = toolActivityViewPage(reader, groups, state, 32, 20, labels);
    const resultRows = page.rows.filter((row) => row !== '' && row.split('').every((char) => char === character));
    expect(resultRows).toHaveLength(3);
    for (const row of resultRows) expect(stringWidth(row)).toBeLessThanOrEqual(32);
    expect(resultRows.join('')).toBe(content.slice(0, character === '日' ? 48 : 96));
    expect(page.rows.includes(labels.more)).toBe(stringWidth(content) > 96);
    const expanded = toolActivityViewPage(reader, groups, toggleToolActivityView(state), 32, 20, labels);
    expect(expanded.rows.join('')).toContain(content);
  });

  it.each([96, 97])('should bound the entire grouped preview at the %s character boundary across small pages', (length) => {
    const content = 'x'.repeat(length);
    const { reader, groups } = fixture(content);
    const first = groups[0]!.entries[0]!;
    first.result = { text: content, nextOffset: content.length, hasMore: false, truncated: false };
    groups[0]!.entries.push({ ...first, key: 'b', input: 'second.ts' });
    groups.push({ summary: 'Edit', entries: [{ ...first, key: 'c', tool: 'Edit', action: 'Edit', input: 'next.ts', result: { ...first.result, text: 'next-result' } }] });
    let state = createToolActivityViewState();
    const rows: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const page = toolActivityViewPage(reader, groups, state, 32, 1, labels);
      rows.push(...page.rows);
      if (!page.hasMore) break;
      state = moveToolActivityView(state, page, 'next');
    }
    expect(rows.filter((row) => /^x+$/u.test(row))).toEqual(['x'.repeat(32), 'x'.repeat(32), 'x'.repeat(32)]);
    expect(rows).toContain(labels.more);
    expect(rows).toContain('next-result');
    const expanded = toolActivityViewPage(reader, groups.slice(0, 1), toggleToolActivityView(state), 32, 30, labels);
    expect(expanded.rows.join('').split(content)).toHaveLength(3);
    expect(expanded.rows).toContain('second.ts');
  });

  it('should retain the individual compact budget across pages and recalculate it on resize', () => {
    const content = 'x'.repeat(97);
    const { reader, groups } = fixture(content);
    groups[0]!.entries[0]!.result = { text: content, nextOffset: content.length, hasMore: false, truncated: false };
    const initial = createToolActivityViewState();
    const wide = toolActivityViewPage(reader, groups, initial, 64, 20, labels);
    expect(wide.rows.join('')).toContain(content);
    expect(wide.rows).not.toContain(labels.more);
    let state = initial;
    const rows: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const page = toolActivityViewPage(reader, groups, state, 32, 1, labels);
      rows.push(...page.rows);
      if (!page.hasMore) break;
      state = moveToolActivityView(state, page, 'next');
    }
    expect(rows.filter((row) => /^x+$/u.test(row))).toHaveLength(3);
    expect(rows).toContain(labels.more);
    expect(toolActivityViewPage(reader, groups, initial, 64, 20, labels)).toEqual(wide);
  });

  it('should collapse to the shared compact summary and mark omitted results', () => {
    const { reader, groups } = fixture('one\ntwo\nthree\nfour');
    const page = toolActivityViewPage(reader, groups, createToolActivityViewState(), 100, 10, labels);
    expect(page.rows).toEqual(['Bash Ran printf ready ✓ 250 ms', 'one', 'two', 'three', 'more']);
    expect(reader.detail).not.toHaveBeenCalled();
  });

  it('should show the raw start and completion times and the completion order only when expanded', () => {
    const { reader, groups } = fixture('one\ntwo');
    const compact = toolActivityViewPage(reader, groups, createToolActivityViewState(), 100, 10, labels);
    for (const row of compact.rows) {
      expect(row).not.toMatch(/@\d|#\d|completion/u);
    }
    const expanded = toolActivityViewPage(reader, groups, toggleToolActivityView(createToolActivityViewState()), 100, 10, labels);
    expect(expanded.rows).toContain('success @1000 → @1250 (250 ms) completion #2');
  });

  it.each([
    { status: 'success' as const, durationMs: 74, expected: 'Bash Ran printf ready ✓ 74 ms' },
    { status: 'failure' as const, durationMs: 3240, expected: 'Bash Ran printf ready ✗ 3.2 s' },
    { status: 'success' as const, durationMs: undefined, expected: 'Bash Ran printf ready ✓' },
    { status: 'running' as const, durationMs: undefined, expected: 'Bash Ran printf ready … running' },
  ])('should end the compact header with the $status status and duration', ({ status, durationMs, expected }) => {
    const { reader, groups } = fixture('');
    groups[0]!.entries[0] = { ...groups[0]!.entries[0]!, status, durationMs, result: { text: '', nextOffset: 0, hasMore: false, truncated: false } };
    const page = toolActivityViewPage(reader, groups, createToolActivityViewState(), 100, 10, labels);
    expect(page.rows).toEqual([expected]);
  });

  it('should shorten the title rather than the status in a narrow compact header', () => {
    const { reader, groups } = fixture('');
    groups[0]!.entries[0]!.result = { text: '', nextOffset: 0, hasMore: false, truncated: false };
    const page = toolActivityViewPage(reader, groups, createToolActivityViewState(), 20, 10, labels);
    expect(page.rows).toEqual(['Bash Ran p… ✓ 250 ms']);
    expect(stringWidth(page.rows[0]!)).toBeLessThanOrEqual(20);
  });

  it('should page forward and back without skipping the wrapped tail of a Japanese single line', () => {
    const content = '日本語😀'.repeat(12) + 'END';
    const { reader, groups } = fixture(content);
    let state = toggleToolActivityView(createToolActivityViewState());
    const observed: string[] = [];
    const first = toolActivityViewPage(reader, groups, state, 16, 3, labels);
    let page = first;
    for (let index = 0; index < 40; index += 1) {
      observed.push(...page.rows);
      expect(page.rows.length).toBeLessThanOrEqual(3);
      for (const row of page.rows) {
        expect(stringWidth(row)).toBeLessThanOrEqual(16);
        expect(row).not.toContain('�');
      }
      if (!page.hasMore) break;
      state = moveToolActivityView(state, page, 'next');
      page = toolActivityViewPage(reader, groups, state, 16, 3, labels);
    }
    expect(observed.join('')).toContain(content);
    const last = state;
    expect(moveToolActivityView(last, page, 'next')).toEqual(last);
    while (state.previous.length > 0) state = moveToolActivityView(state, page, 'previous');
    expect(toolActivityViewPage(reader, groups, state, 16, 3, labels).rows).toEqual(first.rows);
    expect(toggleToolActivityView(state).expanded).toBe(false);
  });

  it('should relayout the same page position at a narrower width without consuming its content', () => {
    const { reader, groups } = fixture('日本語の結果を読む');
    const state = toggleToolActivityView(createToolActivityViewState());
    const wide = toolActivityViewPage(reader, groups, state, 80, 8, labels);
    const narrow = toolActivityViewPage(reader, groups, state, 14, 8, labels);
    expect(narrow.rows.join('')).toContain('日本語の結果を読む');
    for (const row of narrow.rows) expect(stringWidth(row)).toBeLessThanOrEqual(14);
    expect(toolActivityViewPage(reader, groups, state, 80, 8, labels)).toEqual(wide);
  });

  it('should keep grouped targets individually readable only when expanded', () => {
    const { reader, groups } = fixture('ready');
    groups[0]!.summary = 'Read 2 files';
    groups[0]!.entries[0] = { ...groups[0]!.entries[0]!, tool: 'Read', action: 'Read', input: 'first.ts' };
    groups[0]!.entries.push({ ...groups[0]!.entries[0]!, key: 'b', input: 'second.ts' });
    const compact = toolActivityViewPage(reader, groups, createToolActivityViewState(), 80, 12, labels);
    expect(compact.rows).toEqual(['✓ Read 2 files ✓2', 'one', 'two', 'three', 'more']);
    const detail = toolActivityViewPage(reader, groups, toggleToolActivityView(createToolActivityViewState()), 80, 12, labels);
    expect(detail.rows.filter((row) => row === 'ready')).toHaveLength(2);
    expect(detail.rows).toContain('first.ts');
    expect(detail.rows).toContain('second.ts');
  });

  it('should keep a late failure visible in a narrow collapsed group', () => {
    const { reader, groups } = fixture('ready');
    groups[0]!.summary = 'Ran 500 operations';
    groups[0]!.entries = Array.from({ length: 500 }, (_, index) => ({
      ...groups[0]!.entries[0]!, key: String(index), status: index === 499 ? 'failure' : 'success',
    }));
    const page = toolActivityViewPage(reader, groups, createToolActivityViewState(), 16, 2, labels);
    expect(page.rows[0]).toMatch(/^✗ /u);
    expect(stringWidth(page.rows[0]!)).toBeLessThanOrEqual(16);
  });

  it('should keep empty and tiny viewports finite', () => {
    const { reader, groups } = fixture('日本語');
    const state = createToolActivityViewState();
    expect(toolActivityViewPage(reader, [], state, 1, 1, labels).rows).toEqual([]);
    expect(toolActivityViewPage(reader, groups, state, 1, 0, labels).rows).toEqual([]);
    const page = toolActivityViewPage(reader, groups, state, 1, 1, labels);
    expect(page.rows).toEqual(['…']);
    expect(moveToolActivityView(state, page, 'previous')).toEqual(state);
  });
});

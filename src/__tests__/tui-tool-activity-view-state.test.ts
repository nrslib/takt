import { describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';
import {
  createToolActivityViewState, moveToolActivityView, toggleToolActivityView, toolActivityViewPage,
  mergeToolActivityTranscript,
  type ToolActivityViewLabels,
} from '../features/tui/toolActivityViewState.js';
import type { ToolActivityGroup, ToolActivityProjection } from '../shared/tool-activity/types.js';
import { ToolActivityDisplay } from '../shared/ui/ToolActivityDisplay.js';

const labels: ToolActivityViewLabels = { compact: 'compact', expanded: 'expanded', more: 'more', end: 'end', completion: 'completion' };

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
      const header = `${isError ? '✗' : '✓'} ${title}`;
      expect(compact.rows[0]).toBe(`${header} ${summary}`);
      expect(compact.rows).toContain('ready');
      const expanded = toolActivityViewPage(display, groups, toggleToolActivityView(initial), 80, 10, labels);
      expect(expanded.rows[0]).toBe(header);
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

  it.each([false, true])('retains the complete input after narrow, wide and expanded headers with expanded first=%s', (expandedFirst) => {
    const { reader, groups } = fixture('ready');
    const command = 'printf abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    groups[0]!.entries[0]!.input = command;
    const initial = createToolActivityViewState();
    const expanded = toggleToolActivityView(initial);
    const pages = [
      ...(expandedFirst ? [toolActivityViewPage(reader, groups, expanded, 40, 1, labels)] : []),
      toolActivityViewPage(reader, groups, initial, 40, 1, labels),
      toolActivityViewPage(reader, groups, initial, 80, 1, labels),
      toolActivityViewPage(reader, groups, expanded, 40, 1, labels),
      toolActivityViewPage(reader, groups, initial, 40, 1, labels),
    ];
    expect(pages[expandedFirst ? 1 : 0]!.rows[0]).toMatch(/…$/u);
    const retained = pages.reduce((ranges, page) => mergeToolActivityTranscript(ranges, page.transcript ?? []), [] as NonNullable<typeof pages[0]['transcript']>[number][]);
    expect(retained.map((range) => range.text)).toEqual([`✓ Bash Ran ${command}`]);
    expect(reader.detail).not.toHaveBeenCalled();
  });
  it('preserves an ellipsis from the original input across narrow and wide display', () => {
    const { reader, groups } = fixture('ready');
    groups[0]!.entries[0]!.input = "printf '途中…完了'";
    const state = createToolActivityViewState();
    const narrow = toolActivityViewPage(reader, groups, state, 19, 1, labels);
    const wide = toolActivityViewPage(reader, groups, state, 80, 1, labels);
    expect(mergeToolActivityTranscript(narrow.transcript ?? [], wide.transcript ?? []).map((range) => range.text))
      .toEqual(["✓ Bash Ran printf '途中…完了'"]);
  });
  it('retains full timestamps after a compact row and all finite expanded pages', () => {
    const { reader, groups } = fixture('ready');
    Object.assign(groups[0]!.entries[0]!, { startedAt: 1794440000000, completedAt: 1794440000250 });
    const initial = createToolActivityViewState();
    const compact = toolActivityViewPage(reader, groups, initial, 32, 2, labels);
    expect(compact.rows[1]).toMatch(/…$/u);
    let retained = mergeToolActivityTranscript([], compact.transcript ?? []);
    let state = toggleToolActivityView(initial);
    for (let index = 0; index < 30; index++) {
      const page = toolActivityViewPage(reader, groups, state, 32, 2, labels);
      retained = mergeToolActivityTranscript(retained, page.transcript ?? []);
      if (!page.hasMore) break;
      state = moveToolActivityView(state, page, 'next');
    }
    expect(retained.filter((range) => range.key === JSON.stringify(['a', 'time'])).map((range) => range.text))
      .toEqual(['success @1794440000000 → @1794440000250 (250 ms) completion #2']);
  });
  it.each(['group', 'groupOmission', 'omission'] as const)('separates display omission from the source of %s rows', (section) => {
    const { reader, groups } = fixture('ready');
    const entry = groups[0]!.entries[0]!;
    groups[0]!.entries.push({ ...entry, key: 'b' });
    groups[0]!.summary = 'Ran 200 operations with details';
    const guide = { ...labels, more: 'Continue to see additional results…' };
    const initial = createToolActivityViewState();
    const state = { ...initial, position: { ...initial.position, section } };
    const narrow = toolActivityViewPage(reader, groups, state, 16, 1, guide);
    const wide = toolActivityViewPage(reader, groups, state, 80, 1, guide);
    const retained = mergeToolActivityTranscript(narrow.transcript ?? [], wide.transcript ?? []);
    expect(narrow.transcript![0]!.omitted).toBe(true);
    expect(narrow.transcript![0]!.text).toBe(wide.rows[0]!.slice(0, 15));
    expect(retained.map((range) => range.text)).toEqual(wide.rows);
    expect(retained[0]!.omitted).toBe(false);
    expect(mergeToolActivityTranscript(retained, narrow.transcript ?? [])).toEqual(retained);
    expect(reader.detail).not.toHaveBeenCalled();
  });
  it('stores only the visible prefix and keeps an undisplayed wide grapheme out of the source range', () => {
    const { reader, groups } = fixture('ready');
    const initial = createToolActivityViewState();
    const page = toolActivityViewPage(reader, groups, initial, 10, 1, labels);
    expect(page.rows).toEqual(['✓ Bash Ra…']);
    expect(page.transcript).toEqual([{ key: JSON.stringify(['a', 'header']), offset: 0, text: '✓ Bash Ra', omitted: true }]);
    const input = { ...initial, expanded: true, position: { ...initial.position, section: 'input' as const } };
    groups[0]!.entries[0]!.input = '日本語';
    const tiny = toolActivityViewPage(reader, groups, input, 1, 1, labels);
    expect(tiny.rows).toEqual(['…']);
    expect(tiny.transcript).toEqual([{ key: JSON.stringify(['a', 'input']), offset: 0, text: '', omitted: true }]);
  });
  it('removes the omission marker when an equally long complete range is later displayed', () => {
    const partial = [{ key: 'header', offset: 0, text: 'visible', omitted: true }];
    const complete = [{ key: 'header', offset: 0, text: 'visible', omitted: false }];
    expect(mergeToolActivityTranscript(partial, complete)).toEqual(complete);
    expect(mergeToolActivityTranscript(complete, partial)).toEqual(complete);
  });
  it('preserves the rendered spaces for tabs in compact headers across widths', () => {
    const { reader, groups } = fixture('ready');
    groups[0]!.entries[0]!.input = 'printf\tready';
    const state = createToolActivityViewState();
    const narrow = toolActivityViewPage(reader, groups, state, 16, 1, labels);
    const wide = toolActivityViewPage(reader, groups, state, 80, 1, labels);
    const retained = mergeToolActivityTranscript(narrow.transcript ?? [], wide.transcript ?? []);
    expect(retained.map((range) => range.text)).toEqual(wide.rows);
    expect(wide.rows).toEqual(['✓ Bash Ran printf ready']);
    expect(narrow.transcript![0]!.text + '…').toBe(narrow.rows[0]);
  });
  it('retains overlapping visible result ranges once across modes, reflow and preceding entry removal', () => {
    const { reader, groups } = fixture('one\ntwo\nthree\nfour\nunseen');
    const initial = createToolActivityViewState();
    const prefix = { summary: 'Used Grep', entries: [{ ...groups[0]!.entries[0]!, key: 'unfinished', tool: 'Grep', action: 'Used Grep', status: 'running' as const }] };
    const first = toolActivityViewPage(reader, [prefix, ...groups], initial, 80, 10, labels);
    const compact = toolActivityViewPage(reader, groups, initial, 80, 5, labels);
    const expanded = toolActivityViewPage(reader, groups, toggleToolActivityView(initial), 80, 7, labels);
    const narrow = toolActivityViewPage(reader, groups, toggleToolActivityView(initial), 4, 12, labels);
    const retained = [first, compact, expanded, narrow].reduce((ranges, page) => mergeToolActivityTranscript(ranges, page.transcript ?? []), [] as NonNullable<typeof first.transcript>[number][]);
    const result = retained.filter((range) => range.key === JSON.stringify(['a', 'result'])).map((range) => range.text).join('');
    expect(result).toContain('one\ntwo\nthree\nfour');
    expect(result.split('one')).toHaveLength(2);
    expect(result).not.toContain('unseen');
    expect(retained.some((range) => range.key.includes('unfinished'))).toBe(false);
  });
  it('keeps identical results from different entries and preserves gaps between separately viewed ranges', () => {
    const ranges = mergeToolActivityTranscript([], [
      { key: 'tool-2/result', offset: 0, text: 'ready', omitted: false },
      { key: 'tool-3/result', offset: 0, text: 'ready', omitted: false },
      { key: 'tool-2/result', offset: 10, text: 'tail', omitted: false },
    ]);
    expect(mergeToolActivityTranscript(ranges, [{ key: 'tool-2/result', offset: 2, text: 'ady', omitted: false }])).toEqual(ranges);
    expect(ranges.filter((range) => range.text === 'ready')).toHaveLength(2);
    expect(ranges.filter((range) => range.key === 'tool-2/result').map((range) => range.offset)).toEqual([0, 10]);
  });
  it('finishes the page safely when the selected unfinished entry is removed at turn termination', () => {
    const { reader, groups } = fixture('completed-result');
    const unfinished = { ...groups[0]!.entries[0]!, key: 'unfinished', status: 'running' as const };
    groups[0]!.entries.push(unfinished);
    const initial = toggleToolActivityView(createToolActivityViewState());
    const state = { ...initial, position: { ...initial.position, entry: 1, section: 'header' as const } };
    expect(toolActivityViewPage(reader, groups, state, 80, 2, labels).rows[0]).toContain('… Bash');
    groups[0]!.entries.pop();
    expect(toolActivityViewPage(reader, groups, state, 80, 2, labels)).toMatchObject({ rows: [], transcript: [], hasMore: false });
  });
  it('identifies only displayed completed rows for transcript retention without reading unseen detail', () => {
    const { reader, groups } = fixture('unvisited-detail');
    const completed = groups[0]!.entries[0]!;
    completed.result = { text: 'completed-result', nextOffset: 16, hasMore: false, truncated: false };
    groups.push({ summary: 'running', entries: [{ ...completed, key: 'running', status: 'running',
      input: 'unfinished-input', result: { text: 'unfinished-output', nextOffset: 17, hasMore: false, truncated: false } }] });
    const page = toolActivityViewPage(reader, groups, createToolActivityViewState(), 100, 20, labels);
    expect(page.rows).toContain('unfinished-output');
    expect(page.transcript?.map((row) => row.text)).toEqual(page.rows.slice(0, 3));
    expect(page.transcript?.map((row) => row.text)).toContain('completed-result');
    const bounded = toolActivityViewPage(reader, groups, createToolActivityViewState(), 100, 1, labels);
    expect(bounded.transcript?.map((row) => row.text)).toEqual(bounded.rows);
    expect(reader.detail).not.toHaveBeenCalled();
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
    expect(page.rows).toContain('✓ Bash Ran printf ready');
    expect(page.rows).toContain('success @1000 → @1250 (250 ms) completion #2');
    expect(page.rows.slice(-4)).toEqual(['one', 'two', 'three', 'more']);
    expect(reader.detail).not.toHaveBeenCalled();
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

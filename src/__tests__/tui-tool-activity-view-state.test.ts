import { describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';
import {
  createToolActivityViewState, moveToolActivityView, toggleToolActivityView, toolActivityViewPage,
  type ToolActivityViewLabels,
} from '../features/tui/toolActivityViewState.js';
import type { ToolActivityGroup, ToolActivityProjection } from '../shared/tool-activity/types.js';

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
    groups.push({ summary: 'Edit', entries: [{ ...first, key: 'c', tool: 'Edit', input: 'next.ts', result: { ...first.result, text: 'next-result' } }] });
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
    expect(page.rows).toContain('✓ Bash printf ready');
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

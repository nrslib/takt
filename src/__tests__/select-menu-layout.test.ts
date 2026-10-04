import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { countItemLines, countRenderedLines, renderSingleOption, type SelectOptionItem } from '../shared/prompt/select-menu.js';
import { adjustScrollOffset, createViewportState, renderMenuWithViewport } from '../shared/prompt/select-viewport.js';
import { getDisplayWidth } from '../shared/utils/text.js';
import { selectOption, selectOptionWithDefault } from '../shared/prompt/select.js';
import { restoreStdin, setupRawStdin } from './helpers/stdinSimulator.js';

describe('select description layout', () => {
  it.each([
    { description: 'a'.repeat(74), descriptionRows: 1 },
    { description: 'a'.repeat(75), descriptionRows: 2 },
    { description: '界'.repeat(37), descriptionRows: 1 },
    { description: `${'界'.repeat(37)}→>`, descriptionRows: 2 },
    { description: `${'a'.repeat(73)}界`, descriptionRows: 2 },
  ])('wraps $descriptionRows description rows without losing characters', ({ description, descriptionRows }) => {
    const option = { label: 'review', value: 'resume', description, descriptionWrapFromColumns: 80 };
    const lines = renderSingleOption(option, true, 80).map(stripVTControlCharacters);

    expect(lines).toHaveLength(1 + descriptionRows);
    expect(lines.slice(1).map((line) => line.slice(5)).join('')).toBe(description);
    expect(lines.every((line) => getDisplayWidth(line) <= 79)).toBe(true);
    expect(countItemLines(option, 80)).toBe(lines.length);
    expect(countRenderedLines([option], true, 80)).toBe(lines.length + 1);
  });

  it.each([
    { columns: 80, wrap: undefined },
    { columns: 60, wrap: 80 },
  ])('keeps a single truncated description at $columns columns with threshold $wrap', ({ columns, wrap }) => {
    const option = {
      label: 'review', value: 'resume', description: 'root > '.repeat(20),
      ...(wrap === undefined ? {} : { descriptionWrapFromColumns: wrap }),
    };
    const lines = renderSingleOption(option, true, columns).map(stripVTControlCharacters);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^     root > .*…$/u);
    expect(countItemLines(option, columns)).toBe(2);
  });

  it('uses wrapped physical rows for viewport ranges and scrolling', () => {
    const options: SelectOptionItem<string>[] = [
      { label: 'review (default)', value: 'resume', description: 'r'.repeat(140), descriptionWrapFromColumns: 80 },
      { label: 'group:', value: 'heading', selectable: false },
      { label: 'review', value: 'leaf' },
    ];
    const viewport = createViewportState(8, options, true, 80);
    expect(viewport.active).toBe(true);
    expect(createViewportState(24, options, true, 80).active).toBe(false);
    const initial = renderMenuWithViewport(options, 0, true, 0, viewport.maxOptionLines, 'Cancel', 80)
      .map(stripVTControlCharacters);
    expect(initial).toHaveLength(4);
    expect(initial[0]).toContain('❯');
    expect(initial.slice(1, 3).map((line) => line.slice(5)).join('')).toBe('r'.repeat(140));
    expect(initial[3]).toContain('↓ 3 more');
    const offset = adjustScrollOffset(2, 0, options, true, viewport.maxOptionLines, 80);
    expect(offset).toBe(1);
    const moved = renderMenuWithViewport(options, 2, true, offset, viewport.maxOptionLines, 'Cancel', 80)
      .map(stripVTControlCharacters);
    expect(moved).toHaveLength(4);
    expect(moved.find((line) => line.includes('❯'))).toContain('review');
    expect(adjustScrollOffset(0, offset, options, true, viewport.maxOptionLines, 80)).toBe(0);
  });
});

describe('select layout after terminal width changes', () => {
  const fullPath = 'takt-default > develop → development-core > peer-review → peer-review > initial-reviewers → takt-development-review > review';
  const terminalProperties = [
    [process.stdout, 'columns'],
    [process.stdout, 'rows'],
    [process.stdin, 'isTTY'],
    [process.stdin, 'isRaw'],
    [process.stdin, 'setRawMode'],
  ] as const;
  let descriptors: (PropertyDescriptor | undefined)[];
  let noTty: string | undefined;
  let touchTty: string | undefined;

  beforeEach(() => {
    descriptors = terminalProperties.map(([stream, property]) => Object.getOwnPropertyDescriptor(stream, property));
    noTty = process.env.TAKT_NO_TTY;
    touchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
    delete process.env.TAKT_NO_TTY;
    process.env.TAKT_TEST_FLG_TOUCH_TTY = '1';
  });

  afterEach(() => {
    restoreStdin();
    terminalProperties.forEach(([stream, property], index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(stream, property, descriptor);
      else Reflect.deleteProperty(stream, property);
    });
    if (noTty === undefined) delete process.env.TAKT_NO_TTY;
    else process.env.TAKT_NO_TTY = noTty;
    if (touchTty === undefined) delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    else process.env.TAKT_TEST_FLG_TOUCH_TTY = touchTty;
  });

  function setTerminal(columns: number, rows: number): void {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  }

  function resumeOptions(): SelectOptionItem<string>[] {
    return [
      { label: 'Resume failed position: "review"', value: 'resume', description: fullPath, descriptionWrapFromColumns: 80 },
      { label: 'group:', value: 'heading', selectable: false },
      { label: 'review', value: 'leaf' },
    ];
  }

  function menuFrames(): string[][] {
    return vi.mocked(process.stdout.write).mock.calls
      .map(([chunk]) => stripVTControlCharacters(String(chunk)))
      .filter((chunk) => chunk.includes('❯') && chunk.endsWith('\n'))
      .map((chunk) => chunk.slice(0, -1).split('\n'));
  }

  function expectFrame(lines: string[], columns: number, rows: number, selectedLabel: string): void {
    expect(lines.every((line) => getDisplayWidth(line) <= columns)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(rows - 4);
    expect(lines.find((line) => line.includes('❯'))).toContain(selectedLabel);
    const hasIndicators = lines.some((line) => /[↑↓] \d+ more/u.test(line));
    expect(hasIndicators).toBe(rows === 8 || (rows === 9 && columns === 80));
  }

  function expectResume(lines: string[], columns: number, rows: number, defaultMarker: boolean): void {
    expectFrame(lines, columns, rows, 'Resume failed position: "review"');
    if (defaultMarker) expect(lines[0]).toContain('(default)');
    expect(lines[0]).not.toContain('…');
    const description: string[] = [];
    for (const line of lines.slice(1)) {
      if (!line.startsWith('     ')) break;
      description.push(line.slice(5));
    }
    expect(description).toHaveLength(columns === 80 ? 2 : 1);
    if (columns === 80) expect(description.join('')).toBe(fullPath);
    else expect(description[0]).toMatch(/^takt-default > develop → development-core.*…$/u);
  }

  function expectPreviousFramesErased(frames: string[][]): void {
    const erasedLineCounts = vi.mocked(process.stdout.write).mock.calls
      .map(([chunk]) => /^\x1B\[(\d+)A$/u.exec(String(chunk)))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]));
    expect(erasedLineCounts).toEqual(frames.slice(0, -1).map((lines) => lines.length));
  }

  const widthChanges = [24, 8, 9].flatMap((rows) => [
    { rows, from: 60, to: 80 },
    { rows, from: 80, to: 60 },
  ]);

  it.each(widthChanges)('recalculates layout on movement from $from to $to columns with $rows rows', async ({ rows, from, to }) => {
    setTerminal(from, rows);
    const stdin = setupRawStdin([]);
    const selection = selectOptionWithDefault('Start position:', resumeOptions(), 'resume');
    try {
      expectResume(menuFrames()[0]!, from, rows, true);
      Object.defineProperty(process.stdout, 'columns', { value: to, configurable: true });
      stdin.send('\x1B[B');
      expectFrame(menuFrames()[1]!, to, rows, 'review');
      stdin.send('\x1B[A');
      expectResume(menuFrames()[2]!, to, rows, true);
      const frames = menuFrames();
      expect(frames).toHaveLength(3);
      expectPreviousFramesErased(frames);
    } finally {
      stdin.send('\r');
      expect(await selection).toBe('resume');
    }
  });

  it.each(widthChanges)('recalculates layout on option updates from $from to $to columns with $rows rows', async ({ rows, from, to }) => {
    setTerminal(from, rows);
    const stdin = setupRawStdin([]);
    const options = resumeOptions();
    const selection = selectOption('Start position:', options, {
      onKeyPress: (key) => key === 'b' ? [...options] : null,
      showConfirmation: false,
    });
    try {
      expectResume(menuFrames()[0]!, from, rows, false);
      Object.defineProperty(process.stdout, 'columns', { value: to, configurable: true });
      stdin.send('b');
      expectResume(menuFrames()[1]!, to, rows, false);
      stdin.send('\x1B[B');
      expectFrame(menuFrames()[2]!, to, rows, 'review');
      stdin.send('b');
      expectFrame(menuFrames()[3]!, to, rows, 'review');
      stdin.send('\x1B[A');
      expectResume(menuFrames()[4]!, to, rows, false);
      const frames = menuFrames();
      expect(frames).toHaveLength(5);
      expectPreviousFramesErased(frames);
    } finally {
      stdin.send('\r');
      expect(await selection).toBe('resume');
    }
  });

  it.each([{ from: 60, to: 80 }, { from: 80, to: 60 }])('keeps ordinary descriptions on one row after changing from $from to $to columns', async ({ from, to }) => {
    setTerminal(from, 24);
    const stdin = setupRawStdin([]);
    const selection = selectOption('Select:', [{ label: 'Ordinary', value: 'ordinary', description: fullPath }], {
      showConfirmation: false,
    });
    try {
      const initial = menuFrames()[0]!;
      expect(initial).toHaveLength(3);
      expect(initial[1]).toMatch(/^     takt-default.*…$/u);
      Object.defineProperty(process.stdout, 'columns', { value: to, configurable: true });
      stdin.send('\x1B[B');
      stdin.send('\x1B[A');
      const frames = menuFrames();
      expect(frames).toHaveLength(3);
      for (const lines of frames.slice(1)) {
        expect(lines).toHaveLength(3);
        expect(lines[1]).toMatch(/^     takt-default.*…$/u);
        expect(getDisplayWidth(lines[1]!)).toBe(to);
      }
      expectPreviousFramesErased(frames);
    } finally {
      stdin.send('\r');
      expect(await selection).toBe('ordinary');
    }
  });
});

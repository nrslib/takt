import { describe, expect, it } from 'vitest';
import { sanitizeLoopAnalysisReportForPublication } from '../features/tasks/execute/loopAnalysisReportPublication.js';
import { safeExternalErrorMessage } from '../shared/utils/safeExternalErrorMessage.js';

const pathCases = [
  { input: 'reports/subworkflows/**/plan.md', expected: 'reports/subworkflows/**/plan.md' },
  { input: 'reports/subworkflows/*/plan.md', expected: 'reports/subworkflows/*/plan.md' },
  { input: './src/x.ts', expected: './src/x.ts' },
  { input: '../src/x.ts', expected: '../src/x.ts' },
  { input: 'src/x.ts:12', expected: 'src/x.ts:12' },
  { input: '日本語/英語', expected: '日本語/英語' },
  { input: '入力 / 出力', expected: '入力 / 出力' },
  { input: '// comment', expected: '// comment' },
  { input: '///', expected: '///' },
  { input: 'reports/../plan.md', expected: 'reports/../plan.md' },
  { input: 'a/b/c', expected: 'a/b/c' },
  { input: 'context/task/order.md:21-23', expected: 'context/task/order.md:21-23' },
  { input: 'A/B', expected: 'A/B' },
  { input: 'https://github.com/nrslib/takt/pull/1491', expected: 'https://github.com/nrslib/takt/pull/1491' },
  { input: '末尾/', expected: '末尾/' },
  { input: '/ ', expected: '/ ' },
  { input: '/Users/jane/repo/a.ts', expected: '[path]' },
  { input: '/@scope/private/report.md', expected: '[path]' },
  { input: '/$HOME/private/report.md', expected: '[path]' },
  { input: '/[private]/report.md', expected: '[path]' },
  { input: '/Users/x/.takt/runs/<slug>/trace.md', expected: '[path]' },
  { input: '/Users/x/.takt/runs/source-run/trace.md', expected: '[path]' },
  { input: '[trace](</Users/x/.takt/runs/source/trace.md>)', expected: '[trace](<[path]>)' },
  { input: '[/Users/x/a.ts]', expected: '[[path]]' },
  { input: '</div>src/x.ts', expected: '</div>src/x.ts' },
  { input: '<div>src/x.ts', expected: '<div>src/x.ts' },
  { input: 'a<b>/c', expected: 'a<b>/c' },
  { input: '[x]/y', expected: '[x]/y' },
  { input: 'Evidence: /Users/jane/repo/a.ts', expected: 'Evidence: [path]' },
  { input: 'path=/Users/jane/repo/a.ts', expected: 'path=[path]' },
  { input: '(/Users/jane/repo/a.ts)', expected: '([path])' },
  { input: '[log](/Users/jane/repo/a.ts)', expected: '[log]([path])' },
  { input: '__BT__/Users/jane/repo/a.ts__BT__', expected: '__BT__[path]__BT__' },
  { input: '" /Users/jane/repo/a.ts "', expected: '" [path] "' },
  { input: '/Users/jane/repo/a.ts:12', expected: '[path]' },
  { input: 'file:///Users/jane/repo/a.ts', expected: '[path]' },
  { input: 'https://example.com/a/b', expected: 'https://example.com/a/b' },
  { input: 'C:/Users/jane/repo/a.ts', expected: '[path]' },
  { input: 'path=C:/Users/jane/repo/a.ts', expected: 'path=[path]' },
  { input: 'C:\\Users\\jane\\repo\\a.ts', expected: '[path]' },
  { input: '\\\\server\\share\\repo\\a.ts', expected: '[path]' },
  { input: '//server/share/repo/a.ts', expected: '[path]' },
  { input: '~/repo/a.ts', expected: '[path]' },
] as const;

describe('safeExternalErrorMessage', () => {
  it.each(pathCases)('applies the shared path rule to $input', ({ input, expected }) => {
    const resolvedInput = input.replaceAll('__BT__', String.fromCharCode(96));
    const resolvedExpected = expected.replaceAll('__BT__', String.fromCharCode(96));
    expect(safeExternalErrorMessage(new Error(resolvedInput))).toBe(resolvedExpected);
    expect(sanitizeLoopAnalysisReportForPublication(resolvedInput)).toBe(resolvedExpected);
  });

  it('preserves the stable external error categories', () => {
    expect(safeExternalErrorMessage(new Error('EACCES: /Users/jane/report.md'))).toBe(
      'permission denied',
    );
    expect(safeExternalErrorMessage(new Error('ENOENT: /Users/jane/report.md'))).toBe(
      'not found',
    );
  });
});

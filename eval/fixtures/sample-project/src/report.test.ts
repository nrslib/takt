import { describe, expect, it, vi } from 'vitest';
import { Logger } from './logger.js';
import { generateReport } from './report.js';

function captureStderr(): { written: string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { written, restore: () => spy.mockRestore() };
}

describe('generateReport', () => {
  it('processes all templates and returns the summary', () => {
    const logger = new Logger('error');
    const summary = generateReport(['a', 'b', 'c'], logger);
    expect(summary).toBe('レポート: 3 件のテンプレートを処理しました');
  });

  it('warns and throws when no templates are provided', () => {
    const { written, restore } = captureStderr();
    const logger = new Logger('warn');
    expect(() => generateReport([], logger)).toThrow(
      'Failed to generate report: no templates available',
    );
    restore();
    expect(written).toEqual(['[warn] report: no templates provided; skipping generation\n']);
  });
});

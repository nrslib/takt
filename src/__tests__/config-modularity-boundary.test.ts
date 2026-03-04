import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function getLineCount(path: string): number {
  const content = readFileSync(new URL(path, import.meta.url), 'utf-8');
  return content.trimEnd().split(/\r?\n/).length;
}

describe('config module file-size boundary', () => {
  it('keeps globalConfigCore.ts under 300 lines', () => {
    const lineCount = getLineCount('../infra/config/global/globalConfigCore.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps globalConfig.ts as thin facade under 120 lines', () => {
    const lineCount = getLineCount('../infra/config/global/globalConfig.ts');
    expect(lineCount).toBeLessThanOrEqual(120);
  });

  it('keeps projectConfig.ts under 300 lines', () => {
    const lineCount = getLineCount('../infra/config/project/projectConfig.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps pieceExecution.ts under 300 lines', () => {
    const lineCount = getLineCount('../features/tasks/execute/pieceExecution.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });
});

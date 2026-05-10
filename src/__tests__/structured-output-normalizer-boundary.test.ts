import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf-8');
}

describe('structured output normalizer boundary', () => {
  it('keeps builtin followup-task normalizers outside WorkflowEngineSetup', () => {
    const source = readSource('src/core/workflow/engine/WorkflowEngineSetup.ts');

    expect(source).not.toContain('infra/workflow/structured-output');
    expect(source).toContain('structuredOutputNormalizers: params.options.structuredOutputNormalizers');
  });

  it('does not hide unresolved provider state with an unknown fallback in StepExecutor', () => {
    const source = readSource('src/core/workflow/engine/StepExecutor.ts');

    expect(source).not.toContain("provider ?? 'unknown'");
  });
});

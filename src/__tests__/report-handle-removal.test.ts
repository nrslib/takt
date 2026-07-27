import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceTemplatePlaceholders } from '../core/workflow/instruction/escape.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

const REMOVED_PLACEHOLDERS = [
  '{current_report}',
  '{previous_report}',
  '{peer_reports}',
  '{report_history}',
] as const;

describe('report handle removal', () => {
  let reportDir: string;

  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'takt-report-handle-removal-'));
  });

  afterEach(() => {
    rmSync(reportDir, { recursive: true, force: true });
  });

  it('removes legacy instruction variables while retaining report content interpolation', () => {
    writeFileSync(join(reportDir, 'review.md'), 'inherited review body', 'utf-8');
    const template = REMOVED_PLACEHOLDERS.join('|');
    const legacyRendered = replaceTemplatePlaceholders(
      template,
      makeStep(),
      makeInstructionContext({ reportDir }),
    );
    const reportRendered = replaceTemplatePlaceholders(
      'Inherited report: {report:review.md}',
      makeStep(),
      makeInstructionContext({ reportDir }),
    );

    expect(legacyRendered).toBe(template);
    expect(reportRendered).toBe('Inherited report: inherited review body');
  });
});

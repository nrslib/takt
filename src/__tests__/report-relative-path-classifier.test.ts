import { describe, expect, it } from 'vitest';
import { classifyReportRelativePath } from '../core/models/reserved-report-names.js';

describe('classifyReportRelativePath', () => {
  it.each([
    ['review.md', 'review.md', 'review.md'],
    [
      'public/.takt-report-internal/review.md',
      'public/.takt-report-internal/review.md',
      'public/.takt-report-internal/review.md',
    ],
  ])('classifies public report path %s', (input, normalizedPath, portableIdentity) => {
    expect(classifyReportRelativePath(input)).toEqual({
      kind: 'public',
      normalizedPath,
      portableIdentity,
    });
  });

  it.each([
    '.takt-report-internal/history/review.md',
    '.TAKT-REPORT-INTERNAL/history/review.md',
  ])('classifies normalized internal namespace path %s', (input) => {
    expect(classifyReportRelativePath(input).kind).toBe('internal-namespace');
  });

  it.each([
    'resume-artifacts.json',
    'nested/resume-artifacts.json',
  ])('classifies reserved manifest path %s', (input) => {
    expect(classifyReportRelativePath(input).kind).toBe('reserved-manifest');
  });

  it('uses Unicode Default Case Fold and NFC for portable identity', () => {
    const fullFold = classifyReportRelativePath('Straße.md');
    const upperFold = classifyReportRelativePath('STRASSE.md');
    const nfc = classifyReportRelativePath('réview.md');
    const nfd = classifyReportRelativePath('re\u0301view.md');

    expect(fullFold.kind === 'public' && fullFold.portableIdentity).toBe('strasse.md');
    expect(upperFold.kind === 'public' && upperFold.portableIdentity).toBe('strasse.md');
    expect(nfc.kind === 'public' && nfc.portableIdentity).toBe('réview.md');
    expect(nfd.kind === 'public' && nfd.portableIdentity).toBe('réview.md');
  });

  it.each([
    '',
    '.',
    '..',
    '../review.md',
    'nested/../../review.md',
    '/absolute/review.md',
    'C:\\absolute\\review.md',
    'C:drive-relative.md',
    'review\0.md',
    ' review.md',
    'review.md ',
    './nested/review.md',
    'nested/./review.md',
    'draft/../review.md',
    'nested//review.md',
    'nested\\\\review.md',
    'nested\\review.md',
    '.takt-report-internal\\history\\review.md',
    'nested\\Resume-Artifacts.JSON',
    'nested/',
    'public/../.takt-report-internal/history/review.md',
  ])('classifies invalid report-relative path %s', (input) => {
    expect(classifyReportRelativePath(input).kind).toBe('invalid');
  });
});

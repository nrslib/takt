/**
 * Unit tests for InstructionBuilder helper functions
 *
 * Tests isOutputContractItem, renderReportContext, and renderReportOutputInstruction.
 */

import { describe, it, expect } from 'vitest';
import {
  isOutputContractItem,
  renderReportContext,
  renderReportOutputInstruction,
} from '../core/workflow/instruction/InstructionBuilder.js';
import type { OutputContractEntry } from '../core/models/types.js';
import { makeStep, makeInstructionContext } from './test-helpers.js';

describe('isOutputContractItem', () => {
  it('should return true for OutputContractItem (has name)', () => {
    expect(isOutputContractItem({ name: 'report.md', format: 'report', useJudge: true })).toBe(true);
  });

  it('should return true for OutputContractItem with order/format', () => {
    expect(isOutputContractItem({ name: 'report.md', order: 'Output to file', format: 'markdown', useJudge: true })).toBe(true);
  });

  it('should return false when name is missing', () => {
    expect(isOutputContractItem({ format: 'report', useJudge: true })).toBe(false);
  });
});

describe('renderReportContext', () => {
  it('should render single OutputContractItem', () => {
    const contracts: OutputContractEntry[] = [{ name: '00-plan.md', format: '00-plan', useJudge: true }];
    const result = renderReportContext(contracts, '/tmp/reports');

    expect(result).toContain('Report Directory: /tmp/reports/');
    expect(result).toContain('Report File: /tmp/reports/00-plan.md');
  });

  it('should render single OutputContractItem by name', () => {
    const contracts: OutputContractEntry[] = [{ name: 'plan.md', format: 'plan', useJudge: true }];
    const result = renderReportContext(contracts, '/tmp/reports');

    expect(result).toContain('Report Directory: /tmp/reports/');
    expect(result).toContain('Report File: /tmp/reports/plan.md');
  });

  it('should render multiple contracts as list', () => {
    const contracts: OutputContractEntry[] = [
      { name: '00-plan.md', format: '00-plan', useJudge: true },
      { name: '01-review.md', format: '01-review', useJudge: true },
    ];
    const result = renderReportContext(contracts, '/tmp/reports');

    expect(result).toContain('Report Directory: /tmp/reports/');
    expect(result).toContain('Report Files:');
    expect(result).toContain('00-plan.md: /tmp/reports/00-plan.md');
    expect(result).toContain('01-review.md: /tmp/reports/01-review.md');
  });
});

describe('renderReportOutputInstruction', () => {
  it('should return empty string when no output contracts', () => {
    const step = makeStep();
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });
    expect(renderReportOutputInstruction(step, ctx, 'en')).toBe('');
  });

  it('should return empty string when no reportDir', () => {
    const step = makeStep({ outputContracts: [{ name: 'report.md', format: 'report', useJudge: true }] });
    const ctx = makeInstructionContext();
    expect(renderReportOutputInstruction(step, ctx, 'en')).toBe('');
  });

  it('should render English single-file instruction', () => {
    const step = makeStep({ outputContracts: [{ name: 'report.md', format: 'report', useJudge: true }] });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports', stepIteration: 2 });

    const result = renderReportOutputInstruction(step, ctx, 'en');
    expect(result).toContain('Report output');
    expect(result).toContain('Report File');
    expect(result).toContain('Move current content to `logs/reports-history/`');
  });

  it('should render English multi-file instruction', () => {
    const step = makeStep({
      outputContracts: [{ name: 'plan.md', format: 'plan', useJudge: true }, { name: 'review.md', format: 'review', useJudge: true }],
    });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });

    const result = renderReportOutputInstruction(step, ctx, 'en');
    expect(result).toContain('Report Files');
  });

  it('should render Japanese single-file instruction', () => {
    const step = makeStep({ outputContracts: [{ name: 'report.md', format: 'report', useJudge: true }] });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports', stepIteration: 1 });

    const result = renderReportOutputInstruction(step, ctx, 'ja');
    expect(result).toContain('レポート出力');
    expect(result).toContain('Report File');
    expect(result).toContain('`logs/reports-history/`');
  });

  it('should render Japanese multi-file instruction', () => {
    const step = makeStep({
      outputContracts: [{ name: 'plan.md', format: 'plan', useJudge: true }, { name: 'review.md', format: 'review', useJudge: true }],
    });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });

    const result = renderReportOutputInstruction(step, ctx, 'ja');
    expect(result).toContain('Report Files');
  });
});

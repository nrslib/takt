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
} from '../core/piece/instruction/InstructionBuilder.js';
import type { OutputContractEntry } from '../core/models/types.js';
import { makeMovement, makeInstructionContext } from './test-helpers.js';

describe('isOutputContractItem', () => {
  it('should return true for OutputContractItem (has name)', () => {
    expect(isOutputContractItem({ name: 'report.md' })).toBe(true);
  });

  it('should return true for OutputContractItem with order/format', () => {
    expect(isOutputContractItem({ name: 'report.md', order: 'Output to file', format: 'markdown' })).toBe(true);
  });

  it('should return false for OutputContractLabelPath (has label and path)', () => {
    expect(isOutputContractItem({ label: 'Report', path: 'report.md' })).toBe(false);
  });
});

describe('renderReportContext', () => {
  it('should render single OutputContractItem', () => {
    const contracts: OutputContractEntry[] = [{ name: '00-plan.md' }];
    const result = renderReportContext(contracts, '/tmp/reports');

    expect(result).toContain('Report Directory: /tmp/reports/');
    expect(result).toContain('Report File: /tmp/reports/00-plan.md');
  });

  it('should render single OutputContractLabelPath', () => {
    const contracts: OutputContractEntry[] = [{ label: 'Plan', path: 'plan.md' }];
    const result = renderReportContext(contracts, '/tmp/reports');

    expect(result).toContain('Report Directory: /tmp/reports/');
    expect(result).toContain('Report File: /tmp/reports/plan.md');
  });

  it('should render multiple contracts as list', () => {
    const contracts: OutputContractEntry[] = [
      { name: '00-plan.md' },
      { label: 'Review', path: '01-review.md' },
    ];
    const result = renderReportContext(contracts, '/tmp/reports');

    expect(result).toContain('Report Directory: /tmp/reports/');
    expect(result).toContain('Report Files:');
    expect(result).toContain('00-plan.md: /tmp/reports/00-plan.md');
    expect(result).toContain('Review: /tmp/reports/01-review.md');
  });
});

describe('renderReportOutputInstruction', () => {
  it('should return empty string when no output contracts', () => {
    const step = makeMovement();
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });
    expect(renderReportOutputInstruction(step, ctx, 'en')).toBe('');
  });

  it('should return empty string when no reportDir', () => {
    const step = makeMovement({ outputContracts: [{ name: 'report.md' }] });
    const ctx = makeInstructionContext();
    expect(renderReportOutputInstruction(step, ctx, 'en')).toBe('');
  });

  it('should render English single-file instruction', () => {
    const step = makeMovement({ outputContracts: [{ name: 'report.md' }] });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports', movementIteration: 2 });

    const result = renderReportOutputInstruction(step, ctx, 'en');
    expect(result).toContain('Report output');
    expect(result).toContain('Report File');
    expect(result).toContain('Move current content to `logs/reports-history/`');
  });

  it('should render English multi-file instruction', () => {
    const step = makeMovement({
      outputContracts: [{ name: 'plan.md' }, { name: 'review.md' }],
    });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });

    const result = renderReportOutputInstruction(step, ctx, 'en');
    expect(result).toContain('Report Files');
  });

  it('should render Japanese single-file instruction', () => {
    const step = makeMovement({ outputContracts: [{ name: 'report.md' }] });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports', movementIteration: 1 });

    const result = renderReportOutputInstruction(step, ctx, 'ja');
    expect(result).toContain('レポート出力');
    expect(result).toContain('Report File');
    expect(result).toContain('`logs/reports-history/`');
  });

  it('should render Japanese multi-file instruction', () => {
    const step = makeMovement({
      outputContracts: [{ name: 'plan.md' }, { name: 'review.md' }],
    });
    const ctx = makeInstructionContext({ reportDir: '/tmp/reports' });

    const result = renderReportOutputInstruction(step, ctx, 'ja');
    expect(result).toContain('Report Files');
  });
});

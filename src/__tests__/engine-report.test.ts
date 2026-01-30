/**
 * Tests for engine report event emission (step:report)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { isReportObjectConfig } from '../workflow/instruction-builder.js';
import type { WorkflowStep, ReportObjectConfig, ReportConfig } from '../models/types.js';

/**
 * Extracted emitStepReports logic for unit testing.
 * Mirrors engine.ts emitStepReports + emitIfReportExists.
 *
 * reportDir already includes the `.takt/reports/` prefix (set by engine constructor).
 */
function emitStepReports(
  emitter: EventEmitter,
  step: WorkflowStep,
  reportDir: string,
  projectCwd: string,
): void {
  if (!step.report || !reportDir) return;
  const baseDir = join(projectCwd, reportDir);

  if (typeof step.report === 'string') {
    emitIfReportExists(emitter, step, baseDir, step.report);
  } else if (isReportObjectConfig(step.report)) {
    emitIfReportExists(emitter, step, baseDir, step.report.name);
  } else {
    for (const rc of step.report) {
      emitIfReportExists(emitter, step, baseDir, rc.path);
    }
  }
}

function emitIfReportExists(
  emitter: EventEmitter,
  step: WorkflowStep,
  baseDir: string,
  fileName: string,
): void {
  const filePath = join(baseDir, fileName);
  if (existsSync(filePath)) {
    emitter.emit('step:report', step, filePath, fileName);
  }
}

/** Create a minimal WorkflowStep for testing */
function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    agent: 'coder',
    agentDisplayName: 'Coder',
    instructionTemplate: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

describe('emitStepReports', () => {
  let tmpDir: string;
  let reportBaseDir: string;
  // reportDir now includes .takt/reports/ prefix (matches engine constructor behavior)
  const reportDirName = '.takt/reports/test-report-dir';

  beforeEach(() => {
    tmpDir = join(tmpdir(), `takt-report-test-${Date.now()}`);
    reportBaseDir = join(tmpDir, reportDirName);
    mkdirSync(reportBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should emit step:report when string report file exists', () => {
    // Given: a step with string report and the file exists
    const step = createStep({ report: 'plan.md' });
    writeFileSync(join(reportBaseDir, 'plan.md'), '# Plan', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, 'plan.md'), 'plan.md');
  });

  it('should not emit when string report file does not exist', () => {
    // Given: a step with string report but file doesn't exist
    const step = createStep({ report: 'missing.md' });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit step:report when ReportObjectConfig report file exists', () => {
    // Given: a step with ReportObjectConfig and the file exists
    const report: ReportObjectConfig = { name: '03-review.md', format: '# Review' };
    const step = createStep({ report });
    writeFileSync(join(reportBaseDir, '03-review.md'), '# Review\nOK', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, '03-review.md'), '03-review.md');
  });

  it('should emit for each existing file in ReportConfig[] array', () => {
    // Given: a step with array report, two files exist, one missing
    const report: ReportConfig[] = [
      { label: 'Scope', path: '01-scope.md' },
      { label: 'Decisions', path: '02-decisions.md' },
      { label: 'Missing', path: '03-missing.md' },
    ];
    const step = createStep({ report });
    writeFileSync(join(reportBaseDir, '01-scope.md'), '# Scope', 'utf-8');
    writeFileSync(join(reportBaseDir, '02-decisions.md'), '# Decisions', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then: emitted for scope and decisions, not for missing
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, '01-scope.md'), '01-scope.md');
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, '02-decisions.md'), '02-decisions.md');
  });

  it('should not emit when step has no report', () => {
    // Given: a step without report
    const step = createStep({ report: undefined });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not emit when reportDir is empty', () => {
    // Given: a step with report but empty reportDir
    const step = createStep({ report: 'plan.md' });
    writeFileSync(join(reportBaseDir, 'plan.md'), '# Plan', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When: empty reportDir
    emitStepReports(emitter, step, '', tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * Tests for engine report event emission (step:report)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { isOutputContractItem } from '../core/workflow/index.js';
import type { WorkflowStep, OutputContractItem, OutputContractLabelPath, OutputContractEntry } from '../core/models/index.js';

/**
 * Extracted emitStepReports logic for unit testing.
 * Mirrors engine.ts emitStepReports + emitIfReportExists.
 *
 * reportDir already includes the `.takt/runs/{slug}/reports` path (set by engine constructor).
 */
function emitStepReports(
  emitter: EventEmitter,
  step: WorkflowStep,
  reportDir: string,
  projectCwd: string,
): void {
  if (!step.outputContracts || step.outputContracts.length === 0 || !reportDir) return;
  const baseDir = join(projectCwd, reportDir);

  for (const entry of step.outputContracts) {
    const fileName = isOutputContractItem(entry) ? entry.name : entry.path;
    emitIfReportExists(emitter, step, baseDir, fileName);
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
    persona: 'coder',
    personaDisplayName: 'Coder',
    instruction: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

describe('emitStepReports', () => {
  let tmpDir: string;
  let reportBaseDir: string;
  // reportDir now includes .takt/runs/{slug}/reports path (matches engine constructor behavior)
  const reportDirName = '.takt/runs/test-report-dir/reports';

  beforeEach(() => {
    tmpDir = join(tmpdir(), `takt-report-test-${Date.now()}`);
    reportBaseDir = join(tmpDir, reportDirName);
    mkdirSync(reportBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should emit step:report when output contract file exists', () => {
    // Given: a step with output contract and the file exists
    const outputContracts: OutputContractEntry[] = [{ name: 'plan.md', format: 'plan', useJudge: true }];
    const step = createStep({ outputContracts });
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

  it('should not emit when output contract file does not exist', () => {
    // Given: a step with output contract but file doesn't exist
    const outputContracts: OutputContractEntry[] = [{ name: 'missing.md', format: 'missing', useJudge: true }];
    const step = createStep({ outputContracts });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit step:report when OutputContractItem file exists', () => {
    // Given: a step with OutputContractItem and the file exists
    const outputContracts: OutputContractEntry[] = [{ name: '03-review.md', format: '# Review', useJudge: true }];
    const step = createStep({ outputContracts });
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

  it('should emit for each existing file in output contracts array', () => {
    // Given: a step with array output contracts, two files exist, one missing
    const outputContracts: OutputContractEntry[] = [
      { name: '01-scope.md', format: '01-scope', useJudge: true },
      { name: '02-decisions.md', format: '02-decisions', useJudge: true },
      { name: '03-missing.md', format: '03-missing', useJudge: true },
    ];
    const step = createStep({ outputContracts });
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

  it('should not emit when step has no output contracts', () => {
    // Given: a step without output contracts
    const step = createStep({ outputContracts: undefined });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not emit when reportDir is empty', () => {
    // Given: a step with output contracts but empty reportDir
    const outputContracts: OutputContractEntry[] = [{ name: 'plan.md', format: 'plan', useJudge: true }];
    const step = createStep({ outputContracts });
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

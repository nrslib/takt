/**
 * Tests for engine report event emission (movement:report)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { isOutputContractItem } from '../core/piece/index.js';
import type { PieceMovement, OutputContractItem, OutputContractLabelPath, OutputContractEntry } from '../core/models/index.js';

/**
 * Extracted emitMovementReports logic for unit testing.
 * Mirrors engine.ts emitMovementReports + emitIfReportExists.
 *
 * reportDir already includes the `.takt/runs/{slug}/reports` path (set by engine constructor).
 */
function emitMovementReports(
  emitter: EventEmitter,
  movement: PieceMovement,
  reportDir: string,
  projectCwd: string,
): void {
  if (!movement.outputContracts || movement.outputContracts.length === 0 || !reportDir) return;
  const baseDir = join(projectCwd, reportDir);

  for (const entry of movement.outputContracts) {
    const fileName = isOutputContractItem(entry) ? entry.name : entry.path;
    emitIfReportExists(emitter, movement, baseDir, fileName);
  }
}

function emitIfReportExists(
  emitter: EventEmitter,
  movement: PieceMovement,
  baseDir: string,
  fileName: string,
): void {
  const filePath = join(baseDir, fileName);
  if (existsSync(filePath)) {
    emitter.emit('movement:report', movement, filePath, fileName);
  }
}

/** Create a minimal PieceMovement for testing */
function createMovement(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'test-movement',
    persona: 'coder',
    personaDisplayName: 'Coder',
    instructionTemplate: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

describe('emitMovementReports', () => {
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

  it('should emit movement:report when output contract file exists', () => {
    // Given: a movement with output contract and the file exists
    const outputContracts: OutputContractEntry[] = [{ name: 'plan.md' }];
    const movement = createMovement({ outputContracts });
    writeFileSync(join(reportBaseDir, 'plan.md'), '# Plan', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('movement:report', handler);

    // When
    emitMovementReports(emitter, movement, reportDirName, tmpDir);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(movement, join(reportBaseDir, 'plan.md'), 'plan.md');
  });

  it('should not emit when output contract file does not exist', () => {
    // Given: a movement with output contract but file doesn't exist
    const outputContracts: OutputContractEntry[] = [{ name: 'missing.md' }];
    const movement = createMovement({ outputContracts });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('movement:report', handler);

    // When
    emitMovementReports(emitter, movement, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit movement:report when OutputContractItem file exists', () => {
    // Given: a movement with OutputContractItem and the file exists
    const outputContracts: OutputContractEntry[] = [{ name: '03-review.md', format: '# Review' }];
    const movement = createMovement({ outputContracts });
    writeFileSync(join(reportBaseDir, '03-review.md'), '# Review\nOK', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('movement:report', handler);

    // When
    emitMovementReports(emitter, movement, reportDirName, tmpDir);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(movement, join(reportBaseDir, '03-review.md'), '03-review.md');
  });

  it('should emit for each existing file in output contracts array', () => {
    // Given: a movement with array output contracts, two files exist, one missing
    const outputContracts: OutputContractEntry[] = [
      { label: 'Scope', path: '01-scope.md' },
      { label: 'Decisions', path: '02-decisions.md' },
      { label: 'Missing', path: '03-missing.md' },
    ];
    const movement = createMovement({ outputContracts });
    writeFileSync(join(reportBaseDir, '01-scope.md'), '# Scope', 'utf-8');
    writeFileSync(join(reportBaseDir, '02-decisions.md'), '# Decisions', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('movement:report', handler);

    // When
    emitMovementReports(emitter, movement, reportDirName, tmpDir);

    // Then: emitted for scope and decisions, not for missing
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(movement, join(reportBaseDir, '01-scope.md'), '01-scope.md');
    expect(handler).toHaveBeenCalledWith(movement, join(reportBaseDir, '02-decisions.md'), '02-decisions.md');
  });

  it('should not emit when movement has no output contracts', () => {
    // Given: a movement without output contracts
    const movement = createMovement({ outputContracts: undefined });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('movement:report', handler);

    // When
    emitMovementReports(emitter, movement, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not emit when reportDir is empty', () => {
    // Given: a movement with output contracts but empty reportDir
    const outputContracts: OutputContractEntry[] = [{ name: 'plan.md' }];
    const movement = createMovement({ outputContracts });
    writeFileSync(join(reportBaseDir, 'plan.md'), '# Plan', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('movement:report', handler);

    // When: empty reportDir
    emitMovementReports(emitter, movement, '', tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });
});

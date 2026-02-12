/**
 * Shared helpers for unit tests and integration tests.
 *
 * Unlike engine-test-helpers.ts, this file has no mock dependencies and
 * can be safely imported from any test file without requiring vi.mock() setup.
 */

import type { PieceMovement, PieceRule } from '../core/models/types.js';
import type { InstructionContext } from '../core/piece/instruction/instruction-context.js';

export function makeRule(condition: string, next: string, extra: Partial<PieceRule> = {}): PieceRule {
  return { condition, next, ...extra };
}

export function makeMovement(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'test-movement',
    personaDisplayName: 'tester',
    instructionTemplate: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

export function makeInstructionContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'test task',
    iteration: 1,
    maxMovements: 10,
    movementIteration: 1,
    cwd: '/tmp/test',
    projectCwd: '/tmp/project',
    userInputs: [],
    ...overrides,
  };
}

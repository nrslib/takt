import { describe, expect, it } from 'vitest';
import { OptionsBuilder } from '../core/piece/engine/OptionsBuilder.js';
import type { PieceMovement } from '../core/models/types.js';
import type { PieceEngineOptions } from '../core/piece/types.js';

function createMovement(): PieceMovement {
  return {
    name: 'reviewers',
    personaDisplayName: 'Reviewers',
    instructionTemplate: 'review',
    passPreviousResponse: false,
    permissionMode: 'full',
  };
}

function createBuilder(step: PieceMovement): OptionsBuilder {
  const engineOptions: PieceEngineOptions = {
    projectCwd: '/project',
  };

  return new OptionsBuilder(
    engineOptions,
    () => '/project',
    () => '/project',
    () => undefined,
    () => '.takt/runs/sample/reports',
    () => 'ja',
    () => [{ name: step.name }],
    () => 'default',
    () => 'test piece',
  );
}

describe('OptionsBuilder.buildResumeOptions', () => {
  it('should enforce readonly permission and empty allowedTools for report/status phases', () => {
    // Given
    const step = createMovement();
    const builder = createBuilder(step);

    // When
    const options = builder.buildResumeOptions(step, 'session-123', { maxTurns: 3 });

    // Then
    expect(options.permissionMode).toBe('readonly');
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(3);
    expect(options.sessionId).toBe('session-123');
  });
});
